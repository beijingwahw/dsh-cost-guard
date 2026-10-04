import { describe, it, expect } from 'vitest'
import { parseCachedUsage, outcomeToSplit, splitCachedUsage } from '../src/core/cache-parse.js'
import type { RawUsageSnapshot } from '../src/core/cache-types.js'

const rawSnapshot = (promptTokens: number, completionTokens: number, cachedTokens?: number): RawUsageSnapshot => ({
  promptTokens,
  completionTokens,
  ...(cachedTokens === undefined ? {} : { cachedTokens }),
})

describe('cache-parse 解析正常', () => {
  it('cached=0 正常解析（确无命中）', () => {
    const r = parseCachedUsage(rawSnapshot(1_000, 200, 0))
    expect(r).toEqual({ ok: true, cached: 0, uncached: 1_000 })
  })

  it('部分命中拆分正确', () => {
    const r = parseCachedUsage(rawSnapshot(1_000, 200, 300))
    expect(r).toEqual({ ok: true, cached: 300, uncached: 700 })
  })

  it('全覆盖（cached == promptTokens）', () => {
    const r = parseCachedUsage(rawSnapshot(1_000, 200, 1_000))
    expect(r).toEqual({ ok: true, cached: 1_000, uncached: 0 })
  })

  it('大数命中不溢出', () => {
    const r = parseCachedUsage(rawSnapshot(5_000_000, 100, 4_999_999))
    expect(r).toEqual({ ok: true, cached: 4_999_999, uncached: 1 })
  })

  it('cachedTokens 缺失时 splitCachedUsage 回退未命中并标注 cached-unknown', () => {
    const split = splitCachedUsage({ promptTokens: 1_000, completionTokens: 200 }, 200)
    expect(split).toEqual({ inputHit: 0, inputMiss: 1_000, output: 200, uncertainty: 'cached-unknown' })
  })

  it('outcomeToSplit 正常分支保留三段', () => {
    const split = outcomeToSplit({ ok: true, cached: 300, uncached: 700 }, 200)
    expect(split).toEqual({ inputHit: 300, inputMiss: 700, output: 200 })
  })
})

describe('cache-parse 回退分支', () => {
  it('raw 为 null / undefined 回退 missing', () => {
    const a = parseCachedUsage(null)
    expect(a).toEqual({ ok: false, reason: 'missing', rawPrompt: 0 })
    const b = parseCachedUsage(undefined)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.reason).toBe('missing')
  })

  it('缓存/输入取值为负或 NaN（非法值家族）回退 malformed', () => {
    expect(parseCachedUsage(rawSnapshot(1_000, 200, -5))).toEqual({ ok: false, reason: 'malformed', rawPrompt: 1_000 })
    const negPrompt = parseCachedUsage(rawSnapshot(-10, 0, 0))
    expect(negPrompt).toEqual({ ok: false, reason: 'malformed', rawPrompt: -10 })
    const nan = parseCachedUsage({ promptTokens: Number.NaN, completionTokens: 0, cachedTokens: 0 })
    expect(nan.ok).toBe(false)
    if (!nan.ok) expect(nan.reason).toBe('malformed')
  })

  it('cachedTokens 非整数回退 malformed', () => {
    const r = parseCachedUsage(rawSnapshot(1_000, 200, 100.5))
    expect(r).toEqual({ ok: false, reason: 'malformed', rawPrompt: 1_000 })
  })

  it('cachedTokens 大于 promptTokens 回退 malformed', () => {
    const r = parseCachedUsage(rawSnapshot(1_000, 200, 1_500))
    expect(r).toEqual({ ok: false, reason: 'malformed', rawPrompt: 1_000 })
  })

  it('outcomeToSplit / splitCachedUsage 回退分支全部按未命中计费并标注 uncertainty', () => {
    const missing = outcomeToSplit({ ok: false, reason: 'missing', rawPrompt: 1_000 }, 200)
    expect(missing).toEqual({ inputHit: 0, inputMiss: 1_000, output: 200, uncertainty: 'cached-unknown' })
    const malformed = outcomeToSplit({ ok: false, reason: 'malformed', rawPrompt: 50 }, 30)
    expect(malformed).toEqual({ inputHit: 0, inputMiss: 50, output: 30, uncertainty: 'malformed' })
    // 便携入口同样回退标注
    const a = splitCachedUsage({ promptTokens: 800, completionTokens: 0 })
    expect(a.uncertainty).toBe('cached-unknown')
    expect(a.inputMiss).toBe(800)
    const b = splitCachedUsage({ promptTokens: 800, completionTokens: 0, cachedTokens: 900 })
    expect(b.uncertainty).toBe('malformed')
  })
})