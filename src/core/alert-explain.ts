/**
 * @module dsh-cost-guard/core/alert-explain
 * 告警根因叙事（Alert Explainable Narrative，0.15.0，零 DSH 依赖）。
 *
 * 市面空缺：成本告警只喊「超了」（水位数字 + scope），不解释「为什么超、
 * 主因是谁、下一步怎么办」。本模块把既有的根因分析（rca.ts，0.14.0）
 * 与告警信号合成为**告警专属的中文叙事**——同一条告警通知里既给事实
 * （scope/水位/Δ）也给出证据（会话/路由双视角主因 + 通道构成 + 建议），
 * 让通知对象（人类宿主 / Agent / 转发到 IM）不必再打开面板就能决策。
 *
 * 与 explain.ts 的关系：explain.ts 面向「主动查询」（工具/面板，可长文本）；
 * 本模块面向「被动通知」（告警，需即时、聚焦、可转发）。两者共用
 * RootCauseReport 契约，但叙事结构不同：告警叙事以「为什么超」为首句，
 * 收敛到 1 条主因 + 最多 2 条建议，避免刷屏。
 *
 * 纯函数、无副作用、零 DSH；只陈述有据事实（金额/占比/Δ），不推测。
 */

import type { RootCauseReport, RcaFactor } from './rca.js'
import type { BudgetScope } from './types.js'

/** 告警信号（来自 Guard 决策的事实投影，不含 DSH 类型）。 */
export interface AlarmSignal {
  /** 触发告警的预算范围。 */
  scope: BudgetScope
  /** 决策动作：warn=仅告警放行；block=硬熔断阻断。 */
  action: 'warn' | 'block'
  /** 触发水位比例（0~1；不可得时缺省）。 */
  ratio?: number
  /** 已花费金额（不可得时缺省）。 */
  spent?: number
  /** 预算上限（不可得时缺省）。 */
  limit?: number
  /** 预测式/自适应告警的附加说明（可选）。 */
  detail?: string
}

/** 告警叙事条目。 */
export interface AlarmExplainItem {
  kind: 'summary' | 'factor' | 'suggestion'
  text: string
}

function fmtCost(cost: number): string {
  return cost.toFixed(2)
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** 单因子一句（告警版：更紧凑，不含冗余占比措辞）。 */
function factorSentence(factor: RcaFactor, suffix: string): string {
  const deltaPart =
    factor.delta !== 0
      ? factor.delta >= 0
        ? `较基线 +${fmtCost(factor.delta)}（增量贡献 ${pct(Math.abs(factor.deltaShare))}）`
        : `较基线 ${fmtCost(factor.delta)}（增量贡献 ${pct(Math.abs(factor.deltaShare))}）`
      : ''
  return `「${factor.key}」${suffix}已花 ${fmtCost(factor.cost)}（占 ${pct(factor.share)}）${deltaPart}`
}

/** 告警首句：先回答「为什么告警」，再给根因结论。 */
function summarySentence(signal: AlarmSignal, report: RootCauseReport): string {
  const scopeLabel = signal.scope === 'total' ? '总预算' : `${signal.scope}预算`
  const level = signal.action === 'block' ? '已熔断（请求被阻断）' : '触发告警（请求放行）'
  const levelPart = `${scopeLabel}${signal.ratio !== undefined ? `已达 ${pct(signal.ratio)}` : ''}${
    signal.spent !== undefined && signal.limit !== undefined
      ? `（${fmtCost(signal.spent)}/${fmtCost(signal.limit)}）`
      : ''
  }，${level}`
  const deltaPart =
    report.window === 'delta' && report.deltaCost !== 0
      ? `较基线 ${report.deltaCost >= 0 ? '+' : ''}${fmtCost(report.deltaCost)}（${pct(report.deltaRatio)}）`
      : ''
  const detailPart = signal.detail ? `（${signal.detail}）` : ''
  return `${levelPart}${deltaPart}${detailPart}；${report.summary}`
}

/** 建议句：告警版聚焦「现在能做什么」，最多 2 条，无据不出。 */
function suggestionItems(report: RootCauseReport): string[] {
  const out: string[] = []
  const mix = report.channelMix
  if (mix.outputShare >= 0.5 && mix.totalTokens > 0) {
    out.push(
      `建议：输出 token 占 ${pct(mix.outputShare)}，压缩输出（精简回复 / 降低 max_tokens）是当前最直接的省钱动作。`,
    )
  }
  if (mix.cacheReadShare < 0.1 && mix.totalTokens > 0) {
    out.push(`建议：缓存命中占比仅 ${pct(mix.cacheReadShare)}，公共前缀提示复用可显著降本（读价约为输入价 0.1 倍）。`)
  }
  if (out.length === 0 && report.totalCost > 0) {
    out.push(`建议：检查主因会话/模型的调用频率，或错峰使用高峰时段规避 ×2 定价。`)
  }
  return out
}

/**
 * 生成告警根因叙事（纯函数）。
 * @param signal 告警信号（Guard 决策投影）。
 * @param report 根因报表（rca.ts 输出，建议直接复用 ExplainRuntime 的报表）。
 */
export function buildAlarmExplanation(signal: AlarmSignal, report: RootCauseReport): AlarmExplainItem[] {
  const items: AlarmExplainItem[] = []
  items.push({ kind: 'summary', text: summarySentence(signal, report) })

  // 主因：会话与路由各取 1 条（避免告警刷屏）
  const sessionPrimary = report.bySession.primary[0]
  const routePrimary = report.byRoute.primary[0]
  if (sessionPrimary) items.push({ kind: 'factor', text: `会话主因：${factorSentence(sessionPrimary, '')}` })
  if (routePrimary) items.push({ kind: 'factor', text: `路由主因：${factorSentence(routePrimary, '')}` })

  for (const text of suggestionItems(report)) {
    items.push({ kind: 'suggestion', text })
  }
  return items
}

/** 拼为单段文本（供通知负载 / 日志）。 */
export function formatAlarmExplanation(items: AlarmExplainItem[]): string {
  return items.map((item) => item.text).join('\n')
}

/** 单行版：每行一条（供 IM / 日志逐行输出）。 */
export function formatAlarmLines(items: AlarmExplainItem[]): string[] {
  return items.map((item) => {
    if (item.kind === 'summary') return item.text
    if (item.kind === 'factor') return `  ${item.text}`
    return `  建议: ${item.text.replace(/^建议：/, '')}`
  })
}