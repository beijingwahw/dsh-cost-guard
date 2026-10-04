import { describe, it, expect } from 'vitest'
import { Meter, WindowMeter } from '../src/core/meter.js'
import { dayKey, monthKey, FixedClock } from '../src/core/clock.js'
import type { UsageEntry } from '../src/core/types.js'
import { BASE_BAND } from '../src/core/types.js'

function entry(partial: Partial<UsageEntry> & { route: UsageEntry['route'] }): UsageEntry {
  return {
    time: partial.time ?? 1_700_000_000_000,
    route: partial.route,
    usage: partial.usage ?? { inputTokens: 100, outputTokens: 50 },
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    reasoningTokens: partial.reasoningTokens ?? 0,
    cost: partial.cost ?? 0.01,
    credits: partial.credits ?? 0,
    totalTokens: partial.totalTokens ?? 150,
    band: partial.band ?? BASE_BAND,
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
  it('按 session / total 累计（含积分）', () => {
    const m = new Meter(480)
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1, credits: 10 }))
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, credits: 20 }), 's1')
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 3, credits: 30 }), 's1')
    expect(m.spent('total').cost).toBe(6)
    expect(m.spent('total').credits).toBe(60)
    expect(m.spent('total').requests).toBe(3)
    expect(m.spent('session').cost).toBe(5)
    expect(m.spent('session').credits).toBe(50)
    const snap = m.snapshot()
    expect(snap.routes['deepseek/deepseek-chat']!.cost).toBe(3)
    expect(snap.routes['deepseek/deepseek-chat']!.credits).toBe(30)
    expect(snap.sessions['s1']!.cost).toBe(5)
    expect(snap.sessions['s1']!.credits).toBe(50)
  })

  it('缺失 credits 字段的旧快照不污染累计', () => {
    const m = new Meter(480)
    const legacy = entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1 })
    delete (legacy as Partial<UsageEntry>).credits
    m.record(legacy, 's1')
    expect(m.spent('total').cost).toBe(1)
    expect(m.spent('total').credits).toBe(0)
  })

  it('缺失 band 字段的旧条目归 BASE_BAND', () => {
    const m = new Meter(480)
    const legacy = entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1 })
    delete (legacy as Partial<UsageEntry>).band
    m.record(legacy, 's1')
    expect(m.spent('total').cost).toBe(1)
    const bands = m.bandTotals()
    expect(bands[BASE_BAND]!.cost).toBe(1)
  })

  it('分带累计与快照', () => {
    const m = new Meter(480)
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1, band: 'peak' }))
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, band: 'valley' }))
    m.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 3, band: 'peak' }), 's1')
    const bands = m.bandTotals()
    expect(bands['peak']!.cost).toBe(4)
    expect(bands['valley']!.cost).toBe(2)
    expect(bands['peak']!.requests).toBe(2)
    // 总额不因分带拆分而改变
    expect(m.spent('total').cost).toBe(6)
    const snap = m.snapshot()
    expect(snap.bands['peak']!.cost).toBe(4)
    expect(snap.bands['valley']!.cost).toBe(2)
    // 快照可回灌恢复分带
    const m2 = new Meter(480, snap)
    expect(m2.bandTotals()['peak']!.cost).toBe(4)
  })
})

describe('WindowMeter', () => {
  it('按日 / 月窗口累计（含积分）', () => {
    const w = new WindowMeter(480)
    const t1 = 1_696_521_600_000 // 2023-10-06 00:00 +08
    const t2 = t1 + 86_400_000 // 2023-10-07 00:00 +08
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: t1, cost: 1, credits: 10 }))
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: t2, cost: 2, credits: 20 }))
    expect(w.day('2023-10-06').cost).toBe(1)
    expect(w.day('2023-10-06').credits).toBe(10)
    expect(w.day('2023-10-07').cost).toBe(2)
    expect(w.day('2023-10-07').credits).toBe(20)
    expect(w.month('2023-10').cost).toBe(3)
    expect(w.month('2023-10').credits).toBe(30)
  })

  it('recentDays 以注入时钟的今天为终点', () => {
    const w = new WindowMeter(480, () => 1_700_000_000_000)
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: 1_700_000_000_000, cost: 9, credits: 90 }))
    const days = w.recentDays(3)
    expect(days).toHaveLength(3)
    expect(days[2]?.key).toBe(dayKey(1_700_000_000_000, 480))
    expect(days[2]?.bucket.cost).toBe(9)
    expect(days[2]?.bucket.credits).toBe(90)
    expect(w.today().cost).toBe(9)
    expect(w.today().credits).toBe(90)
    expect(w.thisMonth().cost).toBe(9)
    expect(w.thisMonth().credits).toBe(90)
  })

  it('分带日 / 月分布', () => {
    const w = new WindowMeter(480, () => 1_700_000_000_000)
    const t1 = 1_696_521_600_000 // 2023-10-06 00:00 +08
    const t2 = t1 + 86_400_000 // 2023-10-07 00:00 +08
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: t1, cost: 1, band: 'peak' }))
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: t2, cost: 2, band: 'valley' }))
    expect(w.dayBands('2023-10-06')['peak']!.cost).toBe(1)
    expect(w.dayBands('2023-10-07')['valley']!.cost).toBe(2)
    expect(w.monthBands('2023-10')['peak']!.cost).toBe(1)
    expect(w.monthBands('2023-10')['valley']!.cost).toBe(2)
  })

  it('今日 / 本月分带分布（注入时钟）', () => {
    const w = new WindowMeter(480, () => 1_700_000_000_000)
    w.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, time: 1_700_000_000_000, cost: 5, band: 'peak' }))
    const today = w.todayBands()
    const month = w.thisMonthBands()
    expect(today['peak']!.cost).toBe(5)
    expect(month['peak']!.cost).toBe(5)
  })
})