import { describe, it, expect, vi } from 'vitest'
import { apply, type CostGuardConfig } from '../src/index.js'
import type { Context } from '@deepseek-ai/cordis'
import type { CostGuardService } from '../src/service.js'

/** 最小 Context mock：logger / on / tools.register / provide（真实执行由 apply 全链路驱动）。 */
function fakeCtx() {
  const registered: unknown[] = []
  const provided = new Map<string, unknown>()
  const handlers = new Map<string, (...args: never[]) => void>()
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  const ctx = {
    logger,
    on: (ev: string, cb: (...args: never[]) => void) => {
      handlers.set(ev, cb)
      return () => {}
    },
    tools: { register: (tool: unknown) => { registered.push(tool) } },
    provide: (name: string, value: unknown) => { provided.set(name, value) },
  } as unknown as Context
  return {
    ctx,
    registered,
    provided,
    fire: (ev: string, ...args: never[]) => handlers.get(ev)?.(...args),
  }
}

const session = { id: 's1' } as never

function headerEvent(provider = 'deepseek', model = 'deepseek-chat') {
  return { type: 'request/header', time: Date.now(), data: { header: { config: { provider, model } } } } as never
}

function messageEvent(usage: Record<string, number>, time = Date.now(), route?: { provider: string; model: string }) {
  // 部分宿主把 provider/model 随消息载荷下发；有则并入 data，供路由记账
  return { type: 'assistant/message', time, data: { usage, ...(route ?? {}) } } as never
}

function baseConfig(overrides: Partial<CostGuardConfig> = {}): CostGuardConfig {
  return {
    enabled: true,
    tzOffsetMin: 480,
    mode: 'block',
    cancelOnBlock: true,
    pricing: {
      'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
    },
    budgets: { total: { limit: 999 } },
    bands: [],
    fallbackProvider: 'deepseek',
    fallbackModel: 'deepseek-chat',
    enableTool: true,
    verbose: true,
    ...overrides,
  }
}

