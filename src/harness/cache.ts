/**
 * @module dsh-cost-guard/harness/cache
 * DSH 缓存计量适配层：从会话事件读取原始 usage、驱动 core 缓存账本与
 * 前缀提示检测，并把缓存指标呈现为面板 / 洞察输出。
 *
 * 数据链路（与既有 listener 并行、互不干扰）：
 *   session/event(assistant/message) -> DshCacheUsageReader（原始 usage 快照）
 *     -> core CacheUsageParser（三通道拆分 + 回退标注）
 *     -> core CachePricingEngine（按路由/时段取三通道价）
 *     -> core CacheMetrics（Token 加权命中率 / 收益 / 不确定数）
 *     -> core CacheHintDetector（可优化前缀提示）
 *     -> CachePanelPresenter（面板与洞察输出）
 *
 * 回退语义（方案文档 4.3）：
 *   - usage 整体缺失：不入账（与既有计量一致）。
 *   - usage 存在但缓存命中字段缺失 / 异常：按未命中计费，标注 uncertainty，
 *     命中率不纳入可信汇总；连续 5 次回退输出一次性提示（每 10 分钟最多一条）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  CacheSummary,
  CacheUsageReader,
  CacheUsageResult,
  PrefixCandidate,
  RawUsageSnapshot,
} from '../core/cache-types.js'
import { parseCachedUsage, outcomeToSplit } from '../core/cache-parse.js'
import { computeCacheCost, CacheMetrics } from '../core/cache-metrics.js'
import { deepseekBandForEpoch, CachePricingEngine } from '../core/cache-pricing.js'
import type { CacheHintDetector } from '../core/cache-hint.js'
import { parseSessionEvent, type ParsedSessionEvent } from './listener.js'

// ---------------------------------------------------------------------------
// DshCacheUsageReader：读 DSH 事件 usage -> RawUsageSnapshot（原始字段优先）
// ---------------------------------------------------------------------------

/** 从任意对象取有限非负数；不合法返回 undefined。 */
function num(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return v
}

/** 从 DSH 会话事件读取原始用量快照（宽容解析，兼容 OpenAI 风格与 DSH 归一化字段）。 */
export function readCacheUsage(event: unknown): CacheUsageResult {
  const record = (event ?? {}) as { data?: unknown }
  const data = record.data
  if (!data || typeof data !== 'object') return { status: 'missing', raw: null }
  const inner = data as Record<string, unknown>
  // 部分宿主把 usage 放在 data.usage；兼容 response.usage 形状
  const usage = (inner['usage'] ?? inner['response']) as Record<string, unknown> | null | undefined
  if (!usage || typeof usage !== 'object') return { status: 'missing', raw: null }

  // 输入 token：prompt_tokens（原生）> promptTokens > inputTokens(+cacheRead)
  let promptTokens = num(usage['prompt_tokens']) ?? num(usage['promptTokens'])
  if (promptTokens === undefined) {
    const input = num(usage['inputTokens']) ?? 0
    const cacheRead = num(usage['cacheReadTokens']) ?? 0
    promptTokens = input + cacheRead
  }
  const completionTokens = num(usage['completion_tokens']) ?? num(usage['completionTokens']) ?? num(usage['outputTokens']) ?? 0

  // 缓存命中 token：prompt_tokens_details.cached_tokens（原生）> cachedTokens > cacheReadTokens
  // 字段"存在但非法"（负数/非整数/超限）用哨兵 -1 传递，由 core 解析器判为 malformed。
  const details = usage['prompt_tokens_details'] as Record<string, unknown> | undefined
  let cachedRaw: unknown
  if (details && typeof details === 'object' && 'cached_tokens' in details) {
    cachedRaw = details['cached_tokens']
  } else if (usage['cachedTokens'] !== undefined) {
    cachedRaw = usage['cachedTokens']
  } else if ('cacheReadTokens' in usage) {
    // DSH 归一化字段存在即视为明确（含 0 = 确无命中）；字段不存在视为缺失 -> 回退
    cachedRaw = usage['cacheReadTokens']
  }
  const cachedTokens = cachedRaw === undefined ? undefined : (num(cachedRaw) ?? -1)

  const raw: RawUsageSnapshot = {
    promptTokens,
    completionTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  }
  return { status: 'ok', raw }
}

/** CacheUsageReader 端口具象实现（供依赖注入与测试）。 */
export class DshCacheUsageReader implements CacheUsageReader {
  read(event: unknown): CacheUsageResult {
    return readCacheUsage(event)
  }
}

// ---------------------------------------------------------------------------
// 缓存计量管道：(event) -> 账本 + 提示检测
// ---------------------------------------------------------------------------

/** 缓存计量接线配置。 */
export interface CacheMeterOptions {
  /** 时区偏移（分钟），用于时段判定。 */
  tzOffsetMin: number
  /** 三通道定价引擎。 */
  pricing: CachePricingEngine
  /** 缓存账本（Token 加权命中率 / 收益 / 不确定数）。 */
  metrics: CacheMetrics
  /** 可优化前缀提示检测器。 */
  hint: CacheHintDetector
  /** 前缀签名生成器：默认按 route + 输入量级分桶（可注入真实文本哈希）。 */
  prefixOf?: (route: string, split: { inputHit: number; inputMiss: number }) => string
  /** 回退告警回调（连续 5 次回退触发；缺省走 ctx.logger）。 */
  onFallbackStreak?: (streak: number) => void
}

