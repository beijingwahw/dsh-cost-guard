import { describe, it, expect } from 'vitest'
import { Meter, WindowMeter } from '../src/core/meter.js'
import { createBudgetEvaluator } from '../src/core/budget.js'
import { buildCostStatus, formatStatusSummary, toToolJson } from '../src/harness/tool.js'
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

describe('tool.official 官方注册状态展示（0.9.0）', () => {
  function ctx() {
    return {
      official: { enabled: true as const, overrides: {}, holidays: new Set<string>() },
      tzOffsetMin: 480,
    }
  }

  it('未启用 officialPricing 时 official 段缺省（零回归）', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const st = buildCostStatus(meter, windows, evaluator, idleGuard())
    expect(st.official).toBeUndefined()
  })

  it('启用后 registry 输出 DeepSeek 全部状态 + 多厂商在售/停用/开源全景', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const st = buildCostStatus(meter, windows, evaluator, idleGuard(), ctx())
    expect(st.official).toBeDefined()
    const reg = st.official!.registry
    // DeepSeek 3 种状态完整保留（零回归）
    const byStatus = (s: string) => reg.filter((r) => r.status === s).map((r) => r.model)
    expect(byStatus('active')).toEqual(expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro']))
    expect(byStatus('routed').sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].sort())
    expect(byStatus('decommissioned')).toEqual(expect.arrayContaining(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']))
    // 多厂商：OpenAI 在售、Gemini 2.5 停用、Meta 开源无价
    expect(byStatus('active')).toEqual(
      expect.arrayContaining(['gpt-6-astra', 'gpt-6.1-sol', 'claude-opus-5.5', 'gemini-3.7-flash', 'mistral-large-3']),
    )
    // 0.11.0：国内主流厂商全景（智谱/阿里/豆包/Kimi/百度/百川/MiniMax/阶跃/讯飞）
    expect(byStatus('active')).toEqual(
      expect.arrayContaining([
        'glm-5.3', 'glm-5.3-flash', 'qwen3.8-max', 'qwen3.8-flash', 'doubao-seed-2.1-pro',
        'kimi-k3', 'ernie-5.0', 'baichuan2-53b', 'minimax-m3', 'step-5-preview', 'spark-x2.5',
      ]),
    )
    expect(byStatus('decommissioned')).toEqual(expect.arrayContaining(['gemini-2.5-flash', 'gemini-2.5-pro']))
    expect(byStatus('legacy')).toEqual(expect.arrayContaining(['claude-sonnet-5', 'claude-opus-4.5']))
    expect(byStatus('oss').sort()).toEqual(['llama-3.3-70b', 'llama-4-maverick', 'llama-4-scout'].sort())
    // registry 新字段：provider / currency / peakPolicy / sourceLevel / verifiedAt
    const astra = reg.find((r) => r.model === 'gpt-6-astra')!
    expect(astra.provider).toBe('openai')
    expect(astra.currency).toBe('USD')
    expect(astra.peakPolicy).toBe('flat')
    expect(astra.sourceLevel).toBe('official')
    expect(astra.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const flash = reg.find((r) => r.model === 'deepseek-flash')!
    expect(flash.provider).toBe('deepseek')
    expect(flash.currency).toBe('CNY')
    expect(flash.peakPolicy).toBe('dsn-peak')
    // 既有断言语义保留：DeepSeek 字段不变
    const chat = reg.find((r) => r.model === 'deepseek-chat')!
    expect(chat.status).toBe('decommissioned')
    expect(chat.decommissionedAt).toBe('2026-07-24')
    expect(chat.migrateTo).toContain('deepseek-flash')
    const v4flash = reg.find((r) => r.model === 'deepseek-v4-flash')!
    expect(v4flash.routesTo).toBe('deepseek-flash')
  })

  it('摘要输出多厂商官方模型分组：在售/路由/停用/Legacy/开源与币种标注', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const summary = formatStatusSummary(buildCostStatus(meter, windows, evaluator, idleGuard(), ctx()))
    // DeepSeek 分组（零回归保留既有语义）
    expect(summary).toContain('官方模型(deepseek/CNY): 在售 deepseek-flash、deepseek-v4-pro')
    expect(summary).toContain('下线路由 2 个')
    expect(summary).toContain('deepseek-v4-flash→deepseek-flash')
    expect(summary).toContain('官方停用(deepseek): deepseek-chat、deepseek-reasoner、deepseek-coder 已停用')
    expect(summary).toContain('迁移至 deepseek-flash')
    // 多厂商分组与币种
    expect(summary).toContain('官方模型(openai/USD): 在售 gpt-6-astra')
    expect(summary).toContain('官方模型(anthropic/USD): Legacy 在售 claude-sonnet-5')
    expect(summary).toContain('官方模型(google/USD): 在售 gemini-3.7-flash')
    expect(summary).toContain('官方停用(google): gemini-2.5-flash')
    expect(summary).toContain('官方模型(meta): 开源权重（无官方托管 API 价） llama-4-maverick')
    expect(summary).toContain('官方模型(mistral/USD): 在售 mistral-large-3')
    // 0.11.0：国内厂商 CNT/CNY 分组展示
    expect(summary).toContain('官方模型(zhipu/CNY): 在售 glm-5.3、glm-5.3-flash')
    expect(summary).toContain('官方模型(qwen/CNY): 在售 qwen3.8-max')
    expect(summary).toContain('官方模型(spark/CNY): 在售 spark-x2.5、spark-x2.5-4b')
    // flat 策略标注恒定价
    expect(summary).toContain('恒定价')
  })
})
describe('tool.toToolJson 无损 JSON 投影', () => {
  it('过滤 undefined 键（未启用模块不输出）', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const st = buildCostStatus(meter, windows, evaluator, idleGuard())
    const json = toToolJson(st)
    expect(json).toBeDefined()
    for (const k of Object.keys(json)) {
      expect(json[k]).not.toBeUndefined()
    }
  })

  it('拒绝 NaN / Infinity / -0 等非无损 JSON 值', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const st = buildCostStatus(meter, windows, evaluator, idleGuard())
    ;(st.total as { cost: number }).cost = Number.NaN
    expect(() => toToolJson(st)).toThrowError(/不是无损 JSON 值/)
    ;(st.total as { cost: number }).cost = Number.POSITIVE_INFINITY
    expect(() => toToolJson(st)).toThrowError(/不是无损 JSON 值/)
  })

  it('深层循环引用被拒绝而非栈溢出', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    const st = buildCostStatus(meter, windows, evaluator, idleGuard())
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    ;(st as unknown as Record<string, unknown>).routes = { deepseek: cyc as never }
    expect(() => toToolJson(st)).toThrowError(/不是无损 JSON 值/)
  })
})
