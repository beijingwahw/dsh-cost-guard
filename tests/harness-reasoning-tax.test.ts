import { describe, it, expect } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UsageEntry } from '../src/core/types.js'
import {
  ReasoningTaxRuntime,
  attachReasoningTaxTool,
  formatReasoningTaxLines,
  type ReasoningTaxPanelPayload,
} from '../src/harness/reasoning-tax.js'

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

describe('ReasoningTaxRuntime 面板', () => {
  it('append 后 panel 输出存量报表：按路由归因、思考税占比', () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 3000, 200))
    rt.append(entry('deepseek/deepseek-reasoner', 1000, 100))
    rt.append(entry('deepseek/deepseek-chat', 500, 400))

    const panel = rt.panel()
    expect(panel).toBeDefined()
    expect(panel?.enabled).toBe(true)
    expect(panel?.window).toBe('current')
    const r = panel!.report
    expect(r.totalReasoningTokens).toBe(4500)
    expect(r.totalOutputTokens).toBe(700)
    // 推理 / (推理+可见输出) = 4500 / 5200 ≈ 0.865
    expect(r.taxRatio).toBeCloseTo(4500 / 5200, 4)
    expect(r.byRoute.length).toBe(2)
    expect(r.dominant?.route).toBe('deepseek/deepseek-reasoner')
    // 税成本 = 推理 × 输出价 / 1e6；reasoner 4000 × 2000 / 1e6 = 8
    expect(r.totalTaxCost).toBeCloseTo((4000 * 2000 + 500 * 500) / 1_000_000, 4)
    expect(r.pricedRoutes).toBe(2)
  })

  it('无推理样本：panel 返回 undefined（面板段缺省）', () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-chat', 0))
    expect(rt.panel()).toBeUndefined()
  })

  it('预算水位：limit > 0 时输出 budget（ok/warn/block 判定）', () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf, { limit: 0.004, warnAt: 0.5, hardAt: 1 })
    rt.append(entry('deepseek/deepseek-reasoner', 3000, 100))
    const r = rt.panel()!.report
    expect(r.budget).toBeDefined()
    // 税成本 = 3000 × 2000 / 1e6 = 6 -> 远超 limit 0.004 -> block
    expect(r.budget?.ratio).toBeGreaterThan(1)
    expect(r.budget?.level).toBe('block')
  })

  it('预算水位：warn 介于 warnAt 与 hardAt 之间', () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf, { limit: 0.01, warnAt: 0.5, hardAt: 1 })
    rt.append(entry('deepseek/deepseek-chat', 3000, 100)) // 税成本 = 3000×500/1e6 = 1.5 -> 15x limit
    // 调整：让 ratio 落在 warn 区间：税成本 6 -> limit 10 -> ratio 0.6
    const rt2 = new ReasoningTaxRuntime(outputPriceOf, { limit: 10, warnAt: 0.5, hardAt: 1 })
    rt2.append(entry('deepseek/deepseek-reasoner', 3000, 100))
    expect(rt2.panel()!.report.budget?.level).toBe('warn')
    // 前一个 rt 无预算输出（limit 过小且成本为 0 无样本时不出现）——cost 仍为 0 的情况
    expect(rt.panel()).toBeDefined()
  })

  it('未配置预算：报表不含 budget 键（纯洞察）', () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 1000, 100))
    const r = rt.panel()!.report
    expect(r.budget).toBeUndefined()
    const json = JSON.stringify(r)
    expect(json).not.toContain('"budget"')
  })
})

describe('attachReasoningTaxTool 工具接线', () => {
  it('注册只读工具 cost_guard_reasoning：报表 + 叙事、JSON 安全', async () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf)
    rt.append(entry('deepseek/deepseek-reasoner', 4000, 300))
    rt.append(entry('deepseek/deepseek-chat', 500, 200))

    const registered: unknown[] = []
    const ctx = {
      tools: { register: (tool: unknown) => { registered.push(tool) } },
    } as unknown as Context
    attachReasoningTaxTool(ctx, rt)
    expect(registered.length).toBe(1)
    const tool = registered[0] as { name: string; execute: (args: never) => Promise<Record<string, unknown>> }
    expect(tool.name).toBe('cost_guard_reasoning')

    const out = await awaitExec(tool)
    expect(out.window).toBe('current')
    expect(out.summary).toContain('主因路由')
    expect(Array.isArray(out.narrative)).toBe(true)
    expect((out.narrative as string[]).length).toBeGreaterThan(0)
    const json = JSON.stringify(out)
    expect(json).toContain('"byRoute"')
    expect(json).toContain('"taxRatio"')
    // 无 NaN / Infinity
    expect(json).not.toContain('NaN')
    expect(json).not.toContain('Infinity')
  })

  it('无样本时工具返回无叙事降级（不抛错）', async () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf)
    const registered: unknown[] = []
    const ctx = { tools: { register: (tool: unknown) => { registered.push(tool) } } } as unknown as Context
    attachReasoningTaxTool(ctx, rt)
    const tool = registered[0] as { execute: (args: never) => Promise<Record<string, unknown>> }
    const out = await awaitExec(tool)
    expect(out.summary).toContain('暂无推理 token 样本')
  })
})

describe('formatReasoningTaxLines 人读行', () => {
  it('输出思考税单行：占比、估算成本、主因路由与预算水位', () => {
    const rt = new ReasoningTaxRuntime(outputPriceOf, { limit: 20, warnAt: 0.7, hardAt: 1 })
    rt.append(entry('deepseek/deepseek-reasoner', 3000, 100)) // 税成本 6 -> ratio 0.3 -> ok
    const panel = rt.panel() as ReasoningTaxPanelPayload
    const lines = formatReasoningTaxLines(panel)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('推理税治理')
    expect(lines[0]).toContain('思考税 97%') // 3000 / (3000+100)
    expect(lines[0]).toContain('主因路由 deepseek/deepseek-reasoner')
    expect(lines[0]).toContain('推理税预算 30%（ok）')
  })
})

/** 直接执行工具回调（同步 Promise 解包）。 */
async function awaitExec(tool: { execute: (args: never) => Promise<Record<string, unknown>> }): Promise<Record<string, unknown>> {
  return tool.execute({} as never)
}