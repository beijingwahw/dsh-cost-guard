import { describe, it, expect } from 'vitest'
import {
  buildPricingTable,
  computeCost,
  priceFor,
  billedTokens,
  formatCost,
  BUILTIN_PRICES,
  FALLBACK_PRICE,
} from '../src/core/pricing.js'

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
})