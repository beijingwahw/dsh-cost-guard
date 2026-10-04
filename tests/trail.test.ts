import { describe, it, expect } from 'vitest'
import { CostTrail } from '../src/core/trail.js'

describe('CostTrail（成本轨迹采样）', () => {
  it('按时间升序追加观测点', () => {
    const t = new CostTrail()
    t.push('day', 1000, 1)
    t.push('day', 2000, 3)
    t.push('day', 1500, 2)
    const pts = t.points('day')
    expect(pts.map((p) => p.time)).toEqual([1000, 1500, 2000])
    expect(pts.map((p) => p.cost)).toEqual([1, 2, 3])
  })

  it('同一时刻重复写入按最新值覆盖（幂等）', () => {
    const t = new CostTrail()
    t.push('day', 1000, 1)
    t.push('day', 1000, 5)
    expect(t.points('day')).toHaveLength(1)
    expect(t.latestCost('day')).toBe(5)
  })

  it('读取返回副本，不污染内部状态', () => {
    const t = new CostTrail()
    t.push('day', 1000, 1)
    const pts = t.points('day')
    pts[0]!.cost = 999
    expect(t.latestCost('day')).toBe(1)
  })

  it('容量超限丢最旧', () => {
    const t = new CostTrail(3)
    t.push('day', 1, 1)
    t.push('day', 2, 2)
    t.push('day', 3, 3)
    t.push('day', 4, 4)
    expect(t.points('day').map((p) => p.time)).toEqual([2, 3, 4])
  })

  it('多 scope 独立、last/latestCost/scopes/clear 可用', () => {
    const t = new CostTrail()
    t.push('day', 1, 1)
    t.push('month', 1, 10)
    expect(t.last('day')?.cost).toBe(1)
    expect(t.latestCost('month')).toBe(10)
    expect(t.scopes().sort()).toEqual(['day', 'month'])
    t.clear('day')
    expect(t.latestCost('day')).toBe(0)
    t.push('total', 1, 7)
    t.clear()
    expect(t.scopes()).toEqual([])
  })
})