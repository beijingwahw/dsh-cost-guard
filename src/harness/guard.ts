/**
 * @module dsh-cost-guard/harness/guard
 * 熔断防护层：在 `agent/pre-step`（waterfall）中检查预算。
 * 命中硬限 -> 返回 reject（阻止进入下一步）并调用 agent.cancel 终止轮次；
 * 命中告警水位 -> 允许继续但记录告警日志，通知宿主。
 *
 * 0.4.0 预测式治理：
 * - 决策输入可携带 forecast（到期投影 / 尖峰 / 请求预检估算），
 *   由 Predictor 策略决定是否提前告警或熔断（默认不启用，语义与 0.3.0 一致）。
 * - 请求预检：pre-step 可拿到消息序列，按其字符量估算本次调用成本，
 *   在『花出去之前』判断是否会烧穿指定预算。
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
import type { BudgetEvaluator, BudgetInput, PredictivePolicy } from '../core/budget.js'
import type { RequestEstimate } from '../core/anomaly.js'
import type { Meter } from '../core/meter.js'

export type GuardMode = 'off' | 'warn' | 'block'

export interface GuardOptions {
  /** 熔断模式：off=只计量；warn=超限只告警；block=超限阻断（默认）。 */
  mode: GuardMode
  /** 是否在硬阻断时同时调用 agent.cancel 终止轮次（默认 true）。 */
  cancelOnBlock: boolean
  /** 告警补充回调（通知宿主 / 桌面通知 / 日志等）。 */
  onViolation?: (decision: BudgetDecision, scope: BudgetScope) => void
  /** 预测式治理策略（0.4.0）；缺省 = 0.3.0 语义。 */
  predictive?: PredictivePolicy
  /** 预测上下文构造器：当前 meter/trail/detector 的 forecast 输入（可选）。 */
  forecastInput?: () => BudgetInput['forecast']
  /** 请求预检：按消息字符量估算本次调用成本（可选；估算不可得时返回 undefined）。 */
  estimateFromMessages?: (chars: number) => RequestEstimate | undefined
  /** 自适应调节输入（0.5.0）：由 governor 计算的动态额度与水位（可选；需要 forecast 时接收）。 */
  adaptiveInput?: (forecast?: BudgetInput['forecast']) => BudgetInput['adaptive'] | undefined
}

/** 由 Meter 快照（+ 可选预测上下文）构造预算评估输入。 */
export function budgetInputFromMeter(
  meter: Meter,
  forecast?: BudgetInput['forecast'],
  adaptive?: BudgetInput['adaptive'],
): BudgetInput {
  const spent: Partial<Record<BudgetScope, number>> = {}
  for (const scope of ['total', 'day', 'month', 'session'] as const) {
    spent[scope] = meter.spent(scope).cost
  }
  const input: BudgetInput = { spent }
  if (forecast && Object.keys(forecast).length > 0) input.forecast = forecast
  if (adaptive) input.adaptive = adaptive
  return input
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
  const logger = ctx.logger('cost-guard')

  /**
   * 宿主回调隔离：宿主注入的任意回调（估算 / forecast / adaptive / 通知）
   * 抛错都不允许反噬 pre-step 主流程，记录可识别错误并降级为 undefined。
   */
  const safeHost = <T>(label: string, fn: () => T): T | undefined => {
    try {
      return fn()
    } catch (err) {
      logger.error(
        `[cost-guard] 宿主回调(${label})异常，已降级跳过: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  const decisionWith = (estimate?: RequestEstimate): BudgetDecision => {
    const forecast = safeHost('forecastInput', () => options.forecastInput?.())
    const merged: BudgetInput['forecast'] = forecast ? { ...forecast } : {}
    if (estimate) merged.estimate = estimate
    const adaptive = safeHost('adaptiveInput', () => options.adaptiveInput?.(merged))
    return evaluator.decide(budgetInputFromMeter(meter, merged, adaptive))
  }

  const inspectAlways = (): BudgetDecision => {
    const forecast = safeHost('forecastInput', () => options.forecastInput?.())
    const adaptive = safeHost('adaptiveInput', () => options.adaptiveInput?.(forecast))
    return evaluator.decide(budgetInputFromMeter(meter, forecast, adaptive))
  }

  const state: GuardHandle = {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: inspectAlways,
  }

  if (options.mode === 'off') {
    // 只计量不干预：每次决策仅记录，不挂监听
    state.inspect = inspectAlways
    return state
  }

  ctx.on(
    'agent/pre-step',
    async (
      payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      let decision: BudgetDecision
      try {
        // 请求级预检：消息序列字符量 -> 估算本次调用成本
        let chars = 0
        try {
          chars = JSON.stringify(payload.messages ?? []).length
        } catch {
          chars = 0
        }
        const estimate = safeHost('estimateFromMessages', () => options.estimateFromMessages?.(chars))
        decision = decisionWith(estimate)
      } catch (err) {
        // 评估本身异常：不阻断请求（避免插件故障反噬宿主推理），但必须可识别
        logger.error(`[cost-guard] 预算评估异常，本轮放行: ${err instanceof Error ? err.message : String(err)}`)
        return next()
      }
      state.lastDecision = decision

      if (decision.action === 'block') {
        const hard = decision.triggers.find((t) => t.level === 'hard')
        const predictiveHard = decision.predictive?.find((t) => t.level === 'hard')
        const scope = hard?.scope ?? predictiveHard?.scope ?? 'total'
        const reason = `[cost-guard] ${scope} 预算已耗尽 (${hard ? hard.spent.toFixed(2) : '?'}/${hard ? hard.limit.toFixed(2) : '?'})，已熔断。`
        logger.warn(reason)
        if (predictiveHard && !hard) {
          logger.warn(`[cost-guard] 预测式熔断：${predictiveHard.detail}`)
        }
        safeHost('onViolation', () => {
          options.onViolation?.(decision, scope)
        })
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
        const predictiveWarn = decision.predictive?.find((t) => t.level === 'warn')
        if (w) {
          logger.warn(
            `[cost-guard] ${w.scope} 预算达到 ${Math.round(w.ratio * 100)}% (${w.spent.toFixed(2)}/${w.limit.toFixed(2)})，请留意。`,
          )
          safeHost('onViolation', () => {
            options.onViolation?.(decision, w.scope)
          })
        }
        if (predictiveWarn && !w) {
          logger.warn(`[cost-guard] 预测式告警：${predictiveWarn.detail}`)
          safeHost('onViolation', () => {
            options.onViolation?.(decision, predictiveWarn.scope ?? 'total')
          })
        }
      }

      return next()
    },
  )

  return state
}