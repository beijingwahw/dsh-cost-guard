/**
 * @module dsh-cost-guard/core/tenant
 * 多租户成本解释视图（Multi-Tenant Cost Explanation View，0.16.0，零 DSH 依赖）。
 *
 * 行业缺口：市面成本方案（LiteLLM / C1.ai / Azure / Snowflake）的成本归因
 * 止步于「会话 / 路由」两个记账维度——会话是任务视角、路由是模型视角，
 * 都没有回答企业最关心的第三问：「钱是哪个团队 / 项目 / 工作区花的」。DeepSeek
 * Harness 常被多个租户（团队 / 项目 / 工作区）共用同一实例，成本混在同一个
 * Meter 账本里，缺少按租户归集与可解释的租户级根因视图。本模块补上这一维：
 *
 *   - 租户解析：sessionId -> 租户 的解析器（精确映射 / 前缀映射 / 正则提取，
 *     未命中兜底 defaultTenant），完全由调用方配置，不侵占用例元数据；
 *   - 租户聚合：把会话桶按租户归并（纯加和，金额 / Token 四通道全量带入）；
 *   - 租户间归因：复用 rca.ts 的增量贡献分解算法（buildFactorView），逐租户
 *     归因 Δ 成本（无基线退化为存量构成），标识主因 / 次因 / 噪声租户；
 *   - 租户内解释：对每个主因租户，再对其内部会话做一次会话视角归因，
 *     输出「租户为什么烧钱 -> 该租户哪个会话在烧钱」的两级证据链；
 *   - 中文叙事：与 explain.ts 同构（total/overview + factor + suggestion），
 *     事实驱动、不虚构数字。
 *
 * 纯函数、无副作用、JSON 安全（除零保护），可在任意宿主复用与单测。
 */

import type { UsageBucket } from './types.js'
import { emptyBucket } from './types.js'
import {
  buildChannelMix,
  buildFactorView,
  type RcaChannelMix,
  type RcaFactor,
  type RcaFactorView,
  type RcaGrade,
} from './rca.js'
import type { ExplainItem } from './explain.js'

/** 租户解析规则配置（sessionId -> 租户）。 */
export interface TenantResolveOptions {
  /** 精确映射：sessionId -> tenantId（最高优先级）。 */
  mapping?: Record<string, string>
  /** 前缀映射：sessionId 以 prefix 开头 -> tenantId（次优先级，最长前缀优先）。 */
  prefix?: Record<string, string>
  /** 正则提取：从 sessionId 提取租户 id（取第一个捕获组，无捕获组取整个匹配；末优先级）。 */
  regex?: { source: string; flags?: string }
}

/** 租户解析器：输入会话 id，输出租户 id（未命中返回 undefined，由调用方兜底）。 */
export type TenantResolver = (sessionId: string) => string | undefined

/** 由配置构造租户解析器（纯函数；优先级 mapping > prefix > regex）。 */
export function tenantResolverOf(options: TenantResolveOptions = {}): TenantResolver {
  const mapping = options.mapping ?? {}
  const prefixEntries = Object.entries(options.prefix ?? {}).sort((a, b) => b[0].length - a[0].length)
  const regex =
    options.regex !== undefined ? new RegExp(options.regex.source, options.regex.flags ?? '') : undefined
  return (sessionId: string): string | undefined => {
    if (mapping[sessionId] !== undefined) return mapping[sessionId]
    for (const [prefix, tenantId] of prefixEntries) {
      if (sessionId.startsWith(prefix)) return tenantId
    }
    if (regex !== undefined) {
      const match = regex.exec(sessionId)
      if (match !== null) return match[1] ?? match[0]
    }
    return undefined
  }
}