/** 默认前缀签名：route + 输入量级分桶（2^10=1024 token 一档），稳定负载归同类。 */
export function defaultPrefixOf(route: string, split: { inputHit: number; inputMiss: number }): string {
  const total = split.inputHit + split.inputMiss
  const bucket = total <= 0 ? 0 : Math.floor(Math.log2(total))
  return `${route}#k${bucket}`
}

/** 挂载缓存计量：订阅 session/event，驱动 core 账本与提示检测。 */
export function attachCacheMeter(ctx: Context, options: CacheMeterOptions): void {
  const { tzOffsetMin, pricing, metrics, hint } = options
  const prefixOf = options.prefixOf ?? defaultPrefixOf
  const logger = ctx.logger('cost-guard')
  let fallbackStreak = 0
  let lastFallbackHintAt = 0
  // 会话路由状态：request/header 更新，assistant/message 归属最近路由
  let currentRoute = 'deepseek/deepseek-chat'

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      if (event.type === 'request/header') {
        const parsed: ParsedSessionEvent = parseSessionEvent(event)
        if (parsed.provider || parsed.model) {
          currentRoute = `${parsed.provider ?? 'deepseek'}/${parsed.model ?? 'deepseek-chat'}`
        }
        return
      }
      if (event.type !== 'assistant/message') return
      // 以 readCacheUsage 自身为准：兼容 OpenAI 原生（prompt_tokens*）与 DSH 归一化形状
      const result = readCacheUsage({ ...event, data: (event as { data?: unknown }).data })
      if (result.status !== 'ok') return // 用量整体缺失：不入账（与既有计量一致）
      const raw = result.raw
      const parsed: ParsedSessionEvent = parseSessionEvent({ ...event, sessionId: String(session.id) })
      const time = parsed.time
      const routeKey = currentRoute

      const outcome = parseCachedUsage(raw)
      const split = outcomeToSplit(outcome, raw.completionTokens ?? parsed.usage?.outputTokens ?? 0)

      const band = deepseekBandForEpoch(time, tzOffsetMin)
      const price = pricing.resolve(routeKey, band)
      const { cost, baselineCost, saving } = computeCacheCost(split, price)

      metrics.append({ split, cost, baselineCost, saving }, {
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
        route: routeKey,
      })

      const prefixId = prefixOf(routeKey, { inputHit: split.inputHit, inputMiss: split.inputMiss })
      hint.observe(prefixId, routeKey, split, time, tzOffsetMin)

      // 连续 5 次回退：一次性提示，最多每 10 分钟一条
      if (split.uncertainty) {
        fallbackStreak += 1
        if (fallbackStreak === 5) {
          const now = Date.now()
          if (now - lastFallbackHintAt >= 600_000) {
            lastFallbackHintAt = now
            logger.warn(
              '[cost-guard] 连续 5 次请求缺少缓存命中字段（cached_tokens），已按未命中计费并标注不确定。' +
                '建议升级 DSH 版本或检查网关是否剥离 usage 扩展字段。',
            )
            options.onFallbackStreak?.(fallbackStreak)
          }
        }
      } else {
        fallbackStreak = 0
      }
    } catch (err) {
      // 缓存计量是旁路能力：单条事件解析/入账失败只跳过本条并留日志，
      // 不得把异常抛回宿主事件链（fail-safe，不吞错）。
      logger.warn(`[cost-guard] 缓存计量事件处理失败，已跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

// ---------------------------------------------------------------------------
// CachePanelPresenter：面板 / 洞察 / 提示输出（JSON 安全、人读摘要）
// ---------------------------------------------------------------------------

/** 缓存面板负载（供聚合进 CostStatusPayload.cache）。 */
export interface CachePanelPayload {
  enabled: true
  /** 全局 Token 加权命中率 / 收益 / 不确定数。 */
  summary: CacheSummary
  /** 会话维度汇总。 */
  sessions: Record<string, CacheSummary>
  /** 路由维度汇总。 */
  routes: Record<string, CacheSummary>
  /** 可优化前缀候选。 */
  hints: PrefixCandidate[]
}

/** 由账本 + 检测器构建面板负载。 */
export function buildCachePanel(metrics: CacheMetrics, hint: CacheHintDetector): CachePanelPayload {
  return {
    enabled: true,
    summary: metrics.summary('global'),
    sessions: metrics.byScope('session'),
    routes: metrics.byScope('route'),
    hints: hint.candidates(),
  }
}

/** 人读缓存面板行（命中率 / 收益 / 不确定数 / 前缀提示）。 */
export function formatCacheLines(payload: CachePanelPayload): string[] {
  const s = payload.summary
  const lines: string[] = []
  const rate = `${(s.hitRate * 100).toFixed(1)}%`
  const base = `缓存: 命中率 ${rate} (${s.hitTotal.toLocaleString()}/${s.inputTotal.toLocaleString()} tokens) · 收益 ${s.savingTotal.toFixed(4)} 元`
  lines.push(s.uncertainCount > 0 ? `${base} · 不确定 ${s.uncertainCount} 次` : base)
  if (payload.hints.length > 0) {
    for (const h of payload.hints) {
      lines.push(
        `  提示: 前缀 ${h.prefixId} 近 ${h.repeatCount} 次均未命中，若稳定化可节省约 ${h.potentialSaving.toFixed(2)} 元（当前命中率 ${(h.observedHitRate * 100).toFixed(1)}%）`,
      )
    }
  }
  return lines
}