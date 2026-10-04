/**
 * @module dsh-cost-guard/core/clock
 * 时间分桶：把 epoch ms 映射到 会话无关的『日』『月』键，用于日 / 月预算。
 * 使用注入的时区偏移（分钟），默认为东八区（+480），不依赖宿主 TZ。
 */

/** 东八区偏移（分钟）。 */
export const DEFAULT_TZ_OFFSET_MIN = 480

export interface ClockLike {
  /** 当前 epoch ms。 */
  now(): number
  /** 时区偏移（分钟，UTC+8 = 480）。 */
  tzOffsetMin: number
}

export class SystemClock implements ClockLike {
  constructor(public readonly tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN) {}
  now(): number {
    return Date.now()
  }
}

/** 可注入的固定时钟（测试与冒烟使用）。 */
export class FixedClock implements ClockLike {
  constructor(
    public nowValue: number,
    public readonly tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN,
  ) {}
  now(): number {
    return this.nowValue
  }
  set(value: number): void {
    this.nowValue = value
  }
}

/**
 * epoch ms -> 本时区日历日键 'YYYY-MM-DD'。
 */
export function dayKey(ms: number, tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN): string {
  const shifted = new Date(ms + tzOffsetMin * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * epoch ms -> 本时区月份键 'YYYY-MM'。
 */
export function monthKey(ms: number, tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN): string {
  const shifted = new Date(ms + tzOffsetMin * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/**
 * 今日结束时刻（epoch ms）：本时区下一个 00:00 的瞬间。
 * 用于预测引擎的「今日结束」目标时刻。
 */
export function endOfDayEpoch(ms: number, tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN): number {
  const shifted = new Date(ms + tzOffsetMin * 60_000)
  const nextLocalMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1)
  return nextLocalMidnight - tzOffsetMin * 60_000
}

/**
 * 本月结束时刻（epoch ms）：本时区下一个月的 00:00 的瞬间。
 * 用于预测引擎的「月末」目标时刻。
 */
export function endOfMonthEpoch(ms: number, tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN): number {
  const shifted = new Date(ms + tzOffsetMin * 60_000)
  const nextLocalMonth = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1)
  return nextLocalMonth - tzOffsetMin * 60_000
}

/** 本月剩余自然日数（含今天，最少 1 天）。 */
export function daysLeftInMonth(ms: number, tzOffsetMin: number = DEFAULT_TZ_OFFSET_MIN): number {
  const end = endOfMonthEpoch(ms, tzOffsetMin)
  const days = Math.ceil((end - ms) / 86_400_000)
  return Math.max(1, days)
}