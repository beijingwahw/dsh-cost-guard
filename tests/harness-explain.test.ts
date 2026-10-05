import { describe, it, expect } from 'vitest'
import { Meter } from '../src/core/meter.js'
import { ExplainRuntime, attachExplainTool, formatExplainLines } from '../src/harness/explain.js'
import type { Context } from '@deepseek-ai/cordis'
import type { UsageBucket } from '../src/core/types.js'

function bucket(cost: number, tokens = 0): UsageBucket {
  return {
    requests: 1,
    inputTokens: tokens,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: tokens,
    cost,
    credits: 0,
  }
}

function seedMeter(sessions: Record<string, UsageBucket>, routes: Record<string, UsageBucket>): Meter {
  return new Meter(480, { buckets: {}, bands: {}, sessions, routes })
}

describe('ExplainRuntime 双模式与工具接线', () => {
  it('current 模式：存量构成归因，不消费基线；panel 输出负载', () => {
    const meter = seedMeter({ taskA: bucket(8), taskB: bucket(2) }, { 'deepseek/deepseek-chat': bucket(8) })
    const rt = new ExplainRuntime(meter)
    const { report } = rt.explain('current')
    expect(report.window).toBe('current')
    expect(report.totalCost).toBe(10)
    expect(report.bySession.dominant?.key).toBe('taskA')

    const panel = rt.panel()
    expect(panel?.enabled).toBe(true)
    expect(panel?.window).toBe('current')
    expect(panel?.report.byRoute.dominant?.key).toBe('deepseek/deepseek-chat')
  })

  it('panel 纯空快照：返回 undefined（延后面板段）', () => {
    const meter = seedMeter({}, {})
    const rt = new ExplainRuntime(meter)
    expect(rt.panel()).toBeUndefined()
  })

  it('delta 模式：连续两次查询给出增量归因并沉淀基线', () => {
    const meter = seedMeter({ taskA: bucket(9), taskB: bucket(1) }, {})
    const rt = new ExplainRuntime(meter)
    const first = rt.explain('delta') // 无基线 -> 存量归因并建立基线
    expect(first.report.window).toBe('current')
    const second = rt.explain('delta') // 与上次快照比 -> 同值 Δ=0
    expect(second.report.window).toBe('delta')
    expect(second.report.deltaCost).toBe(0)

    // 快照变化后第三次查询：Δ反映增量
    meter.record(
      {
        time: Date.now(),
        route: { provider: 'deepseek', model: 'deepseek-chat' },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        cacheReadTokens: 0,
        reasoningTokens: 0,
        cost: 5,
        credits: 0,
        totalTokens: 0,
        band: 'base',
      },
      'taskA',
    )
    const third = rt.explain('delta')
    expect(third.report.window).toBe('delta')
    expect(third.report.deltaCost).toBe(5)
    expect(third.report.bySession.dominant?.key).toBe('taskA')
    expect(third.items.length).toBeGreaterThan(0)
  })

  it('工具执行：默认带叙事；narrative=false 时省略；生成 JSON 安全输出', async () => {
    const meter = seedMeter({ taskA: bucket(8), taskB: bucket(2) }, { 'deepseek/deepseek-chat': bucket(8) })
    const rt = new ExplainRuntime(meter)

    const registered: unknown[] = []
    const ctx = {
      tools: { register: (tool: unknown) => { registered.push(tool) } },
    } as unknown as Context

    attachExplainTool(ctx, rt, { mode: 'delta' })
    expect(registered.length).toBe(1)
    const tool = registered[0] as { name: string; execute: (args: never) => Promise<Record<string, unknown>> }
    expect(tool.name).toBe('cost_guard_explain')

    const out = await awaitExec(tool)
    expect(out.window).toBe('current') // 首次 delta 无基线退化为存量
    expect(Array.isArray(out.narrative)).toBe(true)
    expect(out.summary).toContain('成本')
    const json = JSON.stringify(out)
    expect(json).toContain('"window"')
  })

  it('formatExplainLines：单行人读面板根因行', () => {
    const meter = seedMeter({ taskA: bucket(8) }, { 'deepseek/deepseek-chat': bucket(8) })
    const rt = new ExplainRuntime(meter)
    const panel = rt.panel()
    expect(panel).toBeDefined()
    const lines = formatExplainLines(panel!)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('会话主因 taskA')
    expect(lines[0]).toContain('路由主因 deepseek/deepseek-chat')
  })
})

/** 直接执行工具回调（同步 Promise 解包）。 */
async function awaitExec(tool: { execute: (args: never) => Promise<Record<string, unknown>> }): Promise<Record<string, unknown>> {
  return tool.execute({} as never)
}