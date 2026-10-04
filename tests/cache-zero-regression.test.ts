import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Meter, WindowMeter } from '../src/core/meter.js'
import { createBudgetEvaluator } from '../src/core/budget.js'
import { CacheMetrics } from '../src/core/cache-metrics.js'
import { CacheHintDetector } from '../src/core/cache-hint.js'
import { CachePricingEngine } from '../src/core/cache-pricing.js'
import { buildCostStatus, formatStatusSummary } from '../src/harness/tool.js'
import { attachCacheMeter, buildCachePanel, formatCacheLines, readCacheUsage } from '../src/harness/cache.js'
import type { GuardHandle } from '../src/harness/guard.js'
import type { UsageEntry } from '../src/core/types.js'
import { BASE_BAND } from '../src/core/types.js'
import { parseSessionEvent, toUsageEntry } from '../src/harness/listener.js'

function entry(partial: Partial<UsageEntry> & { route: UsageEntry['route'] }): UsageEntry {
  return {
    time: partial.time ?? 1_700_000_000_000,
    route: partial.route,
    usage: partial.usage ?? { inputTokens: 100, outputTokens: 50 },
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    reasoningTokens: partial.reasoningTokens ?? 0,
    cost: partial.cost ?? 0.01,
    credits: partial.credits ?? 0,
    totalTokens: partial.totalTokens ?? 150,
    band: partial.band ?? BASE_BAND,
  }
}

function idleGuard(): GuardHandle {
  return {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: () => ({ action: 'allow', triggers: [] }),
  }
}

describe('cache 零回归与 harness 全链路', () => {
  it('未启用 cache 时输出与 v0.5.0 一致：无 cache 段、摘要无缓存行、事件流不解析缓存字段', () => {
    const meter = new Meter(480)
    const windows = new WindowMeter(480, () => 1_700_000_000_000)
    const evaluator = createBudgetEvaluator([])
    meter.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2 }))
    windows.record(entry({ route: { provider: 'deepseek', model: 'deepseek-chat' }, cost: 2 }))

    // 未注入 cache 上下文（默认关闭）
    const st = buildCostStatus(meter, windows, evaluator, idleGuard(), { tzOffsetMin: 480 })
    expect(st.cache).toBeUndefined()
    const summary = formatStatusSummary(st)
    expect(summary).not.toContain('缓存:')
    expect(summary).not.toContain('前缀')

    // 事件流：既有度量不受缓存影响（usage 无缓存字段也正常入账）
    const parsed = parseSessionEvent({
      type: 'assistant/message',
      time: 1_700_000_000_000,
      data: { usage: { inputTokens: 100, outputTokens: 50 } },
    })
    const priced = toUsageEntry(parsed, {} as never, { provider: 'deepseek', model: 'deepseek-chat' })
    // 无缓存字段的事件按既有路径正常折算（cacheReadTokens 归零、totalTokens 沿用既有口径）
    expect(priced).toBeDefined()
    expect(priced!.cacheReadTokens).toBe(0)
    expect(priced!.totalTokens).toBe(150)
    const st2 = buildCostStatus(meter, windows, evaluator, idleGuard(), { tzOffsetMin: 480 })
    expect(st2.cache).toBeUndefined()
  })

  it('启用 cache 后：真实事件 → 读取/拆分/定价/账本/命中率/收益/面板全链路正确', async () => {
    const ctx = new Context()
    const metrics = new CacheMetrics()
    const engine = new CachePricingEngine()
    const hint = new CacheHintDetector(engine)
    const warnSpy = vi.fn()
    // attachCacheMeter 返回 void（监听随插件卸载自动回收），此处只验证副作用
    attachCacheMeter(ctx, {
      tzOffsetMin: 480,
      pricing: engine,
      metrics,
      hint,
      onFallbackStreak: warnSpy,
    })

    const emit = (data: unknown, time = Date.now()) =>
      ctx.emit('session/event', { get id() { return 's1' } }, { type: 'assistant/message', time, data })

    // ① OpenAI 原生形状：usage.prompt_tokens_details.cached_tokens
    emit({ usage: { prompt_tokens: 1_000_000, completion_tokens: 200_000, prompt_tokens_details: { cached_tokens: 300_000 } } })
    // ② DSH 归一化形状：usage.cachedTokens（无 details）
    emit({ usage: { promptTokens: 800_000, completionTokens: 100_000, cachedTokens: 400_000 } })
    // ③ inputTokens + cacheReadTokens 归一化形状
    emit({ usage: { inputTokens: 700_000, outputTokens: 50_000, cacheReadTokens: 200_000 } })
    // ④ 缓存字段缺失 → 回退未命中 + 标注
    emit({ usage: { promptTokens: 500_000, completionTokens: 60_000 } })
    // ⑤ 非法缓存字段（负数）→ malformed 回退
    emit({ usage: { promptTokens: 400_000, completionTokens: 40_000, cachedTokens: -5 } })

    await new Promise((r) => setTimeout(r, 0))

    const s = metrics.summary('global')
    // 可信请求（①②③）：hit = 300k+400k+200k = 900k；输入 = 1M+800k+(700k+200k) = 2.7M
    expect(s.inputTotal).toBe(2_700_000)
    expect(s.hitTotal).toBe(900_000)
    expect(s.hitRate).toBeCloseTo(0.9 / 2.7)
    expect(s.uncertainCount).toBe(2) // ④⑤
    expect(s.savingTotal).toBeGreaterThan(0)

    // 面板与摘要
    const panel = buildCachePanel(metrics, hint)
    expect(panel.enabled).toBe(true)
    expect(panel.summary.hitRate).toBeCloseTo(0.9 / 2.7)
    const lines = formatCacheLines(panel)
    expect(lines[0]).toContain('缓存: 命中率 33.3%')
    expect(lines[0]).toContain('收益')
    expect(lines[0]).toContain('不确定 2 次')

    // 连续 5 次回退一次性提示（④⑤ 累计 2 次，再补 3 次）
    for (let i = 0; i < 3; i++) emit({ usage: { promptTokens: 100_000, completionTokens: 10_000 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(5)

    // readCacheUsage 单元形状：details 优先、非法哨兵
    expect(readCacheUsage({ data: { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } } })).toEqual({
      status: 'ok',
      raw: { promptTokens: 10, completionTokens: 2, cachedTokens: 4 },
    })
    expect(readCacheUsage({ data: { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } } } }).status).toBe('ok')
  })
})