/** 把会话桶按租户聚合（纯加和，四通道 Token + 金额 / 积分全量带入）。 */
export function aggregateTenantBuckets(
  sessions: Record<string, UsageBucket>,
  resolve: TenantResolver,
  defaultTenant = 'default',
): Record<string, UsageBucket> {
  const tenants: Record<string, UsageBucket> = {}
  for (const [sessionId, bucket] of Object.entries(sessions)) {
    const tenantId = resolve(sessionId) ?? defaultTenant
    let acc = tenants[tenantId]
    if (acc === undefined) {
      acc = { ...emptyBucket() }
      tenants[tenantId] = acc
    }
    acc.requests += bucket.requests ?? 0
    acc.inputTokens += bucket.inputTokens ?? 0
    acc.cacheReadTokens += bucket.cacheReadTokens ?? 0
    acc.outputTokens += bucket.outputTokens ?? 0
    acc.totalTokens += bucket.totalTokens ?? 0
    acc.cost += bucket.cost ?? 0
    acc.credits += bucket.credits ?? 0
  }
  return tenants
}

/** 租户归因输入：当前会话桶（可选基线做增量归因）。 */
export interface TenantRcaInput {
  sessions: Record<string, UsageBucket>
}

export interface TenantRcaOptions {
  /** 可选基线（前一时段 / 期初快照）；提供时做租户间增量归因。 */
  baseline?: TenantRcaInput
  /** 会话 -> 租户解析器（缺省全部归 defaultTenant）。 */
  resolve?: TenantResolver
  /** 未解析会话的兜底租户（默认 'default'）。 */
  defaultTenant?: string
  /** 主因阈值（默认 0.3）。 */
  primaryThreshold?: number
  /** 次因阈值（默认 0.1）。 */
  secondaryThreshold?: number
  /** 租户间最多保留的租户数（默认 8）。 */
  topN?: number
  /** 每个主因租户内最多保留的会话因子数（默认 3）。 */
  sessionTopN?: number
}

/** 单个租户的账目事实（供详情表与叙事引用）。 */
export interface TenantCostFact {
  /** 租户 id。 */
  tenantId: string
  /** 累计金额成本。 */
  cost: number
  /** 成本占比（0~1；总额为 0 时为 0）。 */
  share: number
  /** Δ 成本 = 当前 - 基线；无基线时与 cost 同号（存量归因）。 */
  delta: number
  /** 增量贡献占比（有符号）。 */
  deltaShare: number
  /** 归因级别。 */
  grade: RcaGrade
}

/** 单个租户的内部解释（会话视角主因 + 通道构成）。 */
export interface TenantDetail extends TenantCostFact {
  /** 该租户内会话数。 */
  sessionCount: number
  /** 该租户主因会话（复用 RcaFactor 结构，kind='session'）。 */
  topSessions: RcaFactor[]
  /** 该租户通道构成（可优化面提示）。 */
  channelMix: RcaChannelMix
}

/** 多租户成本解释报表。 */
export interface TenantCostReport {
  /** 归因窗口：'current' = 存量构成归因；'delta' = 与基线增量归因。 */
  window: 'current' | 'delta'
  /** 当前总额（全部租户金额合计）。 */
  totalCost: number
  /** 基线总额（无基线时为 0）。 */
  baselineTotalCost: number
  /** Δ 成本 = 当前总额 - 基线总额（无基线时为 0）。 */
  deltaCost: number
  /** 变化比例 = Δ / 基线总额（基线为 0 时为 0）。 */
  deltaRatio: number
  /** 租户数。 */
  tenantCount: number
  /** 租户间归因视图（复用 RcaFactorView；因子 kind='tenant'）。 */
  byTenant: RcaFactorView
  /** 主因租户的内部解释（按 |deltaShare| 降序，最多 topN 个租户各自解释）。 */
  details: TenantDetail[]
  /** 全局通道构成（token 占比提示）。 */
  channelMix: RcaChannelMix
  /** 一句话摘要（供叙事引用，事实驱动）。 */
  summary: string
}

const DEFAULT_PRIMARY = 0.3
const DEFAULT_SECONDARY = 0.1
const DEFAULT_TOPN = 8
const DEFAULT_SESSION_TOPN = 3

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function fmtCost(cost: number): string {
  return cost.toFixed(2)
}

