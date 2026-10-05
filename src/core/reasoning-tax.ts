/**
 * @module dsh-cost-guard/core/reasoning-tax
 * 推理成本专项治理（Reasoning Tax Governance，0.17.0，零 DSH 依赖）。
 *
 * 市面空缺：DeepSeek Harness 生态既有成本插件（dsh-billing / dsh-cost-meter /
 * dsh-cost-tracker 等）只统计输入 / 输出 / 缓存三通道，无人按「推理 token
 * （思维链 / thinking）」专项计量与治理——而 2026 年行业共识（多家权威渠道一致）
 * 指出：推理模型的思考 token 按输出价计费，往往为可见输出的 5–20 倍，
 * 是账单里最大的隐藏成本（「思考税」）。既有 ReasoningLedger（0.8.0）仅做
 * 全局汇总展示，不回答「哪条路由在烧思考税、税比多高、要不要给它设预算」。
 *
 * 本模块把推理 token 从「展示项」升级为「可治理对象」：
 *   1. 思考税账本：按路由聚合推理 token / 可见输出 / 推理成本（推理 token × 输出价）；
 *   2. 全局与逐路由思考税（taxRatio = 推理 / (推理 + 可见输出)）与主因识别；
 *   3. 独立于金额预算的「推理税预算」水位：limit + warnAt/hardAt → ok / warn / block
 *      （纯新增治理维度，不干预既有 budgets 熔断语义）；
 *   4. 中文叙事（summary / factor / suggestion）：告诉用户「思考税花在哪、怎么省」。
 *
 * 纯函数 + 无副作用账本；币种与取价全部注入，冒烟与单测可确定性复现。
 */

import type { UsageEntry } from './types.js'
import type { ExplainItem } from './explain.js'

/** 单条路由的思考税账目（依据 usage 事实，无推测）。 */
export interface ReasoningTaxRoute {
  /** 路由键 'provider/model'。 */
  route: string
  /** 产生推理 token 的请求数。 */
  requests: number
  /** 推理 token 累计。 */
  reasoningTokens: number
  /** 可见输出 token 累计（不含推理）。 */
  outputTokens: number
  /** 思考税估算成本 = 推理 token × 输出价 / 1e6（币种随模型取价器）。 */
  taxCost: number
}

/** 思考税报表（单窗口：存量归因，不消费 / 更新基线）。 */
export interface ReasoningTaxReport {
  /** 归因窗口（0.17.0 为存量构成归因）。 */
  window: 'current'
  /** 推理 token 累计（全部路由）。 */
  totalReasoningTokens: number
  /** 可见输出 token 累计（全部路由）。 */
  totalOutputTokens: number
  /** 推理税成本累计（全部路由，币种随取价器）。 */
  totalTaxCost: number
  /** 全局思考税 = 推理 / (推理 + 可见输出)；0~1。 */
  taxRatio: number
  /** 有币种定价的路由数（取价器返回 > 0 的路由），用于区分估算口径。 */
  pricedRoutes: number
  /** 逐路由思考税（按 taxCost 降序；定价为 0 的路由排后）。 */
  byRoute: ReasoningTaxRoute[]
  /** 主因路由（税成本最高；无样本时不出现）。 */
  dominant?: ReasoningTaxRoute
  /** 推理税预算水位（未配置预算时不出现）。 */
  budget?: {
    /** 预算上限（金额）。 */
    limit: number
    /** 已用（= totalTaxCost）。 */
    spent: number
    /** 使用率 = spent / limit。 */
    ratio: number
    /** 水位判定。 */
    level: 'ok' | 'warn' | 'block'
  }
}

/** 推理税预算配置。 */
export interface ReasoningTaxBudget {
  /** 预算上限（金额，与取价器币种一致）。 */
  limit: number
  /** 告警水位（0~1），默认 0.8。 */
  warnAt: number
  /** 阻断水位（0~1），默认 1。 */
  hardAt: number
}

