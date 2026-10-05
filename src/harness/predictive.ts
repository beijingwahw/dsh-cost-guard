/**
 * @module dsh-cost-guard/harness/predictive
 * 预测式治理的 harness 装配层：把 core 的预测 / 异常引擎与实时计量
 * 绑定为「预测上下文」，供预算决策（forecast 输入）与成本工具（展示）使用。
 *
 * 职责：
 *   1. sampling：每次用量入账后，把「时刻 -> 累计成本」采样进 CostTrail，
 *      把单次请求成本送入 MadDetector —— 数据来源是真实事件流。
 *   2. context：从 trail + detector + 时钟构造 BudgetInput.forecast
 *      （到期投影 projected / 尖峰 spike / 请求预检 estimate）。
 *   3. estimate：从 pre-step 的消息与价表估算单次请求成本（请求发出前）。
 *
 * 全部行为可注入时钟与固定价格表，冒烟与单测可确定性复现。
 */

import type { BudgetScope } from '../core/types.js'
import type { BudgetInput } from '../core/budget.js'
import type { CostTrail } from '../core/trail.js'
import type { MadDetector, RequestEstimate } from '../core/anomaly.js'
import { buildForecast, type ForecastPoint } from '../core/forecast.js'
import { estimateRequestCost } from '../core/anomaly.js'
import { endOfDayEpoch, endOfMonthEpoch } from '../core/clock.js'
import type { Meter } from '../core/meter.js'
import type { PricingTable } from '../core/pricing.js'
import { priceFor } from '../core/pricing.js'
import type { UsageEntry } from '../core/types.js'

/** 到期投影的「目标时刻」解析：没有自然终点的 scope（total/session）由宿主显式给出。 */
export type ScopeTargetResolver = (scope: BudgetScope, now: number, tzOffsetMin: number) => number | undefined

/** 默认目标时刻：day -> 今日结束；month -> 月末；其余（total/session）无自然终点，不投影。 */
export const defaultTargetResolver: ScopeTargetResolver = (scope, now, tzOffsetMin) => {
  if (scope === 'day') return endOfDayEpoch(now, tzOffsetMin)
  if (scope === 'month') return endOfMonthEpoch(now, tzOffsetMin)
  return undefined
}

/** 预测上下文装配所需的运行时依赖（全部可注入，便于测试）。 */
export interface PredictiveRuntime {
  trail: CostTrail
  detector: MadDetector
  meter: Meter
  /** 价表（用于请求预检估算）。 */
  pricing: PricingTable
  fallbackRoute: { provider: string; model: string }
  tzOffsetMin: number
  /** 时钟（默认 Date.now）。 */
  now?: () => number
  /** scope -> 目标时刻解析（默认按 day/month 自然周期）。 */
  resolveTarget?: ScopeTargetResolver
  /** 请求预检的输出比（默认 0.5）。 */
  outputRatio?: number
}

/** 用量入账后的采样钩子：把真实事件流喂给预测 / 异常引擎。 */
export function sampleEntry(runtime: Pick<PredictiveRuntime, 'trail' | 'detector' | 'meter'>, entry: UsageEntry, sessionId?: string): void {
  const { trail, detector, meter } = runtime
  // 前置条件：meter 已入账该 entry；采样累计成本作为观测点
  trail.push('total', entry.time, meter.spent('total').cost)
  trail.push('day', entry.time, meter.spent('day').cost)
  trail.push('month', entry.time, meter.spent('month').cost)
  if (sessionId) trail.push('session', entry.time, meter.spent('session').cost)
  // 单次请求成本进入 MAD 尖峰检测窗口
  detector.push(entry.cost)
}

/** 从 trail 观测点构造预测模型输入。 */
function toForecastPoints(trail: CostTrail, scope: BudgetScope): ForecastPoint[] {
  return trail.points(scope).map((s) => ({ t: s.time, y: s.cost }))
}

/**
 * 构造预算决策的 forecast 输入：
 * - projected：对每个有观测轨迹且有目标时刻的 scope 外推到期成本；
 * - spike：最近一次请求的 MAD 分级（非 normal 才携带）；
 * - estimate：宿主在请求前估算的本次调用成本（可由 preStepEstimate 提供）。
 */
export function buildForecastContext(
  runtime: PredictiveRuntime,
  estimate?: RequestEstimate,
): NonNullable<BudgetInput['forecast']> {
  const now = runtime.now?.() ?? Date.now()
  const resolve = runtime.resolveTarget ?? defaultTargetResolver
  const projected: Partial<Record<BudgetScope, number>> = {}

  for (const scope of runtime.trail.scopes()) {
    const targetAt = resolve(scope, now, runtime.tzOffsetMin)
    if (targetAt === undefined || targetAt <= now) continue
    const points = toForecastPoints(runtime.trail, scope)
    if (points.length === 0) continue
    const fc = buildForecast({ points, targetAt, now })
    if (fc) projected[scope] = fc.expected
  }

  const ctx: NonNullable<BudgetInput['forecast']> = {}
  if (Object.keys(projected).length > 0) ctx.projected = projected
  const spikeLevel = runtime.detector.lastClassify()
  if (spikeLevel !== 'normal') ctx.spike = { level: spikeLevel }
  if (estimate) ctx.estimate = estimate
  return ctx
}

/** 从请求前的消息序列估算本次调用成本（字符数 → token 的启发式折算）。 */
export function preStepEstimate(
  messageChars: number,
  runtime: Pick<PredictiveRuntime, 'pricing' | 'fallbackRoute' | 'outputRatio'>,
): RequestEstimate | undefined {
  // 启发式：混合文本约 4 字符 / token；无文本时按最小输入 1 估算做兜底
  const chars = Math.max(0, messageChars)
  if (chars <= 0) return undefined
  const inputTokens = Math.max(1, Math.round(chars / 4))
  const { price } = priceFor(runtime.pricing, runtime.fallbackRoute)
  if (!price) return undefined
  return estimateRequestCost(inputTokens, price, runtime.outputRatio !== undefined ? { outputRatio: runtime.outputRatio } : {})
}