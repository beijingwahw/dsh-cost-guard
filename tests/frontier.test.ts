import { describe, it, expect } from 'vitest'
import { FrontierRuntime, formatFrontierLines } from '../src/harness/frontier.js'
import { Meter, WindowMeter } from '../src/core/meter.js'
import { createBudgetEvaluator } from '../src/core/budget.js'
import { buildCostStatus, formatStatusSummary, toToolJson } from '../src/harness/tool.js'
import { buildPricingTable } from '../src/core/pricing.js'
import { CacheMetrics } from '../src/core/cache-metrics.js'
import { CachePricingEngine } from '../src/core/cache-pricing.js'
import type { GuardHandle } from '../src/harness/guard.js'
import { BASE_BAND, type UsageEntry } from '../src/core/types.js'

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

describe('FrontierRuntime 入账路由', () => {
  it('focus + otel 启用时 record 同时写入两个账本', () => {
    const focusSink: unknown[] = []
    const otelSink: unknown[] = []
    const rt = new FrontierRuntime(
      { focus: { enabled: true, sink: (l) => focusSink.push(l) }, otel: { enabled: true, sink: (s) => otelSink.push(s) } },
      { currencyOf: (k) => (k.startsWith('openai/') ? 'USD' : 'CNY') },
    )
    rt.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1.5 }), 's1')
    expect(rt.focus?.count).toBe(1)
    expect(rt.otel?.count).toBe(1)
    expect(focusSink).toHaveLength(1)
    expect(otelSink).toHaveLength(1)
  })

  it('未启用的能力不构造（缺省零回归）', () => {
    const rt = new FrontierRuntime(undefined)
    expect(rt.any).toBe(false)
    expect(rt.focus).toBeUndefined()
    expect(rt.otel).toBeUndefined()
    const rt2 = new FrontierRuntime({ unitEconomy: true })
    expect(rt2.any).toBe(true)
    expect(rt2.focus).toBeUndefined()
    expect(rt2.otel).toBeUndefined()
  })

  it('currencyOf 注入到 FOCUS 行与 OTel 属性', () => {
    const rt = new FrontierRuntime({ focus: { enabled: true } }, { currencyOf: (k) => (k.includes('gpt') ? 'USD' : 'CNY') })
    rt.record(entry({ route: { provider: 'openai', model: 'gpt-5.2' }, cost: 0.5 }), 's2')
    const line = rt.focus!.lines()[0]!
    expect(line.BillingCurrency).toBe('USD')
    expect(line.ResourceId).toBe('openai/gpt-5.2')
  })
})

