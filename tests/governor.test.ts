import { describe, it, expect } from 'vitest'
import { govern, defaultGovernorConfig } from '../src/core/governor.js'
import { daysLeftInMonth, endOfMonthEpoch } from '../src/core/clock.js'

describe('governor（自适应预算调节器）', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    monthSpent: 0,
    daySpent: 0,
    daysLeftInMonth: 30,
    carriedIn: 0,
    ...over,
  })

  it('月度 → 日额度动态派生：剩余预算 / 剩余天数 × (1 - 留存)', () => {
    // 月 3000，已花 0，剩余 30 天 -> 日均 3000/30=100，留存 10% -> 90
    const g = govern({ ...defaultGovernorConfig, monthLimit: 3000 }, base())
    expect(g.dayAllowance).toBeCloseTo(90, 6)
    expect(g.pressure).toBe(1)
    expect(g.warnAt).toBe(0.8)
    expect(g.hardAt).toBe(1)
    expect(g.exhausted).toBe(false)
  })

  it('月度已消耗一半：按剩余可用/剩余天数 + 留存', () => {
    // 月 3000，已花 1500，剩余 15 天 -> (3000-1500)*0.9/15 = 90
    const g = govern({ ...defaultGovernorConfig, monthLimit: 3000 }, base({ monthSpent: 1500, daysLeftInMonth: 15 }))
    expect(g.dayAllowance).toBeCloseTo(90, 6)
  })

  it('背压：今日预测超支 → 收紧日额度与动态水位', () => {
    // 日额度 90，但预测今日结束花 120（超 33%）-> 背压 0.5
    const g = govern(
      { ...defaultGovernorConfig, monthLimit: 3000 },
      base({ dayProjected: 120 }),
    )
    // pressure = 1 - (1 - 90/120) * 0.5 = 1 - 0.25*0.5 = 0.875
    expect(g.pressure).toBeCloseTo(0.875, 6)
    expect(g.dayAllowance).toBeCloseTo(90 * 0.875, 6)
    expect(g.warnAt).toBeLessThan(0.8)
    expect(g.hardAt).toBeLessThan(1)
  })

  it('背压：月末预测超支同样收紧', () => {
    // 月 3000，预测月末 4000 -> monthOk=0.75，pressure=1-0.25*0.5=0.875
    const g = govern(
      { ...defaultGovernorConfig, monthLimit: 3000 },
      base({ monthProjected: 4000 }),
    )
    expect(g.pressure).toBeCloseTo(0.875, 6)
  })

  it('跨周期结转：月末预测剩余按比例结转', () => {
    // 月 3000，已花 2000，预测月末花 2400 -> 剩余 600 -> 结转 600
    const g = govern(
      { ...defaultGovernorConfig, monthLimit: 3000 },
      base({ monthSpent: 2000, monthProjected: 2400 }),
    )
    expect(g.projectedMonthRemaining).toBeCloseTo(600, 6)
    expect(g.carryOver).toBeCloseTo(600, 6)
    // 结转比例 50% -> 300
    const g2 = govern(
      { ...defaultGovernorConfig, monthLimit: 3000, carryOverRatio: 0.5 },
      base({ monthSpent: 2000, monthProjected: 2400 }),
    )
    expect(g2.carryOver).toBeCloseTo(300, 6)
  })

  it('上期结转加入可用池：增大日额度', () => {
    // 上期结转 300 -> 月可用 3300 -> 日均 99（留 10%）
    const g = govern(
      { ...defaultGovernorConfig, monthLimit: 3000 },
      base({ carriedIn: 300 }),
    )
    expect(g.dayAllowance).toBeCloseTo(99, 6)
  })

  it('今日已花超日额度 -> exhausted', () => {
    const g = govern(
      { ...defaultGovernorConfig, monthLimit: 3000 },
      base({ daySpent: 95 }),
    )
    expect(g.dayRemaining).toBeCloseTo(0, 6)
    expect(g.exhausted).toBe(true)
  })

  it('月度无预算且无结转 -> 今日额度为 0', () => {
    const g = govern({ ...defaultGovernorConfig, monthLimit: 0 }, base())
    expect(g.dayAllowance).toBe(0)
  })

  it('日额度下限：背压极强时保留 floorRatio 兜底', () => {
    // 预测 900（额度 90 的 10 倍）-> pressure 收至下限，日额度 >= 90*0.3=27
    const g = govern(
      { ...defaultGovernorConfig, monthLimit: 3000 },
      base({ dayProjected: 900 }),
    )
    expect(g.dayAllowance).toBeGreaterThanOrEqual(90 * 0.3 - 1e-9)
    expect(g.pressure).toBeGreaterThan(0)
  })
})

describe('clock daysLeftInMonth', () => {
  it('月初 = 全月天数；与 endOfMonthEpoch 一致', () => {
    // 2026-10-01 00:00:00 UTC+8
    const start = Date.UTC(2026, 9, 1) - 480 * 60_000
    expect(daysLeftInMonth(start, 480)).toBe(31)
    // 2026-10-31 12:00 -> 还剩 1 天
    const late = Date.UTC(2026, 9, 31, 12) - 480 * 60_000
    expect(daysLeftInMonth(late, 480)).toBe(1)
    // 月末最后一刻 -> 至少 1
    const end = endOfMonthEpoch(start, 480) - 1
    expect(daysLeftInMonth(end, 480)).toBe(1)
  })
})