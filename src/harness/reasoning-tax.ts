/**
 * @module dsh-cost-guard/harness/reasoning-tax
 * 推理成本专项治理（0.17.0，可选）DSH 适配层：
 * - 由用量事件流喂入思考税账本（core/reasoning-tax.ts），按路由聚合推理 token、
 *   可见输出与推理成本，输出思考税报表 + 独立推理税预算水位 + 中文叙事；
 * - 注册只读工具 `cost_guard_reasoning`：Agent 可请求「推理（思考）token 花了多少 /
 *   为什么 / 怎么省」，拿到结构化思考税报表 + 证据 + 建议（自我诊断「思考税」的
 *   Agent 能力，市面无同类工具）；
 * - 面板负载 `reasoningTax` 并入成本状态，未配置时整体 undefined（零回归）。
 *
 * 兼容边界：`reasoningTax` 配置未提供时本适配层不构造（undefined），
 * 事件流与状态输出与 0.16.0 完全一致（零回归）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { UsageEntry } from '../core/types.js'
import {
  ReasoningTaxLedger,
  buildReasoningTaxExplanation,
  type OutputPriceOf,
  type ReasoningTaxBudget,
  type ReasoningTaxReport,
  type ReasoningTaxRoute,
} from '../core/reasoning-tax.js'
import type { ExplainItem } from '../core/explain.js'

/** 面板负载（并入 CostStatusPayload.reasoningTax；未启用时为 undefined 零回归）。 */
export interface ReasoningTaxPanelPayload {
  enabled: true
  /** 归因窗口（0.17.0 为存量构成归因）。 */
  window: 'current'
  /** 思考税报表（JSON 安全，供面板与工具复用）。 */
  report: ReasoningTaxReport
}

/** 思考税运行时：持账本 + 预算配置，输出报表 + 叙事。 */
export class ReasoningTaxRuntime {
  private readonly ledger: ReasoningTaxLedger

  constructor(
    outputPriceOf: OutputPriceOf,
    private readonly budget?: ReasoningTaxBudget,
  ) {
    this.ledger = new ReasoningTaxLedger(outputPriceOf)
  }

  /** 由主计量 sampler 喂入一次用量入账（reasoningTokens > 0 才入账）。 */
  append(entry: UsageEntry): void {
    this.ledger.append(entry)
  }

  /** 查询当前思考税存量归因（不消费 / 更新基线）。 */
  view(): { report: ReasoningTaxReport; items: ExplainItem[] } | null {
    const report = this.ledger.report(this.budget)
    if (report === null) return null
    return { report, items: buildReasoningTaxExplanation(report) }
  }

  /** 只读查询当前存量思考税（供面板）。无样本时 undefined。 */
  panel(): ReasoningTaxPanelPayload | undefined {
    const { report } = this.view() ?? {}
    if (report === undefined) return undefined
    return { enabled: true, window: 'current', report }
  }
}

/** 因子行的 JsonValue 投影（保真、无 undefined 键；数值均为有限数）。 */
function routeToJson(route: ReasoningTaxRoute): Record<string, JsonValue> {
  return {
    route: route.route,
    requests: route.requests,
    reasoningTokens: route.reasoningTokens,
    outputTokens: route.outputTokens,
    taxCost: route.taxCost,
  }
}

/** 思考税报表 -> 无损 JSON（无 NaN/Infinity/-0/undefined 键，与 dsh-session JsonValue 契约一致）。 */
function reportToJson(report: ReasoningTaxReport): Record<string, JsonValue> {
  return {
    window: report.window,
    totalReasoningTokens: report.totalReasoningTokens,
    totalOutputTokens: report.totalOutputTokens,
    totalTaxCost: report.totalTaxCost,
    taxRatio: report.taxRatio,
    pricedRoutes: report.pricedRoutes,
    byRoute: report.byRoute.map(routeToJson),
    ...(report.dominant !== undefined ? { dominant: routeToJson(report.dominant) } : {}),
    ...(report.budget !== undefined ? { budget: { limit: report.budget.limit, spent: report.budget.spent, ratio: report.budget.ratio, level: report.budget.level } } : {}),
  }
}

/**
 * 注册只读工具 `cost_guard_reasoning`：
 * 「推理（思考）token 花了多少 / 为什么 / 怎么省」——返回思考税报表
 * （逐路由聚合、思考税占比、推理成本、独立推理税预算水位）与中文叙事
 * （总览/因子/建议）。
 */
export function attachReasoningTaxTool(ctx: Context, runtime: ReasoningTaxRuntime): void {
  ctx.tools.register(
    defineTool({
      name: 'cost_guard_reasoning',
      description:
        '读取推理成本专项治理报表（只读）：回答「推理（思考）token 花了多少 / 在哪里烧 / 怎么省」——' +
        '按路由给出推理 token 聚合（占比思考税 taxRatio、推理成本 taxCost、请求数），' +
        '独立于金额预算的推理税预算水位（ok/warn/block），以及中文治理建议' +
        '（思考预算压缩 / 路由降级 / 非推理模型切换）。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute(): Promise<Record<string, JsonValue>> {
        const view = runtime.view()
        const out: Record<string, JsonValue> =
          view === null
            ? { window: 'current', summary: '暂无推理 token 样本（reasoningTokens > 0 的调用尚未发生）' }
            : {
                window: view.report.window,
                summary: view.report.dominant !== undefined ? `主因路由 ${view.report.dominant.route}` : '暂无主因',
                report: reportToJson(view.report),
              }
        if (view !== null && view.items.length > 0) {
          out['narrative'] = view.items.map((item) => item.text)
        }
        return Promise.resolve(out)
      },
    }),
  )
}

/** 人读思考税面板行（供 formatStatusSummary 复用）。 */
export function formatReasoningTaxLines(payload: ReasoningTaxPanelPayload): string[] {
  const r = payload.report
  const dominant = r.dominant
  const budget =
    r.budget !== undefined
      ? ` · 推理税预算 ${Math.round(r.budget.ratio * 100)}%（${r.budget.level}）`
      : ''
  return [
    `推理税治理: 推理 ${r.totalReasoningTokens.toLocaleString()} tokens（思考税 ${Math.round(r.taxRatio * 100)}% · 估算 ${r.totalTaxCost.toFixed(2)}）` +
      (dominant !== undefined ? ` · 主因路由 ${dominant.route}` : '') +
      budget,
  ]
}