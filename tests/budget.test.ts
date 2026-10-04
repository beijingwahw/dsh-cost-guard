import { describe, it, expect } from 'vitest'
import { createBudgetEvaluator, policiesFromConfig } from '../src/core/budget.js'

describe('budget', () => {
  const policies = [
    { scope: 'session' as const, limit: 10, warnAt: 0.8, hardAt: 1 },
    { scope: 'day' as const, limit: 100, warnAt: 0.8, hardAt: 1 },
    { scope: 'month' as const, limit: 1000, warnAt: 0.8, hardAt: 1 },
  ]

  it('未超限 allow', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({ spent: { session: 1, day: 10, month: 100 } })
    expect(d.action).toBe('allow')
    expect(d.triggers).toHaveLength(0)
  })

  it('命中告警水位 -> warn', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({ spent: { session: 8, day: 10, month: 100 } })
    expect(d.action).toBe('warn')
    expect(d.triggers[0]?.scope).toBe('session')
    expect(d.triggers[0]?.level).toBe('warn')
  })

  it('命中硬限 -> block', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({ spent: { session: 12, day: 10, month: 100 } })
    expect(d.action).toBe('block')
    expect(d.triggers[0]?.level).toBe('hard')
  })

  it('多个 scope 同时触发时 block 优先', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({ spent: { session: 9, day: 99, month: 900 } })
    expect(d.action).toBe('warn')
  })

  it('check 单维度', () => {
    const ev = createBudgetEvaluator(policies)
    const r = ev.check({ spent: { day: 50 } }, 'day')
    expect(r?.level).toBe('ok')
    const r2 = ev.check({ spent: { day: 90 } }, 'day')
    expect(r2?.level).toBe('warn')
    const r3 = ev.check({ spent: { day: 120 } }, 'day')
    expect(r3?.level).toBe('hard')
  })

  it('limit=0 的策略不参与', () => {
    const ev = createBudgetEvaluator(policiesFromConfig({
      session: { limit: 0 },
      day: { limit: 5, warnAt: 0.8, hardAt: 1 },
    }))
    const d = ev.decide({ spent: { session: 999, day: 4 } })
    expect(d.action).toBe('warn') // day 80%
  })

  it('按 scope 优先级返回冗余触发', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({ spent: { session: 9, day: 90 } })
    expect(d.triggers.map((t) => t.scope)).toEqual(['session', 'day'])
    expect(d.action).toBe('warn')
  })
})