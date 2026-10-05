import { describe, it, expect } from 'vitest'
import { MemorySnapshotStore, encodeSnapshot, decodeSnapshot, snapshotToMeterSeed } from '../src/core/store.js'
import type { CostSnapshot } from '../src/core/types.js'

function validSnapshot(overrides: Record<string, unknown> = {}): CostSnapshot {
  return {
    version: 1,
    savedAt: 1_700_000_000_000,
    buckets: {
      total: {
        requests: 2,
        inputTokens: 100,
        cacheReadTokens: 20,
        outputTokens: 50,
        reasoningTokens: 5,
        totalTokens: 170,
        cost: 0.42,
        credits: 3,
      },
    },
    routes: {},
    sessions: {},
    bands: {},
    ...overrides,
  } as CostSnapshot
}

describe('store.MemorySnapshotStore', () => {
  it('未保存时 load 为 undefined', async () => {
    const store = new MemorySnapshotStore()
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('save 后 load 返回同一快照（引用保留）', async () => {
    const store = new MemorySnapshotStore()
    const snap = validSnapshot()
    await store.save(snap)
    await expect(store.load()).resolves.toBe(snap)
  })
})

describe('store.encodeSnapshot / decodeSnapshot', () => {
  it('编码为合法 JSON 字符串', () => {
    const snap = validSnapshot()
    const text = encodeSnapshot(snap)
    expect(typeof text).toBe('string')
    expect(JSON.parse(text)).toEqual(snap)
  })

  it('合法快照解码还原', () => {
    const snap = validSnapshot()
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap)
  })

  it('非法 JSON 返回 undefined（不抛错）', () => {
    expect(decodeSnapshot('{oops')).toBeUndefined()
  })

  it('非对象载荷返回 undefined', () => {
    expect(decodeSnapshot('null')).toBeUndefined()
    expect(decodeSnapshot('[1]')).toBeUndefined()
    expect(decodeSnapshot('"x"')).toBeUndefined()
  })

  it('version 不匹配返回 undefined', () => {
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ version: 2 })))).toBeUndefined()
  })

  it('savedAt 非法返回 undefined', () => {
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ savedAt: '2026' })))).toBeUndefined()
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ savedAt: Number.NaN })))).toBeUndefined()
  })

  it('buckets 缺失/非桶映射返回 undefined', () => {
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ buckets: undefined })))).toBeUndefined()
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ buckets: { total: null } })))).toBeUndefined()
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ buckets: 'x' })))).toBeUndefined()
  })

  it('routes / sessions / bands 为非法桶映射时拒绝', () => {
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ routes: { r: [] } })))).toBeUndefined()
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ sessions: { s: 1 } })))).toBeUndefined()
    expect(decodeSnapshot(encodeSnapshot(validSnapshot({ bands: { peak: 'b' } })))).toBeUndefined()
  })

  it('routes / sessions / bands 缺失时宽容通过（旧快照）', () => {
    const old = validSnapshot()
    // 直接构造缺键的对象（JSON.stringify 序列化 undefined 键即缺失）
    const { routes, sessions, bands, ...rest } = old
    const decoded = decodeSnapshot(JSON.stringify(rest))
    expect(decoded).toBeDefined()
    expect(decoded!.buckets.total.inputTokens).toBe(100)
  })
})

describe('store.snapshotToMeterSeed', () => {
  it('映射 buckets/routes/sessions 并补齐 bands', () => {
    const seed = snapshotToMeterSeed(validSnapshot())
    expect(seed.buckets).toEqual(validSnapshot().buckets)
    expect(seed.routes).toEqual({})
    expect(seed.sessions).toEqual({})
    expect(seed.bands).toEqual({})
  })

  it('bands 缺失时兜底为空映射', () => {
    const snap = validSnapshot()
    const { bands, ...rest } = snap
    const seed = snapshotToMeterSeed(rest as CostSnapshot)
    expect(seed.bands).toEqual({})
  })
})