import { describe, it, expect } from 'vitest'
import { CacheHintDetector, DEFAULT_HINT_CONFIG } from '../src/core/cache-hint.js'
import { CachePricingEngine } from '../src/core/cache-pricing.js'
import type { TokenSplit } from '../src/core/cache-types.js'

const engine = new CachePricingEngine()
const tz = 480
// 北京 helper：返回北京时钟 (hh:mm) 对应的 epoch ms
const bj = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m - 1, d, hh, mm) - 8 * 60 * 60 * 1000
// 北京 2026-09-07（周一，非节假日）10:00 → peak
const TIME_PEAK = bj(2026, 9, 7, 10, 0)
// 北京 2026-09-07（周一）22:00 → idle
const TIME_IDLE = bj(2026, 9, 7, 22, 0)

function split(hit: number, miss: number, uncertainty?: TokenSplit['uncertainty']): TokenSplit {
  return uncertainty
    ? { inputHit: hit, inputMiss: miss, output: 0, uncertainty }
    : { inputHit: hit, inputMiss: miss, output: 0 }
}

describe('cache-hint 前缀提示检测', () => {
  it('达到阈值（repeat>=3 且 saving>=0.5）触发候选；默认阈值与文档一致', () => {
    expect(DEFAULT_HINT_CONFIG).toEqual({ minRepeat: 3, minSaving: 0.5 })
    const d = new CacheHintDetector(engine)
    // flash peak 未命中价 2.0 / 命中价 0.04 → 每 1M 差的 1.96 元
    // 每次 300k 未命中 → 0.3*1.96 = 0.588 元/次；3 次 → 1.764 元
    for (let i = 0; i < 3; i++) d.observe('p1', 'deepseek/deepseek-flash', split(0, 300_000), TIME_PEAK, tz)
    const c = d.candidates()
    expect(c).toHaveLength(1)
    expect(c[0]!.prefixId).toBe('p1')
    expect(c[0]!.repeatCount).toBe(3)
    expect(c[0]!.potentialSaving).toBeCloseTo(3 * 0.3 * (2.0 - 0.04))
    expect(c[0]!.observedHitRate).toBe(0)
  })

  it('低于阈值不触发：重复次数不足 / 节省金额不足两类', () => {
    // 重复不足：仅 2 次
    const d1 = new CacheHintDetector(engine)
    d1.observe('p1', 'deepseek/deepseek-flash', split(0, 300_000), TIME_PEAK, tz)
    d1.observe('p1', 'deepseek/deepseek-flash', split(0, 300_000), TIME_PEAK, tz)
    expect(d1.candidates()).toHaveLength(0)
    // 金额不足：3 次 × 10k 未命中 → 0.01*1.96*3 = 0.0588 元 << 0.5
    const d2 = new CacheHintDetector(engine)
    for (let i = 0; i < 3; i++) d2.observe('p2', 'deepseek/deepseek-flash', split(0, 10_000), TIME_PEAK, tz)
    expect(d2.candidates()).toHaveLength(0)
  })

  it('部分命中时按未命中部分估算潜在节省并累计命中率', () => {
    const d = new CacheHintDetector(engine)
    // 每次 300k 命中 + 300k 未命中，3 次 → 未命中累计 900k（0.882 元 ≥ 0.5 触发）
    for (let i = 0; i < 3; i++) d.observe('p3', 'deepseek/deepseek-flash', split(300_000, 300_000), TIME_IDLE, tz)
    const c = d.candidates()
    expect(c).toHaveLength(1)
    expect(c[0]!.potentialSaving).toBeCloseTo(3 * 0.3 * (1.0 - 0.02)) // idle 价差 0.98/1M
    expect(c[0]!.observedHitRate).toBeCloseTo(0.5) // 900k hit / 1.8M total
  })

  it('不确定请求不参与统计（不计数 hits，视为被忽略）', () => {
    const d = new CacheHintDetector(engine)
    // 2 次正常 + 1 次不确定（缺失字段）→ 正常仅 2 次，未达 minRepeat=3
    d.observe('p4', 'deepseek/deepseek-flash', split(0, 300_000), TIME_PEAK, tz)
    d.observe('p4', 'deepseek/deepseek-flash', split(0, 300_000), TIME_PEAK, tz)
    d.observe('p4', 'deepseek/deepseek-flash', split(0, 300_000, 'cached-unknown'), TIME_PEAK, tz)
    expect(d.candidates()).toHaveLength(0)
    // 全部不确定 → 永远不触发
    const d2 = new CacheHintDetector(engine)
    for (let i = 0; i < 5; i++) d2.observe('p5', 'deepseek/deepseek-flash', split(0, 300_000, 'malformed'), TIME_PEAK, tz)
    expect(d2.candidates()).toHaveLength(0)
  })

  it('多个候选按潜在节省降序输出', () => {
    const d = new CacheHintDetector(engine)
    // pA 每次未命中 400k × 3（1.176 元），pB 每次未命中 200k × 3（0.588 元 ≥ 0.5 触发）
    for (let i = 0; i < 3; i++) {
      d.observe('pA', 'deepseek/deepseek-flash', split(0, 400_000), TIME_IDLE, tz)
      d.observe('pB', 'deepseek/deepseek-flash', split(0, 200_000), TIME_IDLE, tz)
    }
    const c = d.candidates()
    expect(c.map((x) => x.prefixId)).toEqual(['pA', 'pB'])
    expect(c[0]!.potentialSaving).toBeCloseTo(3 * 0.4 * 0.98)
    expect(c[1]!.potentialSaving).toBeCloseTo(3 * 0.2 * 0.98)
  })
})