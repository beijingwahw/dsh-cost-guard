/**
 * @module dsh-cost-guard/core/forecast
 * 预测式成本治理引擎（零 DSH 依赖）。
 *
 * 行业现状：LLM 成本工具普遍停留在『事后治理』——先超支、后报告、再熔断。
 * 本模块把治理前移到『事前』：基于已发生的消费轨迹外推未来，回答
 * 三个关键问题：
 *   1. 照当前速度，今天 / 本月结束时会花多少？（轨迹预测 + 置信区间）
 *   2. 预算何时耗尽？（Time-to-Exhaustion 触顶预警）
 *   3. 剩余预算还能支撑多久？（辅助“要不要现在停”的决策）
 *
 * 模型选择（数据越充分越精确，自动降级保证任何数据量下都可预测）：
 *   - >= 2 个分布在不同时刻的观测点 -> 最小二乘线性趋势模型（残差标准误置信带，
 *     外推越远不确定性越大，置信带随外推距离线性展宽）。
 *   - 仅 1 个观测点 -> 固定速率模型（spent / elapsed × period）。
 *   - 0 观测 -> undefined（数据不足，不输出可能误导的预测）。
 *
 * 全部为纯函数 / 无副作用，便于单测与宿主复用。
 */

/** 一次观测：某时刻的累计成本。 */
export interface ForecastPoint {
  /** 观测时刻（epoch ms）。 */
  t: number
  /** 该时刻的累计成本（金额）。 */
  y: number
}

/** 最小二乘线性回归结果。 */
export interface LinearFit {
  /** 斜率（金额 / ms）。 */
  slope: number
  /** 截距（金额）。 */
  intercept: number
  /** 决定系数 R²（0~1，1 = 完美线性）。 */
  r2: number
  /** 残差标准误（金额）。 */
  se: number
  /** 参与拟合的样本数。 */
  n: number
}

/** 预测结果。 */
export interface CostForecast {
  /** 预测目标时刻（epoch ms）的预计成本。 */
  expected: number
  /** 置信下界（>= 0）。 */
  lower: number
  /** 置信上界。 */
  upper: number
  /** 采用模型：trend = 线性趋势；rate = 固定速率。 */
  model: 'trend' | 'rate'
  /** 可信度 0~1：数据越充分越接近 1。 */
  confidence: number
  /** 平均消耗速率（金额 / ms）。 */
  ratePerMs: number
}

/** 预算耗尽预测（Time-to-Exhaustion）。 */
export interface ExhaustionForecast {
  /** 预计耗尽时刻（epoch ms）。 */
  at: number
  /** 距当前剩余毫秒数。 */
  remainingMs: number
}

/** 线性回归：OLS 拟合 y = slope·t + intercept。样本不足返回 undefined。 */
export function linearRegression(points: ForecastPoint[]): LinearFit | undefined {
  const n = points.length
  if (n < 2) return undefined
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.t
    sy += p.y
  }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  for (const p of points) {
    sxx += (p.t - mx) ** 2
    sxy += (p.t - mx) * (p.y - my)
  }
  if (sxx === 0) return undefined
  const slope = sxy / sxx
  const intercept = my - slope * mx
  let sse = 0
  let sst = 0
  for (const p of points) {
    const err = p.y - (slope * p.t + intercept)
    sse += err * err
    sst += (p.y - my) ** 2
  }
  const se = n > 2 ? Math.sqrt(sse / (n - 2)) : sse > 0 ? Math.sqrt(sse / n) : 0
  const r2 = sst === 0 ? 1 : 1 - sse / sst
  return { slope, intercept, r2, se, n }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

export interface ForecastOptions {
  /** 观测点（按时间升序或乱序均可，内部排序）。 */
  points: ForecastPoint[]
  /** 预测目标时刻（epoch ms）：如 今日结束 / 月末。 */
  targetAt: number
  /** 当前时刻（epoch ms）。 */
  now: number
  /** 置信系数（乘残差标准误），默认 1.0（约 ±1σ）。 */
  z?: number
  /** 单点模型用于估计不确定性的观测跨度（ms），默认 5 分钟。 */
  singlePointSpanMs?: number
}

