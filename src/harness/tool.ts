/**
 * @module dsh-cost-guard/harness/tool
 * 成本状态工具：把实时用量、峰谷时段与预算水位暴露给模型与用户。
 * - 注册 `cost_guard_status` 工具：Agent 可主动查询当前成本/预算状态（自感知成本）。
 * - 输出包含「话费（金额）」与「积分」两类独立消耗，以及峰谷时段的
 *   当前时段、生效单价与分带消耗分布（实时追踪）。
 * - 该工具为只读、零副作用、不摄入 prompt 大块内容。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Meter } from '../core/meter.js'
import type { WindowMeter } from '../core/meter.js'
import type { BudgetEvaluator } from '../core/budget.js'
import type { ModelPrice, TimeBand } from '../core/types.js'
import { BASE_BAND } from '../core/types.js'
import {
  formatCost,
  formatCredits,
  bandIdForEpoch,
  buildBandPriceTable,
  priceForAt,
  type BandPriceTable,
  type PricingTable,
} from '../core/pricing.js'
import type { CostTrail } from '../core/trail.js'
import type { MadDetector, SpikeLevel } from '../core/anomaly.js'
import { buildForecast } from '../core/forecast.js'
import { endOfDayEpoch, endOfMonthEpoch } from '../core/clock.js'
import { requestCostDistribution, routeEfficiency, estimateReplacement } from '../core/efficiency.js'
import type { GuardHandle } from './guard.js'
import { buildCachePanel, formatCacheLines } from './cache.js'
import type { CachePanelPayload } from './cache.js'

/** 单维度消耗：话费（金额）与积分独立。 */
export interface CostDimension {
  cost: number
  credits: number
  tokens: number
  requests: number
}

/** 峰谷时段实时状态。 */
export interface BandStatus {
  /** 当前命中时段 id；无时段配置或无命中时为 BASE_BAND。 */
  current: string
  /** 当前时段定义（id / start / end）；未配置时段或处于间隙时为 null。 */
  active: { id: string; start: string; end: string } | null
  /** 全部时段定义（供面板展示）。 */
  schedule: Array<{ id: string; start: string; end: string }>
  /** 当前时刻判定所依据的 epoch ms。 */
  at: number
}

export interface CostStatusPayload {
  total: CostDimension
  day: CostDimension
  month: CostDimension
  session: CostDimension
  guard: { action: string; triggers: Array<{ scope: string; spent: number; limit: number; ratio: number }> }
  routes: Record<string, CostDimension>
  /** 峰谷时段实时状态。 */
  band: BandStatus
  /** 当前时段内各模型生效单价（键为 'provider/model' 或 'model'）。 */
  activePrices: Record<string, ModelPrice>
  /** 全局累计按峰谷时段分布（bandId -> 消耗）。 */
  bandTotals: Record<string, CostDimension>
  /** 今日累计按峰谷时段分布（bandId -> 消耗）。 */
  todayBands: Record<string, CostDimension>
  /** 预测式治理状态（0.4.0；采样数据不足或未启用时为 null）。 */
  forecast: {
    /** 今日结束 / 本月底 的到期成本投影。 */
    projections: Record<string, { expected: number; lower: number; upper: number; confidence: number }>
    /** 最近一次请求的 MAD 尖峰级别。 */
    spike: SpikeLevel
    /** 预算决策中的预测式触发明细（预测告警/熔断原因）。 */
    predictive: Array<{ kind: string; scope?: string; level: string; detail: string }>
    /** 预测上下文采样到的观测点数量（total scope）。 */
    samples: number
  } | null
  /** 自适应调节状态（0.5.0；启用 adaptive 策略且注入 governor 时存在）。 */
  adaptive: {
    /** 应用动态水位的预算 scope。 */
    scope: string
    /** 今日动态可支配额度（金额）。 */
    dayAllowance: number
    /** 今日剩余可用（金额）。 */
    dayRemaining: number
    /** 背压因子（<=1：预测超支导致收紧；1：正常）。 */
    pressure: number
    /** 动态告警/阻断水位（比例）。 */
    warnAt: number
    hardAt: number
    /** 本月结束预测剩余（金额；负数 = 预测超支）。 */
    projectedMonthRemaining: number
    /** 下月可结转额度（金额）。 */
    carryOver: number
    /** 今日额度是否已耗尽。 */
    exhausted: boolean
    /** 成本感知提示：calm（从容）/ frugal（节约）/ minimal（最小化）。 */
    cue: string
  } | null
  /** 成本效率洞察（0.5.0）。 */
  efficiency: {
    /** 各路由每千输出 token 成本（质量-成本杠杆）。 */
    routes: Array<{ route: string; cost: number; costPerKOutput: number; costPerMTokens: number; requests: number }>
    /** 单请求成本分布（样本不足时 null）。 */
    distribution: { n: number; p50: number; p95: number; max: number; avg: number } | null
    /** 路由替代节约建议。 */
    replacement: Array<{ from: string; to: string; currentCost: number; replacementCost: number; saving: number; suggestion: string }>
  }
  /** 缓存维度计量（0.6.0；仅 cache.enabled=true 时存在，缺省 undefined = 零回归）。 */
  cache?: CachePanelPayload
}