describe('index.apply 入口集成', () => {
  it('enabled=false 时不注册任何能力', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig({ enabled: false }))
    expect(h.provided.size).toBe(0)
    expect(h.registered.length).toBe(0)
  })

  it('基础配置：计量入账 → status/summary 可用，工具注册', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig())
    expect(h.provided.has('costGuard')).toBe(true)
    expect(h.registered.length).toBe(1) // cost_guard_status 工具

    h.fire('session/event', session, headerEvent())
    h.fire('session/event', session, messageEvent({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, reasoningTokens: 5 }))

    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()
    // tokens = 100 + 20 + 50 = 170；cost = 100/1e6*2 + 50/1e6*8 + 20/1e6*0.5
    expect(status.total.tokens).toBe(170)
    // 单价 per million：100×2 + 20×0.5 + 50×8 = 610 / 1e6
    expect(status.total.cost).toBeCloseTo(0.00061, 12)
    expect(status.band.current).toBe('base')
    expect(svc.summary()).toContain('总花费')
  })

  it('熔断：超预算时 guard 触发 warn（warnAt 与 hardAt 之间）', () => {
    const h = fakeCtx()
    // cost = 0.006；limit 0.0065 → ratio ≈ 0.92 ∈ (0.8, 1) → warn（未触 hardAt）
    apply(h.ctx, baseConfig({ mode: 'warn', budgets: { total: { limit: 0.0065 } } }))
    h.fire('session/event', session, headerEvent())
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500 }))
    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()
    expect(status.guard.action).toBe('warn')
  })

  it('全功能：官方计价 + 缓存计量 + 前沿套件 + 预测/自适应联动出全套状态段', () => {
    const h = fakeCtx()
    apply(
      h.ctx,
      baseConfig({
        officialPricing: { enabled: true },
        cache: { enabled: true },
        frontier: { focus: { enabled: true }, otel: { enabled: true }, unitEconomy: true, leverage: true },
        predictive: { projections: { total: { target: '30' } }, adaptive: { scope: 'day', onExhausted: 'warn' } },
        adaptive: { monthLimit: 30 },
        bands: [{ id: 'peak', start: '00:00', end: '23:59' }], // 全天命中：band 判定按真实当前时刻，避免时段外导致 flaky
      }),
    )
    const t = Date.UTC(2026, 8, 14, 2, 0, 0) // 周一 10:00 +08 → 命中用户 peak 时段
    h.fire('session/event', session, headerEvent('deepseek', 'deepseek-flash'))
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 }, t))

    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()

    // 用户自定义时段优先：peak
    expect(status.band.current).toBe('peak')
    // 官方计价段：flash 官方价 + 注册表存在
    expect(status.official).toBeDefined()
    expect(Object.keys(status.official!.prices).length).toBeGreaterThan(0)
    // 缓存维度段存在（cache.enabled=true）
    expect(status.cache).toBeDefined()
    // 前沿套件段存在（focus/otel/unitEconomy/leverage 全开）
    expect(status.frontier).toBeDefined()
    // 自适应调节段（adaptive 配置生效）
    expect(status.adaptive).not.toBeNull()
    // 预测段（predictive 配置生效）
    expect(status.forecast).not.toBeNull()
  })

  it('enableTool=false 时不注册工具但仍提供计量服务', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig({ enableTool: false }))
    expect(h.registered.length).toBe(0)
    expect(h.provided.has('costGuard')).toBe(true)
  })

  it('explain 未配置：不注册解释工具、面板无 explain 段（零回归）', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig())
    h.fire('session/event', session, headerEvent('deepseek', 'deepseek-flash'))
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500 }))

    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()
    expect(h.registered.length).toBe(1) // 仅 cost_guard_status
    expect(status.explain).toBeUndefined()
    expect(svc.summary()).not.toContain('根因解释')
  })

  it('explain 启用：注册解释工具、状态面板含根因段、summary 输出根因行', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig({ explain: { enabled: true } }))
    expect(h.registered.length).toBe(2) // cost_guard_status + cost_guard_explain

    h.fire('session/event', session, headerEvent('deepseek', 'deepseek-flash'))
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500 }, Date.now(), { provider: 'deepseek', model: 'deepseek-flash' }))

    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()
    expect(status.explain).toBeDefined()
    expect(status.explain!.window).toBe('current')
    expect(status.explain!.report.byRoute.dominant?.key).toBe('deepseek/deepseek-flash')
    expect(svc.summary()).toContain('根因解释')
  })

  it('explain 启用且无任何用量：面板段延后（undefined），工具仍注册', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig({ explain: { enabled: true } }))
    const svc = h.provided.get('costGuard') as CostGuardService
    expect(statusOf(svc).explain).toBeUndefined()
    expect(h.registered.length).toBe(2)
  })

  it('告警根因解释接线：explain.alert 启用时超水位 pre-step 告警全链路不抛错且决策为 warn', async () => {
    const h = fakeCtx()
    apply(
      h.ctx,
      baseConfig({
        mode: 'warn',
        budgets: { total: { limit: 0.0065 } }, // cost=0.006 → ratio≈0.92 ∈ (0.8, 1) → warn
        explain: { enabled: true, alert: { enabled: true } },
      }),
    )
    h.fire('session/event', session, headerEvent())
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500 }))

    const next = async () => ({ kind: 'allow' as const })
    const res = await h.fire(
      'agent/pre-step',
      { agent: {}, messages: [], turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    expect(res).toEqual({ kind: 'allow' })
    const svc = h.provided.get('costGuard') as CostGuardService
    expect(svc.status().guard.action).toBe('warn')
    // 告警叙事已由 notify 合成并落日志：explainAlarm 装配后 guard 全链路无异常
  })

  it('告警根因解释零回归：explain 启用但未配置 alert 时，pre-step 告警行为与 0.14.0 一致', async () => {
    const h = fakeCtx()
    apply(
      h.ctx,
      baseConfig({
        mode: 'warn',
        budgets: { total: { limit: 0.0065 } },
        explain: { enabled: true }, // alert 未配置 -> explainAlarm=undefined
      }),
    )
    h.fire('session/event', session, headerEvent())
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500 }))

    const next = async () => ({ kind: 'allow' as const })
    const res = await h.fire(
      'agent/pre-step',
      { agent: {}, messages: [], turn: 0, step: 0, signal: new AbortController().signal },
      next,
    )
    expect(res).toEqual({ kind: 'allow' })
    expect((h.provided.get('costGuard') as CostGuardService).status().guard.action).toBe('warn')
  })

  it('告警根因解释零回归：仅配置 alert 而未启用 explain 时 alert 无效（不注册额外工具）', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig({ explain: { alert: { enabled: true } } }))
    expect(h.registered.length).toBe(1) // 仅 cost_guard_status；explain 未启用 -> 无 cost_guard_explain
  })

  it('多租户未配置：不注册租户工具、面板无 tenant 段（零回归）', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig())
    h.fire('session/event', session, headerEvent('deepseek', 'deepseek-flash'))
    h.fire('session/event', session, messageEvent({ inputTokens: 1000, outputTokens: 500 }))

    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()
    expect(h.registered.length).toBe(1) // 仅 cost_guard_status
    expect(status.tenant).toBeUndefined()
    expect(svc.summary()).not.toContain('多租户视图')
  })

  it('多租户启用：注册租户工具、状态面板含租户段、summary 输出租户行', () => {
    const h = fakeCtx()
    apply(
      h.ctx,
      baseConfig({
        tenant: { enabled: true, resolve: { prefix: { 'team-a/': 'team-a', 'team-b/': 'team-b' } } },
      }),
    )
    expect(h.registered.length).toBe(2) // cost_guard_status + cost_guard_tenant

    h.fire('session/event', { id: 'team-a/s1' } as never, headerEvent('deepseek', 'deepseek-flash'))
    h.fire('session/event', { id: 'team-a/s1' } as never, messageEvent({ inputTokens: 1000, outputTokens: 500 }, Date.now(), { provider: 'deepseek', model: 'deepseek-flash' }))

    const svc = h.provided.get('costGuard') as CostGuardService
    const status = svc.status()
    expect(status.tenant).toBeDefined()
    expect(status.tenant!.window).toBe('current')
    expect(status.tenant!.report.byTenant.dominant?.key).toBe('team-a')
    expect(status.tenant!.report.details[0]?.topSessions[0]?.key).toBe('team-a/s1')
    expect(svc.summary()).toContain('多租户视图')
    expect(svc.summary()).toContain('主因租户 team-a')
  })

  it('多租户启用且无任何用量：面板段延后（undefined），工具仍注册', () => {
    const h = fakeCtx()
    apply(h.ctx, baseConfig({ tenant: { enabled: true, resolve: { prefix: { 'team-a/': 'team-a' } } } }))
    expect(statusOf(h.provided.get('costGuard') as CostGuardService).tenant).toBeUndefined()
    expect(h.registered.length).toBe(2)
  })
})

/** 从服务直取状态（避免在断言处重复声明局部变量）。 */
function statusOf(svc: CostGuardService): ReturnType<CostGuardService['status']> {
  return svc.status()
}