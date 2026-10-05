/**
 * @module dsh-cost-guard/core/explain
 * 可解释成本叙事（Explainable Cost Narrative，0.14.0，零 DSH 依赖）。
 *
 * 市面空缺：成本工具给出「数字与报表」，但不给「解释」。本模块把
 * 根因分析（rca.ts）的结构化证据合成为人类与 Agent 可读的中文叙事：
 *   - 总览句（summary）：花了多少 / 较基线变化多少 / 主因是谁；
 *   - 因子句（factor）：每个主因 / 次因一句，带数字证据（金额、占比、贡献）；
 *   - 建议句（suggestion）：基于可优化面（通道构成 / 缓存命中收益）与
 *     既有治理方法论（缓存杠杆、输出压缩、路由替代、错峰治理）给出行动项，
 *     只陈述有据结论，不虚构数字。
 *
 * 纯函数、零 DSH 依赖；文案只做「模板化事实陈述」，不推测、不归罪。
 */

import type { RootCauseReport, RcaFactor } from './rca.js'

/** 叙事条目类型。 */
export type ExplainItemKind = 'summary' | 'factor' | 'suggestion'

/** 一条叙事。 */
export interface ExplainItem {
  kind: ExplainItemKind
  text: string
}

/** 可优化面事实（可选输入；来自既有缓存维度计量与效率洞察，不虚构）。 */
export interface ExplainContext {
  /** 缓存命中相关事实（0.6.0 缓存维度计量启用时提供）。 */
  cache?: {
    /** Token 加权命中率（0~1）。 */
    hitRate: number
    /** 相对全未命中基线的累计已省金额。 */
    saving: number
    /** 可优化前缀提示条数（可选）。 */
    hintCount?: number
  }
  /** 路由替代建议（0.5.0 效率洞察，可选）。 */
  replacementHints?: string[]
  /** 阈值覆盖（用于测试与演示）：输出占比告警阈值（默认 0.5）。 */
  outputShareWarnAt?: number
  /** 阈值覆盖：缓存命中率过低告警阈值（默认 0.4）。 */
  cacheHitWarnAt?: number
}

const DEFAULT_OUTPUT_SHARE_WARN_AT = 0.5
const DEFAULT_CACHE_HIT_WARN_AT = 0.4

