import { describe, it, expect } from 'vitest'
import { Meter, WindowMeter } from '../src/core/meter.js'
import { createBudgetEvaluator } from '../src/core/budget.js'
import { buildCostStatus, formatStatusSummary } from '../src/harness/tool.js'
import { buildPricingTable } from '../src/core/pricing.js'
import type { GuardHandle } from '../src/harness/guard.js'
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

function idleGuard(): GuardHandle {
  return {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: () => ({ action: 'allow', triggers: [] }),
  }
}

describe('tool.buildCostStatus / formatStatusSummary', () => {
  it('状态同时输出话费与积分（两维度独立、互不影响）', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, credits: 5 }))
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 20, credits: 300 }), 's1')
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 20, credits: 300 }))

    const st = buildCostStatus(meter, windows, evaluator, idleGuard())
    expect(st.total.cost).toBe(22)
    expect(st.total.credits).toBe(305)
    expect(st.total.tokens).toBe(300)
    expect(st.total.requests).toBe(2)
    expect(st.session.cost).toBe(20)
    expect(st.session.credits).toBe(300)
    expect(st.day.cost).toBe(20)
    expect(st.day.credits).toBe(300)
    expect(st.month.credits).toBe(300)
    expect(st.routes['deepseek/deepseek-reasoner']!.credits).toBe(300)
    expect(st.routes['deepseek/deepseek-chat']!.credits).toBe(5)
    expect(st.guard.action).toBe('allow')
  })

  it('摘要同时呈现总花费与总积分，路由行带积分', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 20, credits: 300 }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 20, credits: 300 }))

    const summary = formatStatusSummary(buildCostStatus(meter, windows, evaluator, idleGuard()))
    expect(summary).toContain('总花费 20')
    expect(summary).toContain('总积分 300')
    expect(summary).toContain('今日 20')
    expect(summary).toContain('本月 20')
    expect(summary).toContain('deepseek/deepseek-reasoner 20')
    expect(summary).not.toContain('预算状态')
  })

  it('摘要熔断行保留（预算语义不受积分影响）', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([{ scope: 'total', limit: 1, warnAt: 0.8, hardAt: 1 }])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 20, credits: 300 }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-reasoner' }, cost: 20, credits: 300 }))

    const guard: GuardHandle = {
      lastDecision: {
        action: 'block',
        triggers: [{ scope: 'total', spent: 20, limit: 1, ratio: 20, level: 'hard' }],
      },
      inspect: () => ({
        action: 'warn' as const,
        triggers: [{ scope: 'total', spent: 20, limit: 1, ratio: 20, level: 'hard' as const }],
      }),
    }
    const summary = formatStatusSummary(buildCostStatus(meter, windows, evaluator, guard))
    expect(summary).toContain('预算状态: warn')
  })

  it('实时追踪：当前时段 / 生效单价 / 分带分布', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, band: 'peak' }))
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1, band: 'valley' }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, band: 'peak' }))

    const bands = [
      { id: 'peak', start: '09:00', end: '18:00', prices: { 'deepseek-chat': { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 } } },
      { id: 'valley', start: '22:00', end: '08:00' },
    ]
    const baseline = buildPricingTable({})
    // 固定时钟 2023-11-14 14:33 UTC = 22:33 +08 -> valley
    const st = buildCostStatus(meter, windows, evaluator, idleGuard(), {
      bands: bands as never,
      baseline,
      tzOffsetMin: 480,
      now: () => 1_700_000_000_000,
    })
    expect(st.band.current).toBe('valley')
    expect(st.band.active?.start).toBe('22:00')
    expect(st.band.schedule).toHaveLength(2)
    // 生效单价：valley 无覆盖 -> 基准价；peak 带内 chat 覆盖价 6 仍可查
    expect(st.activePrices['deepseek-chat']!.inputPerMillion).toBe(2)
    expect(st.activePrices['deepseek-reasoner']!.inputPerMillion).toBe(4)
    // 分带分布
    expect(st.bandTotals['peak']!.cost).toBe(2)
    expect(st.bandTotals['valley']!.cost).toBe(1)
    expect(st.todayBands['peak']!.cost).toBe(2)
  })

  it('未配置时段时实时状态回退基准价展示', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2 }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2 }))

    const st = buildCostStatus(meter, windows, evaluator, idleGuard(), { baseline: buildPricingTable({}), tzOffsetMin: 480 })
    expect(st.band.current).toBe(BASE_BAND)
    expect(st.band.active).toBeNull()
    expect(st.band.schedule).toEqual([])
    const summary = formatStatusSummary(st)
    expect(summary).toContain('当前时段: 基准价（未配置峰谷）')
  })

  it('摘要包含当前时段与今日分带', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, band: 'peak' }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, band: 'peak' }))

    const bands = [{ id: 'peak', start: '09:00', end: '18:00' }]
    const baseline = buildPricingTable({})
    // 固定时钟 2023-11-14 02:00 UTC = 10:00 +08 -> peak
    const st = buildCostStatus(meter, windows, evaluator, idleGuard(), {
      bands: bands as never,
      baseline,
      tzOffsetMin: 480,
      now: () => Date.UTC(2023, 10, 14, 2, 0, 0),
    })
    const summary = formatStatusSummary(st)
    expect(summary).toContain('当前时段: peak (09:00-18:00)')
    expect(summary).toContain('今日分带: peak 2')
  })
})