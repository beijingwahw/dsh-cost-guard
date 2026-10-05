/**
 * @module dsh-cost-guard/harness/alert
 * 告警根因解释（0.15.0，可选）DSH 适配层：
 * - 在 Guard 告警触发（onViolation）后，把告警信号 + 当前计量快照的根因报表
 *   合成**告警根因叙事**（core/alert-explain.ts），并通过宿主回调通知。
 * - 借助 ExplainRuntime 的基线语义：首次触发为存量构成归因（并沉淀基线），
 *   后续触发与该告警前的基线对比 → 增量根因（Δ 贡献），回答「这次为什么超」。
 *
 * 兼容边界：`explain.alert.enabled` 缺省 false；未启用时本适配层不构造（undefined），
 * 告警通知行为与 0.14.0 完全一致（零回归）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BudgetDecision, BudgetScope } from '../core/types.js'
import type { RootCauseReport } from '../core/rca.js'
import {
  buildAlarmExplanation,
  formatAlarmLines,
  type AlarmExplainItem,
  type AlarmSignal,
} from '../core/alert-explain.js'
import type { ExplainRuntime } from './explain.js'

/** 告警根因通知负载（供宿主回调 / 日志 / IM 转发）。 */
export interface ExplainAlarmPayload {
  /** 触发告警的预算范围。 */
  scope: BudgetScope
  /** 决策动作。 */
  action: 'warn' | 'block'
  /** 归因窗口（report.window 投影；delta=与告警前基线增量归因）。 */
  window: 'current' | 'delta'
  /** 根因报表（JSON 安全，供宿主深处理）。 */
  report: RootCauseReport
  /** 人读叙事行（summary / factor / suggestion）。 */
  lines: string[]
}

export interface AlertExplainOptions {
  /** 宿主告警通知回调（IM / 桌面通知 / 转发）。 */
  onExplainAlarm?: (payload: ExplainAlarmPayload) => void
  /** 单次通知最多建议条数（默认 2）。 */
  maxSuggestions?: number
}

const DEFAULT_OPTIONS: Required<Pick<AlertExplainOptions, 'maxSuggestions'>> = { maxSuggestions: 2 }

/** 把 Guard 决策投影为告警信号（数学事实，无副作用）。 */
function signalFromDecision(
  decision: BudgetDecision,
  scope: BudgetScope,
  detail?: string,
): AlarmSignal {
  const trigger = decision.triggers.find((t) => t.scope === scope && t.level === (decision.action === 'block' ? 'hard' : 'warn'))
  // onViolation 只在 warn/block 分支回调，这里把 action 窄化投影为通知负载允许的取值
  // （类型上 BudgetDecision.action 含 'allow'，运行时不会出现，窄化保证编译契约安全）。
  // exactOptionalPropertyTypes 下用展开式保留「无 trigger 时不下发空字段」的语义。
  return {
    scope,
    action: decision.action === 'block' ? 'block' : 'warn',
    ...(trigger !== undefined ? { ratio: trigger.ratio, spent: trigger.spent, limit: trigger.limit } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

/**
 * 挂载告警根因解释：在 Guard 告警触发后合成告警叙事并回调宿主。
 * 返回句柄供 index.ts 显式调用（挂在 onViolation 之后）。
 */
export function attachAlertExplain(
  ctx: Context,
  explain: ExplainRuntime,
  options: AlertExplainOptions = {},
): {
  /** 根据 Guard 决策构造告警解释并回调宿主；返回供日志追加的人读行。 */
  notify: (decision: BudgetDecision, scope: BudgetScope, detail?: string) => string[]
} {
  const logger = ctx.logger('cost-guard')
  const opts = { ...DEFAULT_OPTIONS, ...options }

  /**
   * 宿主回调隔离：宿主注入的任意回调抛错不允许反噬告警主流程，
   * 记录可识别错误后降级（仅影响通知，不影响熔断本身）。
   */
  const safeNotify = (payload: ExplainAlarmPayload): string[] => {
    try {
      options.onExplainAlarm?.(payload)
    } catch (err) {
      logger.error(
        `[cost-guard] 告警根因通知回调异常，已降级跳过: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return payload.lines
  }

  return {
    notify: (decision, scope, detail) => {
      const { report } = explain.explain('delta')
      const signal = signalFromDecision(decision, scope, detail)
      const items = trimSuggestions(buildAlarmExplanation(signal, report), opts.maxSuggestions)
      const lines = formatAlarmLines(items)
      const payload: ExplainAlarmPayload = {
        scope,
        action: decision.action === 'block' ? 'block' : 'warn',
        window: report.window,
        report,
        lines,
      }
      return safeNotify(payload)
    },
  }
}

/** 建议条数收敛（告警通知防刷屏）。 */
function trimSuggestions(items: AlarmExplainItem[], max: number): AlarmExplainItem[] {
  const out: AlarmExplainItem[] = []
  let suggestions = 0
  for (const item of items) {
    if (item.kind === 'suggestion') {
      if (suggestions >= max) continue
      suggestions += 1
    }
    out.push(item)
  }
  return out
}

/** 人读告警解释面板行（供 formatStatusSummary 复用；payload 需先生成）。 */
export function formatAlarmPanelLines(payload: { scope: BudgetScope; action: 'warn' | 'block'; window: 'current' | 'delta'; report: RootCauseReport }): string[] {
  const { scope, action, window, report } = payload
  return [
    `告警根因(${window}): ${scope} 预算 ${action === 'block' ? '熔断' : '告警'} · 主因会话 ${report.bySession.dominant?.key ?? '无'} · 主因路由 ${report.byRoute.dominant?.key ?? '无'} · 输出占比 ${Math.round(report.channelMix.outputShare * 100)}%`,
  ]
}