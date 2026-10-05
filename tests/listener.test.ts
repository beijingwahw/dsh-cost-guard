import { describe, it, expect } from 'vitest'
import { parseSessionEvent, toUsageEntry } from '../src/harness/listener.js'
import { buildPricingTable } from '../src/core/pricing.js'
import { buildOfficialPricingTable } from '../src/core/official-pricing.js'

function fakeEvent(type: string, data: unknown, time = 1_700_000_000_000) {
  return { type, data, time } as never
}

describe('listener.parseSessionEvent', () => {
  it('解析 request/header 路由', () => {
    const e = parseSessionEvent(
      fakeEvent('request/header', {
        header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } },
      }),
    )
    expect(e.provider).toBe('deepseek')
    expect(e.model).toBe('deepseek-reasoner')
  })

  it('解析 assistant/message usage', () => {
    const e = parseSessionEvent(
      fakeEvent('assistant/message', {
        usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, reasoningTokens: 10 },
      }),
    )
    expect(e.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
    })
  })

  it('usage 缺失时宽容', () => {
    const e = parseSessionEvent(fakeEvent('assistant/message', {}))
    expect(e.usage).toBeUndefined()
  })

  it('assistant/message 宽容读取数据载荷中的路由（宿主随消息下发）', () => {
    const e = parseSessionEvent(
      fakeEvent('assistant/message', {
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    )
    expect(e.provider).toBe('deepseek')
    expect(e.model).toBe('deepseek-flash')
    expect(e.usage?.inputTokens).toBe(10)
  })

  it('未知事件类型不抛错', () => {
    const e = parseSessionEvent(fakeEvent('turn/start', { turn: 1 }))
    expect(e.type).toBe('turn/start')
    expect(e.usage).toBeUndefined()
  })
})

describe('listener.toUsageEntry', () => {
  const routes = buildPricingTable({})
  const fb = { provider: 'deepseek', model: 'deepseek-chat' }

  it('按路由计价并折算', () => {
    const entry = toUsageEntry(
      {
        type: 'assistant/message',
        time: 1_700_000_000_000,
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 },
      },
      routes,
      fb,
    )
    expect(entry).toBeDefined()
    // deepseek-reasoner: input 4 + output 16 = 20
    expect(entry!.cost).toBeCloseTo(20, 6)
    expect(entry!.totalTokens).toBe(2_000_000)
    // 未配置积分单价的默认表 -> 积分按 0 计
    expect(entry!.credits).toBe(0)
  })

  it('零用量返回 undefined', () => {
    const entry = toUsageEntry(
      { type: 'assistant/message', time: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
      routes,
      fb,
    )
    expect(entry).toBeUndefined()
  })

  it('路由缺失时回退默认', () => {
    const entry = toUsageEntry(
      { type: 'assistant/message', time: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      routes,
      fb,
    )
    expect(entry!.route).toEqual(fb)
  })

  it('cacheRead 单独计价', () => {
    const entry = toUsageEntry(
      {
        type: 'assistant/message',
        time: 1,
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      },
      routes,
      fb,
    )
    // deepseek-chat cacheRead 0.5
    expect(entry!.cost).toBeCloseTo(0.5, 6)
  })

  it('按路由积分单价折算积分', () => {
    const withCredits = buildPricingTable({
      'deepseek-reasoner': { ...routes['deepseek-reasoner']!, creditsPerMillion: 100 },
    })
    const entry = toUsageEntry(
      {
        type: 'assistant/message',
        time: 1,
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 },
      },
      withCredits,
      fb,
    )
    // 2M 计费 token x 100 / 1M = 200 积分
    expect(entry!.credits).toBeCloseTo(200, 6)
    expect(entry!.cost).toBeCloseTo(20, 6)
  })

  it('部分模型配积分价、其余按 0，互不影响', () => {
    const withCredits = buildPricingTable({
      'deepseek-reasoner': { ...routes['deepseek-reasoner']!, creditsPerMillion: 100 },
    })
    const entry = toUsageEntry(
      {
        type: 'assistant/message',
        time: 1,
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      withCredits,
      fb,
    )
    // deepseek-chat 未配积分价 -> 0；金额仍按内置价 2
    expect(entry!.credits).toBe(0)
    expect(entry!.cost).toBeCloseTo(2, 6)
  })

  it('无时段上下文时归 BASE_BAND 并按基准价', () => {
    const entry = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2024, 0, 1, 2, 0, 0), // +08 时区为 10:00
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
    )
    expect(entry!.band).toBe('base')
    expect(entry!.cost).toBeCloseTo(2, 6)
  })

  it('按事件本地时刻选带并采用带内价', () => {
    const bands = [
      { id: 'peak', start: '09:00', end: '18:00', prices: { 'deepseek-chat': { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 } } },
    ]
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        // 2024-01-01 02:00 UTC = 10:00 +08 -> peak
        time: Date.UTC(2024, 0, 1, 2, 0, 0),
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      { bands: bands as never, tzOffsetMin: 480 },
    )
    expect(en!.band).toBe('peak')
    expect(en!.cost).toBeCloseTo(6, 6) // 带内 input 6，而非基准 2
  })

  it('跨午夜带（晚 22:00-06:00）在凌晨命中', () => {
    const bands = [{ id: 'night', start: '22:00', end: '06:00' }]
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        // 2024-01-01 18:00 UTC = 次日 02:00 +08 -> night
        time: Date.UTC(2024, 0, 1, 18, 0, 0),
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      { bands: bands as never, tzOffsetMin: 480 },
    )
    expect(en!.band).toBe('night')
    expect(en!.cost).toBeCloseTo(2, 6) // night 无覆盖 -> 基准价
  })

  it('未配置带覆盖的模型在带内回退基准价', () => {
    const bands = [
      { id: 'peak', start: '09:00', end: '18:00', prices: { 'deepseek-chat': { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 } } },
    ]
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2024, 0, 1, 2, 0, 0), // +08 = 10:00 peak
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      { bands: bands as never, tzOffsetMin: 480 },
    )
    expect(en!.band).toBe('peak')
    expect(en!.cost).toBeCloseTo(4, 6) // reasoner 无带内价 -> 基准 4
  })
})

