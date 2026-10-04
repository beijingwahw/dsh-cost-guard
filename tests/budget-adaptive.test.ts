import { describe, it, expect } from 'vitest'
import { createBudgetEvaluator } from '../src/core/budget.js'
import type { GovernorOutput } from '../src/core/governor.js'
import type { BudgetPolicy } from '../src/core/types.js'

const policies: BudgetPolicy[] = [
  { scope: 'session', limit: 10, warnAt: 0.8, hardAt: 1 },
  { scope: 'day', limit: 100, warnAt: 0.8, hardAt: 1 },
  { scope: 'month', limit: 1000, warnAt: 0.8, hardAt: 1 },
  { scope: 'total', limit: 5000, warnAt: 0.8, hardAt: 1 },
]

/** 构造一个确定性的 governor 输出。 */
function gov(partial: Partial<GovernorOutput>): GovernorOutput {
  return {
    dayAllowance: 80,
    dayRemaining: 30,
    pressure: 1,
    warnAt: 0.8,
    hardAt: 1,
    projectedMonthRemaining: 200,
    carryOver: 200,
    exhausted: false,
    ...partial,
  }
}

describe('budget adaptive（自适应调节治理，0.5.0）', () => {
  it('未配置 adaptive 策略：即便注入 governor 也忽略，与 0.4.0 语义一致', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({
      spent: { day: 50 },
      adaptive: { governor: gov({ warnAt: 0.1, hardAt: 0.2 }) },
    })
    expect(d.action).toBe('allow')
    expect(d.adaptive).toBeUndefined()
    expect(d.predictive).toBeUndefined()
  })

  it('adaptive 启用但未注入 governor：回退静态水位，不输出 adaptive', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: {} })
    const d = ev.decide({ spent: { day: 50 } })
    expect(d.action).toBe('allow')
    expect(d.triggers).toHaveLength(0)
    expect(d.adaptive).toBeUndefined()
  })

  it('动态水位收紧：背压强时硬水位下调，达到即熔断', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: {} })
    // 背压 0.4 -> warnAt=0.52 hardAt=0.94；花 95/100 = 0.95 静态不会硬熔断，动态触发
    const d = ev.decide({
      spent: { day: 95 },
      adaptive: { governor: gov({ pressure: 0.4, warnAt: 0.52, hardAt: 0.94 }) },
    })
    expect(d.triggers.some((t) => t.scope === 'day' && t.level === 'hard')).toBe(true)
    expect(d.action).toBe('block')
    expect(d.adaptive?.cue).toBe('frugal')
  })

  it('动态水位告警：背压中等时预警比静态更早', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: {} })
    const d = ev.decide({
      spent: { day: 90 },
      adaptive: { governor: gov({ pressure: 0.6, warnAt: 0.7, hardAt: 1 }) },
    })
    expect(d.triggers.some((t) => t.scope === 'day' && t.level === 'warn')).toBe(true)
    expect(d.action).toBe('warn')
    expect(d.adaptive?.cue).toBe('frugal')
  })

  it('今日额度耗尽（exhausted）：默认告警而非熔断', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: {} })
    const d = ev.decide({
      spent: { day: 40 },
      adaptive: { governor: gov({ dayAllowance: 40, dayRemaining: 0, exhausted: true, pressure: 0.3 }) },
    })
    expect(d.action).toBe('warn')
    const p = d.predictive?.find((x) => x.kind === 'adaptive')
    expect(p?.level).toBe('warn')
    expect(p?.detail).toContain('耗尽')
  })

  it('onExhausted=block：今日额度耗尽即熔断本周期', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: { onExhausted: 'block' } })
    const d = ev.decide({
      spent: { day: 40 },
      adaptive: { governor: gov({ dayAllowance: 40, dayRemaining: 0, exhausted: true, pressure: 0.9 }) },
    })
    expect(d.action).toBe('block')
    expect(d.predictive?.find((x) => x.kind === 'adaptive')?.level).toBe('hard')
  })

  it('scope 可配置：对 total 应用动态水位', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: { scope: 'total' } })
    const d = ev.decide({
      spent: { total: 2500 }, // 2500/5000 = 0.5，静态 warnAt=0.8 不触发
      adaptive: { governor: gov({ warnAt: 0.45, hardAt: 0.9, pressure: 0.8 }) },
    })
    expect(d.triggers.some((t) => t.scope === 'total' && t.level === 'warn')).toBe(true)
    expect(d.adaptive?.scope).toBe('total')
  })

  it('cue 级别：exhausted→minimal；高/中压力→calm/frugal', () => {
    const ev = createBudgetEvaluator(policies, { adaptive: {} })
    const calm = ev.decide({ spent: {}, adaptive: { governor: gov({ pressure: 0.95, exhausted: false }) } })
    expect(calm.adaptive?.cue).toBe('calm')
    const frugal = ev.decide({ spent: {}, adaptive: { governor: gov({ pressure: 0.6, exhausted: false }) } })
    expect(frugal.adaptive?.cue).toBe('frugal')
    const minimal = ev.decide({ spent: {}, adaptive: { governor: gov({ pressure: 1, exhausted: true }) } })
    expect(minimal.adaptive?.cue).toBe('minimal')
  })

  it('adaptive 与预测式治理共存：偏移不干扰 projection/preflight', () => {
    const ev = createBudgetEvaluator(policies, {
      adaptive: { onExhausted: 'block' },
      projections: { day: { warnAt: 0.8, hardAt: 1 } },
      preflight: { mode: 'expected', action: 'block', scope: 'day' },
    })
    const d = ev.decide({
      spent: { day: 10 },
      forecast: { projected: { day: 120 } },
      adaptive: { governor: gov({ exhausted: true }) },
    })
    // projection hard 优先 block；adaptive exhausted 也 block，两者同向
    expect(d.action).toBe('block')
    const kinds = d.predictive?.map((x) => x.kind) ?? []
    expect(kinds).toContain('projection')
    expect(kinds).toContain('adaptive')
  })
})