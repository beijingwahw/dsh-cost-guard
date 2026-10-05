import { describe, it, expect } from 'vitest'
import { buildExplanation, formatExplanation, formatExplanationLines } from '../src/core/explain.js'
import { analyzeCostRca } from '../src/core/rca.js'
import type { UsageBucket } from '../src/core/types.js'

function bucket(cost: number, opts: { input?: number; cache?: number; output?: number } = {}): UsageBucket {
  const input = opts.input ?? 0
  const cache = opts.cache ?? 0
  const output = opts.output ?? 0
  return {
    cost,
    credits: 0,
    requests: 1,
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output,
  }
}

describe('buildExplanation 可解释成本叙事', () => {
  it('存量归因：summary + 主因因子句 + 无缓存信号时的通用建议', () => {
    const report = analyzeCostRca({
      sessions: { taskA: bucket(80), taskB: bucket(20) },
      routes: { 'deepseek/deepseek-chat': bucket(80), 'deepseek/deepseek-flash': bucket(20) },
    })
    const items = buildExplanation(report)
    const summary = items.find((i) => i.kind === 'summary')
    expect(summary?.text).toContain('当前累计')
    expect(summary?.text).toContain('成本根因报告')
    const sessionFactor = items.filter((i) => i.kind === 'factor' && i.text.includes('taskA'))
    expect(sessionFactor.length).toBeGreaterThan(0)
    expect(items.some((i) => i.kind === 'suggestion' && i.text.includes('当前无可优化的通道/缓存信号'))).toBe(true)
  })

  it('输出通道占比超阈值：给出输出压缩建议（不依赖缓存计量）', () => {
    const report = analyzeCostRca({
      sessions: { a: bucket(10, { input: 100, output: 900 }) },
    })
    const items = buildExplanation(report, { outputShareWarnAt: 0.5 })
    const suggestion = items.find((i) => i.kind === 'suggestion')
    expect(suggestion?.text).toContain('输出 token 占计费 token 90%')
    expect(suggestion?.text).toContain('压缩输出')
  })

  it('缓存命中率低：复用缓存维度计量事实给第一杠杆建议（含已省金额）', () => {
    const report = analyzeCostRca({ sessions: { a: bucket(10) } })
    const items = buildExplanation(report, {
      cache: { hitRate: 0.2, saving: 3.5 },
      cacheHitWarnAt: 0.4,
    })
    const suggestion = items.find((i) => i.kind === 'suggestion')
    expect(suggestion?.text).toContain('缓存命中率仅 20%')
    expect(suggestion?.text).toContain('已省 3.50')
    expect(suggestion?.text).toContain('0.1 倍')
  })

  it('缓存命中良好且有前缀提示：给「再省空间」建议', () => {
    const report = analyzeCostRca({ sessions: { a: bucket(10) } })
    const items = buildExplanation(report, {
      cache: { hitRate: 0.85, saving: 9, hintCount: 2 },
    })
    const suggestion = items.find((i) => i.kind === 'suggestion')
    expect(suggestion?.text).toContain('命中率 85%')
    expect(suggestion?.text).toContain('2 条可优化前缀提示')
  })

  it('路由替代建议转述：只输出调用方给的既有结论前 3 条', () => {
    const report = analyzeCostRca({ sessions: { a: bucket(10) } })
    const items = buildExplanation(report, {
      replacementHints: ['改用 deepseek-flash 可省 30%', '迁移至 v4-pro 提升质量', '第三条', '第四条将被截断'],
    })
    const suggestions = items.filter((i) => i.kind === 'suggestion' && i.text.includes('路由替代'))
    expect(suggestions.length).toBe(3)
    expect(suggestions[0]?.text).toContain('deepseek-flash')
  })

  it('delta 归因：summary 含基线变化与增量贡献', () => {
    const report = analyzeCostRca(
      { sessions: { a: bucket(9), b: bucket(1) } },
      { baseline: { sessions: { a: bucket(1), b: bucket(1) } } },
    )
    const items = buildExplanation(report)
    const summary = items.find((i) => i.kind === 'summary')
    expect(summary?.text).toContain('较基线')
    expect(summary?.text).toContain('变化 +8.00')
    const factorA = items.find((i) => i.kind === 'factor' && i.text.includes('「a」'))
    expect(factorA?.text).toContain('增量贡献')
    expect(factorA?.text).toContain('+8.00')
  })

  it('噪声合并句：低贡献因子合计输出', () => {
    const sessions: Record<string, UsageBucket> = {
      s0: bucket(50),
      s1: bucket(20),
      s2: bucket(10),
      s3: bucket(3),
      s4: bucket(2),
      s5: bucket(1),
      s6: bucket(1),
      s7: bucket(1),
      s8: bucket(1),
      s9: bucket(1),
    }
    const report = analyzeCostRca({ sessions }, { topN: 3 })
    const items = buildExplanation(report)
    const noise = items.find((i) => i.kind === 'factor' && i.text.includes('其余'))
    // kept 外 s3..s9 共 7 个（s2=10% 属次因保留在列）
    expect(noise?.text).toContain('7 个低贡献因子')
  })

  it('formatExplanation 与 formatExplanationLines：单段文本与分行渲染', () => {
    const report = analyzeCostRca({ sessions: { a: bucket(10) } })
    const items = buildExplanation(report)
    const text = formatExplanation(items)
    expect(text).toContain('成本根因报告')
    const lines = formatExplanationLines(items)
    const summary = lines[0] ?? ''
    expect(summary.startsWith('成本根因报告')).toBe(true)
    // factor/建议行带缩进或前缀
    expect(lines.some((l) => l.startsWith('  '))).toBe(true)
    const suggestionLine = lines.find((l) => l.includes('建议:') || l.includes('建议：'))
    if (suggestionLine !== undefined) {
      expect(suggestionLine).not.toContain('💡')
    }
  })

  it('零成本样本：不产生任何建议（避免对空数据说教）', () => {
    const report = analyzeCostRca({})
    const items = buildExplanation(report)
    expect(items.filter((i) => i.kind === 'suggestion')).toEqual([])
    expect(items[0]?.kind).toBe('summary')
  })

  it('outputShareWarnAt 阈值参数化：低于阈值不触发输出建议', () => {
    const report = analyzeCostRca({
      sessions: { a: bucket(10, { input: 800, output: 200 }) },
    })
    const items = buildExplanation(report, { outputShareWarnAt: 0.5 })
    expect(items.some((i) => i.kind === 'suggestion' && i.text.includes('输出 token'))).toBe(false)
  })
})