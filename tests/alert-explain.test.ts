import { describe, it, expect } from 'vitest'
import {
  buildAlarmExplanation,
  formatAlarmExplanation,
  formatAlarmLines,
  type AlarmSignal,
} from '../src/core/alert-explain.js'
import { analyzeCostRca } from '../src/core/rca.js'
import type { UsageBucket } from '../src/core/types.js'

function bucket(cost: number, input = 0, output = 0, cacheRead = 0): UsageBucket {
  return {
    cost,
    credits: 0,
    requests: 1,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    totalTokens: input + cacheRead + output,
  }
}

describe('buildAlarmExplanation 告警根因叙事（零 DSH 纯函数）', () => {
  it('delta 告警：首句先答「为什么告警」，再给主因与建议', () => {
    const report = analyzeCostRca(
      { sessions: { taskA: bucket(8), taskB: bucket(2) } },
      { baseline: { sessions: { taskA: bucket(2), taskB: bucket(1) } } },
    )
    const signal: AlarmSignal = { scope: 'total', action: 'warn', ratio: 0.92, spent: 9.2, limit: 10 }
    const items = buildAlarmExplanation(signal, report)

    expect(items[0].kind).toBe('summary')
    const head = items[0].text
    expect(head).toContain('总预算')
    expect(head).toContain('已达 92%')
    expect(head).toContain('触发告警（请求放行）')
    expect(head).toContain('较基线 +7.00') // deltaCost = 10 - 3 = 7
    expect(head).toContain('会话视角主因「taskA」贡献 86%') // 报表摘要（增量贡献占比不含符号）

    // 会话主因行（routes 为空 -> 无路由主因行）
    const factors = items.filter((i) => i.kind === 'factor')
    expect(factors.length).toBe(1)
    expect(factors[0].text).toContain('会话主因')
    expect(factors[0].text).toContain('「taskA」')
    expect(factors[0].text).toContain('较基线 +6.00')

    // token 为 0 时走兜底建议（无据不出，只有一条）
    const suggestions = items.filter((i) => i.kind === 'suggestion')
    expect(suggestions.length).toBe(1)
    expect(suggestions[0].text).toContain('建议')
  })

  it('block 告警：措辞为「已熔断」并保留水位与间隔', () => {
    const report = analyzeCostRca({ sessions: { taskA: bucket(5) } })
    const signal: AlarmSignal = { scope: 'total', action: 'block', ratio: 1.2, spent: 1.2, limit: 1 }
    const items = buildAlarmExplanation(signal, report)
    const head = items[0].text
    expect(head).toContain('总预算')
    expect(head).toContain('已达 120%')
    expect(head).toContain('已熔断（请求被阻断）')
    expect(head).toContain('（1.20/1.00）')
  })

  it('会话/路由双视角：两条主因行各自输出 Δ 与增量贡献', () => {
    const report = analyzeCostRca(
      { sessions: { taskA: bucket(8) }, routes: { 'deepseek/deepseek-chat': bucket(8) } },
      { baseline: { sessions: { taskA: bucket(3) }, routes: { 'deepseek/deepseek-chat': bucket(3) } } },
    )
    const items = buildAlarmExplanation({ scope: 'total', action: 'warn' }, report)
    const sessionLine = items.find((i) => i.text.includes('会话主因'))
    const routeLine = items.find((i) => i.text.includes('路由主因'))
    expect(sessionLine?.text).toContain('taskA')
    expect(sessionLine?.text).toContain('+5.00')
    expect(routeLine?.text).toContain('deepseek/deepseek-chat')
    expect(routeLine?.text).toContain('+5.00')
  })

  it('输出占比高：输出省钱建议；缓存命中低：缓存建议（token 事实驱动）', () => {
    const report = analyzeCostRca({ sessions: { taskA: bucket(8, 100, 900) } })
    const items = buildAlarmExplanation({ scope: 'total', action: 'warn' }, report)
    const suggestions = items.filter((i) => i.kind === 'suggestion').map((i) => i.text)
    expect(suggestions.some((s) => s.includes('输出 token 占 90%'))).toBe(true)
    expect(suggestions.some((s) => s.includes('缓存命中占比仅 0%'))).toBe(true)
  })

  it('主持有 detail：附在首句后（预测式告警等附加信息）', () => {
    const report = analyzeCostRca({ sessions: { taskA: bucket(5) } })
    const items = buildAlarmExplanation({ scope: 'total', action: 'warn', detail: '预测式尖峰' }, report)
    expect(items[0].text).toContain('（预测式尖峰）')
  })
})

describe('formatAlarmExplanation / formatAlarmLines', () => {
  const report = analyzeCostRca({ sessions: { taskA: bucket(8), taskB: bucket(2) } })
  const items = buildAlarmExplanation({ scope: 'total', action: 'block' }, report)

  it('单段拼接：逐行换行', () => {
    const text = formatAlarmExplanation(items)
    expect(text.split('\n').length).toBe(items.length)
    expect(text).toContain('已熔断（请求被阻断）')
  })

  it('单行版：summary 无前缀、factor 两空格、suggestion 四空格引导', () => {
    const lines = formatAlarmLines(items)
    expect(lines[0]).toBe(items[0].text)
    const factorLine = lines.find((l) => l.includes('会话主因'))
    expect(factorLine?.startsWith('  会话主因：')).toBe(true)
    const sugLine = lines.find((l) => l.includes('建议'))
    expect(sugLine?.startsWith('  建议: ')).toBe(true)
  })
})