import { describe, it, expect } from 'vitest'
import { parseSessionEvent, toUsageEntry } from '../src/harness/listener.js'
import { buildPricingTable } from '../src/core/pricing.js'

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
})