const DEFAULT_WARN_AT = 0.8
const DEFAULT_HARD_AT = 1

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function fmtCost(cost: number): string {
  return cost.toFixed(2)
}

/** 按（归一）模型取官方或用户输出单价（每百万 token；无价返回 0，不臆造）。 */
export type OutputPriceOf = (model: string) => number

interface RouteTaxAcc {
  requests: number
  reasoningTokens: number
  outputTokens: number
  taxCost: number
}

/** 思考税账本：累积 entry 的推理 token 与可见输出，产出逐路由与全局报表。 */
export class ReasoningTaxLedger {
  private readonly routes = new Map<string, RouteTaxAcc>()

  constructor(private readonly outputPriceOf: OutputPriceOf) {}

  /** 追加一次调用；reasoningTokens <= 0 的调用不入账。 */
  append(entry: UsageEntry): void {
    const reasoning = Math.max(0, entry.reasoningTokens)
    if (reasoning <= 0) return
    const route = `${entry.route.provider}/${entry.route.model}`
    const acc = this.routes.get(route) ?? { requests: 0, reasoningTokens: 0, outputTokens: 0, taxCost: 0 }
    acc.requests += 1
    acc.reasoningTokens += reasoning
    acc.outputTokens += Math.max(0, entry.usage.outputTokens)
    const price = Math.max(0, this.outputPriceOf(entry.route.model))
    acc.taxCost += (reasoning * price) / 1_000_000
    this.routes.set(route, acc)
  }

  reset(): void {
    this.routes.clear()
  }

  /** 汇总报表（无推理样本时返回 null）。 */
  report(budget?: ReasoningTaxBudget): ReasoningTaxReport | null {
    const byRoute: ReasoningTaxRoute[] = []
    let totalReasoningTokens = 0
    let totalOutputTokens = 0
    let totalTaxCost = 0
    let pricedRoutes = 0
    for (const [route, acc] of this.routes) {
      totalReasoningTokens += acc.reasoningTokens
      totalOutputTokens += acc.outputTokens
      totalTaxCost += acc.taxCost
      if (acc.taxCost > 0) pricedRoutes += 1
      byRoute.push({ route, requests: acc.requests, reasoningTokens: acc.reasoningTokens, outputTokens: acc.outputTokens, taxCost: acc.taxCost })
    }
    if (totalReasoningTokens <= 0) return null
    // 主因 = 税成本最高（无价路由 taxCost=0 排后）；同成本时按推理 token 多者优先
    byRoute.sort((a, b) => (b.taxCost !== a.taxCost ? b.taxCost - a.taxCost : b.reasoningTokens - a.reasoningTokens))
    const sum = totalReasoningTokens + totalOutputTokens
    const taxRatio = sum > 0 ? totalReasoningTokens / sum : 0
    const budgetView =
      budget !== undefined && budget.limit > 0
        ? (() => {
            const ratio = totalTaxCost / budget.limit
            const warnAt = budget.warnAt ?? DEFAULT_WARN_AT
            const hardAt = budget.hardAt ?? DEFAULT_HARD_AT
            const level: 'ok' | 'warn' | 'block' = ratio >= hardAt ? 'block' : ratio >= warnAt ? 'warn' : 'ok'
            return { limit: budget.limit, spent: totalTaxCost, ratio, level }
          })()
        : undefined
    const dominant = byRoute[0]
    return {
      window: 'current',
      totalReasoningTokens,
      totalOutputTokens,
      totalTaxCost,
      taxRatio,
      pricedRoutes,
      byRoute,
      ...(dominant !== undefined ? { dominant } : {}),
      ...(budgetView !== undefined ? { budget: budgetView } : {}),
    }
  }
}