/**
 * 统一预测入口：根据可用数据自动选择趋势 / 速率模型。
 * - 观测点不足或目标时刻已过 -> undefined。
 */
export function buildForecast(opts: ForecastOptions): CostForecast | undefined {
  const { points, targetAt, now, z = 1, singlePointSpanMs = 5 * 60_000 } = opts
  if (points.length === 0 || targetAt <= now) return undefined
  const sorted = [...points].sort((a, b) => a.t - b.t)
  if (sorted.length === 0) return undefined
  const firstPoint = sorted[0]!
  const lastPoint = sorted[sorted.length - 1]!

  // —— 线性趋势模型（>=2 个分布在不同时刻的观测点）——
  const fit =
    sorted.length >= 2 && lastPoint.t > firstPoint.t ? linearRegression(sorted) : undefined
  if (fit) {
    const expected = Math.max(0, fit.slope * targetAt + fit.intercept)
    // 外推不确定性 = 拟合残差标准误 + 外推距离线性展宽（越远越不确定）
    const horizon = targetAt - now
    const band = z * (fit.se + Math.abs(fit.slope) * horizon * 0.25)
    const confidence = clamp01(
      0.5 + fit.r2 * 0.4 + Math.min(1, sorted.length / 20) * 0.1,
    )
    return {
      expected,
      lower: Math.max(0, expected - band),
      upper: expected + band,
      model: 'trend',
      confidence,
      ratePerMs: fit.slope,
    }
  }

  // —— 固定速率模型（单观测点：spent / elapsed × period）——
  if (lastPoint.t <= now) {
    const elapsed = Math.max(1, now - lastPoint.t)
    const ratePerMs = lastPoint.y / elapsed
    const horizon = targetAt - lastPoint.t
    const expected = Math.max(0, lastPoint.y + ratePerMs * horizon)
    // 观测跨度越短，速率估计越不可靠 -> 置信带越宽
    const span = sorted.length === 1 ? singlePointSpanMs : lastPoint.t - firstPoint.t
    const uncertRatio = clamp01((span > 0 ? singlePointSpanMs / span : 1) * 0.5)
    const band = Math.max(z * Math.sqrt(Math.max(0, expected)), expected * uncertRatio)
    const confidence = clamp01(0.3 + 0.4 * Math.min(1, span / Math.max(1, singlePointSpanMs * 12)))
    return {
      expected,
      lower: Math.max(0, expected - band),
      upper: expected + band,
      model: 'rate',
      confidence,
      ratePerMs,
    }
  }
  return undefined
}

/**
 * Time-to-Exhaustion：按当前速率计算预算耗尽时刻。
 * - limit 未配置 / 速率非正 / 已超限 -> null（不输出误导性预警）。
 */
export function exhaustAt(spent: number, limit: number, ratePerMs: number, now: number): ExhaustionForecast | null {
  if (limit <= 0 || spent <= 0 || ratePerMs <= 0 || spent >= limit) return null
  const remainingMs = (limit - spent) / ratePerMs
  return { at: now + remainingMs, remainingMs }
}

/** 人读剩余时长：`3 小时 12 分钟` / `45 分钟` / `2 天 5 小时`。 */
export function formatRemaining(ms: number): string {
  const totalMin = Math.max(0, Math.ceil((ms || 0) / 60_000))
  if (totalMin < 60) return `${totalMin} 分钟`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  return m > 0 ? `${d} 天 ${h % 24} 小时 ${m} 分钟` : `${d} 天 ${h % 24} 小时`
}

/** 人读金额：与 pricing.formatCost 一致，避免模块间依赖。 */
export function formatForecastCost(cost: number): string {
  return cost >= 100 ? cost.toFixed(2) : cost >= 1 ? cost.toFixed(3) : cost.toFixed(4)
}