/** buildCostStatus 的可选上下文：峰谷时段 + 基准价表 + 时区与时钟。 */
export interface BandStatusContext {
  /** 时段定义；为空时全部按 BASE_BAND（基准价）。 */
  bands?: TimeBand[]
  /** 基准价表（内置 + 用户 pricing 覆盖），用于计算当前时段各模型生效单价。 */
  baseline?: PricingTable
  /** 时区偏移（分钟）。 */
  tzOffsetMin?: number
  /** 时钟（可注入固定时间用于测试与预览），默认 Date.now。 */
  now?: () => number
  /** 预测式治理运行时（0.4.0；提供预测与尖峰展示）。 */
  predictive?: { trail: CostTrail; detector: MadDetector }
  /** 单请求成本样本（0.5.0；成本分布统计），提供 detector.window() 即可。 */
  costSamples?: { window: () => number[] }
  /** 缓存维度计量（0.6.0；仅 cache.enabled=true 时注入，缺省不输出缓存段）。 */
  cache?: { metrics: import('../core/cache-metrics.js').CacheMetrics; hint: import('../core/cache-hint.js').CacheHintDetector }
}

/** 构造路由查询对象：'provider/model' 或裸 'model'。 */
function routeFromKey(key: string): { provider: string; model: string } {
  const idx = key.indexOf('/')
  if (idx > 0 && idx < key.length - 1) {
    return { provider: key.slice(0, idx), model: key.slice(idx + 1) }
  }
  return { provider: 'deepseek', model: key }
}

