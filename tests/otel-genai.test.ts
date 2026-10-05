import { describe, it, expect } from 'vitest'
import { toGenAiSpan, OtelLedger, fnv1a32, stableHex } from '../src/core/otel-genai.js'

const entry = {
  time: Date.UTC(2026, 9, 5, 3, 0, 0),
  cost: 1.506,
  credits: 10,
  band: 'peak',
  totalTokens: 1_200_000,
}

const tokens = { inputTokens: 700_000, cacheReadTokens: 300_000, outputTokens: 200_000, reasoningTokens: 50_000 }

describe('toGenAiSpan OTel GenAI 语义', () => {
  it('标准属性：operation / system / model / usage（SemConv 命名）', () => {
    const span = toGenAiSpan('deepseek/deepseek-chat', entry, tokens, 'sess-1')
    const a = span.attributes
    expect(a['gen_ai.operation.name']).toBe('chat')
    expect(a['gen_ai.system']).toBe('deepseek')
    expect(a['gen_ai.request.model']).toBe('deepseek-chat')
    expect(a['gen_ai.response.model']).toBe('deepseek-chat')
    expect(a['gen_ai.usage.input_tokens']).toBe(700_000)
    expect(a['gen_ai.usage.output_tokens']).toBe(200_000)
    expect(a['gen_ai.usage.cache_read_input_tokens']).toBe(300_000)
  })

  it('扩展属性：成本 / 币种 / 推理 / 时段 / 积分 / 会话', () => {
    const span = toGenAiSpan('deepseek/deepseek-v4-pro', entry, tokens, 'sess-9', { currencyOf: () => 'CNY' })
    const a = span.attributes
    expect(a['dsh.cost.amount']).toBe(1.506)
    expect(a['dsh.cost.currency']).toBe('CNY')
    expect(a['dsh.cost.reasoning_tokens']).toBe(50_000)
    expect(a['dsh.cost.band']).toBe('peak')
    expect(a['dsh.cost.credits']).toBe(10)
    expect(a['dsh.session.id']).toBe('sess-9')
  })

  it('trace/span 标识确定性与会话关联', () => {
    const s1 = toGenAiSpan('deepseek/deepseek-chat', entry, tokens, 'sess-1')
    const s2 = toGenAiSpan('deepseek/deepseek-chat', { ...entry, time: entry.time + 1000 }, tokens, 'sess-1')
    const s3 = toGenAiSpan('deepseek/deepseek-chat', entry, tokens, 'sess-2')
    // 同一会话同 trace、不同 spanId（时间不同）
    expect(s1.traceId).toBe(s2.traceId)
    expect(s1.traceId).not.toBe(s3.traceId)
    expect(s1.spanId).not.toBe(s2.spanId)
    expect(s1.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(s1.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('无会话时 traceId 由路由稳定派生（匿名可关联）', () => {
    const s1 = toGenAiSpan('deepseek/deepseek-chat', entry, tokens)
    const s2 = toGenAiSpan('deepseek/deepseek-chat', entry, tokens)
    expect(s1.traceId).toBe(s2.traceId)
  })

  it('时间戳为 Unix 纳秒且与事件一致（事件级粒度）', () => {
    const span = toGenAiSpan('deepseek/deepseek-chat', entry, tokens)
    expect(span.startTimeUnixNano).toBe(entry.time * 1_000_000)
    expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano)
    expect(span.name).toBe('chat')
    expect(span.kind).toBe('INTERNAL')
  })
})

describe('fnv1a32 / stableHex', () => {
  it('FNV-1a 32 位散列确定性', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'))
    expect(fnv1a32('abc')).toBe(440920332)
  })

  it('stableHex 长度与确定性', () => {
    expect(stableHex('s', 32)).toMatch(/^[0-9a-f]{32}$/)
    expect(stableHex('s', 16)).toBe(stableHex('s', 16))
    expect(stableHex('a', 16)).not.toBe(stableHex('b', 16))
  })
})

describe('OtelLedger 遥测缓冲', () => {
  it('append / count / JSONL / clear', () => {
    const seen: string[] = []
    const ledger = new OtelLedger({ sink: (s) => seen.push(s.attributes['gen_ai.request.model']) })
    ledger.append(toGenAiSpan('deepseek/deepseek-chat', entry, tokens, 's'))
    expect(ledger.count).toBe(1)
    expect(seen).toEqual(['deepseek-chat'])
    expect(JSON.parse(ledger.toJsonl()).attributes['gen_ai.system']).toBe('deepseek')
    ledger.clear()
    expect(ledger.count).toBe(0)
  })

  it('容量上限丢最旧', () => {
    const ledger = new OtelLedger({ capacity: 2 })
    for (let i = 0; i < 4; i++) ledger.append(toGenAiSpan(`p/m${i}`, entry, tokens, `s${i}`))
    expect(ledger.count).toBe(2)
    expect(ledger.spansOf()[0]!.attributes['gen_ai.request.model']).toBe('m2')
  })
})