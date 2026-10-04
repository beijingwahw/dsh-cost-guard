import { describe, it, expect } from 'vitest'
import {
  buildPricingTable,
  computeCost,
  computeCredits,
  priceFor,
  priceForAt,
  billedTokens,
  formatCost,
  formatCredits,
  inBand,
  bandIdForMinutes,
  bandIdForEpoch,
  buildBandPriceTable,
  BUILTIN_PRICES,
  FALLBACK_PRICE,
} from '../src/core/pricing.js'
import { BASE_BAND } from '../src/core/types.js'

describe('pricing', () => {
  it('内置深色价存在且口径正确', () => {
    expect(BUILTIN_PRICES['deepseek-chat']).toBeDefined()
    expect(BUILTIN_PRICES['deepseek-reasoner']).toBeDefined()
  })

  it('computeCost 按百万 token 折算', () => {
    // 1M input * 4 + 0.5M cacheRead * 1 + 2M output * 16 (deepseek-reasoner)
    const price = BUILTIN_PRICES['deepseek-reasoner']!
    const cost = computeCost(price, {
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      cacheReadTokens: 500_000,
    })
    expect(cost).toBeCloseTo(4 + 0.5 + 32, 6)
  })

  it('billedTokens = input + cacheRead + output', () => {
    expect(billedTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })).toBe(18)
    expect(billedTokens({ inputTokens: 0, outputTokens: 0 })).toBe(0)
  })

  it('未配置路由回退到 FALLBACK_PRICE 并标记', () => {
    const table = buildPricingTable({})
    const { price, fallback } = priceFor(table, { provider: 'unknown', model: 'x' })
    expect(fallback).toBe(true)
    expect(price).toEqual(FALLBACK_PRICE)
  })

  it('用户覆盖优先于内置', () => {
    const table = buildPricingTable({
      'deepseek-chat': { inputPerMillion: 9, cacheReadPerMillion: 1, outputPerMillion: 27 },
    })
    const { price, fallback } = priceFor(table, { provider: 'deepseek', model: 'deepseek-chat' })
    expect(fallback).toBe(false)
    expect(price.inputPerMillion).toBe(9)
  })

  it('formatCost 保留合理精度', () => {
    expect(formatCost(123.456)).toBe('123.46')
    expect(formatCost(0.0001234)).toBe('0.0001')
    expect(formatCost(3.14159)).toBe('3.142')
  })

  it('computeCredits 按计费 token x 每百万积分单价折算', () => {
    const price = { ...BUILTIN_PRICES['deepseek-chat']!, creditsPerMillion: 100 }
    // 1M input + 0.5M cacheRead + 0.5M output = 2M 计费 token -> 200 积分
    const credits = computeCredits(price, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 500_000,
    })
    expect(credits).toBeCloseTo(200, 6)
  })

  it('未配置积分单价的模型积分消耗为 0', () => {
    const credits = computeCredits(BUILTIN_PRICES['deepseek-chat']!, {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(credits).toBe(0)
  })

  it('creditsPerMillion 为 0 时积分消耗为 0', () => {
    const credits = computeCredits({ ...BUILTIN_PRICES['deepseek-chat']!, creditsPerMillion: 0 }, {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(credits).toBe(0)
  })

  it('formatCredits 整数原样、非整数保留两位', () => {
    expect(formatCredits(100)).toBe('100')
    expect(formatCredits(0.5)).toBe('0.50')
    expect(formatCredits(1234.567)).toBe('1234.57')
  })
})

describe('pricing.bands（峰谷时段）', () => {
  const bands = [
    { id: 'valley', start: '00:00', end: '08:00' },
    { id: 'peak', start: '09:00', end: '18:00', prices: { 'deepseek-chat': { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 } } },
    { id: 'night', start: '22:00', end: '06:00' },
  ]

  it('inBand 同日内区间', () => {
    expect(inBand(390, bands[0]!)).toBe(true) // 06:30 in 00:00-08:00
    expect(inBand(480, bands[0]!)).toBe(false) // 08:00 不含
    expect(inBand(540, bands[1]!)).toBe(true) // 09:00 in 09:00-18:00
    expect(inBand(1079, bands[1]!)).toBe(true) // 17:59
    expect(inBand(1080, bands[1]!)).toBe(false) // 18:00 不含
  })

  it('inBand 跨午夜', () => {
    expect(inBand(23 * 60 + 30, bands[2]!)).toBe(true) // 23:30
    expect(inBand(60, bands[2]!)).toBe(true) // 01:00
    expect(inBand(12 * 60, bands[2]!)).toBe(false) // 12:00
  })

  it('inBand 全天 (start === end)', () => {
    expect(inBand(0, { id: 'all', start: '00:00', end: '00:00' })).toBe(true)
    expect(inBand(1439, { id: 'all', start: '00:00', end: '00:00' })).toBe(true)
  })

  it('bandIdForMinutes 按配置顺序取第一个命中，间隙归 BASE_BAND', () => {
    expect(bandIdForMinutes(bands, 60)).toBe('valley') // 01:00
    expect(bandIdForMinutes(bands, 9 * 60 + 30)).toBe('peak') // 09:30
    expect(bandIdForMinutes(bands, 20 * 60)).toBe(BASE_BAND) // 20:00 间隙
  })

  it('bandIdForEpoch 按本地分钟换算选带', () => {
    // 2024-01-01 02:00 UTC = 2024-01-01 10:00 +08 -> peak
    const t = Date.UTC(2024, 0, 1, 2, 0, 0)
    expect(bandIdForEpoch(bands, t, 480)).toBe('peak')
    // 2024-01-01 00:00 UTC = 2024-01-01 08:00 +08 -> valley 边界（08:00 不含）
    const t2 = Date.UTC(2024, 0, 1, 0, 0, 0)
    expect(bandIdForEpoch(bands, t2, 480)).toBe(BASE_BAND)
  })

  it('buildBandPriceTable 仅收录显式带价', () => {
    const t = buildBandPriceTable(bands)
    expect(Object.keys(t)).toEqual(['peak'])
    expect(t['peak']!['deepseek-chat']!.inputPerMillion).toBe(6)
  })

  it('priceForAt 带内覆盖优先于基准价', () => {
    const base = buildPricingTable({})
    const table = buildBandPriceTable(bands)
    const { price, fallback } = priceForAt(base, table, { provider: 'deepseek', model: 'deepseek-chat' }, 'peak')
    expect(fallback).toBe(false)
    expect(price.inputPerMillion).toBe(6)
  })

  it('priceForAt 未覆盖带回退基准价', () => {
    const base = buildPricingTable({})
    const table = buildBandPriceTable(bands)
    const { price } = priceForAt(base, table, { provider: 'deepseek', model: 'deepseek-reasoner' }, 'peak')
    expect(price.inputPerMillion).toBe(4) // 基准 reasoner 价
  })

  it('priceForAt BASE_BAND 无机峰谷覆盖', () => {
    const base = buildPricingTable({})
    const table = buildBandPriceTable(bands)
    const { price } = priceForAt(base, table, { provider: 'deepseek', model: 'deepseek-chat' }, BASE_BAND)
    expect(price.inputPerMillion).toBe(2) // 基准 chat 价
  })
})