import { describe, it, expect } from 'vitest'
import {
  ReasoningTaxAuditLedger,
  buildReasoningTaxAuditExplanation,
  formatReasoningTaxAuditExplanation,
} from '../src/core/reasoning-tax-audit.js'
import type { UsageEntry } from '../src/core/types.js'

const T0 = 1_700_000_000_000 // 固定基准时间（epoch ms）

function entry(model: string, reasoningTokens: number, outputTokens: number, time = T0): UsageEntry {
  return {
    time,
    route: { provider: 'deepseek', model },
    usage: { inputTokens: 100, outputTokens },
    cacheReadTokens: 0,
    reasoningTokens,
    cost: 0,
    credits: 0,
    totalTokens: 100 + outputTokens + reasoningTokens,
    band: 'base',
  }
}

const priceOf = (model: string): number => (model === 'reasoner' ? 2000 : model === 'chat' ? 500 : 0)

describe('ReasoningTaxAuditLedger 会话切片（Top N 排行）', () => {
  it('按 sessionId 聚合推理 token / 输出 / 税成本，输出排行与主因会话', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf)
    ledger.append(entry('reasoner', 3000, 200, T0), 'sess-a')
    ledger.append(entry('reasoner', 1000, 100, T0), 'sess-b')
    ledger.append(entry('chat', 500, 400, T0), 'sess-a')
    const report = ledger.report()
    expect(report).not.toBeNull()
    expect(report!.window).toBe('current')
    expect(report!.totalReasoningTokens).toBe(4500)
    expect(report!.totalOutputTokens).toBe(700)
    // 税成本：reasoner 4000×2000/1e6=8；chat 500×500/1e6=0.25 → 8.25
    expect(report!.totalTaxCost).toBeCloseTo(8.25, 6)
    // 会话排行：sess-a（8.25）> sess-b（2）
    expect(report!.sessions.length).toBe(2)
    expect(report!.sessions[0].key).toBe('sess-a')
    expect(report!.sessions[0].reasoningTokens).toBe(3500)
    expect(report!.dominantSession?.key).toBe('sess-a')
    expect(report!.sessionRequests).toBe(3)
    // 税比 = 4500 / (4500 + 700)
    expect(report!.taxRatio).toBeCloseTo(4500 / 5200, 10)
  })

  it('sessionTopN 截断排行条数', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf, { sessionTopN: 2 })
    for (let i = 0; i < 4; i++) {
      ledger.append(entry('reasoner', 1000 + i * 100, 50, T0), `sess-${i}`)
    }
    expect(ledger.report()!.sessions.length).toBe(2)
    expect(ledger.report()!.sessions[0].key).toBe('sess-3')
  })

  it('无 sessionId 只记热力、不记会话切片（零回归）', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf)
    ledger.append(entry('reasoner', 1000, 100, T0))
    const report = ledger.report()!
    expect(report.sessions.length).toBe(0)
    expect(report.sessionRequests).toBe(0)
    expect(report.heat.length).toBe(1)
    expect(report.dominantSession).toBeUndefined()
  })

  it('reasoningTokens <= 0 不入账；全空样本时 report 为 null', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf)
    ledger.append(entry('reasoner', 0, 100, T0), 'sess-a')
    expect(ledger.report()).toBeNull()
  })
})

describe('ReasoningTaxAuditLedger 时间热力桶', () => {
  const hourMs = 60 * 60_000

  it('按 bucketMinutes 分桶，输出热力序列（start 升序）与峰值桶', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf, { bucketMinutes: 60 })
    // 同一桶两条
    ledger.append(entry('reasoner', 2000, 100, T0), 'sess-a')
    ledger.append(entry('reasoner', 1000, 50, T0), 'sess-b')
    // 下一桶一条
    ledger.append(entry('reasoner', 4000, 100, T0 + hourMs), 'sess-c')
    const report = ledger.report()!
    expect(report.heat.length).toBe(2)
    const first = report.heat[0]
    expect(first.key).toBe(String(Math.floor(T0 / hourMs) * hourMs))
    expect(first.requests).toBe(2)
    expect(first.end - first.start).toBe(hourMs)
    // 峰值桶 = 税成本最高 = 第二桶（8 > 6）
    expect(report.dominantBucket?.key).toBe(report.heat[1].key)
    expect(report.taxRatio).toBeCloseTo(7000 / (7000 + 250), 10)
  })

  it('heatBuckets 限制保留最近桶数', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf, { heatBuckets: 2 })
    for (let i = 0; i < 4; i++) {
      ledger.append(entry('reasoner', 1000, 100, T0 + i * hourMs))
    }
    const report = ledger.report()!
    expect(report.heat.length).toBe(2)
    expect(report.heat[0].start).toBe(Math.floor((T0 + 2 * hourMs) / hourMs) * hourMs)
  })

  it('reset 后清空账本（报表回 null）', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf)
    ledger.append(entry('reasoner', 1000, 100, T0), 'sess-a')
    expect(ledger.report()).not.toBeNull()
    ledger.reset()
    expect(ledger.report()).toBeNull()
  })
})

describe('buildReasoningTaxAuditExplanation 中文审计叙事', () => {
  it('summary + factor + suggestion 结构完整，含主因会话与热力证据', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf)
    ledger.append(entry('reasoner', 3000, 100, T0), 'sess-a')
    ledger.append(entry('reasoner', 500, 50, T0), 'sess-b')
    const report = ledger.report()!
    const items = buildReasoningTaxAuditExplanation(report)
    expect(items[0].kind).toBe('summary')
    const text = formatReasoningTaxAuditExplanation(items)
    expect(text).toContain('多维思考税审计')
    expect(text).toContain('主因会话「sess-a」')
    expect(text).toContain('热力峰值')
    expect(items.some((i) => i.kind === 'suggestion')).toBe(true)
    // 会话占比 3000/3500 ≈ 0.857 ≥ 0.5 → 会话收敛建议
    expect(text).toContain('thinking_budget')
  })

  it('无官方价路由税成本为 0：排行只按有价会话，叙事给出无价提示', () => {
    const ledger = new ReasoningTaxAuditLedger(priceOf)
    ledger.append(entry('unknown', 3000, 100, T0), 'sess-a')
    const report = ledger.report()!
    expect(report.dominantSession?.taxCost).toBe(0)
    const items = buildReasoningTaxAuditExplanation(report)
    const text = formatReasoningTaxAuditExplanation(items)
    expect(text).toContain('无官方价')
    expect(items.some((i) => i.kind === 'suggestion')).toBe(true)
  })
})