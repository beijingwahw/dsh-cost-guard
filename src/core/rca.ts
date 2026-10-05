/**
 * @module dsh-cost-guard/core/rca
 * 成本根因分析器（Cost Root-Cause Analyzer，0.14.0，零 DSH 依赖）。
 *
 * 行业缺口（Snowflake 官方博客原文）：
 *   "knowing that an anomaly occurred is only half the battle.
 *    Understanding why the anomaly happened is the other half."
 * 市面成本方案（LiteLLM / C1.ai / Azure / Snowflake）止步于「检测 + 归因」，
 * 只回答「花了多少、谁花的、超没超」，从不回答「为什么花这么多、证据是什么、
 * 下一步怎么办」。本模块把「检测出超支 / 尖峰」升级为「证据化根因」：
 *
 *   - 双视角归因：按会话（任务视角：哪个任务在烧钱）与按路由（模型视角：
 *     哪个模型在烧钱）分别做增量贡献分解——同一笔成本落在会话与路由两个
 *     独立视图，互不叠加、各自完整，回答两个不同问题。
 *   - 增量贡献分解：与可选基线（前一时段 / 期初快照）对比，逐因子归因
 *     Δ 成本；无基线时退化为存量构成归因（当前占比）。
 *   - 因子分级：主因（primary）/ 次因（secondary）逐因子列出，
 *     其余合并为噪声（noise：个数 + 合计，避免长尾刷屏）。
 *   - 通道构成：输入 / 缓存命中 / 输出 token 占比（可优化面提示，
 *     只基于桶内 token 事实，不做金额虚构）。
 *
 * 纯函数、无副作用、JSON 安全（除零保护），可在任意宿主复用与单测。
 */

import type { UsageBucket } from './types.js'
import { emptyBucket } from './types.js'

/** 归因维度（0.16.0 增加 'tenant'：多租户成本解释视图的租户间归因）。 */
export type RcaFactorKind = 'session' | 'route' | 'tenant'

/** 因子级别：主因 / 次因 / 噪声（合并说明）。 */
export type RcaGrade = 'primary' | 'secondary' | 'noise'

/** 单一归因因子。 */
export interface RcaFactor {
  /** 归因维度。 */
  kind: RcaFactorKind
  /** 因子标识：会话 id 或路由键。 */
  key: string
  /** 当前成本（金额）。 */
  cost: number
  /** 当前成本占比（0~1；总额为 0 时为 0）。 */
  share: number
  /** Δ 成本 = 当前 - 基线；无基线或缺失时与 cost 同号（存量归因）。 */
  delta: number
  /** 增量贡献占比（有符号）：delta / Σ|delta|；无基线时与 share 一致。 */
  deltaShare: number
  /** 归因级别。 */
  grade: RcaGrade
}

/** 一个维度（会话或路由）的归因视图。 */
export interface RcaFactorView {
  /** 全部因子，按 |deltaShare| 降序、同值时按 cost 降序。 */
  factors: RcaFactor[]
  /** 主因（primary 级，按 |deltaShare| 降序）。 */
  primary: RcaFactor[]
  /** 次因（secondary 级，按 |deltaShare| 降序）。 */
  secondary: RcaFactor[]
  /** 噪声合并说明（remaining 因子合计）。 */
  noise: { count: number; cost: number; deltaShare: number }
  /** 主导因子：贡献占比最大者（可能为 undefined，当无构成数据时）。 */
  dominant: RcaFactor | undefined
}

/** 通道构成（token 事实，不做金额虚构）。 */
export interface RcaChannelMix {
  /** 输入（未命中）token。 */
  inputTokens: number
  /** 缓存命中输入 token。 */
  cacheReadTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 计费总 token。 */
  totalTokens: number
  /** 输入 token 占比（0~1）。 */
  inputShare: number
  /** 缓存命中 token 占比（0~1）。 */
  cacheReadShare: number
  /** 输出 token 占比（0~1）。 */
  outputShare: number
}

/** 成本根因报表。 */
export interface RootCauseReport {
  /** 归因窗口：'current' = 存量构成归因；'delta' = 与基线增量归因。 */
  window: 'current' | 'delta'
  /** 会话视角总额（口径：全部会话成本合计；总额为 0 时回退路由视角）。 */
  totalCost: number
  /** 基线总额（无基线时为 0）。 */
  baselineTotalCost: number
  /** Δ 成本 = 当前总额 - 基线总额（无基线时为 0）。 */
  deltaCost: number
  /** 变化比例 = Δ / 基线总额（基线为 0 时为 0）。 */
  deltaRatio: number
  /** 会话（任务）视角归因。 */
  bySession: RcaFactorView
  /** 路由（模型）视角归因。 */
  byRoute: RcaFactorView
  /** 通道构成（token 占比提示）。 */
  channelMix: RcaChannelMix
  /** 一句话根因摘要（供叙事引用，事实驱动）。 */
  summary: string
}

