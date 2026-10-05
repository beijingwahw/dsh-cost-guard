/**
 * @module dsh-cost-guard/harness/frontier
 * 前沿套件（0.12.0，可选）DSH 适配层：把主计量出账事件路由给
 * FOCUS 兼容成本台账与 OpenTelemetry GenAI 语义遥测，并把单位经济学 /
 * 成本杠杆聚合为面板负载。
 *
 * 四能力全部可选、缺省关闭：
 * - focus：FOCUS 规范成本行（JSONL 可流出，供 FinOps 工具链消费）。
 * - otel：OTel GenAI SemConv span 记录（trace 关联会话，供可观测平台消费）。
 * - unitEconomy：会话级单位经济学与成本归属（Showback）。
 * - leverage：缓存折扣杠杆 + 输出杠杆（可执行优化行动项）。
 *
 * 兼容边界：frontier 配置未提供时本适配层整体不构造（undefined），
 * 事件流与状态输出与 0.11.0 完全一致（零回归）。
 */

import type { UsageEntry } from '../core/types.js'
import { FocusLedger, toFocusLine, type FocusUsageLine } from '../core/focus-ledger.js'
import { OtelLedger, toGenAiSpan, type GenAiSpan } from '../core/otel-genai.js'
import { buildUnitEconomics, type UnitEconomicsReport } from '../core/unit-economy.js'
import { buildCacheDiscountLevers, buildOutputLevers, type CacheDiscountLever, type OutputLever } from '../core/leverage.js'
import type { CacheMetrics } from '../core/cache-metrics.js'
import type { CachePricingEngine } from '../core/cache-pricing.js'
import { deepseekBandForEpoch } from '../core/cache-pricing.js'
import type { PricingTable } from '../core/pricing.js'
import type { UsageBucket } from '../core/types.js'

/** 前沿套件配置（源自插件 FrontierConfig，本项目内自持，避免循环 import）。 */
export interface FrontierConfigLike {
  /** FOCUS 兼容成本台账。 */
  focus?: {
    enabled: boolean
    /** JSONL 行流出回调（如写文件 / 转发）；缺省仅内存缓冲。 */
    sink?: (line: FocusUsageLine) => void
  }
  /** OTel GenAI 语义遥测。 */
  otel?: {
    enabled: boolean
    /** span 记录流出回调；缺省仅内存缓冲。 */
    sink?: (span: GenAiSpan) => void
  }
  /** 单位经济学与成本归属（会话级 Showback）。 */
  unitEconomy?: boolean
  /** 成本杠杆洞察（缓存折扣 / 输出）。 */
  leverage?: boolean
}

/** 前沿运行时：持有台账 / 遥测账本与开关，接收入账事件。 */
export class FrontierRuntime {
  /** FOCUS 账本（未启用时 undefined）。 */
  readonly focus: FocusLedger | undefined
  /** OTel 遥测账本（未启用时 undefined）。 */
  readonly otel: OtelLedger | undefined
  /** 单位经济学是否启用。 */
  readonly unitEconomy: boolean
  /** 杠杆洞察是否启用。 */
  readonly leverage: boolean
  private readonly currencyOf: (routeKey: string) => string

  constructor(config: FrontierConfigLike | undefined, opts: { currencyOf?: (routeKey: string) => string } = {}) {
    const cfg = config ?? {}
    this.currencyOf = opts.currencyOf ?? (() => 'CNY')
    if (cfg.focus?.enabled) this.focus = new FocusLedger(cfg.focus.sink !== undefined ? { sink: cfg.focus.sink } : {})
    if (cfg.otel?.enabled) this.otel = new OtelLedger(cfg.otel.sink !== undefined ? { sink: cfg.otel.sink } : {})
    this.unitEconomy = cfg.unitEconomy === true
    this.leverage = cfg.leverage === true
  }

  /** 是否启用了任何能力（未启用任何项时可整体省略构建）。 */
  get any(): boolean {
    return this.focus !== undefined || this.otel !== undefined || this.unitEconomy || this.leverage
  }

  /** 入账钩子：由主计量 sampler 调用，路由给台账与遥测。 */
  record(entry: UsageEntry, sessionId?: string): void {
    const routeKey = `${entry.route.provider}/${entry.route.model}`
    const tokens = {
      inputTokens: entry.usage.inputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      outputTokens: entry.usage.outputTokens,
      reasoningTokens: entry.reasoningTokens,
    }
    if (this.focus) {
      this.focus.append(
        toFocusLine(routeKey, entry, tokens, { currencyOf: this.currencyOf }),
      )
    }
    if (this.otel) {
      this.otel.append(toGenAiSpan(routeKey, entry, tokens, sessionId, { currencyOf: this.currencyOf }))
    }
  }

