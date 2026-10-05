import { describe, it, expect } from 'vitest'
import { analyzeCostRca, bucketOf, emptyRcaInput } from '../src/core/rca.js'
import type { UsageBucket } from '../src/core/types.js'

function bucket(cost: number, tokens = 0, requests = 1): UsageBucket {
  return { cost, credits: 0, requests, inputTokens: tokens, cacheReadTokens: 0, outputTokens: 0, totalTokens: tokens }
}

describe('analyzeCostRca 成本根因分析', () => {
  it('空输入：全为安全空值，无主导因子、无噪声', () => {
    const r = analyzeCostRca({})
    expect(r.window).toBe('current')
    expect(r.totalCost).toBe(0)
    expect(r.deltaCost).toBe(0)
    expect(r.deltaRatio).toBe(0)
    expect(r.bySession.factors).toEqual([])
    expect(r.byRoute.dominant).toBeUndefined()
    expect(r.channelMix.totalTokens).toBe(0)
    expect(r.summary).toContain('当前累计成本 0.00')
  })

  it('无基线存量归因：按占比分级（a 主因、b/c 次因）', () => {
    const r = analyzeCostRca({
      sessions: { a: bucket(70), b: bucket(20), c: bucket(10) },
    })
    expect(r.window).toBe('current')
    expect(r.totalCost).toBe(100)
    expect(r.bySession.dominant?.key).toBe('a')
    expect(r.bySession.dominant?.share).toBeCloseTo(0.7, 6)
    expect(r.bySession.dominant?.grade).toBe('primary')
    // a=70% 主因；b=20%、c=10%（>=0.1）均次因
    expect(r.bySession.primary.map((f) => f.key)).toEqual(['a'])
    expect(r.bySession.secondary.map((f) => f.key).sort()).toEqual(['b', 'c'])
    expect(r.summary).toContain('会话「a」占 70%')
  })

  it('有基线增量归因：Δ 贡献分解定位增长主因', () => {
    const r = analyzeCostRca(
      { sessions: { a: bucket(8), b: bucket(5), c: bucket(1) } },
      { baseline: { sessions: { a: bucket(2), b: bucket(4), c: bucket(3) } } },
    )
    expect(r.window).toBe('delta')
    expect(r.totalCost).toBe(14)
    expect(r.baselineTotalCost).toBe(9)
    expect(r.deltaCost).toBe(5)
    expect(r.deltaRatio).toBeCloseTo(5 / 9, 6)
    const a = r.bySession.factors.find((f) => f.key === 'a')
    expect(a?.delta).toBe(6)
    const b = r.bySession.factors.find((f) => f.key === 'b')
    expect(b?.delta).toBe(1)
    const c = r.bySession.factors.find((f) => f.key === 'c')
    expect(c?.delta).toBe(-2)
    // |Δ| 归一：6+1+2=9；a=0.667 primary、b=0.111 次因、c=-0.222 次因
    expect(a?.deltaShare).toBeCloseTo(6 / 9, 6)
    expect(a?.grade).toBe('primary')
    expect(b?.grade).toBe('secondary')
    expect(c?.grade).toBe('secondary')
    expect(r.bySession.dominant?.key).toBe('a')
    expect(r.summary).toContain('会话视角主因「a」贡献 67%')
  })

  it('基线中出现、当前消失的因子：Δ 为负并保留归因记录', () => {
    const r = analyzeCostRca(
      { sessions: { a: bucket(5) } },
      { baseline: { sessions: { a: bucket(5), gone: bucket(7) } } },
    )
    const gone = r.bySession.factors.find((f) => f.key === 'gone')
    expect(gone?.cost).toBe(0)
    expect(gone?.delta).toBe(-7)
    // Σ|Δ| = |5-5|(a) + |0-7|(gone) = 7；gone 贡献 -7/7 = -1（全减）
    expect(gone?.deltaShare).toBeCloseTo(-1, 6)
  })

  it('路由双视角独立归因：同一成本落到 route 视图', () => {
    const r = analyzeCostRca({
      sessions: { s1: bucket(70) },
      routes: { 'deepseek/deepseek-chat': bucket(70) },
    })
    expect(r.bySession.dominant?.key).toBe('s1')
    expect(r.byRoute.dominant?.key).toBe('deepseek/deepseek-chat')
    expect(r.byRoute.dominant?.share).toBeCloseTo(1, 6)
  })

  it('topN 截断：超出保留数的因子并入噪声统计（含 kept 中的低贡献者）', () => {
    // a/b/c 为主次因；d/e 保留但贡献 <0.05 -> 统计进噪声；f..l 被截断
    const sessions: Record<string, UsageBucket> = {
      a: bucket(50),
      b: bucket(20),
      c: bucket(10),
      d: bucket(5),
      e: bucket(3),
      f: bucket(1),
      g: bucket(1),
      h: bucket(1),
      i: bucket(1),
      j: bucket(1),
      k: bucket(1),
      l: bucket(1),
    }
    const r = analyzeCostRca({ sessions }, { topN: 5 })
    expect(r.bySession.factors.length).toBe(5)
    // d+e（kept 低贡献）+ f..l（截断 7 个）
    expect(r.bySession.noise.count).toBe(2 + 7)
    expect(r.bySession.noise.cost).toBe(5 + 3 + 7)
  })

  it('所有因子低于主因阈值时：全部为次因或噪声，主导因子仍为最大者', () => {
    const r = analyzeCostRca({ sessions: { a: bucket(50), b: bucket(50) } }, { primaryThreshold: 0.6, secondaryThreshold: 0.3 })
    expect(r.bySession.primary).toEqual([])
    expect(r.bySession.secondary.length).toBe(2)
    expect(r.bySession.dominant?.key).toBe('a')
  })

  it('通道构成：只基于 token 事实，源为空时回退路由桶', () => {
    const r = analyzeCostRca({
      routes: { deepseek: { ...bucket(10, 1000), inputTokens: 500, cacheReadTokens: 300, outputTokens: 200 } },
    })
    expect(r.channelMix.totalTokens).toBe(1000)
    expect(r.channelMix.inputShare).toBeCloseTo(0.5, 6)
    expect(r.channelMix.cacheReadShare).toBeCloseTo(0.3, 6)
    expect(r.channelMix.outputShare).toBeCloseTo(0.2, 6)
  })

  it('会话桶存在时通道构成以会话桶为准', () => {
    const r = analyzeCostRca({
      sessions: { a: { ...bucket(10, 100), inputTokens: 100, cacheReadTokens: 0, outputTokens: 0 } },
      routes: { deepseek: { ...bucket(10, 999), inputTokens: 500, cacheReadTokens: 300, outputTokens: 200 } },
    })
    expect(r.channelMix.totalTokens).toBe(100)
  })

  it('delta 归因时 Σ|Δ|=0（成本无变化的快照）：deltaShare 回退存量占比', () => {
    const r = analyzeCostRca(
      { sessions: { a: bucket(5), b: bucket(5) } },
      { baseline: { sessions: { a: bucket(5), b: bucket(5) } } },
    )
    expect(r.deltaCost).toBe(0)
    expect(r.bySession.dominant?.deltaShare).toBeCloseTo(0.5, 6)
    expect(r.bySession.dominant?.grade).toBe('primary')
  })

  it('总额口径：会话为空时回退路由合计', () => {
    const r = analyzeCostRca({ routes: { a: bucket(3), b: bucket(7) } })
    expect(r.totalCost).toBe(10)
    expect(r.bySession.factors).toEqual([])
  })

  it('emptyRcaInput 与 bucketOf 便捷工具', () => {
    const input = emptyRcaInput()
    expect(input.sessions).toEqual({})
    expect(input.routes).toEqual({})
    const b = bucketOf(undefined)
    expect(b.cost).toBe(0)
    // 传入实际桶透传；undefined 给空桶（requests=0）
    expect(bucketOf(b).requests).toBe(0)
    expect(bucketOf(bucket(3, 9, 2)).requests).toBe(2)
  })
})