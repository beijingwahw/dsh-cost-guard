import { describe, it, expect } from 'vitest'
import { clamp, sortedAsc, percentile } from '../src/core/math.js'

describe('math.clamp', () => {
  it('低于下界钳到 min', () => {
    expect(clamp(-1, 0, 10)).toBe(0)
  })
  it('高于上界钳到 max', () => {
    expect(clamp(11, 0, 10)).toBe(10)
  })
  it('区间内原样返回', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(0, 0, 10)).toBe(0)
    expect(clamp(10, 0, 10)).toBe(10)
  })
})

describe('math.sortedAsc', () => {
  it('返回升序副本（不改原数组）', () => {
    const src = [3, 1, 2]
    expect(sortedAsc(src)).toEqual([1, 2, 3])
    expect(src).toEqual([3, 1, 2])
  })
})

describe('math.percentile', () => {
  it('空数组返回 0', () => {
    expect(percentile([], 50)).toBe(0)
  })
  it('单元素直接返回该值（任意百分位）', () => {
    expect(percentile([7], 0)).toBe(7)
    expect(percentile([7], 100)).toBe(7)
  })
  it('rank 恰为整数时返回对应元素（lo === hi）', () => {
    expect(percentile([10, 20, 30, 40], 0)).toBe(10)
    expect(percentile([10, 20, 30, 40], 100)).toBe(40)
  })
  it('线性插值：p50 取中位', () => {
    // rank = 0.5 * 3 = 1.5 → 20 + (30-20)*0.5 = 25
    expect(percentile([10, 20, 30, 40], 50)).toBe(25)
  })
  it('p90 高分位', () => {
    // rank = 0.9 * 4 = 3.6 → lo=3(400) hi=4(500) frac=0.6 → 400 + 100*0.6 = 460
    expect(percentile([100, 200, 300, 400, 500], 90)).toBe(460)
  })
})