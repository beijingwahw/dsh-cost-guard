import { describe, it, expect } from 'vitest'
import { createBudgetEvaluator } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/types.js'

const policies: BudgetPolicy[] = [
  { scope: 'session', limit: 10, warnAt: 0.8, hardAt: 1 },
  { scope: 'day', limit: 100, warnAt: 0.8, hardAt: 1 },
  { scope: 'month', limit: 1000, warnAt: 0.8, hardAt: 1 },
  { scope: 'total', limit: 5000, warnAt: 0.8, hardAt: 1 },
]

describe('budget predictive（预测式治理）', () => {
  it('未配置 predictive 策略时：与 0.3.0 语义一致，即使传入 forecast 也忽略', () => {
    const ev = createBudgetEvaluator(policies)
    const d = ev.decide({
      spent: { day: 50 },
      forecast: { projected: { day: 9999 }, spike: { level: 'extreme' }, estimate: { minCost: 1, expectedCost: 2, ceilingCost: 3, predictedOutputTokens: 0 } },
    })
    expect(d.action).toBe('allow')
    expect(d.triggers).toHaveLength(0)
    expect(d.predictive).toBeUndefined()
  })

  describe('到期投影 projection', () => {
    const predictive = {
      projections: {
        day: { target: '今日结束', warnAt: 0.8, hardAt: 1 },
        month: { target: '月末', warnAt: 0.8, hardAt: 1 },
      },
    }

    it('预测成本未到阈值 -> 不触发', () => {
      const ev = createBudgetEvaluator(policies, predictive)
      const d = ev.decide({ spent: { day: 20 }, forecast: { projected: { day: 50 } } })
      expect(d.action).toBe('allow')
      expect(d.predictive).toBeUndefined()
    })

    it('预测成本越过 warnAt -> warn', () => {
      const ev = createBudgetEvaluator(policies, predictive)
      const d = ev.decide({ spent: { day: 20 }, forecast: { projected: { day: 90 } } })
      expect(d.action).toBe('warn')
      const p = d.predictive?.find((x) => x.kind === 'projection')
      expect(p?.scope).toBe('day')
      expect(p?.level).toBe('warn')
      expect(p?.detail).toContain('今日结束')
    })

    it('预测成本越过 hardAt -> block（提前熔断）', () => {
      const ev = createBudgetEvaluator(policies, predictive)
      const d = ev.decide({ spent: { day: 20 }, forecast: { projected: { day: 150 } } })
      expect(d.action).toBe('block')
      expect(d.predictive?.[0]?.level).toBe('hard')
    })
  })

  describe('尖峰 spike', () => {
    it("阈值 'extreme'：extreme 触发 block；spike 不触发", () => {
      const ev = createBudgetEvaluator(policies, { spike: { level: 'extreme', action: 'block' } })
      expect(ev.decide({ spent: {}, forecast: { spike: { level: 'spike' } } }).action).toBe('allow')
      const d = ev.decide({ spent: {}, forecast: { spike: { level: 'extreme' } } })
      expect(d.action).toBe('block')
      expect(d.predictive?.[0]?.kind).toBe('spike')
    })

    it("阈值 'spike'：spike 即触发 warn", () => {
      const ev = createBudgetEvaluator(policies, { spike: { level: 'spike', action: 'warn' } })
      const d = ev.decide({ spent: {}, forecast: { spike: { level: 'spike' } } })
      expect(d.action).toBe('warn')
      expect(d.predictive?.[0]?.level).toBe('warn')
    })
  })

  describe('请求级预检 preflight', () => {
    const estimate = { minCost: 40, expectedCost: 60, ceilingCost: 100, predictedOutputTokens: 0 }

    it('expected 模式：used + expected >= limit -> block（默认 scope total）', () => {
      const ev = createBudgetEvaluator(policies, { preflight: { mode: 'expected', action: 'block' } })
      // total limit=5000，used=4960，expected=60 -> 越线
      const d = ev.decide({ spent: { total: 4960 }, forecast: { estimate } })
      expect(d.action).toBe('block')
      expect(d.predictive?.[0]?.kind).toBe('preflight')
      expect(d.predictive?.[0]?.scope).toBe('total')
    })

    it('min 模式：即使 expected 不越线，min 越线也拦截（输入成本必然发生）', () => {
      const ev = createBudgetEvaluator(policies, { preflight: { mode: 'min', action: 'warn' } })
      const d = ev.decide({ spent: { total: 4980 }, forecast: { estimate } })
      expect(d.action).toBe('warn')
      expect(d.predictive?.[0]?.level).toBe('warn')
    })

    it('不影响其他 scope：预检只盯指定 scope', () => {
      const ev = createBudgetEvaluator(policies, { preflight: { mode: 'expected', action: 'block', scope: 'day' } })
      // day limit=100，used=50，expected=40 -> 90 < 100 放行
      const ok = ev.decide({ spent: { day: 50 }, forecast: { estimate: { ...estimate, expectedCost: 40 } } })
      expect(ok.action).toBe('allow')
      // 50 + 60 = 110 >= 100 -> block
      const d = ev.decide({ spent: { day: 50 }, forecast: { estimate } })
      expect(d.action).toBe('block')
    })

    it('scope 未配置 limit -> 不预检放行', () => {
      const ev = createBudgetEvaluator([{ scope: 'day', limit: 100, warnAt: 0.8, hardAt: 1 }], {
        preflight: { mode: 'expected', action: 'block', scope: 'month' },
      })
      const d = ev.decide({ spent: { month: 0 }, forecast: { estimate } })
      expect(d.action).toBe('allow')
    })
  })

  describe('决策优先级与组合', () => {
    it('预测 block 优先于既有 warn', () => {
      const ev = createBudgetEvaluator(policies, {
        projections: { day: { warnAt: 0.8, hardAt: 1 } },
      })
      const d = ev.decide({ spent: { day: 90 }, forecast: { projected: { day: 120 } } })
      expect(d.action).toBe('block')
      // 既有水位 warn + 预测 hard 同时存在
      expect(d.triggers.some((t) => t.level === 'warn')).toBe(true)
      expect(d.predictive?.[0]?.level).toBe('hard')
    })

    it('既有 hard block 优先于预测 warn', () => {
      const ev = createBudgetEvaluator(policies, {
        projections: { day: { warnAt: 0.8, hardAt: 1 } },
      })
      const d = ev.decide({ spent: { session: 12 }, forecast: { projected: { day: 90 } } })
      expect(d.action).toBe('block')
      expect(d.triggers[0]?.scope).toBe('session')
      expect(d.predictive?.[0]?.level).toBe('warn')
    })

    it('预测 warn 优先于 allow（全部叠加）', () => {
      const ev = createBudgetEvaluator(policies, {
        projections: { day: { warnAt: 0.8, hardAt: 1 } },
      })
      const d = ev.decide({ spent: {}, forecast: { projected: { day: 85 } } })
      expect(d.action).toBe('warn')
    })
  })
})