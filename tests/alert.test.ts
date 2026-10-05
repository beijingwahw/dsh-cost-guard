import { describe, it, expect, vi } from 'vitest'
import { Meter } from '../src/core/meter.js'
import { ExplainRuntime } from '../src/harness/explain.js'
import { attachAlertExplain, formatAlarmPanelLines, type ExplainAlarmPayload } from '../src/harness/alert.js'
import type { Context } from '@deepseek-ai/cordis'
import type { BudgetDecision, UsageBucket } from '../src/core/types.js'

function bucket(cost: number, input = 0, output = 0): UsageBucket {
  return {
    cost,
    credits: 0,
    requests: 1,
    inputTokens: input,
    cacheReadTokens: 0,
    outputTokens: output,
    totalTokens: input + output,
  }
}

function seedMeter(sessions: Record<string, UsageBucket>, routes: Record<string, UsageBucket>): Meter {
  return new Meter(480, { buckets: {}, bands: {}, sessions, routes })
}

function warnDecision(ratio = 0.92): BudgetDecision {
  return {
    action: 'warn',
    triggers: [{ scope: 'total', spent: 0.92, limit: 1, ratio, level: 'warn' }],
  }
}

function blockDecision(): BudgetDecision {
  return {
    action: 'block',
    triggers: [{ scope: 'total', spent: 1.2, limit: 1, ratio: 1.2, level: 'hard' }],
  }
}

function makeCtx() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ctx = { logger: () => logger } as unknown as Context
  return { ctx, logger }
}

describe('attachAlertExplain 告警装配', () => {
  it('首次 notify：delta 查询沉淀基线 -> 存量归因（window=current），负载与行齐全', () => {
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(8), taskB: bucket(2) }, {}))
    let received: ExplainAlarmPayload | undefined
    const alarm = attachAlertExplain(ctx, rt, { onExplainAlarm: (p) => { received = p } })

    const lines = alarm.notify(warnDecision(), 'total')
    expect(lines.length).toBeGreaterThan(0)
    expect(received?.scope).toBe('total')
    expect(received?.action).toBe('warn')
    expect(received?.window).toBe('current')
    expect(received?.lines).toEqual(lines)
    expect(received?.report.bySession.dominant?.key).toBe('taskA')
    expect(lines[0]).toContain('总预算')
    expect(lines[0]).toContain('触发告警（请求放行）')
    expect(lines[0]).toContain('（0.92/1.00）')
  })

  it('连续通知：第二次与告警前基线对比 -> 增量归因（window=delta）', () => {
    const meter = seedMeter({ taskA: bucket(9) }, {})
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(meter)
    const alarm = attachAlertExplain(ctx, rt)
    const first = alarm.notify(warnDecision(), 'total')
    expect(first[0]).not.toContain('较基线')
    // 快照增长后第二次告警：Δ 归因生效（cost +1）
    meter.record(
      {
        time: Date.now(),
        route: { provider: 'deepseek', model: 'deepseek-chat' },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        cacheReadTokens: 0,
        reasoningTokens: 0,
        cost: 1,
        credits: 0,
        totalTokens: 0,
        band: 'base',
      },
      'taskA',
    )
    const second = alarm.notify(warnDecision(), 'total')
    expect(second[0]).toContain('较基线')
  })

  it('建议收敛：maxSuggestions=1 时只保留 1 条建议', () => {
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(8, 100, 900) }, {}))
    const alarm = attachAlertExplain(ctx, rt, { maxSuggestions: 1 })
    const lines = alarm.notify(warnDecision(), 'total')
    const suggestions = lines.filter((l) => l.startsWith('  建议: '))
    expect(suggestions.length).toBe(1)
  })

  it('宿主回调抛错：不反噬告警主流程，记录错误并降级返回行', () => {
    const { ctx, logger } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(5) }, {}))
    const alarm = attachAlertExplain(ctx, rt, {
      onExplainAlarm: () => { throw new Error('im 转发失败') },
    })
    expect(() => {
      const lines = alarm.notify(warnDecision(), 'total')
      expect(lines.length).toBeGreaterThan(0)
    }).not.toThrow()
    expect(logger.error).toHaveBeenCalled()
  })

  it('回调抛非 Error（字符串）：String(err) 降级路径同样记录', () => {
    const { ctx, logger } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(5) }, {}))
    const alarm = attachAlertExplain(ctx, rt, {
      onExplainAlarm: () => { throw '网络不可达' },
    })
    expect(() => alarm.notify(warnDecision(), 'total')).not.toThrow()
    expect(logger.error).toHaveBeenCalled()
  })

  it('block 决策：payload.action=block，首句措辞为已熔断，面板行熔断分支', () => {
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(5) }, {}))
    let received: ExplainAlarmPayload | undefined
    const alarm = attachAlertExplain(ctx, rt, { onExplainAlarm: (p) => { received = p } })
    const lines = alarm.notify(blockDecision(), 'total')
    expect(received?.action).toBe('block')
    expect(lines[0]).toContain('已达 120%')
    expect(lines[0]).toContain('已熔断（请求被阻断）')
    // 面板行：block 分支
    expect(formatAlarmPanelLines({ scope: 'total', action: 'block', window: 'current', report: received!.report })[0]).toContain('熔断')
  })

  it('trigger 未匹配 scope：信号降级为无水位（首句不含已达），仍输出叙事', () => {
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(5) }, {}))
    const alarm = attachAlertExplain(ctx, rt)
    const lines = alarm.notify(warnDecision(), 'month') // triggers 只有 total -> trigger undefined
    expect(lines[0]).not.toContain('已达')
    expect(lines[0]).toContain('month预算')
  })

  it('detail 注入：附加说明并入首句', () => {
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(5) }, {}))
    const alarm = attachAlertExplain(ctx, rt)
    const lines = alarm.notify(warnDecision(), 'total', '预测式尖峰')
    expect(lines[0]).toContain('（预测式尖峰）')
  })

  it('空快照：叙事安全兜底（无主因、无因子行，建议走兜底）', () => {
    const { ctx } = makeCtx()
    const rt = new ExplainRuntime(seedMeter({}, {}))
    const alarm = attachAlertExplain(ctx, rt)
    const lines = alarm.notify(warnDecision(), 'total')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.includes('主因') && !l.startsWith('  '))).toBe(false)
  })

  it('formatAlarmPanelLines：单行摘要含窗口/水位/主因/输出占比', () => {
    const rt = new ExplainRuntime(seedMeter({ taskA: bucket(9, 100, 100) }, { 'deepseek/deepseek-chat': bucket(9, 100, 100) }))
    const { report } = rt.panel()!
    const line = formatAlarmPanelLines({ scope: 'total', action: 'warn', window: 'current', report })[0]
    expect(line).toContain('告警根因(current)')
    expect(line).toContain('会话 taskA')
    expect(line).toContain('路由 deepseek/deepseek-chat')
    expect(line).toContain('输出占比 50%')
  })
})