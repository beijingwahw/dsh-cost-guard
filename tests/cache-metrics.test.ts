import { describe, it, expect } from 'vitest'
import { computeCacheCost, CacheMetrics } from '../src/core/cache-metrics.js'
import type { TokenSplit } from '../src/core/cache-types.js'

const price = { inputHit: 0.02, inputMiss: 1.0, output: 4.0 } // flash 空闲

function split(hit: number, miss: number, output: number, uncertainty?: TokenSplit['uncertainty']): TokenSplit {
  return uncertainty ? { inputHit: hit, inputMiss: miss, output, uncertainty } : { inputHit: hit, inputMiss: miss, output }
}

describe('cache-metrics 收益计算', () => {
  it('cost / baseline / saving 公式（方案 5.3）', () => {
    // 1M 请求：300k 命中 + 700k 未命中 + 200k 输出
    const r = computeCacheCost(split(300_000, 700_000, 200_000), price)
    expect(r.cost).toBeCloseTo(0.3 * 0.02 + 0.7 * 1.0 + 0.2 * 4.0) // 0.006 + 0.7 + 0.8 = 1.506
    expect(r.baselineCost).toBeCloseTo((0.3 + 0.7) * 1.0 + 0.2 * 4.0) // 1.0 + 0.8 = 1.8
    expect(r.saving).toBeCloseTo(1.8 - 1.506) // 0.294
  })

  it('全部命中时 saving = 未命中价与命中价差 × Token（收益上界）', () => {
    const r = computeCacheCost(split(1_000_000, 0, 0), price)
    expect(r.cost).toBeCloseTo(0.02)
    expect(r.baselineCost).toBeCloseTo(1.0)
    expect(r.saving).toBeCloseTo(0.98)
  })

  it('全未命中时 saving = 0（基线等价）', () => {
    const r = computeCacheCost(split(0, 1_000_000, 0), price)
    expect(r.cost).toBeCloseTo(1.0)
    expect(r.baselineCost).toBeCloseTo(1.0)
    expect(r.saving).toBeCloseTo(0)
  })

  it('CacheMetrics 全局汇总：Token 加权命中率 / 收益累计 / 请求计数', () => {
    const m = new CacheMetrics()
    // 两笔：100k 输入全命中（save 0.098 每 100k? 计算：0.1M*0.98=0.098），100k 输入全未命中
    m.append({ split: split(100_000, 0, 0), cost: 0.002, baselineCost: 0.1, saving: 0.098 })
    m.append({ split: split(0, 100_000, 0), cost: 0.1, baselineCost: 0.1, saving: 0 })
    const s = m.summary('global')
    expect(s.inputTotal).toBe(200_000)
    expect(s.hitTotal).toBe(100_000)
    expect(s.hitRate).toBeCloseTo(0.5)
    expect(s.savingTotal).toBeCloseTo(0.098)
    expect(s.uncertainCount).toBe(0)
  })

  it('会话 / 路由维度独立汇总；不确定请求只计 uncertainCount 不污染命中率与收益', () => {
    const m = new CacheMetrics()
    m.append({ split: split(50_000, 0, 0), cost: 0.001, baselineCost: 0.05, saving: 0.049 }, { sessionId: 's1', route: 'deepseek/deepseek-flash' })
    m.append({ split: split(0, 50_000, 0), cost: 0.05, baselineCost: 0.05, saving: 0 }, { sessionId: 's2', route: 'deepseek/deepseek-flash' })
    // 不确定请求：不计入 inputTotal / hitTotal / saving，仅 uncertainCount
    m.append(
      { split: split(0, 100_000, 0, 'cached-unknown'), cost: 0.1, baselineCost: 0.1, saving: 0 },
      { sessionId: 's2', route: 'deepseek/deepseek-v4-pro' },
    )

    const g = m.summary('global')
    expect(g.inputTotal).toBe(100_000)
    expect(g.hitRate).toBeCloseTo(0.5)
    expect(g.savingTotal).toBeCloseTo(0.049)
    expect(g.uncertainCount).toBe(1)

    const sessions = m.byScope('session')
    expect(sessions['s1']!.hitRate).toBe(1)
    expect(sessions['s2']!.uncertainCount).toBe(1)
    expect(sessions['s2']!.inputTotal).toBe(50_000)

    const routes = m.byScope('route')
    expect(routes['deepseek/deepseek-flash']!.inputTotal).toBe(100_000)
    expect(routes['deepseek/deepseek-v4-pro']!.uncertainCount).toBe(1)
    // v4-pro 路由无可信输入 → 空汇总
    expect(routes['deepseek/deepseek-v4-pro']!.inputTotal).toBe(0)
  })
})