/**
 * @module dsh-cost-guard/harness/listener
 * DSH 事件适配层：把 `session/event`（assistant/message.usage + request/header）转换为
 * DetectionEntry 送入 Meter，实现实时计量。
 *
 * 数据链路：
 *   session/event(request/header)  -> 记录当前路由（provider/model）
 *   session/event(assistant/message) -> 携带 usage，按当前路由计价后记录
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsageLike, TimeBand, ModelPrice, UsageEntry } from '../core/types.js'
import { BASE_BAND } from '../core/types.js'
import {
  computeCost,
  computeCredits,
  billedTokens,
  priceFor,
  priceForAt,
  bandIdForEpoch,
  buildBandPriceTable,
  type BandPriceTable,
  type PricingTable,
} from '../core/pricing.js'
import { officialBandForEpochOf, officialEntryPrice } from '../core/official-pricing.js'
import type { CacheBand } from '../core/cache-types.js'
import type { Meter } from '../core/meter.js'
import type { WindowMeter } from '../core/meter.js'

/** 宿主侧会话事件解析出的可用字段。 */
export interface ParsedSessionEvent {
  type: string
  time: number
  sessionId?: string
  usage?: TokenUsageLike
  provider?: string
  model?: string
}

/** DSH SessionEvent 外围可携带的 data 字段（事件载荷；类型未在 dsh-session 中建模）。 */
interface EventWithData {
  data?: unknown
}

/** 从 DSH 的 SessionEvent 提取我们需要的字段（宽容解析，字段缺失不抛错）。 */
export function parseSessionEvent(event: SessionEvent & { sessionId?: string }): ParsedSessionEvent {
  const base: ParsedSessionEvent = {
    type: event.type,
    time: event.time,
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
  }
  const data = (event as EventWithData).data
  if (!data || typeof data !== 'object') return base

  const record = data as Record<string, unknown>

  // request/header -> 路由
  if (event.type === 'request/header') {
    const header = record['header'] as { config?: { provider?: string; model?: string } } | undefined
    const config = header?.config
    if (config?.provider) base.provider = config.provider
    if (config?.model) base.model = config.model
  }

  // assistant/message -> usage（宽容读取路由：部分宿主把 provider/model 随消息载荷下发）
  if (event.type === 'assistant/message') {
    const usage = record['usage'] as TokenUsageLike | undefined
    if (usage && typeof usage.inputTokens === 'number') {
      base.usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
      }
    }
    const msgProvider = (record['provider'] as string | undefined) ?? (record['message'] as { provider?: string } | undefined)?.provider
    const msgModel = (record['model'] as string | undefined) ?? (record['message'] as { model?: string } | undefined)?.model
    if (msgProvider) base.provider = msgProvider
    if (msgModel) base.model = msgModel
  }

  return base
}

/** 峰谷计价上下文：时段表 + 事件时区偏移。 */
export interface BandPricingContext {
  /** 时段定义；为空时全部按 BASE_BAND（基准价），行为与旧版一致。 */
  bands?: TimeBand[]
  /** 事件时区偏移（分钟），用于把事件时间换算为本地分钟选带。 */
  tzOffsetMin?: number
  /**
   * 官方计价引擎（0.8.0；缺省不启用 = 零回归）。
   * 启用后：主计量并入官方价目（flash / v4-pro 三通道）、官方峰谷自动挂载
   * （工作日非节假日 9-12 / 14-18 高峰，其余空闲）、模型名别名归一
   * （deepseek-v4-flash 等旧名路由到 flash 价）。用户自定义 bands 仍优先于官方峰谷。
   */
  official?: {
    enabled: boolean
    /** 用户 pricing 覆盖（最终单价，优先于官方价，不随峰谷翻倍）。 */
    overrides: Record<string, ModelPrice>
    /** 额外法定节假日（YYYY-MM-DD）；缺省用内置 2026 节假日表。 */
    holidays?: ReadonlySet<string>
  }
}

