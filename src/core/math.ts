/**
 * @module dsh-cost-guard/core/math
 * 数值与统计工具（零 DSH 依赖）：clamp、百分位等。
 */

/** 数值夹取到 [min, max]。 */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** 排序后的升序数组。 */
export function sortedAsc(values: number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

/** 百分位（0~100）：取排序数组中对应位置的值，线性插值。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0] ?? 0
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  // lo/hi 必在 [0, length-1] 内；防御性取值避免索引未定义（noUncheckedIndexedAccess）。
  const loVal = sorted[lo]
  const hiVal = sorted[hi]
  if (loVal === undefined || hiVal === undefined) return 0
  if (lo === hi) return loVal
  const frac = rank - lo
  return loVal + (hiVal - loVal) * frac
}