describe('FrontierRuntime.panel 面板聚合', () => {
  const snapshot = () => {
    const meter = new Meter(480)
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 5, usage: { inputTokens: 900_000, outputTokens: 100_000 }, totalTokens: 1_000_000 }), 'sess-A')
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1, usage: { inputTokens: 400_000, outputTokens: 100_000 }, totalTokens: 500_000 }), 'sess-B')
    return meter.snapshot()
  }
  const baseline = buildPricingTable({
    'deepseek/deepseek-chat': { inputPerMillion: 1, cacheReadPerMillion: 0.02, outputPerMillion: 4 },
  })

  it('unitEconomy：会话归属 / 每请求 / 每百万 token（Showback）', () => {
    const rt = new FrontierRuntime({ unitEconomy: true })
    const p = rt.panel(snapshot(), baseline)
    expect(p.unitEconomy).toBeDefined()
    expect(p.unitEconomy!.totalCost).toBeCloseTo(6, 6)
    expect(p.unitEconomy!.topSessions[0]!.sessionId).toBe('sess-A')
    expect(p.unitEconomy!.topSessions[0]!.share).toBeCloseTo(5 / 6, 6)
    expect(p.leverage).toBeUndefined()
    expect(p.focus).toBeUndefined()
  })

  it('leverage：缓存杠杆需缓存账本；输出杠杆由价表推导', () => {
    const metrics = new CacheMetrics()
    metrics.append(
      { split: { inputHit: 300_000, inputMiss: 700_000, output: 100_000 }, cost: 0.706, baselineCost: 1.4, saving: 0.694 },
      { sessionId: 'sess-A', route: 'deepseek/deepseek-chat' },
    )
    const pricing = new CachePricingEngine({
      byRoute: {
        'deepseek/deepseek-chat': {
          idle: { inputHit: 0.02, inputMiss: 1.0, output: 4.0 },
          peak: { inputHit: 0.02, inputMiss: 1.0, output: 4.0 },
        },
      },
    })
    const rt = new FrontierRuntime({ leverage: true })
    const p = rt.panel(snapshot(), baseline, { metrics, pricing }, 480, () => 1_700_000_000_000)
    expect(p.leverage).toBeDefined()
    expect(p.leverage!.cache.length).toBeGreaterThan(0)
    expect(p.leverage!.cache[0]!.route).toBe('deepseek/deepseek-chat')
    expect(p.leverage!.cache[0]!.hitRate).toBeCloseTo(0.3, 6)
    expect(p.leverage!.output.length).toBeGreaterThan(0)
    expect(p.leverage!.output[0]!.route).toBe('deepseek/deepseek-chat')
  })

  it('leverage 无缓存数据时 output 依然输出、cache 为空数组（不报错）', () => {
    const rt = new FrontierRuntime({ leverage: true })
    const p = rt.panel(snapshot(), baseline)
    expect(p.leverage!.cache).toEqual([])
    expect(p.leverage!.output.length).toBeGreaterThan(0)
  })

  it('formatFrontierLines 输出可读行', () => {
    const lines = formatFrontierLines({
      focus: { enabled: true, rows: 12 },
      otel: { enabled: true, spans: 8 },
      unitEconomy: { totalCost: 6, costPerRequest: 3, costPerMTokens: 4, sessions: [], topSessions: [], routes: [] },
    })
    expect(lines.join('\n')).toContain('FOCUS')
    expect(lines.join('\n')).toContain('OTel')
    expect(lines.join('\n')).toContain('单位经济学')
  })
})

describe('frontier 集成：buildCostStatus / toToolJson / 摘要', () => {
  it('启用全部能力后状态输出 frontier 段（含台账行 / 遥测 span / 单位经济 / 杠杆）', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const rt = new FrontierRuntime({ focus: { enabled: true }, otel: { enabled: true }, unitEconomy: true, leverage: true }, { currencyOf: () => 'CNY' })
    rt.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, usage: { inputTokens: 500_000, outputTokens: 100_000 }, totalTokens: 600_000 }), 's1')
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, usage: { inputTokens: 500_000, outputTokens: 100_000 }, totalTokens: 600_000 }), 's1')
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2, usage: { inputTokens: 500_000, outputTokens: 100_000 }, totalTokens: 600_000 }))

    const st = buildCostStatus(meter, windows, evaluator, idleGuard(), {
      baseline: buildPricingTable({
        'deepseek/deepseek-chat': { inputPerMillion: 1, cacheReadPerMillion: 0.02, outputPerMillion: 4 },
      }),
      tzOffsetMin: 480,
      frontier: rt,
    })
    expect(st.frontier).toBeDefined()
    expect(st.frontier!.focus!.rows).toBe(1)
    expect(st.frontier!.otel!.spans).toBe(1)
    expect(st.frontier!.unitEconomy!.totalCost).toBeCloseTo(2, 6)
    // JSON 导出安全
    const json = toToolJson(st)
    expect(json['frontier']).toBeDefined()
    expect((json['frontier'] as Record<string, unknown>)['focus']).toBeDefined()
    // 摘要含前沿行
    const summary = formatStatusSummary(st)
    expect(summary).toContain('前沿: FOCUS')
  })

  it('未启用 frontier 时状态无该键（零回归）', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1 }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 1 }))
    const st = buildCostStatus(meter, windows, evaluator, idleGuard())
    expect(st.frontier).toBeUndefined()
    expect(toToolJson(st)['frontier']).toBeUndefined()
    expect(formatStatusSummary(st)).not.toContain('前沿')
  })
})