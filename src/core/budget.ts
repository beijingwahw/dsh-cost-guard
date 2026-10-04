/**
 * @module dsh-cost-guard/core/budget
 * 预算决策引擎：根据各 scope 已花费与策略限额定出水位与动作。
 * 纯函数：输入快照 + 策略，输出决策，无副作用，便于单测。
 */

import type { BudgetDecision, BudgetPolicy, BudgetScope } from './types.js'

export interface BudgetInput {
  /** scope -> 已花费金额。 */
  spent: Partial<Record<BudgetScope, number>>
}

export interface BudgetEvaluator {
  /** 按当前花费快照计算决策。 */
  decide(spent: BudgetInput): BudgetDecision
  /** 查询单个 scope 的触发状态（供实时询问）。 */
  check(spent: BudgetInput, scope: BudgetScope): { spent: number; limit: number; ratio: number; level: 'warn' | 'hard' | 'ok' } | undefined
}

/** 按策略构造决策器。 */
export function createBudgetEvaluator(policies: BudgetPolicy[]): BudgetEvaluator {
  const sorted = [...policies].sort((a, b) => {
    const order: Record<BudgetScope, number> = { session: 0, day: 1, month: 2, total: 3 }
    return (order[a.scope] ?? 9) - (order[b.scope] ?? 9)
  })

  const decide = (spent: BudgetInput): BudgetDecision => {
    const triggers: BudgetDecision['triggers'] = []
    let action: BudgetDecision['action'] = 'allow'

    for (const p of sorted) {
      const used = spent.spent[p.scope] ?? 0
      if (p.limit <= 0) continue
      const ratio = used / p.limit
      if (ratio >= p.hardAt) {
        triggers.push({ scope: p.scope, spent: used, limit: p.limit, ratio, level: 'hard' })
        action = 'block'
      } else if (ratio >= p.warnAt && action !== 'block') {
        triggers.push({ scope: p.scope, spent: used, limit: p.limit, ratio, level: 'warn' })
        if (action === 'allow') action = 'warn'
      }
    }

    return { action, triggers }
  }

  const check = (spent: BudgetInput, scope: BudgetScope) => {
    const p = sorted.find((x) => x.scope === scope)
    if (!p || p.limit <= 0) return undefined
    const used = spent.spent[scope] ?? 0
    const ratio = used / p.limit
    let level: 'warn' | 'hard' | 'ok' = 'ok'
    if (ratio >= p.hardAt) level = 'hard'
    else if (ratio >= p.warnAt) level = 'warn'
    return { spent: used, limit: p.limit, ratio, level }
  }

  return { decide, check }
}

/** 从配置构造策略集（未配置的 scope 不产生策略）。 */
export function policiesFromConfig(cfg: Record<string, { limit?: number; warnAt?: number; hardAt?: number }>): BudgetPolicy[] {
  const out: BudgetPolicy[] = []
  const scopes: BudgetScope[] = ['session', 'day', 'month', 'total']
  for (const s of scopes) {
    const c = cfg[s]
    if (!c || !c.limit || c.limit <= 0) continue
    out.push({
      scope: s,
      limit: c.limit,
      warnAt: c.warnAt ?? 0.8,
      hardAt: c.hardAt ?? 1,
    })
  }
  return out
}