/** 一句话摘要（事实驱动，无推测）。 */
function buildSummary(report: Omit<TenantCostReport, 'summary'>): string {
  const dominant = report.byTenant.dominant
  if (report.window === 'delta') {
    const parts = [`较基线 ${fmtCost(report.baselineTotalCost)} 变化 ${fmtCost(report.deltaCost)}（${pct(report.deltaRatio)}）`]
    if (dominant !== undefined) {
      parts.push(`租户「${dominant.key}」贡献 ${pct(dominant.deltaShare)}`)
    }
    return parts.join('；')
  }
  const parts = [`当前累计成本 ${fmtCost(report.totalCost)} · ${report.tenantCount} 个租户`]
  if (dominant !== undefined) {
    parts.push(`主因租户「${dominant.key}」占 ${pct(dominant.share)}`)
  }
  return parts.join('；')
}

/**
 * 多租户成本解释分析（纯函数，不改入参）。
 * 输入当前会话桶（与可选基线），按租户解析器聚合并做租户间增量归因，
 * 同时为每个主因租户给出内部会话视角解释（两级证据链）。
 */
export function analyzeTenantRca(input: TenantRcaInput, opts: TenantRcaOptions = {}): TenantCostReport {
  const resolve = opts.resolve ?? (() => undefined)
  const defaultTenant = opts.defaultTenant ?? 'default'
  const primaryThreshold = opts.primaryThreshold ?? DEFAULT_PRIMARY
  const secondaryThreshold = opts.secondaryThreshold ?? DEFAULT_SECONDARY
  const topN = opts.topN ?? DEFAULT_TOPN
  const sessionTopN = opts.sessionTopN ?? DEFAULT_SESSION_TOPN

  const sessions = input.sessions ?? {}
  const baseSessions = opts.baseline?.sessions ?? {}
  const tenants = aggregateTenantBuckets(sessions, resolve, defaultTenant)
  const baseTenants = aggregateTenantBuckets(baseSessions, resolve, defaultTenant)

  const totalCost = Object.values(tenants).reduce((s, b) => s + (b.cost ?? 0), 0)
  const baselineTotalCost = Object.values(baseTenants).reduce((s, b) => s + (b.cost ?? 0), 0)
  const deltaCost = totalCost - baselineTotalCost
  const deltaRatio = baselineTotalCost > 0 ? deltaCost / baselineTotalCost : 0

  // 租户间归因：复用 rca 的增量贡献分解算法（kind='tenant'）
  const byTenant = buildFactorView('tenant', tenants, baseTenants, totalCost, primaryThreshold, secondaryThreshold, topN)

  // 会话 -> 租户 的一次性映射（当前与基线都要，供租户内部会话归因）
  const sessionTenant = new Map<string, string>()
  for (const sessionId of Object.keys(sessions)) sessionTenant.set(sessionId, resolve(sessionId) ?? defaultTenant)
  const baseSessionTenant = new Map<string, string>()
  for (const sessionId of Object.keys(baseSessions)) baseSessionTenant.set(sessionId, resolve(sessionId) ?? defaultTenant)

  // 主因租户的内部解释（按 |deltaShare| 降序取 topN 个租户）
  const details: TenantDetail[] = []
  for (const factor of byTenant.factors) {
    const tenantId = factor.key
    const tenantSessions: Record<string, UsageBucket> = {}
    for (const [sid, b] of sessionTenant) {
      if (b === tenantId && sessions[sid] !== undefined) tenantSessions[sid] = sessions[sid]
    }
    const baseTenantSessions: Record<string, UsageBucket> = {}
    for (const [sid, t] of baseSessionTenant) {
      if (t === tenantId && baseSessions[sid] !== undefined) baseTenantSessions[sid] = baseSessions[sid]
    }
    const tenantCost = factor.cost
    const sessionView = buildFactorView(
      'session',
      tenantSessions,
      baseTenantSessions,
      tenantCost,
      primaryThreshold,
      secondaryThreshold,
      sessionTopN,
    )
    details.push({
      tenantId,
      cost: factor.cost,
      share: factor.share,
      delta: factor.delta,
      deltaShare: factor.deltaShare,
      grade: factor.grade,
      sessionCount: Object.keys(tenantSessions).length,
      topSessions: sessionView.factors,
      channelMix: buildChannelMix(tenantSessions, undefined),
    })
  }

  const channelMix = buildChannelMix(sessions, undefined)
  const window: 'current' | 'delta' = opts.baseline !== undefined ? 'delta' : 'current'
  const base: Omit<TenantCostReport, 'summary'> = {
    window,
    totalCost,
    baselineTotalCost,
    deltaCost,
    deltaRatio,
    tenantCount: Object.keys(tenants).length,
    byTenant,
    details,
    channelMix,
  }
  return { ...base, summary: buildSummary(base) }
}

