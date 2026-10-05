import { describe, it, expect } from 'vitest'
import { buildUnitEconomics } from '../src/core/unit-economy.js'
import { emptyBucket, type UsageBucket } from '../src/core/types.js'

function bucket(partial: Partial<UsageBucket>): UsageBucket {
  return { ...emptyBucket(), ...partial }
}

describe('buildUnitEconomics 单位经济学与成本归属', () => {
  it('会话维度：cost per task / per request / per M tokens 与占比（Showback）', () => {
    const sessions: Record<string, UsageBucket> = {
      'sess-A': bucket({ requests: 10, totalTokens: 1_000_000, cost: 5 }),
      'sess-B': bucket({ requests: 5, totalTokens: 500_000, cost: 1 }),
    }
    const report = buildUnitEconomics(sessions, {}, 2)
    expect(report.totalCost).toBe(6)
    expect(report.costPerRequest).toBeCloseTo(6 / 15, 6)
    expect(report.costPerMTokens).toBeCloseTo(6 / 1.5, 6)
    expect(report.sessions[0]!.sessionId).toBe('sess-A')
    expect(report.sessions[0]!.costPerTask).toBe(5)
    expect(report.sessions[0]!.costPerRequest).toBeCloseTo(0.5, 6)
    expect(report.sessions[0]!.costPerMTokens).toBeCloseTo(5, 6)
    expect(report.sessions[0]!.share).toBeCloseTo(5 / 6, 6)
    expect(report.sessions[1]!.share).toBeCloseTo(1 / 6, 6)
    expect(report.topSessions).toHaveLength(2)
    // Top-N 截断
    const top1 = buildUnitEconomics(sessions, {}, 1)
    expect(top1.topSessions).toHaveLength(1)
    expect(top1.topSessions[0]!.sessionId).toBe('sess-A')
  })

  it('路由构成：排序与占比；reasoning 从桶不可得时置 0（口径注明）', () => {
    const sessions: Record<string, UsageBucket> = { s: bucket({ cost: 2, totalTokens: 1_000_000, inputTokens: 800_000, outputTokens: 200_000 }) }
    const routes: Record<string, UsageBucket> = {
      'deepseek/deepseek-chat': bucket({ cost: 1.5, totalTokens: 600_000, inputTokens: 500_000, cacheReadTokens: 50_000, outputTokens: 50_000 }),
      'deepseek/deepseek-flash': bucket({ cost: 0.5, totalTokens: 400_000, inputTokens: 300_000, outputTokens: 100_000 }),
    }
    const report = buildUnitEconomics(sessions, routes)
    expect(report.routes[0]!.route).toBe('deepseek/deepseek-chat')
    expect(report.routes[0]!.costPerMTokens).toBeCloseTo(1.5 / 0.6, 6)
    expect(report.routes[0]!.cacheReadTokens).toBe(50_000)
    expect(report.routes[0]!.share).toBeCloseTo(1.5 / 2, 6)
    expect(report.routes[1]!.share).toBeCloseTo(0.5 / 2, 6)
    expect(report.routes[0]!.reasoningTokens).toBe(0)
  })

  it('空样本：全零安全值，不报错', () => {
    const report = buildUnitEconomics({}, {})
    expect(report.totalCost).toBe(0)
    expect(report.costPerRequest).toBe(0)
    expect(report.sessions).toEqual([])
    expect(report.topSessions).toEqual([])
    expect(report.routes).toEqual([])
  })

  it('credits 独立累计', () => {
    const report = buildUnitEconomics(
      { a: bucket({ cost: 1, credits: 42, requests: 2, totalTokens: 1000 }) },
      {},
    )
    expect(report.sessions[0]!.credits).toBe(42)
  })

  it('零消耗边的防御分支：零 token / 零请求回溯为安全值', () => {
    const sessions: Record<string, UsageBucket> = {
      zero: bucket({ cost: 0, requests: 0, totalTokens: 0 }),
      tokensOnly: bucket({ cost: 0, totalTokens: 0, requests: 0 }),
    }
    const report = buildUnitEconomics(sessions, { 'p/m': bucket({}) })
    // tokens>0 与 requests>0 均为假 → costPerRequest/costPerMTokens/share = 0
    for (const row of report.sessions) {
      expect(row.costPerRequest).toBe(0)
      expect(row.costPerMTokens).toBe(0)
      expect(row.share).toBe(0)
    }
    // route 空桶：无 token 无 cost
    expect(report.routes[0]!.tokens).toBe(0)
    expect(report.routes[0]!.costPerMTokens).toBe(0)
    expect(report.routes[0]!.share).toBe(0)
  })
})