/**
 * @module dsh-cost-guard/harness/adaptive
 * 自适应调节（0.5.0）的 harness 装配层：把 core 的自适应预算调节器（governor）
 * 与实时计量、预测上下文绑定，为预算决策提供「今日动态额度 + 动态水位 + 结转」。
 *
 * 职责：
 *   1. config：把插件配置（adaptive 节 + budgets.month 回退）归一化为 GovernorConfig。
 *   2. buildGovernorInput：从 meter/windows 读取本月、今日已花费，从 forecast 读取
 *      今日结束 / 月末投影，结合时钟（剩余天数）与上期结转，调用 core govern()。
 *
 * 全部输入可注入，冒烟与单测可确定性复现。
 */

import type { BudgetScope } from '../core/types.js'
import type { BudgetInput } from '../core/budget.js'
import { govern, type GovernorConfig } from '../core/governor.js'
import { daysLeftInMonth } from '../core/clock.js'
import type { Meter, WindowMeter } from '../core/meter.js'

/** 自适应调节配置（与插件 Config.adaptive 对齐，全部可选）。 */
export interface AdaptiveConfig {
  /** 月度预算上限（金额）；缺省回退 budgets.month.limit。 */
  monthLimit?: number
  /** 保守留存比例（0~1），默认 0.1。 */
  reserveRatio?: number
  /** 背压强度（0~1），默认 0.5。 */
  backpressure?: number
  /** 日额度下限比例（0~1），默认 0.3。 */
  floorRatio?: number
  /** 跨周期结转比例（0~1），默认 1。 */
  carryOverRatio?: number
}

/** 归一化为 GovernorConfig；monthLimit 未指定时回退给定值。 */
export function governorConfigFromAdaptive(
  cfg: AdaptiveConfig | undefined,
  fallbackMonthLimit: number,
): GovernorConfig | undefined {
  if (!cfg) return undefined
  return {
    monthLimit: cfg.monthLimit ?? fallbackMonthLimit,
    reserveRatio: cfg.reserveRatio ?? 0.1,
    backpressure: cfg.backpressure ?? 0.5,
    floorRatio: cfg.floorRatio ?? 0.3,
    carryOverRatio: cfg.carryOverRatio ?? 1,
  }
}

/** 自适应输入所需的运行时（全部可注入用于测试）。 */
export interface AdaptiveRuntime {
  meter: Meter
  windows: WindowMeter
  tzOffsetMin: number
  /** 上期结转额度（金额，默认 0）。 */
  carriedIn?: number
  /** 时钟（默认 Date.now）。 */
  now?: () => number
}

/**
 * 构造预算决策的 adaptive 输入：
 * - monthSpent/daySpent 来自 meter 与今日窗口；
 * - dayProjected/monthProjected 来自 forecast.projected（日终/月末投影）；
 * - carriedIn 来自运行时（跨周期结转）。
 * dayProjected 需与预测上下文口径一致：projected 键为 day/month。
 */
export function buildGovernorInput(
  cfg: GovernorConfig | undefined,
  runtime: AdaptiveRuntime,
  forecast?: BudgetInput['forecast'],
): BudgetInput['adaptive'] | undefined {
  if (!cfg) return undefined
  const now = runtime.now?.() ?? Date.now()
  const projected = forecast?.projected ?? {}
  const input = govern(cfg, {
    monthSpent: runtime.meter.spent('month').cost,
    daySpent: runtime.windows.today().cost,
    daysLeftInMonth: daysLeftInMonth(now, runtime.tzOffsetMin),
    carriedIn: runtime.carriedIn ?? 0,
    dayProjected: projected['day'],
    monthProjected: projected['month'],
  })
  return { governor: input }
}

// 标注 BudgetScope 作为投影键的类型参考（预检策略 scope 亦复用该类型）。
export type { BudgetScope }