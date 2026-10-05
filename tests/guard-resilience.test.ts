/**
 * guard（agent/pre-step 熔断）韧性单测：
 * 宿主注入的任意回调（estimateFromMessages / forecastInput / adaptiveInput / onViolation）
 * 抛错都不允许反噬 pre-step 主流程 —— 记录可识别错误、降级跳过、请求照常放行。
 */

import { describe, it, expect, vi } from 'vitest'
import { Meter } from '../src/core/meter.js'
import { createBudgetEvaluator, type BudgetInput } from '../src/core/budget.js'
import { attachGuard, type GuardOptions } from '../src/harness/guard.js'
import type { GuardHandle } from '../src/harness/guard.js'
import type { UsageEntry } from '../src/core/types.js'
import { BASE_BAND } from '../src/core/types.js'

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

/** 最小 cordis Context 桩：记录 on 注册的回调，logger 可控。 */
function fakeCtx() {
  const handlers = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
  }
  return {
    ctx: {
      logger: () => logger,
      on: vi.fn((event: string, cb: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        handlers.set(event, cb)
      }),
    } as never,
    handlers,
    logger,
  }
}

const next = () => Promise.resolve({ kind: 'allow' as const })

describe('guard 宿主回调韧性（fail-safe 隔离）', () => {
  it('estimateFromMessages 抛错不反噬 pre-step，请求照常放行', async () => {
    const { ctx, handlers, logger } = fakeCtx()
    const meter = new Meter(480)
    const evaluator = createBudgetEvaluator([])
    const options: GuardOptions = {
      mode: 'block',
      cancelOnBlock: true,
      estimateFromMessages: () => {
        throw new Error('结算模块崩溃')
      },
    }
    const guard: GuardHandle = attachGuard(ctx, evaluator, meter, options)
    expect(handlers.has('agent/pre-step')).toBe(true)

    const cb = handlers.get('agent/pre-step')!
    const decision = await cb({ agent: { cancel: vi.fn() }, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, next)
    expect(decision).toEqual({ kind: 'allow' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('宿主回调(estimateFromMessages)异常'),
    )
    expect(guard.lastDecision.action).toBe('allow')
  })

  it('forecastInput 抛错时降级为无预测分量继续决策，不反噬', async () => {
    const { ctx, handlers, logger } = fakeCtx()
    const meter = new Meter(480)
    const evaluator = createBudgetEvaluator([
      { scope: 'total', limit: 1, warnAt: 0.8, hardAt: 1 },
    ])
    const options: GuardOptions = {
      mode: 'block',
      cancelOnBlock: true,
      forecastInput: () => {
        throw new Error('投影失败')
      },
    }
    const guard: GuardHandle = attachGuard(ctx, evaluator, meter, options)
    const cb = handlers.get('agent/pre-step')!

    // 花费未超限：forecastInput 抛错后仍应产出 allow，不抛异常
    const decision = await cb({ agent: { cancel: vi.fn() }, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, next)
    expect(decision).toEqual({ kind: 'allow' })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('宿主回调(forecastInput)异常'))
  })

  it('adaptiveInput 抛错时降级为无自适应分量继续决策', async () => {
    const { ctx, handlers, logger } = fakeCtx()
    const meter = new Meter(480)
    const evaluator = createBudgetEvaluator([])
    const options: GuardOptions = {
      mode: 'block',
      cancelOnBlock: true,
      forecastInput: () => ({ projected: {} }),
      adaptiveInput: () => {
        throw new Error('调节器故障')
      },
    }
    attachGuard(ctx, evaluator, meter, options)
    const cb = handlers.get('agent/pre-step')!

    const decision = await cb({ agent: { cancel: vi.fn() }, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, next)
    expect(decision).toEqual({ kind: 'allow' })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('宿主回调(adaptiveInput)异常'))
  })

  it('onViolation 通知回调抛错不反噬熔断结果', async () => {
    const { ctx, handlers, logger } = fakeCtx()
    const meter = new Meter(480)
    meter.record(entry({ route: { provider: 'deepseek', model: 'm' }, cost: 2 }))
    const evaluator = createBudgetEvaluator([
      { scope: 'total', limit: 1, warnAt: 0.6, hardAt: 0.8 },
    ])
    const options: GuardOptions = {
      mode: 'block',
      cancelOnBlock: false,
      onViolation: () => {
        throw new Error('通知通道故障')
      },
    }
    attachGuard(ctx, evaluator, meter, options)
    const cb = handlers.get('agent/pre-step')!

    // 已超硬限：应返回 reject，onViolation 抛错被隔离
    const decision = await cb({ agent: { cancel: vi.fn() }, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, next)
    expect(decision).toEqual({ kind: 'reject' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('已熔断'))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('宿主回调(onViolation)异常'))
  })

  it('mode=off 时不注册监听，只提供 inspect', () => {
    const { ctx, handlers } = fakeCtx()
    const meter = new Meter(480)
    const evaluator = createBudgetEvaluator([])
    const guard: GuardHandle = attachGuard(ctx, evaluator, meter, { mode: 'off', cancelOnBlock: false })
    expect(handlers.size).toBe(0)
    expect(guard.inspect().action).toBe('allow')
  })

  it('inspect 在宿主回调抛错时不反噬状态查询', () => {
    const { ctx, logger } = fakeCtx()
    const meter = new Meter(480)
    const evaluator = createBudgetEvaluator([])
    const guard: GuardHandle = attachGuard(ctx, evaluator, meter, {
      mode: 'off',
      cancelOnBlock: false,
      forecastInput: () => {
        throw new Error('查询故障')
      },
    })
    const decision = guard.inspect()
    expect(decision.action).toBe('allow')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('宿主回调(forecastInput)异常'))
  })

  it('block 分支在硬限命中时 reject 并 cancel', async () => {
    const { ctx, handlers } = fakeCtx()
    const meter = new Meter(480)
    meter.record(entry({ route: { provider: 'deepseek', model: 'm' }, cost: 5 }))
    const evaluator = createBudgetEvaluator([
      { scope: 'day', limit: 5, warnAt: 0.7, hardAt: 0.9 },
    ])
    const cancel = vi.fn()
    attachGuard(ctx, evaluator, meter, { mode: 'block', cancelOnBlock: true })
    const cb = handlers.get('agent/pre-step')!
    const decision = await cb({ agent: { cancel }, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, next)
    expect(decision).toEqual({ kind: 'reject' })
    expect(cancel).toHaveBeenCalled()
  })

  it('预算输入与既有语义一致：spent 从 meter 读取，自适应与预测缺省时与 0.3.0 相同', () => {
    // 回归锚点：评估器在无预测/自适应配置下的行为与基线一致
    const meter = new Meter(480)
    const evaluator = createBudgetEvaluator([{ scope: 'total', limit: 100, warnAt: 0.8, hardAt: 1 }])
    meter.record(entry({ route: { provider: 'deepseek', model: 'm' }, cost: 90 }))
    const decision = evaluator.decide({
      spent: { total: meter.spent('total').cost },
    } as BudgetInput)
    expect(decision.action).toBe('warn')
    expect(decision.triggers[0]).toMatchObject({ scope: 'total', level: 'warn' })
  })
})