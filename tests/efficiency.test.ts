import { describe, it, expect } from 'vitest'
import {
  requestCostDistribution,
  routeEfficiency,
  estimateReplacement,
} from '../src/core/efficiency.js'
import { emptyBucket } from '../src/core/types.js'
import type { UsageBucket } from '../src/core/types.js'
import type { PricingTable } from '../src/core/pricing.js'

function bucket(over: Partial<UsageBucket> = {}): UsageBucket {
  return { ...emptyBucket(), ...over }
}

describe('efficiency（成本效率洞察）', () => {
  it('请求成本分布：样本不足 3 返回 undefined', () => {
    expect(requestCostDistribution([])).toBeUndefined()
    expect(requestCostDistribution([1, 2])).toBeUndefined()
  })

  it('请求成本分布：P50 / P95 / max / avg 计算正确', () => {
    // 样本 [1..10]，注意较低值被过滤为非负
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const d = requestCostDistribution(samples)!
    expect(d.n).toBe(10)
    // 10 个值的 P50：rank=4.5 -> 4 + (5-4)*0.5 = 4.5
    expect(d.p50).toBeCloseTo(5.5, 6)
    // P95：rank=8.55 -> 9 + (10-9)*0.55 = 9.55
    expect(d.p95).toBeCloseTo(9.55, 6)
    expect(d.max).toBe(10)
    expect(d.avg).toBeCloseTo(5.5, 6)
  })

  it('路由效率：每千输出 token 成本与每百万总 token 成本', () => {
    const routes = {
      'a/m1': bucket({ cost: 10, outputTokens: 1000, totalTokens: 5000, requests: 2 }),
      'a/m2': bucket({ cost: 20, outputTokens: 2000, totalTokens: 10000, requests: 1 }),
    }
    const eff = routeEfficiency(routes)
    expect(eff).toHaveLength(2)
    // 按 cost 降序：m2(20) 在前
    expect(eff[0]!.route).toBe('a/m2')
    expect(eff[0]!.costPerKOutput).toBeCloseTo(10, 6)
    expect(eff[1]!.costPerKOutput).toBeCloseTo(10, 6)
    // m2: 20 * 1M / 10000 totalTokens = 2000 元/百万 token
    expect(eff[0]!.costPerMTokens).toBeCloseTo(2000, 6)
  })

  it('路由替代节约：贵路由 → 便宜路由给出正节约建议', () => {
    const routes = {
      'p/reasoner': bucket({
        cost: 20,
        inputTokens: 1_000_000,
        cacheReadTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        requests: 1,
      }),
    }
    const pricing: PricingTable = {
      'p/reasoner': { inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 32 },
      'p/chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
    }
    const est = estimateReplacement(routes, pricing, ['p/chat'])
    expect(est).toHaveLength(1)
    expect(est[0]!.from).toBe('p/reasoner')
    expect(est[0]!.to).toBe('p/chat')
    // 替代成本 = 1M*2 + 1M*8 = 10；节约 = 20-10 = 10；50%
    expect(est[0]!.replacementCost).toBeCloseTo(10, 6)
    expect(est[0]!.saving).toBeCloseTo(10, 6)
    expect(est[0]!.savingPercent).toBeCloseTo(0.5, 6)
    expect(est[0]!.suggestion).toContain('省 10.00 元')
  })

  it('替代更贵时不建议；无 token 不估算', () => {
    const routes = {
      'p/chat': bucket({ cost: 10, inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, requests: 1 }),
      'p/empty': bucket({ cost: 5, totalTokens: 0, requests: 0 }),
    }
    const pricing: PricingTable = {
      'p/chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
      // 比 chat 贵的替代路由 -> 无节约建议
      'p/reasoner': { inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 32 },
      'p/empty': { inputPerMillion: 5, cacheReadPerMillion: 1, outputPerMillion: 20 },
    }
    const est = estimateReplacement(routes, pricing, ['p/reasoner', 'p/empty'])
    // p/empty 无总 token -> 跳过；p/reasoner 更贵 -> 无正节约
    expect(est).toHaveLength(0)
  })
})