describe('listener.toUsageEntry 官方计价模式（0.8.0）', () => {
  const fb = { provider: 'deepseek', model: 'deepseek-chat' }
  // 官方模式装配层的等价基准价表（内置价 + 官方 idle 价 + 用户覆盖）
  const routes = buildOfficialPricingTable({})
  const officialCtx = (enabled: boolean, overrides: Record<string, never> = {}, holidays?: ReadonlySet<string>) => ({
    bands: [],
    tzOffsetMin: 480,
    official: { enabled, overrides, ...(holidays ? { holidays } : {}) },
  })

  it('官方未启用时保持 BASE_BAND（零回归）', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 8, 13, 2, 0, 0), // 周日 10:00 +08
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      officialCtx(false) as never,
    )
    expect(en!.band).toBe('base')
    expect(en!.cost).toBeCloseTo(2, 6) // 旧内置价
  })

  it('官方模式工作日高峰自动挂载官方峰谷与官方价', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 8, 14, 2, 0, 0), // 周一 10:00 +08 peak
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      officialCtx(true) as never,
    )
    expect(en!.band).toBe('peak')
    expect(en!.cost).toBeCloseTo(2, 6) // flash 高峰 input = 1 × 2
  })

  it('官方模式空闲时段按 idle 价', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 8, 14, 5, 0, 0), // 周一 13:00 +08 idle
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      officialCtx(true) as never,
    )
    expect(en!.band).toBe('idle')
    expect(en!.cost).toBeCloseTo(1, 6)
  })

  it('官方模式法定节假日（国庆）全天按 idle', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 9, 5, 2, 0, 0), // 国庆 10:00 +08（法定假日）
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      officialCtx(true) as never,
    )
    expect(en!.band).toBe('idle')
    expect(en!.cost).toBeCloseTo(1, 6)
  })

  it('官方模式旧模型名归一到现行模型价（不再落保守兜底）', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 8, 14, 5, 0, 0), // idle
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      officialCtx(true) as never,
    )
    expect(en!.cost).toBeCloseTo(1, 6) // 按 flash idle 计
  })

  it('官方模式用户覆盖为最终单价，不随峰谷翻倍', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 8, 14, 2, 0, 0), // peak
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      {
        bands: [],
        tzOffsetMin: 480,
        official: {
          enabled: true,
          overrides: { 'deepseek-flash': { inputPerMillion: 0.8, cacheReadPerMillion: 0.01, outputPerMillion: 3.2 } },
        },
      } as never,
    )
    expect(en!.band).toBe('peak')
    expect(en!.cost).toBeCloseTo(0.8, 6) // 用户最终单价，不 ×2
  })

  it('官方模式但用户配置了自定义时段时仍以用户时段优先', () => {
    const en = toUsageEntry(
      {
        type: 'assistant/message',
        time: Date.UTC(2026, 8, 14, 2, 0, 0), // 官方 peak，但用户时段 18-22 不命中 -> base
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      },
      routes,
      fb,
      {
        bands: [{ id: 'evening', start: '18:00', end: '22:00' }] as never,
        tzOffsetMin: 480,
        official: { enabled: true, overrides: {} },
      } as never,
    )
    expect(en!.band).toBe('base') // 未命中用户时段 → BASE_BAND + 官方基准价表
    expect(en!.cost).toBeCloseTo(1, 6) // 官方价表已并入基准
  })
})