/** 一句话摘要（事实驱动，无推测）。 */
function buildSummary(report: Omit<ReasoningTaxReport, 'window'>): string {
  const parts = [`推理 token 累计 ${report.totalReasoningTokens.toLocaleString()}`]
  if (report.taxRatio > 0) parts.push(`思考税 ${pct(report.taxRatio)}`)
  if (report.totalTaxCost > 0) parts.push(`估算成本 ${fmtCost(report.totalTaxCost)}`)
  if (report.dominant !== undefined) {
    parts.push(`主因路由「${report.dominant.route}」税成本 ${fmtCost(report.dominant.taxCost)}`)
  }
  return parts.join(' · ')
}

/**
 * 生成思考税中文叙事（纯函数；与 explain/tenant 同构：summary + factor + suggestion）。
 * 阈值取自报表中的推理税预算（report.budget.warnAt / hardAt 已在账本内判定），
 * 本函数只消费报表事实，不额外注入参数。
 */
export function buildReasoningTaxExplanation(report: ReasoningTaxReport): ExplainItem[] {
  const items: ExplainItem[] = []
  items.push({
    kind: 'summary',
    text: `推理成本解释：${buildSummary(report)}。`,
  })

  // 因子句：主因 / 次因各一句
  const routes = report.byRoute
  const primary = routes.slice(0, 1)
  const secondary = routes.slice(1, 3)
  for (const r of primary) {
    const total = r.reasoningTokens + r.outputTokens
    const ratio = total > 0 ? r.reasoningTokens / total : 0
    const costPart = r.taxCost > 0 ? `，税成本 ${fmtCost(r.taxCost)}` : '（无官方价，成本未估）'
    items.push({
      kind: 'factor',
      text: `  主因路由「${r.route}」推理 ${r.reasoningTokens.toLocaleString()} token（占该路由输出 ${pct(ratio)}，${r.requests} 次）${costPart}`,
    })
  }
  for (const r of secondary) {
    items.push({ kind: 'factor', text: `  次因路由「${r.route}」推理 ${r.reasoningTokens.toLocaleString()} token（${r.requests} 次）` })
  }

  // 建议句：思考税过高 / 预算水位两条治理线
  const suggestions: string[] = []
  if (report.taxRatio > 0.5) {
    suggestions.push(
      `建议：全局思考税 ${pct(report.taxRatio)}——推理 token 占输出一半以上，` +
        `可对高频路由收缩思考预算（thinking_budget / max_tokens 压缩）或按任务复杂度切换非推理模型。`,
    )
  }
  const dominant = report.dominant
  if (dominant !== undefined && dominant.taxCost > 0) {
    const total = dominant.reasoningTokens + dominant.outputTokens
    const ratio = total > 0 ? dominant.reasoningTokens / total : 0
    suggestions.push(
      `建议：主因路由「${dominant.route}」思考税 ${pct(ratio)}、税成本 ${fmtCost(dominant.taxCost)}——` +
        `优先对该路由做推理链压缩或路由降级，是当前最直接的省钱动作。`,
    )
  }
  if (report.budget !== undefined) {
    if (report.budget.level === 'block') {
      suggestions.push(
        `建议：推理税预算已用尽（${pct(report.budget.ratio)} ≥ 阻断水位）——` +
          `考虑收紧推理链输出上限或临时切换非推理模型，避免进一步烧穿。`,
      )
    } else if (report.budget.level === 'warn') {
      suggestions.push(`建议：推理税预算已用 ${pct(report.budget.ratio)}（接近上限 ${fmtCost(report.budget.limit)}）——提前规划压缩动作。`)
    }
  }
  if (report.budget === undefined && suggestions.length === 0) {
    suggestions.push(
      `建议：可为推理税单独设置预算（limit + warn/hard 水位），把「看不见的思考成本」纳入治理。`,
    )
  }
  for (const s of suggestions) {
    items.push({ kind: 'suggestion', text: s })
  }
  return items
}

/** 把叙事条目拼为单段文本（供工具文本输出 / 日志）。 */
export function formatReasoningTaxExplanation(items: ExplainItem[]): string {
  return items.map((item) => item.text).join('\n')
}