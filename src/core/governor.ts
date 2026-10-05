/**
 * @module dsh-cost-guard/core/governor
 * 自适应预算调节器（Adaptive Budget Governor，0.5.0，零 DSH 依赖）。
 *
 * 行业现状：所有成本插件的预算都是『静态配额』——月初定死一个数字，
 * 要么月初猛花月底干瞪眼，要么全程限死浪费冗余。本模块把预算从静态配额
 * 升级为『自适应调节』，纯函数完成三件事：
 *
 *   1. 月度 → 日额度动态派生（Derivation）：
 *      给定月预算、月内已花费与剩余天数，按剩余可用预算 / 剩余天数
 *      动态算出『今天还能花多少』，无需逐日手配。
 *
 *   2. 消费速率背压动态水位（Backpressure）：
 *      喂入预测引擎的『今日结束 / 月末结束』预测成本，若预测超支，
 *      按超支比例自动收紧今日额度与告警/阻断水位（背压）；
 *      预测低于预算时适度放开，实现『花得快就紧，花得稳就松』。
 *
 *   3. 跨周期结转（Carry-over）：
 *      本月未用完的预算按可配置比例结转到下月（次月可用池），
 *      让『上个月省下来的』变成『这个月可以用』，而不是被清零浪费。
 *
 * 全部为纯函数：输入快照 + 配置 → 输出调节指令，无副作用，便于单测。
 */

import { clamp } from './math.js'

// —— 动态水位缩放参数（背压 0..1 -> 水位在 [基线, 默认] 内线性上移）——
/** 告警水位缩放基线：背压=0（无压力）时告警水位 = 默认告警水位 × 0.75。 */
const GOVERNOR_WARN_BASE = 0.75
/** 阻断水位缩放基线：背压=0 时阻断水位 = 默认阻断水位 × 0.85。 */
const GOVERNOR_HARD_BASE = 0.85
/** 默认阻断水位（无缩放时的上限基准 1.0）。 */
const GOVERNOR_BLOCK_DEFAULT = 1
/** 默认告警水位（无缩放时的上限基准 0.8）。 */
const GOVERNOR_WARN_DEFAULT = 0.8
/** 动态告警水位下限（收紧不越过该值，保持常态告警语义）。 */
const GOVERNOR_WARN_MIN = 0.4
/** 动态阻断水位下限（收紧不越过该值，保持常态阻断语义）。 */
const GOVERNOR_HARD_MIN = 0.6

/** 自适应调节器配置。 */
export interface GovernorConfig {
  /** 月度预算上限（金额）。 */
  monthLimit: number
  /** 保守留存比例（0~1）：日额度派生时预留的缓冲，默认 0.1（只敢动用 90%）。 */
  reserveRatio: number
  /** 背压强度（0~1）：预测超支时收紧的力度，默认 0.5。 */
  backpressure: number
  /** 日额度下限比例（相对于日均可用），默认 0.3（无论如何保留 30% 兜底）。 */
  floorRatio: number
  /** 跨周期结转比例（0~1）：上月未用完中可结转的比例，默认 1。 */
  carryOverRatio: number
}

export const defaultGovernorConfig: GovernorConfig = {
  monthLimit: 0,
  reserveRatio: 0.1,
  backpressure: 0.5,
  floorRatio: 0.3,
  carryOverRatio: 1,
}

/** 调节器输入快照（当前会计状态 + 预测事实）。 */
export interface GovernorInput {
  /** 本月已花费（金额）。 */
  monthSpent: number
  /** 今日已花费（金额）。 */
  daySpent: number
  /** 本月剩余自然日数（含今天，>=1）。 */
  daysLeftInMonth: number
  /** 上月末结转到本月的可用额度（金额，默认 0）。 */
  carriedIn: number
  /** 今日结束时预测成本（金额，可选）。 */
  dayProjected?: number
  /** 月末结束时预测成本（金额，可选）。 */
  monthProjected?: number
}

