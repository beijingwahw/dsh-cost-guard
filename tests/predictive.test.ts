import { describe, it, expect } from 'vitest'
import { Meter } from '../src/core/meter.js'
import { buildPricingTable } from '../src/core/pricing.js'
import type { UsageEntry } from '../src/core/types.js'
import { CostTrail } from '../src/core/trail.js'
import { MadDetector } from '../src/core/anomaly.js'
import {
  sampleEntry,
  buildForecastContext,
  preStepEstimate,
  type PredictiveRuntime,
} from '../src/harness/predictive.js'
import { budgetInputFromMeter } from '../src/harness/guard.js'
import { createBudgetEvaluator } from '../src/core/budget.js'

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    time: 1_700_000_000_000,
    route: { provider: 'deepseek', model: 'deepseek-chat' },
    usage: { inputTokens: 1000, outputTokens: 500 },
    cacheReadTokens: 0,
    reasoningTokens: 0,
    cost: 0.5,
    credits: 1,
    totalTokens: 1500,
    band: 'base',
    ...over,
  }
}

function makeRuntime(now: () => number): PredictiveRuntime {
  return {
    trail: new CostTrail(),
    detector: new MadDetector(),
    meter: new Meter(480),
    pricing: buildPricingTable({}),
    fallbackRoute: { provider: 'deepseek', model: 'deepseek-chat' },
    tzOffsetMin: 480,
    now,
  }
}

describe('harness.predictive（预测式治理装配）', () => {
  it('sampleEntry 采样四维轨迹与尖峰窗口', () => {
    const rt = makeRuntime(() => 1_700_000_000_000)
    // 与 attachMeters 一致：先入账 meter，再采样
    rt.meter.record(entry({ time: 1_700_000_000_000, cost: 0.5 }), 's1')
    sampleEntry(rt, entry({ time: 1_700_000_000_000, cost: 0.5 }), 's1')
    rt.meter.record(entry({ time: 1_700_000_000_100, cost: 1.5 }), 's1')
    sampleEntry(rt, entry({ time: 1_700_000_000_100, cost: 1.5 }), 's1')
    expect(rt.trail.points('total')).toHaveLength(2)
    expect(rt.trail.latestCost('day')).toBe(2)
    expect(rt.trail.points('month')).toHaveLength(2)
    expect(rt.trail.points('session')).toHaveLength(2)
    expect(rt.detector.size).toBe(2)
  })

  it('buildForecastContext 输出 day/month 到期投影与尖峰级别', () => {
    const nowMs = 1_700_000_000_000
    const rt = makeRuntime(() => nowMs)
    // 注入近似线性的累计轨迹：每 10 分钟 +1
    for (let i = 0; i < 4; i++) {
      const t = nowMs - (3 - i) * 600_000
      rt.meter.record(entry({ time: t, cost: i + 1 }))
      rt.trail.push('day', t, i + 1)
      rt.trail.push('month', t, i + 1)
    }
    const ctx = buildForecastContext(rt)
    expect(ctx.projected?.day).toBeGreaterThan(1)
    expect(ctx.projected?.month).toBeGreaterThan(1)
    expect(ctx.spike).toBeUndefined() // 样本不足 7 时不可判定
  })

  it('buildForecastContext 携带尖峰级别（窗口充足时）', () => {
    const rt = makeRuntime(() => 1_700_000_000_000)
    // 30 个正常 1~3 的样本 + 1 个极值
    for (let i = 0; i < 30; i++) rt.detector.push(1 + (i % 3))
    rt.detector.push(100)
    const ctx = buildForecastContext(rt)
    expect(ctx.spike?.level).toBe('extreme')
  })

  it('预算决策集成预测式熔断（真实核心链路）', () => {
    const nowMs = 1_700_000_000_000
    const rt = makeRuntime(() => nowMs)
    // 已花 50/100 日预算，但轨迹显示今天将用完预算
    rt.meter.record(entry({ time: nowMs - 3 * 600_000, cost: 30 }))
    rt.trail.push('day', nowMs - 3 * 600_000, 30)
    rt.meter.record(entry({ time: nowMs - 600_000, cost: 20 }))
    rt.trail.push('day', nowMs - 600_000, 50)

    const ev = createBudgetEvaluator(
      [{ scope: 'day', limit: 100, warnAt: 0.8, hardAt: 1 }],
      { projections: { day: { target: '今日结束', warnAt: 0.8, hardAt: 1 } } },
    )
    const input = budgetInputFromMeter(rt.meter, buildForecastContext(rt))
    const d = ev.decide(input)
    expect(d.action).toBe('block')
    expect(d.predictive?.[0]?.kind).toBe('projection')
  })

  it('preStepEstimate 按消息字符量估算成本（请求发出前）', () => {
    const rt = makeRuntime(() => 1_700_000_000_000)
    const est = preStepEstimate(4000, rt) // 约 1000 tokens
    expect(est).toBeDefined()
    expect(est!.minCost).toBeGreaterThan(0)
    expect(est!.predictedOutputTokens).toBeCloseTo(1000 * 0.5)
    expect(preStepEstimate(0, rt)).toBeUndefined()
  })
})