/** 归因输入：当前会话桶与路由桶。 */
export interface RcaInput {
  sessions?: Record<string, UsageBucket>
  routes?: Record<string, UsageBucket>
}

export interface RcaOptions {
  /** 可选基线（前一时段 / 期初快照）；提供时做增量归因。 */
  baseline?: RcaInput
  /** 主因阈值：|deltaShare| 或 share ≥ 该值为主因（默认 0.3）。 */
  primaryThreshold?: number
  /** 次因阈值：≥ 该值为次因（默认 0.1）。 */
  secondaryThreshold?: number
  /** 每个维度最多保留的因子数，其余并入噪声（默认 8）。 */
  topN?: number
}

const DEFAULT_PRIMARY = 0.3
const DEFAULT_SECONDARY = 0.1
const DEFAULT_TOPN = 8

function bucketCost(b: UsageBucket | undefined): number {
  return b?.cost ?? 0
}

/**
 * 单视图增量贡献分解：
 * - 有基线：delta_i = cost_i - base_i，deltaShare_i = delta_i / Σ|delta|
 *   （Σ|delta| 为 0 时回退存量占比）；
 * - 无基线：delta = cost、deltaShare = share（存量构成归因）。
 * （0.16.0 起导出：多租户成本解释视图复用同一归因算法做租户间分解。）
 */
export function buildFactorView(
  kind: RcaFactorKind,
  current: Record<string, UsageBucket> | undefined,
  baseline: Record<string, UsageBucket> | undefined,
  totalCost: number,
  primaryThreshold: number,
  secondaryThreshold: number,
  topN: number,
): RcaFactorView {
  const cur = current ?? {}
  const base = baseline ?? {}
  const factorList: RcaFactor[] = []
  for (const [key, bucket] of Object.entries(cur)) {
    const cost = bucketCost(bucket)
    const baseCost = bucketCost(base[key])
    const delta = cost - baseCost
    factorList.push({
      kind,
      key,
      cost,
      share: totalCost > 0 ? cost / totalCost : 0,
      delta,
      deltaShare: 0, // 依赖归一，下方统一计算
      grade: 'noise',
    })
  }
  // 基线中存在、但当前已消失的因子（零成本回退），保留 Δ 信息
  if (base !== undefined) {
    for (const key of Object.keys(base)) {
      if (cur[key] !== undefined) continue
      const baseCost = bucketCost(base[key])
      if (baseCost <= 0) continue
      factorList.push({
        kind,
        key,
        cost: 0,
        share: 0,
        delta: -baseCost,
        deltaShare: 0,
        grade: 'noise',
      })
    }
  }

  // 按 |delta| 归一（Σ|delta| 为 0 时按存量占比）
  const absSum = factorList.reduce((s, f) => s + Math.abs(f.delta), 0)
  for (const f of factorList) {
    f.deltaShare = absSum > 0 ? f.delta / absSum : f.share
  }

  factorList.sort((a, b) => {
    const d = Math.abs(b.deltaShare) - Math.abs(a.deltaShare)
    if (d !== 0) return d
    return b.cost - a.cost
  })

  const kept = factorList.slice(0, topN)
  const rest = factorList.slice(topN)
  for (const f of kept) {
    const share = Math.abs(f.deltaShare)
    f.grade = share >= primaryThreshold ? 'primary' : share >= secondaryThreshold ? 'secondary' : 'noise'
  }
  const noiseCount = rest.length > 0 ? rest.length + kept.filter((f) => f.grade === 'noise').length : kept.filter((f) => f.grade === 'noise').length
  const noiseCost = (rest.length > 0 ? rest.reduce((s, f) => s + f.cost, 0) : 0) + kept.filter((f) => f.grade === 'noise').reduce((s, f) => s + f.cost, 0)
  const noiseDeltaShare = (rest.length > 0 ? rest.reduce((s, f) => s + f.deltaShare, 0) : 0) + kept.filter((f) => f.grade === 'noise').reduce((s, f) => s + f.deltaShare, 0)
  const primary = kept.filter((f) => f.grade === 'primary')
  const secondary = kept.filter((f) => f.grade === 'secondary')
  return {
    factors: kept,
    primary,
    secondary,
    noise: { count: noiseCount, cost: noiseCost, deltaShare: noiseDeltaShare },
    dominant: kept.length > 0 ? kept[0] : undefined,
  }
}

