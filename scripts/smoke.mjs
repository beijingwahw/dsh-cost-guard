/**
 * dsh-cost-guard 冒烟测试（node scripts/smoke.mjs）
 *
 * 在真实 Node 环境（CI/本地）验证发布产物（lib/）：
 *   1. 包可导入、导出面完整（name / Config / apply / costGuardService）
 *   2. 计价 → 计量 → 预算 → 熔断 全链路决策正确
 *   3. 从真实 DSH 事件形状（session/event 的 assistant/message + request/header）正确折算入账
 *   4. 真实 cordis Context 接线：session/event 事件驱动 Meter 累计、预算决策供 Guard 检查
 *
 * 任一断言失败即非零退出；全部通过打印摘要。
 */
import { strict as assert } from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { name, Config, apply, costGuardService } from '../lib/index.js'
import { Meter, WindowMeter } from '../lib/core/meter.js'
import { buildPricingTable, computeCost } from '../lib/core/pricing.js'
import { createBudgetEvaluator, policiesFromConfig } from '../lib/core/budget.js'
import { parseSessionEvent, toUsageEntry, attachMeters } from '../lib/harness/listener.js'
import { attachGuard } from '../lib/harness/guard.js'

const ok = (label) => console.log(`  ✓ ${label}`)
let step = 0
const section = (label) => console.log(`\n[${++step}] ${label}`)

// ---- 1. 导出面 ----
section('包可导入、导出面完整')
assert.equal(name, 'cost-guard')
assert.equal(costGuardService, 'costGuard')
assert.ok(Config && (typeof Config === 'object' || typeof Config === 'function'), 'Config schema 实例存在')
assert.equal(typeof apply, 'function')
ok('name / Config / apply / costGuardService 齐全')

// ---- 2. 计价 → 计量 → 预算 → 熔断（纯 core 链路）----
section('计价 → 计量 → 预算 → 熔断 全链路')
const pricing = buildPricingTable({})
const price = pricing['deepseek-reasoner']
assert.ok(price, '内置 deepseek-reasoner 价存在')
const cost = computeCost(price, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 })
assert.equal(Math.round(cost), 4 + 16, '1M in + 1M out = 20 元')

const meter = new Meter(480)
const windows = new WindowMeter(480)
const now = Date.now()
const entry = {
  time: now,
  route: { provider: 'deepseek', model: 'deepseek-reasoner' },
  usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  cacheReadTokens: 0,
  reasoningTokens: 0,
  cost,
  totalTokens: 2_000_000,
}
meter.record(entry, 'smoke-s1')
windows.record(entry)

const evaluator = createBudgetEvaluator(policiesFromConfig({ total: { limit: 1 } }))
const decision = evaluator.decide({ spent: { total: meter.spent('total').cost } })
assert.equal(decision.action, 'block', '20 元超 1 元预算 → block')
assert.equal(meter.spent('session').cost, 20, 'session 维度累计正确')
assert.equal(windows.today().cost, 20, '今日窗口累计正确')
ok('超预算 20x → 决策 block，session/今日累计一致')

// ---- 3. 事件形状解析 ----
section('DSH 事件形状 → 入账折算')
const parsed = parseSessionEvent({
  type: 'assistant/message',
  time: 1_700_000_000_000,
  data: {
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 },
  },
})
assert.equal(parsed.usage?.inputTokens, 1_000_000, 'usage 解析')
const priced = toUsageEntry(parsed, pricing, { provider: 'deepseek', model: 'deepseek-reasoner' })
assert.ok(priced, '零用量过滤未误伤')
assert.equal(Math.round(priced.cost), 20, '按 reasoner 价折算 20 元')
const hdr = parseSessionEvent({
  type: 'request/header',
  time: 1_700_000_000_000,
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } },
})
assert.equal(hdr.model, 'deepseek-chat', 'request/header 路由解析')
ok('assistant/message.usage + request/header.config 均正确折算')

// ---- 4. 真实 cordis Context 接线 ----
section('cordis Context 接线（事件监听生效）')
const ctx = new Context()
const m2 = new Meter(480)
const w2 = new WindowMeter(480)
const detach = attachMeters(ctx, m2, w2, pricing, { provider: 'deepseek', model: 'deepseek-chat' })
ctx.emit(
  'session/event',
  { get id() { return 'smoke-live' } },
  {
    type: 'assistant/message',
    time: Date.now(),
    data: { usage: { inputTokens: 500_000, outputTokens: 500_000 } },
  },
)
assert.equal(m2.spent('total').requests, 1, 'session/event → Meter 累计 1 次')
assert.equal(Math.round(m2.spent('total').cost), 5, 'deepseek-chat 500k+500k = 5 元（默认线路）')
assert.equal(w2.today().requests, 1, '今日窗口同步累计')
detach()

const gctx = new Context()
const m3 = new Meter(480)
const e3 = createBudgetEvaluator(policiesFromConfig({ total: { limit: 0.5 } }))
m3.record({ ...entry, cost: 1 }, 's')
const guard = attachGuard(gctx, e3, m3, { mode: 'block', cancelOnBlock: true })
assert.equal(guard.inspect().action, 'block', 'Guard 检查到超限 → block')

// 真实触发 agent/pre-step：验证 reject 决策 + agent.cancel 熔断调用
let cancelled = null
const fakeAgent = { cancel(cause) { cancelled = cause } }
const next = () => Promise.resolve({ kind: 'enter', messages: [] })
gctx.emit(
  'agent/pre-step',
  { agent: fakeAgent, messages: [], turn: 0, step: 1, signal: new AbortController().signal },
  next,
)
assert.equal(guard.lastDecision.action, 'block', '事件触发后最近决策被记录为 block')
assert.ok(cancelled && cancelled.kind === 'hook', 'agent.cancel({kind: hook}) 被调用')
ok('agent/pre-step → reject + agent.cancel 熔断生效')
ok('attachMeters + attachGuard 在真实 Context 上工作')

// ---- 5. apply() 全装配（Config 默认 + 工具注册 + costGuard 服务）----
console.log(`\n[${++step}] apply() 装配路径（工具注册 + ctx.costGuard 服务）`)
const actx = new Context()
const toolsRegistered = []
actx.tools = { register: (def) => toolsRegistered.push(def) }
apply(actx, {
  enabled: true,
  mode: 'block',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {},
  budgets: { total: { limit: 0.5 } },
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-chat',
  enableTool: true,
  verbose: false,
})
assert.equal(toolsRegistered.length, 1, 'cost_guard_status 工具已注册')
assert.equal(toolsRegistered[0].name, 'cost_guard_status', '工具名正确')
assert.ok(actx.costGuard, 'ctx.costGuard 服务已 provide')
actx.emit(
  'session/event',
  { get id() { return 'smoke-apply' } },
  { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
)
const st = actx.costGuard.status()
assert.equal(st.total.cost, 2, 'deepseek-chat 1M input = 2 元')
assert.equal(st.guard.action, 'block', '0.5 元预算 → 服务状态为 block')
assert.equal(typeof actx.costGuard.summary(), 'string', '人读摘要可用')
ok('apply 全装配：工具注册 + 事件计量 + 预算状态 + 摘要服务')

console.log(`\n[${++step}] 冒烟通过 ✓`)
console.log('dsh-cost-guard@0.1.0 lib 产物在真实 Node 环境运行正常')