  /** 由计量快照 + 缓存账本 + 价表构建面板负载（未启用全部为空结构）。 */
  panel(
    snapshot: {
      sessions: Record<string, UsageBucket>
      routes: Record<string, UsageBucket>
    },
    baseline: PricingTable,
    cache?: { metrics: CacheMetrics; pricing: CachePricingEngine },
    tzOffsetMin = 0,
    now: () => number = Date.now,
  ): FrontierPanelPayload {
    const payload: FrontierPanelPayload = {}
    if (this.focus) {
      payload.focus = { enabled: true, rows: this.focus.count }
    }
    if (this.otel) {
      payload.otel = { enabled: true, spans: this.otel.count }
    }
    if (this.unitEconomy) {
      payload.unitEconomy = buildUnitEconomics(snapshot.sessions, snapshot.routes)
    }
    if (this.leverage) {
      const cacheLevers: CacheDiscountLever[] = []
      const outputLevers: OutputLever[] = []
      // 缓存杠杆：需启用缓存计量（命中拆分 + 三通道价）
      if (cache) {
        const band = deepseekBandForEpoch(now(), tzOffsetMin)
        const byRoute = cache.metrics.byScope('route')
        const inputs: Array<{ route: string; missPrice: number; hitPrice: number; hitTokens: number; missTokens: number }> = []
        for (const [route, summary] of Object.entries(byRoute)) {
          const price = cache.pricing.resolve(route, band)
          if (!price || price.inputMiss <= 0) continue
          inputs.push({
            route,
            missPrice: price.inputMiss,
            hitPrice: price.inputHit,
            hitTokens: summary.hitTotal,
            missTokens: Math.max(0, summary.inputTotal - summary.hitTotal),
          })
        }
        cacheLevers.push(...buildCacheDiscountLevers(inputs))
      }
      // 输出杠杆：价表覆盖的路由
      outputLevers.push(...buildOutputLevers(snapshot.routes, baseline))
      payload.leverage = { cache: cacheLevers, output: outputLevers }
    }
    return payload
  }
}

/** 前沿面板负载（并入 CostStatusPayload.frontier；未启用时为 undefined 零回归）。 */
export interface FrontierPanelPayload {
  /** FOCUS 台账（启用时存在）。 */
  focus?: { enabled: true; rows: number }
  /** OTel 遥测（启用时存在）。 */
  otel?: { enabled: true; spans: number }
  /** 单位经济学与成本归属（启用时存在）。 */
  unitEconomy?: UnitEconomicsReport
  /** 杠杆洞察（启用时存在）。 */
  leverage?: {
    /** 缓存折扣杠杆（按潜在再省比例降序；需缓存计量数据）。 */
    cache: CacheDiscountLever[]
    /** 输出杠杆（按可省金额降序）。 */
    output: OutputLever[]
  }
}

/** 人读前沿面板行。 */
export function formatFrontierLines(payload: FrontierPanelPayload): string[] {
  const lines: string[] = []
  if (payload.focus) {
    lines.push(`  前沿: FOCUS 成本台账已导出 ${payload.focus.rows} 行（FinOps 标准规格，JSONL 可流入任意 FinOps 工具）`)
  }
  if (payload.otel) {
    lines.push(`  前沿: OTel GenAI 遥测已输出 ${payload.otel.spans} 条 span（OpenTelemetry GenAI 语义，trace 关联会话）`)
  }
  if (payload.unitEconomy) {
    const u = payload.unitEconomy
    lines.push(
      `  单位经济学: 会话成本合计 ${u.totalCost > 0 ? u.totalCost.toFixed(4) : '0'} · ` +
        `每请求 ${u.costPerRequest.toFixed(6)} · 每百万 token ${u.costPerMTokens.toFixed(4)} · ` +
        `Top ${u.topSessions.length} 会话占比 ${u.totalCost > 0 ? ((u.topSessions.reduce((s, x) => s + x.cost, 0) / u.totalCost) * 100).toFixed(1) : 0}%`,
    )
    for (const s of u.topSessions) {
      lines.push(
        `   ｜ 成本归属 ${(s.share * 100).toFixed(1)}% · 会话 ${s.sessionId.slice(0, 24)} · ${s.cost.toFixed(4)} 元 / ${s.requests} 次 / ${s.tokens.toLocaleString()} tokens`,
      )
    }
  }
  if (payload.leverage) {
    const c = payload.leverage.cache[0]
    if (c) lines.push(`  缓存杠杆: ${c.action}`)
    const o = payload.leverage.output[0]
    if (o) lines.push(`  输出杠杆: ${o.action}`)
  }
  return lines
}