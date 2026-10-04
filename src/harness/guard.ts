/**
 * @module dsh-cost-guard/harness/guard
 * 熔断防护层：在 `agent/pre-step`（waterfall）中检查预算。
 * 命中硬限 -> 返回 reject（阻止进入下一步）并调用 agent.cancel 终止轮次；
 * 命中告警水位 -> 允许继续但记录告警日志，通知宿主。
 *
 * 设计说明：
 * - agent/pre-step 是请求推导前唯一的 waterfall 链，返回 reject 不会打开步骤，
 *   这是『阻止模型继续烧钱』最干净的位置。
 * - 我们不拦截工具本身（tools/pre-execute 只拦工具调用，拦不住推理 token），
 *   而是在新一轮模型请求之前做整体检查。
 * - 熔断消息通过 ctx.logger 输出，并可挂接宿主通知（插件可扩展 notify 回调）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { BudgetDecision, BudgetScope } from '../core/types.js'
import type { BudgetEvaluator } from '../core/budget.js'
import type { Meter } from '../core/meter.js'

export type GuardMode = 'off' | 'warn' | 'block'

export interface GuardOptions {
  /** 熔断模式：off=只计量；warn=超限只告警；block=超限阻断（默认）。 */
  mode: GuardMode
  /** 是否在硬阻断时同时调用 agent.cancel 终止轮次（默认 true）。 */
  cancelOnBlock: boolean
  /** 告警补充回调（通知宿主 / 桌面通知 / 日志等）。 */
  onViolation?: (decision: BudgetDecision, scope: BudgetScope) => void
}

/** 由 Meter 快照构造预算评估输入。 */
export function budgetInputFromMeter(meter: Meter): { spent: Partial<Record<BudgetScope, number>> } {
  const spent: Partial<Record<BudgetScope, number>> = {}
  for (const scope of ['total', 'day', 'month', 'session'] as const) {
    spent[scope] = meter.spent(scope).cost
  }
  return { spent }
}

export interface GuardHandle {
  /** 最近一次决策（供面板 / 工具读取）。 */
  lastDecision: BudgetDecision
  /** 检查当前状态（不改变行为）。 */
  inspect(): BudgetDecision
}

/** 挂载 agent/pre-step 熔断。返回句柄供外部读取最近决策。 */
export function attachGuard(
  ctx: Context,
  evaluator: BudgetEvaluator,
  meter: Meter,
  options: GuardOptions,
): GuardHandle {
  const state: GuardHandle = {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: () => evaluator.decide(budgetInputFromMeter(meter)),
  }

  if (options.mode === 'off') {
    // 只计量不干预：每次决策仅记录，不挂监听
    state.inspect = () => evaluator.decide(budgetInputFromMeter(meter))
    return state
  }

  ctx.on(
    'agent/pre-step',
    async (
      payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      const decision = evaluator.decide(budgetInputFromMeter(meter))
      state.lastDecision = decision

      if (decision.action === 'block') {
        const hard = decision.triggers.find((t) => t.level === 'hard')
        const scope = hard?.scope ?? 'total'
        const reason = `[cost-guard] ${scope} 预算已耗尽 (${hard ? hard.spent.toFixed(2) : '?'}/${hard ? hard.limit.toFixed(2) : '?'})，已熔断。`
        ctx.logger('cost-guard').warn(reason)
        options.onViolation?.(decision, scope)
        if (options.cancelOnBlock) {
          try {
            payload.agent.cancel({ kind: 'hook', reason })
          } catch {
            /* agent 已退出时忽略 */
          }
        }
        return { kind: 'reject' as const }
      }

      if (decision.action === 'warn') {
        const w = decision.triggers.find((t) => t.level === 'warn')
        if (w) {
          ctx.logger('cost-guard').warn(
            `[cost-guard] ${w.scope} 预算达到 ${Math.round(w.ratio * 100)}% (${w.spent.toFixed(2)}/${w.limit.toFixed(2)})，请留意。`,
          )
          options.onViolation?.(decision, w.scope)
        }
      }

      return next()
    },
  )

  return state
}