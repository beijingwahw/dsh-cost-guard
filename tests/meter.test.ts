import { describe, it, expect } from 'vitest'
import { Meter, WindowMeter } from '../src/core/meter.js'
import { dayKey, monthKey, FixedClock } from '../src/core/clock.js'
import type { UsageEntry } from '../src/core/types.js'

function entry(partial: Partial<UsageEntry> & { route: UsageEntry['route'] }): UsageEntry {
  return {
    time: partial.time ?? 1_700_000_000_000,
    route: partial.route,
    usage: partial.usage ?? { inputTokens: 100, outputTokens: 50 },
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    reasoningTokens: partial.reasoningTokens ?? 0,
    cost: partial.cost ?? 0.01,
    totalTokens: partial.totalTokens ?? 150,
  }
}

describe('dayKey / monthKey', () => {
  it('东八区日界正确', () => {
    // 2023-10-05 16:00 UTC = 2023-10-06 00:00 +08
    expect(dayKey(1_696_521_600_000, 480)).toBe('2023-10-06')
    // 同一时刻 UTC 视角仍是 10-05
    expect(dayKey(1_696_521_600_000, 0)).toBe('2023-10-05')
  })

  it('月份键', () => {
    expect(monthKey(1_700_000_000_000, 480)).toBe('2023-11')
  })
})

describe('Meter', () => {
  it('按 session / total 累计', () => {
    const m = new Meter(480)
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1 }))
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2 }), 's1')
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 3 }), 's1')
    expect(m.spent('total').cost).toBe(6)
    expect(m.spent('total').requests).toBe(3)
    expect(m.spent('session').cost).toBe(5)
    const snap = m.snapshot()
    expect(snap.routes['deepseek/deepseek-chat']!.cost).toBe(3)
    expect(snap.sessions['s1']!.cost).toBe(5)
  })
})

describe('WindowMeter', () => {
  it('按日 / 月窗口累计', () => {
    const w = new WindowMeter(480)
    const t1 = 1_696_521_600_000 // 2023-10-06 00:00 +08
    const t2 = t1 + 86_400_000 // 2023-10-07 00:00 +08
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: t1, cost: 1 }))
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: t2, cost: 2 }))
    expect(w.day('2023-10-06').cost).toBe(1)
    expect(w.day('2023-10-07').cost).toBe(2)
    expect(w.month('2023-10').cost).toBe(3)
  })

  it('recentDays 以注入时钟的今天为终点', () => {
    const w = new WindowMeter(480, () => 1_700_000_000_000)
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: 1_700_000_000_000, cost: 9 }))
    const days = w.recentDays(3)
    expect(days).toHaveLength(3)
    expect(days[2]?.key).toBe(dayKey(1_700_000_000_000, 480))
    expect(days[2]?.bucket.cost).toBe(9)
    expect(w.today().cost).toBe(9)
    expect(w.thisMonth().cost).toBe(9)
  })
})