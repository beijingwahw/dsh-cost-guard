import { describe, it, expect } from 'vitest'
import { toFocusLine, FocusLedger } from '../src/core/focus-ledger.js'

const entry = {
  time: Date.UTC(2026, 9, 5, 3, 0, 0),
  cost: 1.506,
  credits: 10,
  totalTokens: 1_200_000,
  band: 'peak',
}

const tokens = { inputTokens: 700_000, cacheReadTokens: 300_000, outputTokens: 200_000, reasoningTokens: 50_000 }

describe('toFocusLine FOCUS 列映射', () => {
  it('标准列：ChargeCategory / 周期 / 币种 / 数量 / 成本（方案映射口径）', () => {
    const line = toFocusLine('deepseek/deepseek-v4-flash', entry, tokens, {
      currencyOf: () => 'cny',
    })
    expect(line.ChargeCategory).toBe('Usage')
    expect(line.ChargePeriodStart).toBe(new Date(entry.time).toISOString())
    expect(line.ChargePeriodEnd).toBe(line.ChargePeriodStart)
    expect(line.BillingCurrency).toBe('CNY')
    expect(line.ConsumedQuantity).toBe(1_200_000)
    expect(line.ConsumedUnit).toBe('tokens')
    expect(line.EffectiveCost).toBe(1.506)
    expect(line.ListCost).toBe(1.506)
    // 每百万 token 综合单价 = 1.506 / 1.2
    expect(line.ListUnitPrice).toBeCloseTo(1.506 / 1.2, 6)
    expect(line.PricingQuantity).toBeCloseTo(1.2, 6)
    expect(line.PricingUnit).toBe('tokens-per-million')
  })

  it('资源与扩展维度：Provider / Service / Resource / Route / Band / 通道 Token / 积分', () => {
    const line = toFocusLine('zhipu/glm-5.3', entry, tokens, { currencyOf: () => 'CNY' })
    expect(line.ProviderName).toBe('zhipu')
    expect(line.ServiceName).toBe('deepseek-harness')
    expect(line.ResourceId).toBe('zhipu/glm-5.3')
    expect(line.Route).toBe('zhipu/glm-5.3')
    expect(line.Band).toBe('peak')
    expect(line.InputTokens).toBe(700_000)
    expect(line.CacheReadTokens).toBe(300_000)
    expect(line.OutputTokens).toBe(200_000)
    expect(line.ReasoningTokens).toBe(50_000)
    expect(line.Credits).toBe(10)
  })

  it('币种解析：缺省 CNY；服务名可覆盖；Provider 缺省回退 deepseek', () => {
    const line = toFocusLine('bare-model', { ...entry, totalTokens: 0 }, { ...tokens, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { serviceName: 'custom' })
    expect(line.BillingCurrency).toBe('CNY')
    expect(line.ProviderName).toBe('bare-model')
    expect(line.ServiceName).toBe('custom')
    expect(line.PricingQuantity).toBe(0)
    expect(line.ListUnitPrice).toBe(0)
  })
})

describe('FocusLedger 台账', () => {
  it('append 计数并保存行；lines 返回副本', () => {
    const ledger = new FocusLedger()
    ledger.append(toFocusLine('deepseek/deepseek-chat', entry, tokens))
    ledger.append(toFocusLine('openai/gpt-5.2', { ...entry, cost: 0.5 }, tokens, { currencyOf: () => 'usd' }))
    expect(ledger.count).toBe(2)
    const rows = ledger.lines()
    expect(rows[1]!.BillingCurrency).toBe('USD')
    rows[0]!.EffectiveCost = 999 // 修改副本不影响内部
    expect(ledger.lines()[0]!.EffectiveCost).toBe(1.506)
  })

  it('容量上限：满则丢最旧（内存有界）', () => {
    const ledger = new FocusLedger({ capacity: 3 })
    for (let i = 0; i < 5; i++) ledger.append(toFocusLine(`p/m${i}`, entry, tokens))
    expect(ledger.count).toBe(3)
    expect(ledger.lines()[0]!.Route).toBe('p/m2')
    expect(ledger.lines()[2]!.Route).toBe('p/m4')
  })

  it('sink 即时流出；toJsonl 逐行 JSON', () => {
    const seen: string[] = []
    const ledger = new FocusLedger({ sink: (l) => seen.push(l.Route) })
    ledger.append(toFocusLine('deepseek/deepseek-chat', entry, tokens))
    expect(seen).toEqual(['deepseek/deepseek-chat'])
    const jsonl = ledger.toJsonl().split('\n')
    expect(jsonl.length).toBe(1)
    expect(JSON.parse(jsonl[0]!).ChargeCategory).toBe('Usage')
  })

  it('clear 清空缓冲', () => {
    const ledger = new FocusLedger()
    ledger.append(toFocusLine('deepseek/deepseek-chat', entry, tokens))
    ledger.clear()
    expect(ledger.count).toBe(0)
  })
})