function fmtCost(cost: number): string {
  return cost.toFixed(2)
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** 单个因子一句：主因与次因用不同语气颗粒度。 */
function factorSentence(factor: RcaFactor, suffix: string): string {
  const deltaPart =
    factor.delta >= 0 ? `较基线 +${fmtCost(factor.delta)}` : `较基线 ${fmtCost(factor.delta)}`
  const sharePart = `占 ${pct(factor.share)}`
  const contribPart = factor.deltaShare !== factor.share ? `，增量贡献 ${pct(factor.deltaShare)}` : ''
  const verbose =
    `  「${factor.key}」${suffix}累计 ${fmtCost(factor.cost)}${factor.share > 0 ? `（${sharePart}）` : ''}` +
    (factor.delta !== 0 ? `，${deltaPart}${contribPart}` : '')
  return verbose
}

/** 汇总句。 */
function summarySentence(report: RootCauseReport): string {
  if (report.window === 'delta') {
    return (
      `成本根因报告：当前累计 ${fmtCost(report.totalCost)}，较基线 ${fmtCost(report.baselineTotalCost)} 变化 ` +
      `${report.deltaCost >= 0 ? '+' : ''}${fmtCost(report.deltaCost)}（${pct(report.deltaRatio)}）；${report.summary}。`
    )
  }
  return `成本根因报告：当前累计 ${fmtCost(report.totalCost)}。${report.summary}。`
}

/** 建议句：基于可优化面与既有治理方法论；无据则不出。 */
function suggestionItems(report: RootCauseReport, ctx: ExplainContext): string[] {
  const out: string[] = []
  const mix = report.channelMix
  const outputShareWarnAt = ctx.outputShareWarnAt ?? DEFAULT_OUTPUT_SHARE_WARN_AT
  const cacheHitWarnAt = ctx.cacheHitWarnAt ?? DEFAULT_CACHE_HIT_WARN_AT

  // 1) 输出通道过高：输出 token 单价最高，压缩输出是第一质量-成本杠杆
  if (mix.outputShare >= outputShareWarnAt && mix.totalTokens > 0) {
    out.push(
      `建议：输出 token 占计费 token ${pct(mix.outputShare)}，输出是单价最高的通道——` +
        `压缩输出（精简回复 / 降低 max_tokens / 减少推理链）是当前最直接的省钱动作。`,
    )
  }
  // 2) 缓存命中率低：缓存读价约输入价 0.1 倍，是 FinOps 第一杠杆
  if (ctx.cache !== undefined) {
    if (ctx.cache.hitRate < cacheHitWarnAt) {
      out.push(
        `建议：缓存命中率仅 ${pct(ctx.cache.hitRate)}（已省 ${fmtCost(ctx.cache.saving)}），` +
          `公共前缀提示复用可显著提升命中——缓存读价约为输入价 0.1 倍，是成本第一杠杆。`,
      )
    } else if (ctx.cache.hintCount !== undefined && ctx.cache.hintCount > 0) {
      out.push(
        `建议：缓存命中表现良好（命中率 ${pct(ctx.cache.hitRate)}，已省 ${fmtCost(ctx.cache.saving)}）；` +
          `另有 ${ctx.cache.hintCount} 条可优化前缀提示，继续收敛公共前缀仍有再省空间。`,
      )
    }
  }
  // 3) 路由替代建议（0.5.0 效率洞察）；只转述调用方给的既有结论
  if (ctx.replacementHints !== undefined && ctx.replacementHints.length > 0) {
    for (const hint of ctx.replacementHints.slice(0, 3)) {
      out.push(`建议（路由替代）：${hint}`)
    }
  }
  // 4) 无任何可优化面时给通用治理提醒（仅当有累计成本时）
  if (out.length === 0 && report.totalCost > 0) {
    out.push(
      `建议：当前无可优化的通道/缓存信号，可结合预测式治理（预算耗尽预测）与` +
        `自适应调节（动态日额度）继续节流，或错峰使用高峰时段规避 ×2 定价。`,
    )
  }
  return out
}

/**
 * 生成可解释成本叙事（纯函数）。
 * @param report 根因报表（rca.ts 输出）。
 * @param ctx 可优化面事实（可选）。
 */
export function buildExplanation(report: RootCauseReport, ctx: ExplainContext = {}): ExplainItem[] {
  const items: ExplainItem[] = []
  items.push({ kind: 'summary', text: summarySentence(report) })

  for (const factor of report.bySession.primary) {
    items.push({ kind: 'factor', text: factorSentence(factor, '会话') })
  }
  for (const factor of report.byRoute.primary) {
    items.push({ kind: 'factor', text: factorSentence(factor, '路由') })
  }
  for (const factor of report.bySession.secondary) {
    items.push({ kind: 'factor', text: factorSentence(factor, '会话') })
  }
  for (const factor of report.byRoute.secondary) {
    items.push({ kind: 'factor', text: factorSentence(factor, '路由') })
  }
  const noiseTotal = report.bySession.noise.count + report.byRoute.noise.count
  if (noiseTotal > 0) {
    const noiseCost = report.bySession.noise.cost + report.byRoute.noise.cost
    items.push({ kind: 'factor', text: `  其余 ${noiseTotal} 个低贡献因子合计 ${fmtCost(noiseCost)}（已并入噪声，避免长尾刷屏）` })
  }

  for (const text of suggestionItems(report, ctx)) {
    items.push({ kind: 'suggestion', text })
  }
  return items
}

/** 把叙事条目拼为单段文本（供工具文本输出 / 日志）。 */
export function formatExplanation(items: ExplainItem[]): string {
  return items.map((item) => item.text).join('\n')
}

/** 双行版：summary 单独一行，其余行缩进（供面板渲染）。 */
export function formatExplanationLines(items: ExplainItem[]): string[] {
  return items.map((item) => {
    if (item.kind === 'summary') return item.text
    if (item.kind === 'factor') return `  ${item.text.trim()}`
    return `  建议: ${item.text.replace(/^建议[（(]?/, '').replace(/[）)]?：/, '：')}`
  })
}