/** 汇总状态（JSON 安全，供工具与面板共用）。 */
export function buildCostStatus(
  meter: Meter,
  windows: WindowMeter,
  evaluator: BudgetEvaluator,
  guard: GuardHandle,
  ctx?: BandStatusContext,
): CostStatusPayload {
  const total = meter.spent('total')
  const day = windows.today()
  const month = windows.thisMonth()
  const session = meter.spent('session')
  const snapshot = meter.snapshot()
  const dimension = (b: { cost: number; credits: number; totalTokens: number; requests: number }): CostDimension => ({
    cost: b.cost,
    credits: b.credits ?? 0,
    tokens: b.totalTokens,
    requests: b.requests,
  })
  const routes: CostStatusPayload['routes'] = {}
  for (const [k, b] of Object.entries(snapshot.routes)) {
    routes[k] = dimension(b)
  }
  const decision = guard.inspect()

  // 峰谷实时状态
  const bands = ctx?.bands ?? []
  const tzOffsetMin = ctx?.tzOffsetMin ?? 0
  const at = (ctx?.now ?? Date.now)()
  const bandId = bands.length > 0 ? bandIdForEpoch(bands, at, tzOffsetMin) : BASE_BAND
  const bandDef = bands.find((b) => b.id === bandId) ?? null
  const bandTable: BandPriceTable = buildBandPriceTable(bands)

  // 当前时段各模型生效单价：基准表键 ∪ 当前带覆盖键
  const priceKeys = new Set<string>()
  if (ctx?.baseline) for (const k of Object.keys(ctx.baseline)) priceKeys.add(k)
  const curBandPrices = bandTable[bandId]
  if (curBandPrices) for (const k of Object.keys(curBandPrices)) priceKeys.add(k)
  const activePrices: CostStatusPayload['activePrices'] = {}
  const baseline = ctx?.baseline ?? {}
  for (const k of priceKeys) {
    const { price } = priceForAt(baseline, bandTable, routeFromKey(k), bandId)
    // 仅展示有明确价格的键；未显式配置且命中兜底的键按兜底价展示也可（保守）。
    if (price) activePrices[k] = { ...price }
  }

  const bandTotals: CostStatusPayload['bandTotals'] = {}
  for (const [k, b] of Object.entries(meter.bandTotals())) {
    bandTotals[k] = dimension(b)
  }
  const todayBands: CostStatusPayload['todayBands'] = {}
  for (const [k, b] of Object.entries(windows.todayBands())) {
    todayBands[k] = dimension(b)
  }

  // —— 预测式治理展示（0.4.0）——
  const predictiveCtx = ctx?.predictive
  const predict = predictiveCtx
    ? ((): NonNullable<CostStatusPayload['forecast']> => {
        const projections: NonNullable<CostStatusPayload['forecast']>['projections'] = {}
        const trail = predictiveCtx.trail
        const nowMs = (ctx?.now ?? Date.now)()
        // 今日结束 / 月末 投影
        const targets: Array<{ scope: string; at: number }> = [
          { scope: 'day', at: endOfDayEpoch(nowMs, tzOffsetMin) },
          { scope: 'month', at: endOfMonthEpoch(nowMs, tzOffsetMin) },
        ]
        for (const t of targets) {
          if (t.at <= nowMs) continue
          const pts = trail.points(t.scope as 'day' | 'month').map((s) => ({ t: s.time, y: s.cost }))
          if (pts.length === 0) continue
          const fc = buildForecast({ points: pts, targetAt: t.at, now: nowMs })
          if (fc) {
            projections[t.scope] = {
              expected: fc.expected,
              lower: fc.lower,
              upper: fc.upper,
              confidence: fc.confidence,
            }
          }
        }
        const predictive = (decision.predictive ?? []).map((p) => ({
          kind: p.kind,
          scope: p.scope,
          level: p.level,
          detail: p.detail,
        }))
        return {
          projections,
          spike: predictiveCtx.detector.lastClassify(),
          predictive,
          samples: trail.points('total').length,
        }
      })()
    : null

  // —— 自适应调节展示（0.5.0）——
  const adaptive = decision.adaptive
    ? {
        scope: decision.adaptive.scope,
        dayAllowance: decision.adaptive.governor.dayAllowance,
        dayRemaining: decision.adaptive.governor.dayRemaining,
        pressure: decision.adaptive.governor.pressure,
        warnAt: decision.adaptive.governor.warnAt,
        hardAt: decision.adaptive.governor.hardAt,
        projectedMonthRemaining: decision.adaptive.governor.projectedMonthRemaining,
        carryOver: decision.adaptive.governor.carryOver,
        exhausted: decision.adaptive.governor.exhausted,
        cue: decision.adaptive.cue,
      }
    : null

  // —— 成本效率洞察（0.5.0）——
  const baselinePricing = ctx?.baseline ?? {}
  const effRoutes = routeEfficiency(snapshot.routes).map((r) => ({
    route: r.route,
    cost: r.cost,
    costPerKOutput: r.costPerKOutput,
    costPerMTokens: r.costPerMTokens,
    requests: r.requests,
  }))
  const dist = ctx?.costSamples ? requestCostDistribution(ctx.costSamples.window()) : undefined
  const replacement = estimateReplacement(snapshot.routes, baselinePricing).map((r) => ({
    from: r.from,
    to: r.to,
    currentCost: r.currentCost,
    replacementCost: r.replacementCost,
    saving: r.saving,
    suggestion: r.suggestion,
  }))
  const efficiency = {
    routes: effRoutes,
    distribution: dist ?? null,
    replacement,
  }

  // —— 缓存维度计量（0.6.0）——
  const cacheCtx = ctx?.cache
  const cache = cacheCtx ? buildCachePanel(cacheCtx.metrics, cacheCtx.hint) : undefined

  return {
    total: dimension(total),
    day: dimension(day),
    month: dimension(month),
    session: dimension(session),
    guard: {
      action: decision.action,
      triggers: decision.triggers.map((t) => ({ scope: t.scope, spent: t.spent, limit: t.limit, ratio: t.ratio })),
    },
    routes,
    band: {
      current: bandId,
      active: bandDef ? { id: bandDef.id, start: bandDef.start, end: bandDef.end } : null,
      schedule: bands.map((b) => ({ id: b.id, start: b.start, end: b.end })),
      at,
    },
    activePrices,
    bandTotals,
    todayBands,
    forecast: predict,
    adaptive,
    efficiency,
    cache,
  }
}

/** 注册只读成本工具。 */
export function attachCostTool(
  ctx: Context,
  meter: Meter,
  windows: WindowMeter,
  evaluator: BudgetEvaluator,
  guard: GuardHandle,
  bandCtx?: BandStatusContext,
): void {
  ctx.tools.register(
    defineTool({
      name: 'cost_guard_status',
      description:
        '读取当前 DeepSeek Harness 的 Token 用量、峰谷时段与成本预算水位（只读）。' +
        '包含 total/day/month/session 四个维度的花费（金额）与积分消耗、预算熔断状态、' +
        '按模型路由的拆分、当前峰谷时段（band）与生效单价、以及全局/今日的分带消耗分布。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(): Promise<Record<string, JsonValue>> {
        // 状态快照本身是纯 JSON 结构，这里显式投影为 JSON 记录以满足工具 schema 契约。
        return buildCostStatus(meter, windows, evaluator, guard, bandCtx) as unknown as Record<string, JsonValue>
      },
    }),
  )
}

