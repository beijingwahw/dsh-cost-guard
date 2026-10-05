import { describe, it, expect } from 'vitest'
import {
  ReasoningTaxLedger,
  buildReasoningTaxExplanation,
  formatReasoningTaxExplanation,
  type ReasoningTaxBudget,
} from '../src/core/reasoning-tax.js'
import type { UsageEntry } from '../src/core/types.js'

function entry(routeModel: string, reasoningTokens: number, outputTokens: number, cost = 0): UsageEntry {
  return {
    time: 1_700_000_000_000,
    route: { provider: 'deepseek', model: routeModel },
    usage: { inputTokens: 100, outputTokens },
    cacheReadTokens: 0,
    reasoningTokens,
    cost,
    credits: 0,
    totalTokens: 100 + outputTokens,
    band: 'base',
  }
}

const priceOf = (model: string): number => (model === 'thinker' ? 8 : model === 'cheap' ? 1 : 0)

describe('ReasoningTaxLedger 思考税账本', () => {
  it('按路由聚合推理 token / 可见输出 / 税成本（推理 × 输出价）', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('thinker', 2000, 300, 5))
    ledger.append(entry('thinker', 1000, 100, 2))
    ledger.append(entry('cheap', 500, 200, 0.5))
    const report = ledger.report()
    expect(report).not.toBeNull()
    expect(report!.totalReasoningTokens).toBe(3500)
    expect(report!.totalOutputTokens).toBe(600)
    expect(report!.totalTaxCost).toBe(8 * 3000 / 1_000_000 + 1 * 500 / 1_000_000)
    expect(report!.pricedRoutes).toBe(2)
    // 税比 = 3500 / (3500 + 600)
    expect(report!.taxRatio).toBeCloseTo(3500 / 4100, 10)
    // 主因按税成本降序：thinker(0.009+0.003=0.012) > cheap(0.0005)
    expect(report!.dominant?.route).toBe('deepseek/thinker')
    expect(report!.byRoute[0].requests).toBe(2)
  })

  it('无推理样本时 report 返回 null；reset 后同样为 null', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('thinker', 0, 300))
    expect(ledger.report()).toBeNull()
    ledger.append(entry('thinker', 500, 50))
    expect(ledger.report()).not.toBeNull()
    ledger.reset()
    expect(ledger.report()).toBeNull()
  })

  it('无官方价路由税成本为 0，排序靠后', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('unknown', 3000, 10))
    ledger.append(entry('cheap', 100, 5))
    const report = ledger.report()!
    // unknown taxCost=0 虽推理多但排后；cheap 是主因
    expect(report.dominant?.route).toBe('deepseek/cheap')
    expect(report.pricedRoutes).toBe(1)
    expect(report.byRoute[1].route).toBe('deepseek/unknown')
  })

  it('预算水位：ratio 到达 warnAt / hardAt 分别 warn / block；未配预算时不输出 budget', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('thinker', 2000, 300))
    const trivial: ReasoningTaxBudget = { limit: 0, warnAt: 0.8, hardAt: 1 }
    expect(ledger.report(trivial)?.budget).toBeUndefined()

    // spent = 2000×8/1e6 = 0.016；limit=0.002 → ratio=8 → block
    const tiny: ReasoningTaxBudget = { limit: 0.002, warnAt: 0.5, hardAt: 1 }
    const blockReport = ledger.report(tiny)!
    expect(blockReport.budget?.level).toBe('block')

    // limit=0.025 → ratio=0.64 落 [warnAt, hardAt) → warn
    const warnCase: ReasoningTaxBudget = { limit: 0.025, warnAt: 0.5, hardAt: 0.9 }
    expect(ledger.report(warnCase)?.budget?.level).toBe('warn')
  })

  it('窗口恒为 current', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('thinker', 100, 10))
    expect(ledger.report()!.window).toBe('current')
  })
})

describe('buildReasoningTaxExplanation 思考税叙事', () => {
  it('summary + factor + suggestion 结构完整，叙事含主因路由与思考税', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('thinker', 2000, 300, 5))
    ledger.append(entry('cheap', 500, 200, 0.5))
    const report = ledger.report({ limit: 0.02, warnAt: 0.5, hardAt: 1 })!
    const items = buildReasoningTaxExplanation(report)
    expect(items[0].kind).toBe('summary')
    expect(items.some((i) => i.kind === 'factor' && i.text.includes('deepseek/thinker'))).toBe(true)
    expect(items.some((i) => i.kind === 'suggestion' && i.text.includes('思考税'))).toBe(true)
    // 税比 2500/(2500+500)=0.83 > 0.5 → 全局思考税建议
    expect(items.some((i) => i.kind === 'suggestion' && i.text.includes('全局思考税'))).toBe(true)
  })

  it('预算告警/阻断时给出对应建议；无预算且无其他建议时提示可设预算', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('cheap', 100, 10))
    const report = ledger.report({ limit: 2, warnAt: 0.5, hardAt: 1 })!
    const noBudget = ledger.report()!
    const items = buildReasoningTaxExplanation(noBudget)
    expect(items.some((i) => i.kind === 'suggestion')).toBe(true)

    // 无预算、税比 100/(110)=0.909 > 0.5 会走全局建议，不走到「可设预算」
    const cheapOnly = new ReasoningTaxLedger(priceOf)
    cheapOnly.append(entry('lowtax', 100, 1000))
    const items2 = buildReasoningTaxExplanation(cheapOnly.report()!)
    const hasBudgetHint = items2.some((i) => i.text.includes('单独设置预算'))
    expect(hasBudgetHint).toBe(true)
  })

  it('formatReasoningTaxExplanation 拼接为多行文本', () => {
    const ledger = new ReasoningTaxLedger(priceOf)
    ledger.append(entry('thinker', 100, 10))
    const text = formatReasoningTaxExplanation(buildReasoningTaxExplanation(ledger.report()!))
    expect(text.split('\n').length).toBeGreaterThanOrEqual(3)
    expect(text).toContain('推理成本解释')
  })
})