/** 生成多租户成本解释叙事（纯函数；与 explain.ts 同构：summary + factor + suggestion）。 */
export function buildTenantExplanation(report: TenantCostReport): ExplainItem[] {
  const items: ExplainItem[] = []
  const dominant = report.byTenant.dominant

  // 1) 总览句
  if (report.window === 'delta') {
    items.push({
      kind: 'summary',
      text:
        `多租户成本解释：当前累计 ${fmtCost(report.totalCost)}，较基线 ${fmtCost(report.baselineTotalCost)} ` +
        `变化 ${report.deltaCost >= 0 ? '+' : ''}${fmtCost(report.deltaCost)}（${pct(report.deltaRatio)}）。${report.summary}。`,
    })
  } else {
    items.push({ kind: 'summary', text: `多租户成本解释：当前累计 ${fmtCost(report.totalCost)}。${report.summary}。` })
  }

  // 2) 租户因子句：主因 / 次因逐租户一句，主因租户附内部主因会话证据
  for (const factor of report.byTenant.primary) {
    const detail = report.details.find((d) => d.tenantId === factor.key)
    const inside = detail?.topSessions[0]
    const insidePart =
      inside !== undefined
        ? `；该租户主因会话「${inside.key}」占 ${pct(inside.share)}`
        : detail !== undefined && detail.sessionCount > 0
          ? `；该租户 ${detail.sessionCount} 个会话`
          : ''
    items.push({
      kind: 'factor',
      text: `  主因租户「${factor.key}」累计 ${fmtCost(factor.cost)}` +
        (factor.share > 0 ? `（占 ${pct(factor.share)}` : '') +
        (factor.deltaShare !== factor.share ? `，增量贡献 ${pct(factor.deltaShare)}` : '') +
        `${factor.share > 0 ? '）' : ''}${insidePart}`,
    })
  }
  for (const factor of report.byTenant.secondary) {
    items.push({
      kind: 'factor',
      text: `  次因租户「${factor.key}」累计 ${fmtCost(factor.cost)}` +
        (factor.share > 0 ? `（占 ${pct(factor.share)}）` : ''),
    })
  }

  // 3) 建议句：主因租户优先治理 + 通道构成提示（只陈述有据结论）
  const suggestion: string[] = []
  if (dominant !== undefined) {
    suggestion.push(`建议：成本集中于「${dominant.key}」（占 ${pct(dominant.share)}），优先治理该租户的会话与路由配置。`)
  }
  const mix = report.channelMix
  if (mix.outputShare >= 0.5 && mix.totalTokens > 0) {
    suggestion.push(`建议：输出 token 占计费 token ${pct(mix.outputShare)}，压缩输出是当前直接的省钱动作。`)
  }
  if (suggestion.length === 0 && report.totalCost > 0) {
    suggestion.push('建议：当前无突出优化信号，可结合预测式治理与自适应调节继续节流。')
  }
  for (const text of suggestion.slice(0, 2)) {
    items.push({ kind: 'suggestion', text })
  }
  return items
}

/** 便捷工厂：空会话输入（供调用方按需填充）。 */
export function emptyTenantInput(): Required<TenantRcaInput> {
  return { sessions: {} }
}