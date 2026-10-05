import { describe, it, expect } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UsageEntry } from '../src/core/types.js'
import {
  ReasoningTaxAuditRuntime,
  attachReasoningTaxAuditTool,
  formatReasoningTaxAuditLines,
  type ReasoningTaxAuditPanelPayload,
} from '../src/harness/reasoning-tax-audit.js'

/** 构造一次带推理 token 的用量 entry（cost 与推理成本解耦：本模块只消费 reasoningTokens）。 */
function entry(route: string, reasoningTokens: number, outputTokens = 10): UsageEntry {
  const [provider, model] = route.split('/')
  return {
    time: Date.now(),
    route: { provider, model },
    usage: { inputTokens: 0, outputTokens, cacheReadTokens: 0 },
    cacheReadTokens: 0,
    reasoningTokens,
    cost: 0,
    credits: 0,
    totalTokens: reasoningTokens + outputTokens,
    band: 'base',
  }
}

const outputPriceOf = (model: string): number => (model === 'deepseek-reasoner' ? 2000 : 500) // 每百万输出 token

describe('ReasoningTaxAuditRuntime 面板', () => {
  it('append 后 panel 输出审计报表：会话 Top N + 热力桶双切片', () => {
    const rt = new ReasoningTaxAuditRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 3000, 200), 'sess-a')
    rt.append(entry('deepseek/deepseek-reasoner', 1000, 100), 'sess-b')

    const panel = rt.panel()
    expect(panel).toBeDefined()
    expect(panel?.enabled).toBe(true)
    expect(panel?.window).toBe('current')
    expect(panel?.sessionTopN).toBe(5)
    expect(panel?.heatBuckets).toBe(24)
    const r = panel!.report
    expect(r.totalReasoningTokens).toBe(4000)
    // 会话切片
    expect(r.sessions.length).toBe(2)
    expect(r.sessions[0].key).toBe('sess-a')
    expect(r.sessions[0].taxCost).toBeCloseTo((3000 * 2000) / 1_000_000, 6)
    // 热力桶：同一时刻入同一桶
    expect(r.heat.length).toBe(1)
    expect(r.heat[0].reasoningTokens).toBe(4000)
    expect(r.dominantSession?.key).toBe('sess-a')
    expect(r.dominantBucket).toBeDefined()
  })

  it('无推理样本：panel 返回 undefined（面板段缺省，零回归）', () => {
    const rt = new ReasoningTaxAuditRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-chat', 0))
    expect(rt.panel()).toBeUndefined()
  })
})

describe('attachReasoningTaxAuditTool 工具接线', () => {
  it('注册只读工具 cost_guard_reasoning_audit：报表 + 叙事、JSON 安全', async () => {
    const rt = new ReasoningTaxAuditRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 4000, 300), 'sess-a')
    rt.append(entry('deepseek/deepseek-chat', 500, 200), 'sess-b')

    const registered: unknown[] = []
    const ctx = {
      tools: { register: (tool: unknown) => { registered.push(tool) } },
    } as unknown as Context
    attachReasoningTaxAuditTool(ctx, rt)
    expect(registered.length).toBe(1)
    const tool = registered[0] as { name: string; execute: (args: never) => Promise<Record<string, unknown>> }
    expect(tool.name).toBe('cost_guard_reasoning_audit')

    const out = await awaitExec(tool)
    expect(out.window).toBe('current')
    expect(out.summary).toContain('主因会话')
    expect(Array.isArray(out.narrative)).toBe(true)
    expect((out.narrative as string[]).length).toBeGreaterThan(0)
    expect(typeof out.explanation).toBe('string')
    const json = JSON.stringify(out)
    expect(json).toContain('"sessions"')
    expect(json).toContain('"heat"')
    // 无 NaN / Infinity
    expect(json).not.toContain('NaN')
    expect(json).not.toContain('Infinity')
  })

  it('无样本时工具返回无叙事降级（不抛错）', async () => {
    const rt = new ReasoningTaxAuditRuntime(outputPriceOf)
    const registered: unknown[] = []
    const ctx = { tools: { register: (tool: unknown) => { registered.push(tool) } } } as unknown as Context
    attachReasoningTaxAuditTool(ctx, rt)
    const tool = registered[0] as { execute: (args: never) => Promise<Record<string, unknown>> }
    const out = await awaitExec(tool)
    expect(out.summary).toContain('暂无推理 token 样本')
  })
})

describe('formatReasoningTaxAuditLines 人读行', () => {
  it('输出审计单行：总推理、思考税占比、估算成本、主因会话与热力峰值', () => {
    const rt = new ReasoningTaxAuditRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 3000, 100), 'sess-a')
    const panel = rt.panel() as ReasoningTaxAuditPanelPayload
    const lines = formatReasoningTaxAuditLines(panel)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('推理税审计')
    expect(lines[0]).toContain('思考税 97%') // 3000 / (3000+100)
    expect(lines[0]).toContain('主因会话 sess-a')
  })

  it('多会话排行时输出会话排行行', () => {
    const rt = new ReasoningTaxAuditRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 2000, 100), 'sess-a')
    rt.append(entry('deepseek/deepseek-chat', 300, 50), 'sess-b')
    const panel = rt.panel() as ReasoningTaxAuditPanelPayload
    const lines = formatReasoningTaxAuditLines(panel)
    expect(lines.length).toBe(2)
    expect(lines[1]).toContain('会话排行')
    expect(lines[1]).toContain('sess-b')
  })
})

/** 直接执行工具回调（同步 Promise 解包）。 */
async function awaitExec(tool: { execute: (args: never) => Promise<Record<string, unknown>> }): Promise<Record<string, unknown>> {
  return tool.execute({} as never)
}