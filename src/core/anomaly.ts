/**
 * @module dsh-cost-guard/core/anomaly
 * 成本异常检测（零 DSH 依赖）。
 *
 * 行业现状：异常成本往往在月结账单里才被发现。本模块提供两个事前能力：
 *   1. MAD（Median Absolute Deviation）成本尖峰检测：对『单请求成本』维护滑动
 *      窗口，用中位数稳健估计基准（对离群点不敏感），给出修正 z 分数，
 *      实时识别成本尖峰请求——请求发生后立即感知，而非事后对账。
 *   2. 请求级成本预检估算：在请求发出前用输入 token 与单价估算本次调用的
 *      最低 / 期望 / 上限成本，供预算决策在『花出去之前』判断是否放行。
 *
 * 纯 TS 实现，无外部依赖；异常分数为稳健统计量，抗单点污染。
 */

// ---------------------------------------------------------------------------
// MAD 尖峰检测
// ---------------------------------------------------------------------------

/** 当前窗口的稳健统计量。 */
export interface MadStats {
  median: number
  /** 原始 MAD（中位数绝对偏差）。 */
  mad: number
  n: number
}

/** 尖峰分级。 */
export type SpikeLevel = 'normal' | 'spike' | 'extreme'

/** 常数缩放系数：把 MAD 换算为与标准差同尺度（正态假设下）。 */
export const MAD_SCALE = 1.4826

/** 滑动窗口 MAD 检测器。 */
export class MadDetector {
  private readonly samples: number[] = []
  /** 最近一次成功记录的样本（供分类查询，无样本时为 undefined）。 */
  private lastSample: number | undefined = undefined

  constructor(
    /** 窗口容量（样本数），超限丢最旧。 */
    private readonly capacity = 100,
    /** 判定为 spike 的修正 z 分数阈值。 */
    private readonly zThreshold = 3,
  ) {}

  /** 记录一次请求成本；返回该样本的修正 z 分数（样本不足时返回 0）。 */
  push(cost: number): number {
    if (!Number.isFinite(cost) || cost < 0) return 0
    if (this.samples.length >= this.capacity) this.samples.shift()
    this.samples.push(cost)
    this.lastSample = cost
    return this.score(cost)
  }

  /** 最近一次记录的样本；无样本返回 undefined。 */
  last(): number | undefined {
    return this.lastSample
  }

  /** 最近一次样本的分级；window 样本不足或 MAD=0 时返回 normal。 */
  lastClassify(): SpikeLevel {
    if (this.lastSample === undefined) return 'normal'
    return this.classify(this.lastSample)
  }

  /** 对给定成本打分（基于当前窗口；样本 < 7 或 MAD 为 0 时返回 0 表示不可判）。 */
  score(cost: number): number {
    const stats = this.stats()
    if (!stats || stats.n < 7 || stats.mad === 0) return 0
    return Math.abs(cost - stats.median) / (MAD_SCALE * stats.mad)
  }

  /** 尖峰分级：extreme >= 2×zThreshold；spike >= zThreshold；其余 normal。 */
  classify(cost: number): SpikeLevel {
    const z = this.score(cost)
    if (z >= this.zThreshold * 2) return 'extreme'
    if (z >= this.zThreshold) return 'spike'
    return 'normal'
  }

  /** 当前窗口统计；样本不足 2 个时返回 undefined。 */
  stats(): MadStats | undefined {
    const n = this.samples.length
    if (n < 2) return undefined
    const sorted = [...this.samples].sort((a, b) => a - b)
    const median = medianOf(sorted)
    const devs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
    return { median, mad: medianOf(devs), n }
  }

  /** 清空窗口（如跨会话重置）。 */
  clear(): void {
    this.samples.length = 0
  }

  /** 窗口样本数。 */
  get size(): number {
    return this.samples.length
  }

  /** 窗口样本副本（只读用途，如成本分布统计）。 */
  window(): number[] {
    return [...this.samples]
  }
}

function medianOf(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  // n>=1 时 mid 必在界内；n>=2 时 mid-1 在界内。防御性取值避免索引未定义。
  const hiVal = sorted[mid] ?? 0
  if (n % 2 === 1) return hiVal
  const loVal = sorted[mid - 1] ?? 0
  return (loVal + hiVal) / 2
}

// ---------------------------------------------------------------------------
// 请求级成本预检估算
// ---------------------------------------------------------------------------

export interface RequestEstimate {
  /** 仅输入 token 的最低成本（输出为 0 的下界）。 */
  minCost: number
  /** 期望成本（输入 + 按 outputRatio 预估的输出）。 */
  expectedCost: number
  /** 上限成本（输入 + 按 maxOutputRatio 预估的输出）。 */
  ceilingCost: number
  /** 预估输出 token（输入 × outputRatio）。 */
  predictedOutputTokens: number
}

export interface RequestEstimateOptions {
  /** 期望输出 / 输入比（默认 0.5：输出约为输入一半）。 */
  outputRatio?: number
  /** 上限输出 / 输入比（默认 2：保守上界防失控）。 */
  maxOutputRatio?: number
}

/**
 * 请求前成本预检：用已知输入 token 与单价估算本次调用的成本区间。
 * 注意：这里只做『估算』而非『计费』——精确成本仍需 usage 事件结算，
 * 预检的价值在于把“会不会超预算”的判断从花完之后提前到花出去之前。
 */
export function estimateRequestCost(
  inputTokens: number,
  price: { inputPerMillion: number; outputPerMillion: number },
  opts: RequestEstimateOptions = {},
): RequestEstimate {
  const outputRatio = opts.outputRatio ?? 0.5
  const maxOutputRatio = opts.maxOutputRatio ?? 2
  const safeInput = Math.max(0, inputTokens)
  const inCost = (safeInput * price.inputPerMillion) / 1_000_000
  const predictedOutputTokens = safeInput * outputRatio
  const expectedCost = inCost + (predictedOutputTokens * price.outputPerMillion) / 1_000_000
  const ceilingCost = inCost + (safeInput * maxOutputRatio * price.outputPerMillion) / 1_000_000
  return { minCost: inCost, expectedCost, ceilingCost, predictedOutputTokens }
}

/**
 * 预检是否放行：若本次请求即使按最低成本也/或按期望成本就会导致预算越线，
 * 返回拦截理由；否则放行。返回 null 表示放行。
 * - 按最低成本判断：输入 token 已确定，最低成本是必然发生的支出。
 * - 按期望成本判断：把『预期开销』计入剩余预算，避免连串中等请求悄悄透支。
 */
export function preflightCheck(
  estimate: RequestEstimate,
  spent: number,
  limit: number,
  mode: 'min' | 'expected' = 'expected',
): string | null {
  if (limit <= 0) return null
  const cost = mode === 'min' ? estimate.minCost : estimate.expectedCost
  if (spent + cost > limit) {
    return `本次请求预计花费 ${cost.toFixed(4)}，将使 ${spent.toFixed(2)}/${limit.toFixed(2)} 预算越线，已预检拦截`
  }
  return null
}