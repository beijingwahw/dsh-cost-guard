/**
 * @module dsh-cost-guard/harness/tool
 * 成本状态工具：把实时用量与预算水位暴露给模型与用户。
 * - 注册 `cost_guard_status` 工具：Agent 可主动查询当前成本/预算状态（自感知成本）。
 * - 该工具为只读、零副作用、不摄入 prompt 大块内容。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Meter } from '../core/meter.js'
import type { WindowMeter } from '../core/meter.js'
import type { BudgetEvaluator } from '../core/budget.js'
import type { PricingTable } from '../core/pricing.js'
import { formatCost } from '../core/pricing.js'
import type { GuardHandle } from './guard.js'

export interface CostStatusPayload {
  total: { cost: number; tokens: number; requests: number }
  day: { cost: number; tokens: number; requests: number }
  month: { cost: number; tokens: number; requests: number }
  session: { cost: number; tokens: number; requests: number }
  guard: { action: string; triggers: Array<{ scope: string; spent: number; limit: number; ratio: number }> }
  routes: Record<string, { cost: number; tokens: number; requests: number }>
}

/** 汇总状态（JSON 安全，供工具与面板共用）。 */
export function buildCostStatus(
  meter: Meter,
  windows: WindowMeter,
  evaluator: BudgetEvaluator,
  guard: GuardHandle,
): CostStatusPayload {
  const total = meter.spent('total')
  const day = windows.today()
  const month = windows.thisMonth()
  const session = meter.spent('session')
  const snapshot = meter.snapshot()
  const routes: CostStatusPayload['routes'] = {}
  for (const [k, b] of Object.entries(snapshot.routes)) {
    routes[k] = { cost: b.cost, tokens: b.totalTokens, requests: b.requests }
  }
  const decision = guard.inspect()
  return {
    total: { cost: total.cost, tokens: total.totalTokens, requests: total.requests },
    day: { cost: day.cost, tokens: day.totalTokens, requests: day.requests },
    month: { cost: month.cost, tokens: month.totalTokens, requests: month.requests },
    session: { cost: session.cost, tokens: session.totalTokens, requests: session.requests },
    guard: {
      action: decision.action,
      triggers: decision.triggers.map((t) => ({ scope: t.scope, spent: t.spent, limit: t.limit, ratio: t.ratio })),
    },
    routes,
  }
}

/** 注册只读成本工具。 */
export function attachCostTool(
  ctx: Context,
  meter: Meter,
  windows: WindowMeter,
  evaluator: BudgetEvaluator,
  guard: GuardHandle,
): void {
  ctx.tools.register(
    defineTool({
      name: 'cost_guard_status',
      description:
        '读取当前 DeepSeek Harness 的 Token 用量与成本预算水位（只读）。' +
        '包含 total/day/month/session 四个维度的花费与 Token，以及预算熔断状态与按模型路由的拆分。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(): Promise<Record<string, JsonValue>> {
        // 状态快照本身是纯 JSON 结构，这里显式投影为 JSON 记录以满足工具 schema 契约。
        return buildCostStatus(meter, windows, evaluator, guard) as unknown as Record<string, JsonValue>
      },
    }),
  )
}

/** 人读摘要（面板与日志共用）。 */
export function formatStatusSummary(status: CostStatusPayload): string {
  const lines = [
    `cost-guard 总花费 ${formatCost(status.total.cost)} (${status.total.tokens.toLocaleString()} tokens, ${status.total.requests} 次调用)`,
    `  今日 ${formatCost(status.day.cost)} · 本月 ${formatCost(status.month.cost)} · 本会话 ${formatCost(status.session.cost)}`,
  ]
  if (status.guard.action !== 'allow') {
    lines.push(
      `  预算状态: ${status.guard.action} — ${status.guard.triggers
        .map((t) => `${t.scope} ${Math.round(t.ratio * 100)}%(${formatCost(t.spent)}/${formatCost(t.limit)})`)
        .join(', ')}`,
    )
  }
  const top = Object.entries(status.routes)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 3)
  if (top.length) {
    lines.push(`  主要路由: ${top.map(([k, v]) => `${k} ${formatCost(v.cost)}`).join(' · ')}`)
  }
  return lines.join('\n')
}