/** 调节结果：今日动态额度 + 动态水位 + 结转。 */
export interface GovernorOutput {
  /** 今日动态可用额度（金额；<=0 表示今日已无额度）。 */
  dayAllowance: number
  /** 今日剩余可用（金额）。 */
  dayRemaining: number
  /** 背压因子（<=1：预测超支导致收紧；1：正常）。 */
  pressure: number
  /** 动态告警水位（比例，0~1）。 */
  warnAt: number
  /** 动态阻断水位（比例，0~1）。 */
  hardAt: number
  /** 本月结束预测剩余（金额；负数 = 预测超支）。 */
  projectedMonthRemaining: number
  /** 下月可结转额度（金额）。 */
  carryOver: number
  /** 是否处于今日熔断态（今日额度已耗尽）。 */
  exhausted: boolean
}

/** 有限非负归一化（NaN/Infinity/负值按 0 处理，防止污染调节结果）。 */
function nonNeg(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** 由输入快照计算自适应调节结果（纯函数）。 */
export function govern(config: GovernorConfig, input: GovernorInput): GovernorOutput {
  const cfg: GovernorConfig = { ...defaultGovernorConfig, ...config }
  const daysLeft = Math.max(1, nonNeg(input.daysLeftInMonth))
  const monthSpent = nonNeg(input.monthSpent)
  const daySpent = nonNeg(input.daySpent)
  const carriedIn = nonNeg(input.carriedIn)
  const dayProjected = input.dayProjected === undefined ? undefined : nonNeg(input.dayProjected)
  const monthProjected = input.monthProjected === undefined ? undefined : nonNeg(input.monthProjected)
  const monthLimit = nonNeg(cfg.monthLimit)

  // 1) 月度可用池：月预算 + 上期结转 - 本月已花
  const monthAvailable = Math.max(0, monthLimit + carriedIn - monthSpent)
  // 预留缓冲后，分配给剩余天数的日均可用
  const dailyBase = daysLeft > 0 ? (monthAvailable * (1 - cfg.reserveRatio)) / daysLeft : 0

  // 2) 背压：预测超支时收紧
  let pressure = 1
  if (dayProjected !== undefined && dayProjected > 0) {
    const dayOk = dailyBase > 0 ? dailyBase / dayProjected : 0
    if (dayOk < 1) pressure = Math.min(pressure, 1 - (1 - dayOk) * cfg.backpressure)
  }
  if (monthProjected !== undefined && monthProjected > 0) {
    const monthOk = monthLimit + carriedIn > 0
      ? (monthLimit + carriedIn) / monthProjected
      : 0
    if (monthOk < 1) {
      const monthPressure = 1 - (1 - monthOk) * cfg.backpressure
      pressure = Math.min(pressure, monthPressure)
    }
  }
  pressure = clamp(pressure, 0, 1)

  // 3) 今日动态额度：日均可用 × 背压，且不低于下限（有剩余时）
  const floor = dailyBase * cfg.floorRatio
  const dayAllowanceRaw = dailyBase * pressure
  const dayAllowance = monthAvailable > 0 ? Math.max(floor, dayAllowanceRaw, 0) : 0
  // 0.5.0 语义：日额度不用于『超过日上限即熔断』——日预算仍有独立 hardAt，
  // 此处动态额度驱动的是水位缩放与展示；今日可用不足时标记 exhausted。
  const dayRemaining = Math.max(0, dayAllowance - daySpent)
  const exhausted = dayAllowance > 0 && daySpent >= dayAllowance

  // 4) 动态水位：背压越强，告警/阻断越提前
  //    缩放公式：基线 + (1-基线) × pressure，随背压从 [基线, 1] 线性上移
  const warnScale = GOVERNOR_WARN_BASE + (1 - GOVERNOR_WARN_BASE) * pressure
  const hardScale = GOVERNOR_HARD_BASE + (1 - GOVERNOR_HARD_BASE) * pressure
  const warnAt = clamp(GOVERNOR_WARN_DEFAULT * warnScale, GOVERNOR_WARN_MIN, GOVERNOR_WARN_DEFAULT)
  const hardAt = clamp(GOVERNOR_BLOCK_DEFAULT * hardScale, GOVERNOR_HARD_MIN, GOVERNOR_BLOCK_DEFAULT)

  // 5) 结转与月末预测
  const monthProjectedFinal = monthProjected ?? monthSpent
  const projectedMonthRemaining = monthLimit + carriedIn - monthProjectedFinal
  const carryOver = Math.max(0, projectedMonthRemaining) * cfg.carryOverRatio

  return { dayAllowance, dayRemaining, pressure, warnAt, hardAt, projectedMonthRemaining, carryOver, exhausted }
}