/** 通道构成（0.16.0 起导出：租户视图复用）。 */
export function buildChannelMix(
  sessions: Record<string, UsageBucket> | undefined,
  routes: Record<string, UsageBucket> | undefined,
): RcaChannelMix {
  const source = sessions !== undefined && Object.keys(sessions).length > 0 ? sessions : routes ?? {}
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const bucket of Object.values(source)) {
    inputTokens += bucket.inputTokens ?? 0
    cacheReadTokens += bucket.cacheReadTokens ?? 0
    outputTokens += bucket.outputTokens ?? 0
  }
  const totalTokens = inputTokens + cacheReadTokens + outputTokens
  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    inputShare: totalTokens > 0 ? inputTokens / totalTokens : 0,
    cacheReadShare: totalTokens > 0 ? cacheReadTokens / totalTokens : 0,
    outputShare: totalTokens > 0 ? outputTokens / totalTokens : 0,
  }
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function fmtCost(cost: number): string {
  return cost.toFixed(2)
}

/** 一句话根因摘要（事实驱动，无推测）。 */
function buildSummary(report: Omit<RootCauseReport, 'summary'>): string {
  const sessionDominant = report.bySession.dominant
  const routeDominant = report.byRoute.dominant
  if (report.window === 'delta') {
    const parts = [`较基线 ${fmtCost(report.baselineTotalCost)} 变化 ${fmtCost(report.deltaCost)}（${pct(report.deltaRatio)}）`]
    if (sessionDominant !== undefined) {
      parts.push(`会话视角主因「${sessionDominant.key}」贡献 ${pct(sessionDominant.deltaShare)}`)
    }
    if (routeDominant !== undefined) {
      parts.push(`路由视角主因「${routeDominant.key}」贡献 ${pct(routeDominant.deltaShare)}`)
    }
    return parts.join('；')
  }
  const parts = [`当前累计成本 ${fmtCost(report.totalCost)}`]
  if (sessionDominant !== undefined) {
    parts.push(`会话「${sessionDominant.key}」占 ${pct(sessionDominant.share)}`)
  }
  if (routeDominant !== undefined) {
    parts.push(`路由「${routeDominant.key}」占 ${pct(routeDominant.share)}`)
  }
  return parts.join('；')
}

/**
 * 成本根因分析（纯函数，不改入参）。
 * 输入当前会话/路由桶（与可选基线），输出会话、路由双视角归因报表。
 */
export function analyzeCostRca(input: RcaInput, opts: RcaOptions = {}): RootCauseReport {
  const baseline = opts.baseline
  const primaryThreshold = opts.primaryThreshold ?? DEFAULT_PRIMARY
  const secondaryThreshold = opts.secondaryThreshold ?? DEFAULT_SECONDARY
  const topN = opts.topN ?? DEFAULT_TOPN

  const sessions = input.sessions ?? {}
  const routes = input.routes ?? {}
  const baseSessions = baseline?.sessions ?? {}
  const baseRoutes = baseline?.routes ?? {}

  // 总额口径：会话视角合计；会话为空时回退路由视角
  const totalCost =
    Object.keys(sessions).length > 0
      ? Object.values(sessions).reduce((s, b) => s + bucketCost(b), 0)
      : Object.values(routes).reduce((s, b) => s + bucketCost(b), 0)
  const baselineTotalCost =
    Object.keys(baseSessions).length > 0
      ? Object.values(baseSessions).reduce((s, b) => s + bucketCost(b), 0)
      : Object.values(baseRoutes).reduce((s, b) => s + bucketCost(b), 0)
  const deltaCost = totalCost - baselineTotalCost
  const deltaRatio = baselineTotalCost > 0 ? deltaCost / baselineTotalCost : 0

  const bySession = buildFactorView('session', sessions, baseSessions, totalCost, primaryThreshold, secondaryThreshold, topN)
  const byRoute = buildFactorView('route', routes, baseRoutes, totalCost, primaryThreshold, secondaryThreshold, topN)
  const channelMix = buildChannelMix(sessions, routes)

  const window: 'current' | 'delta' = baseline !== undefined ? 'delta' : 'current'
  const base = { window, totalCost, baselineTotalCost, deltaCost, deltaRatio, bySession, byRoute, channelMix }
  return { ...base, summary: buildSummary(base) }
}

/** 便捷工厂：从两个空桶得到空归因输入（供调用方按需填充）。 */
export function emptyRcaInput(): Required<RcaInput> {
  return { sessions: {}, routes: {} }
}

/** 便捷工具：取桶（undefined 时返回空桶，供调用方读取金额/请求数）。 */
export function bucketOf(bucket: UsageBucket | undefined): UsageBucket {
  return bucket ?? emptyBucket()
}