/** 由解析后的宿主事件构造计价入账条目。 */
export function toUsageEntry(
  parsed: ParsedSessionEvent,
  routes: PricingTable,
  fallbackRoute: { provider: string; model: string },
  bandCtx?: BandPricingContext,
  /** 预构建的带覆盖表（高频路径在装配层构建一次复用；缺省按 bandCtx 构建）。 */
  prebuiltBandTable?: BandPriceTable,
): UsageEntry | undefined {
  if (!parsed.usage || parsed.usage.inputTokens + parsed.usage.outputTokens + (parsed.usage.cacheReadTokens ?? 0) <= 0) {
    return undefined
  }
  const route = {
    provider: parsed.provider ?? fallbackRoute.provider,
    model: parsed.model ?? fallbackRoute.model,
  }
  const usage = {
    inputTokens: parsed.usage.inputTokens,
    outputTokens: parsed.usage.outputTokens,
    cacheReadTokens: parsed.usage.cacheReadTokens ?? 0,
  }
  // 0.10.0：缓存写 token（Anthropic 官方单独计价；其余厂商无写价概念时按 0，零回归）。
  // 仅用于 cost 折算，不入 UsageEntry.usage（保持 0.9.0 形状与显示口径）。
  const usageForCost = {
    ...usage,
    cacheWriteTokens: parsed.usage.cacheWriteTokens ?? 0,
  }
  // 峰谷选带：事件本地时刻；无时段配置归 BASE_BAND
  const tzOffsetMin = bandCtx?.tzOffsetMin ?? 0
  const bands = bandCtx?.bands ?? []
  // 用户显式配置的时段始终优先（官方引擎不越过用户自定义计费规则）
  const official = bandCtx?.official
  let band: string
  let price: ModelPrice
  if (bands.length > 0) {
    band = bandIdForEpoch(bands, parsed.time, tzOffsetMin)
    const bandTable: BandPriceTable = prebuiltBandTable ?? buildBandPriceTable(bands)
    price = priceForAt(routes, bandTable, route, band).price
  } else if (official?.enabled === true) {
    // 官方峰谷自动挂载：无用户时段时按官方规则选带（'peak' / 'idle'）；
    // 0.11.0 band 按模型峰谷策略判定（dsn-peak=DeepSeek 官方、baichuan-tier=百川每日 0-8/8-24、flat 恒定价）
    band = officialBandForEpochOf(route.model, parsed.time, tzOffsetMin, official.holidays)
    const resolved = officialEntryPrice(official.overrides, route, band as CacheBand, routes)
    price = resolved.price
  } else {
    band = BASE_BAND
    price = priceFor(routes, route).price
  }
  return {
    time: parsed.time,
    route,
    usage,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: parsed.usage.reasoningTokens ?? 0,
    cost: computeCost(price, usageForCost),
    credits: computeCredits(price, usage),
    totalTokens: billedTokens(usage),
    band,
  }
}

export interface MeterSink {
  record(entry: UsageEntry, sessionId?: string): void
  /** 日/月窗口。 */
  recordWindow(entry: UsageEntry): void
}

/** 订阅宿主事件的计量管道（inject 由插件入口决定）。 */
export function attachSessionMeter(
  ctx: Context,
  sink: MeterSink,
  routes: PricingTable,
  fallbackRoute: { provider: string; model: string },
  bandCtx?: BandPricingContext,
): () => void {
  // 带覆盖表在装配层构建一次，事件流中复用（避免每次事件重复分配）。
  const prebuiltBandTable: BandPriceTable = buildBandPriceTable(bandCtx?.bands ?? [])
  const logger = ctx.logger('cost-guard')
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      const parsed = parseSessionEvent({ ...event, sessionId: String(session.id) })
      const entry = toUsageEntry(parsed, routes, fallbackRoute, bandCtx, prebuiltBandTable)
      if (!entry) return
      sink.record(entry, parsed.sessionId)
      sink.recordWindow(entry)
    } catch (err) {
      // 计量是旁路能力：宿主事件链中的异常不得反噬会话主流程。
      // 记录并跳过本条事件（fail-safe），不吞错也不抛给宿主。
      logger.warn(`[cost-guard] 计量事件处理失败，已跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  })
  return () => {
    /* ctx.on 在插件卸载时自动回收 */
  }
}

/** 便捷工厂：直接绑定 Meter + WindowMeter。 */
export function attachMeters(
  ctx: Context,
  meter: Meter,
  windows: WindowMeter,
  routes: PricingTable,
  fallbackRoute: { provider: string; model: string },
  bandCtx?: BandPricingContext,
  /** 入账后的采样钩子（0.4.0：喂给预测/异常引擎），入账后调用。 */
  sampler?: (entry: UsageEntry, sessionId?: string) => void,
): () => void {
  return attachSessionMeter(
    ctx,
    {
      record: (entry, sessionId) => {
        meter.record(entry, sessionId)
        sampler?.(entry, sessionId)
      },
      recordWindow: (entry) => {
        windows.record(entry)
      },
    },
    routes,
    fallbackRoute,
    bandCtx,
  )
}