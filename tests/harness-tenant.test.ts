import { describe, it, expect } from 'vitest'
import { Meter } from '../src/core/meter.js'
import { TenantRuntime, attachTenantTool, formatTenantLines } from '../src/harness/tenant.js'
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

function seedMeter(sessions: Record<string, UsageBucket>): Meter {
  return new Meter(480, { buckets: {}, bands: {}, sessions, routes: {} })
}

describe('TenantRuntime 面板与双模式', () => {
  it('current 模式：租户存量归因；panel 输出负载', () => {
    const meter = seedMeter({ 'a/s1': bucket(8), 'a/s2': bucket(2) })
    const rt = new TenantRuntime(meter, (sid) => sid.split('/')[0])
    const { report } = rt.view('current')
    expect(report.window).toBe('current')
    expect(report.totalCost).toBe(10)
    expect(report.tenantCount).toBe(1)
    expect(report.byTenant.dominant?.key).toBe('a')

    const panel = rt.panel()
    expect(panel?.enabled).toBe(true)
    expect(panel?.window).toBe('current')
    expect(panel?.report.details[0]?.topSessions[0]?.key).toBe('a/s1')
  })

  it('panel 纯空快照：返回 undefined（延后面板段）', () => {
    const meter = seedMeter({})
    const rt = new TenantRuntime(meter)
    expect(rt.panel()).toBeUndefined()
  })

  it('delta 模式：连续两次查询给出增量归因并沉淀基线', () => {
    const meter = seedMeter({ 'a/s1': bucket(9), 'b/s1': bucket(1) })
    const rt = new TenantRuntime(meter, (sid) => sid.split('/')[0])
    const first = rt.view('delta') // 无基线 -> 存量归因并建立基线
    expect(first.report.window).toBe('current')
    const second = rt.view('delta') // 与上次快照比 -> 同值 Δ=0
    expect(second.report.window).toBe('delta')
    expect(second.report.deltaCost).toBe(0)

    // 快照变化后第三次查询：Δ 反映增量
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
      'a/s3',
    )
    const third = rt.view('delta')
    expect(third.report.window).toBe('delta')
    expect(third.report.deltaCost).toBe(5)
    expect(third.report.byTenant.dominant?.key).toBe('a')
    expect(third.items.length).toBeGreaterThan(0)
  })
})

describe('attachTenantTool 工具接线', () => {
  it('注册只读工具 cost_guard_tenant：默认带叙事、JSON 安全', async () => {
    const meter = seedMeter({ 'a/s1': bucket(8), 'b/s1': bucket(2) })
    const rt = new TenantRuntime(meter, (sid) => sid.split('/')[0])

    const registered: unknown[] = []
    const ctx = {
      tools: { register: (tool: unknown) => { registered.push(tool) } },
    } as unknown as Context

    attachTenantTool(ctx, rt, { mode: 'delta' })
    expect(registered.length).toBe(1)
    const tool = registered[0] as { name: string; execute: (args: never) => Promise<Record<string, unknown>> }
    expect(tool.name).toBe('cost_guard_tenant')

    const out = await awaitExec(tool)
    expect(out.window).toBe('current') // 首次 delta 无基线退化为存量
    expect(Array.isArray(out.narrative)).toBe(true)
    expect(out.summary).toContain('租户')
    const json = JSON.stringify(out)
    expect(json).toContain('"byTenant"')
    expect(json).toContain('"details"')
  })

  it('formatTenantLines：单行人读面板租户行', () => {
    const meter = seedMeter({ 'a/s1': bucket(8), 'b/s1': bucket(2) })
    const rt = new TenantRuntime(meter, (sid) => sid.split('/')[0])
    const panel = rt.panel()
    expect(panel).toBeDefined()
    const lines = formatTenantLines(panel!)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('多租户视图')
    expect(lines[0]).toContain('主因租户 a')
    expect(lines[0]).toContain('其主因会话 a/s1')
  })
})

/** 直接执行工具回调（同步 Promise 解包）。 */
async function awaitExec(tool: { execute: (args: never) => Promise<Record<string, unknown>> }): Promise<Record<string, unknown>> {
  return tool.execute({} as never)
}