/** 人读摘要（面板与日志共用）：话费、积分与峰谷实时状态分行呈现。 */
export function formatStatusSummary(status: CostStatusPayload): string {
  const lines = [
    `cost-guard 总花费 ${formatCost(status.total.cost)} · 总积分 ${formatCredits(status.total.credits)} (${status.total.tokens.toLocaleString()} tokens, ${status.total.requests} 次调用)`,
    `  今日 ${formatCost(status.day.cost)} / 积分 ${formatCredits(status.day.credits)} · 本月 ${formatCost(status.month.cost)} / 积分 ${formatCredits(status.month.credits)} · 本会话 ${formatCost(status.session.cost)} / 积分 ${formatCredits(status.session.credits)}`,
  ]
  // 峰谷时段实时追踪
  const band = status.band
  if (band) {
    lines.push(
      band.active
        ? `  当前时段: ${band.active.id} (${band.active.start}-${band.active.end})`
        : `  当前时段: 基准价${band.schedule.length > 0 ? `（未命中${band.schedule.map((b) => b.id).join('/')}）` : '（未配置峰谷）'}`,
    )
  }
  const todayBands = Object.entries(status.todayBands ?? {})
  if (todayBands.length > 0) {
    lines.push(
      `  今日分带: ${todayBands
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k} ${formatCost(v.cost)} / 积分 ${formatCredits(v.credits)}`)
        .join(' · ')}`,
    )
  }
  if (status.guard.action !== 'allow') {
    lines.push(
      `  预算状态: ${status.guard.action} — ${status.guard.triggers
        .map((t) => `${t.scope} ${Math.round(t.ratio * 100)}%(${formatCost(t.spent)}/${formatCost(t.limit)})`)
        .join(', ')}`,
    )
  }
  // 预测式治理展示（0.4.0）
  const fc = status.forecast
  if (fc && Object.keys(fc.projections).length > 0) {
    const proj = Object.entries(fc.projections)
      .map(([scope, v]) => `${scope === 'day' ? '今日结束' : '月末'} ~${formatCost(v.expected)}（置信 ${formatCost(v.lower)}..${formatCost(v.upper)}）`)
      .join(' · ')
    lines.push(`  预测: ${proj}`)
  }
  if (fc?.spike && fc.spike !== 'normal') {
    lines.push(`  尖峰: 最近请求成本异常 (${fc.spike})`)
  }
  if (fc && fc.predictive.length > 0) {
    for (const p of fc.predictive) {
      lines.push(`  预测式${p.level === 'hard' ? '熔断' : '告警'}: ${p.detail}`)
    }
  }
  // 自适应调节展示（0.5.0）
  const ad = status.adaptive
  if (ad) {
    const cueLabel = ad.cue === 'calm' ? '从容' : ad.cue === 'frugal' ? '节约' : '最小化'
    lines.push(
      `  自适应: ${cueLabel}（今日额度 ${formatCost(ad.dayAllowance)} / 剩余 ${formatCost(ad.dayRemaining)} · ` +
        `动态水位 ${Math.round(ad.warnAt * 100)}%/${Math.round(ad.hardAt * 100)}% · 背压 ${Math.round(ad.pressure * 100)}% · ` +
        `月末预测剩余 ${formatCost(ad.projectedMonthRemaining)} · 下月结转 ${formatCost(ad.carryOver)}）`,
    )
    if (ad.exhausted) lines.push(`  自适应: 今日额度已耗尽，请降低调用频率`)
  }
  // 成本效率洞察（0.5.0）
  const eff = status.efficiency
  if (eff) {
    if (eff.routes.length > 0) {
      const byPerK = [...eff.routes].sort((a, b) => b.costPerKOutput - a.costPerKOutput)
      const worst = byPerK[0]
      if (worst && worst.costPerKOutput > 0) {
        lines.push(`  效率: 每千输出 token 成本最高 ${worst.route} ${worst.costPerKOutput.toFixed(3)} 元（输出是质量杠杆）`)
      }
    }
    if (eff.distribution && eff.distribution.p95 > 0) {
      lines.push(
        `  分布: 单次请求成本 P50 ${formatCost(eff.distribution.p50)} · P95 ${formatCost(eff.distribution.p95)} · Max ${formatCost(eff.distribution.max)}（${eff.distribution.n} 次）`,
      )
    }
    for (const r of eff.replacement) {
      lines.push(r.suggestion)
    }
  }
  // 缓存维度计量（0.6.0；仅启用时输出）
  if (status.cache) {
    for (const line of formatCacheLines(status.cache)) lines.push(line)
  }
  const top = Object.entries(status.routes)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 3)
  if (top.length) {
    lines.push(`  主要路由: ${top.map(([k, v]) => `${k} ${formatCost(v.cost)} / 积分 ${formatCredits(v.credits)}`).join(' · ')}`)
  }
  return lines.join('\n')
}