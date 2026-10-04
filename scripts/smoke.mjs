/**
 * dsh-cost-guard 冒烟测试（node scripts/smoke.mjs）
 *
 * 在真实 Node 环境（CI/本地）验证发布产物（lib/）：
 *   1. 包可导入、导出面完整（name / Config / apply / costGuardService）
 *   2. 计价（金额 + 积分）→ 计量 → 预算 → 熔断 全链路决策正确
 *   3. 从真实 DSH 事件形状（session/event 的 assistant/message + request/header）正确折算入账（含积分）
 *   4. 真实 cordis Context 接线：session/event 事件驱动 Meter 累计、预算决策供 Guard 检查
 *   5. apply() 全装配：工具注册 + 积分单价配置生效 + 状态/摘要同时输出话费与积分
 *   6. 峰谷计费与实时追踪：按事件本地时刻选带定价、分带累计、当前时段与生效单价输出
 *
 * 任一断言失败即非零退出；全部通过打印摘要。
 */
import { strict as assert } from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { name, Config, apply, costGuardService } from '../lib/index.js'
import { Meter, WindowMeter } from '../lib/core/meter.js'
import { buildPricingTable, computeCost, computeCredits, bandIdForEpoch } from '../lib/core/pricing.js'
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

// ---- 2. 计价 → 计量 → 预算 → 熔断（纯 core 链路，含积分）----
section('计价（金额+积分）→ 计量 → 预算 → 熔断 全链路')
const pricing = buildPricingTable({
  'deepseek-reasoner': { inputPerMillion: 4, cacheReadPerMillion: 1, outputPerMillion: 16, creditsPerMillion: 100 },
})
const price = pricing['deepseek-reasoner']
assert.ok(price, '内置 deepseek-reasoner 价存在')
const cost = computeCost(price, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 })
assert.equal(Math.round(cost), 4 + 16, '1M in + 1M out = 20 元')
const credits = computeCredits(price, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 })
assert.equal(credits, 200, '2M 计费 token x 100 积分/1M = 200 积分')

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
  credits,
  totalTokens: 2_000_000,
}
meter.record(entry, 'smoke-s1')
windows.record(entry)

const evaluator = createBudgetEvaluator(policiesFromConfig({ total: { limit: 1 } }))
const decision = evaluator.decide({ spent: { total: meter.spent('total').cost } })
assert.equal(decision.action, 'block', '20 元超 1 元预算 → block')
assert.equal(meter.spent('session').cost, 20, 'session 维度金额累计正确')
assert.equal(meter.spent('session').credits, 200, 'session 维度积分累计正确')
assert.equal(windows.today().cost, 20, '今日窗口金额累计正确')
assert.equal(windows.today().credits, 200, '今日窗口积分累计正确')
ok('超预算 20x → 决策 block，session/今日 金额与积分累计一致')

// ---- 3. 事件形状解析 ----
section('DSH 事件形状 → 入账折算（金额+积分）')
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
assert.equal(priced.credits, 200, '按 reasoner 积分价折算 200 积分')
const hdr = parseSessionEvent({
  type: 'request/header',
  time: 1_700_000_000_000,
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } },
})
assert.equal(hdr.model, 'deepseek-chat', 'request/header 路由解析')
// 未配置积分单价的模型积分按 0，金额仍按内置价
const pricedChat = toUsageEntry(parsed, pricing, { provider: 'deepseek', model: 'deepseek-chat' })
assert.equal(pricedChat.credits, 0, '未配积分价的模型积分按 0')
assert.equal(Math.round(pricedChat.cost), 2 + 8, 'deepseek-chat 内置价 1M in + 1M out = 10 元')
ok('assistant/message.usage + request/header.config 均正确折算（金额+积分）')

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
m3.record({ ...entry, cost: 1, credits: 10 }, 's')
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

// ---- 5. apply() 全装配（Config 默认 + 工具注册 + costGuard 服务 + 积分展示）----
console.log(`\n[${++step}] apply() 装配路径（工具注册 + ctx.costGuard 服务 + 积分统计）`)
const actx = new Context()
const toolsRegistered = []
actx.tools = { register: (def) => toolsRegistered.push(def) }
apply(actx, {
  enabled: true,
  mode: 'block',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {
    'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8, creditsPerMillion: 100 },
  },
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
assert.equal(st.total.credits, 100, 'deepseek-chat 1M input x 100 积分/1M = 100 积分')
assert.equal(st.routes['deepseek/deepseek-chat'].credits, 100, '按路由明细含积分')
assert.equal(st.guard.action, 'block', '0.5 元预算 → 服务状态为 block')
const summary = actx.costGuard.summary()
assert.equal(typeof summary, 'string', '人读摘要可用')
assert.ok(summary.includes('总花费 2') && summary.includes('总积分 100'), '摘要同时呈现话费与积分')
ok('apply 全装配：工具注册 + 事件计量（金额+积分） + 预算状态 + 摘要服务')

// ---- 6. 峰谷计费与实时追踪（apply 装配 + 确定性时段 + 自洽时钟）----
console.log(`\n[${++step}] 峰谷计费接入 + 实时追踪（时段选档、分带累计、状态输出）`)
const bctx = new Context()
const btools = []
bctx.tools = { register: (def) => btools.push(def) }
apply(bctx, {
  enabled: true,
  mode: 'off',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {
    'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
    'deepseek-reasoner': { inputPerMillion: 4, cacheReadPerMillion: 1, outputPerMillion: 16 },
  },
  bands: [
    { id: 'peak', start: '09:00', end: '18:00', prices: { 'deepseek-chat': { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 } } },
    { id: 'valley', start: '22:00', end: '08:00' },
  ],
  budgets: { total: { limit: 100 } },
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-chat',
  enableTool: true,
  verbose: false,
})
const bands = [
  { id: 'peak', start: '09:00', end: '18:00', prices: { 'deepseek-chat': { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 } } },
  { id: 'valley', start: '22:00', end: '08:00' },
]
// 「今天」的确定性时刻：02:00 UTC = 10:00 +08（peak 带内）；12:00 UTC 前一天 = 今天 02:00 +08（valley 带内）
// 确定性时刻：以「+08 本地日」伪时间轴构造，保证与 Date.now() 落到同一本地日
// 本地 10:00 -> peak 带内；本地 02:00 -> 跨午夜 valley 带内
const localAxis = Date.now() + 480 * 60_000
const localMidnight = Math.floor(localAxis / 86_400_000) * 86_400_000
const peakTime = localMidnight + 10 * 3_600_000 - 480 * 60_000
const nightTime = localMidnight + 2 * 3_600_000 - 480 * 60_000
bctx.emit(
  'session/event',
  { get id() { return 'smoke-band' } },
  { type: 'assistant/message', time: peakTime, data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
)
bctx.emit(
  'session/event',
  { get id() { return 'smoke-band-night' } },
  { type: 'assistant/message', time: nightTime, data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
)
const bst = bctx.costGuard.status()
// 实时追踪：当前时段带判定与实时时钟自洽
const expectedBand = bandIdForEpoch(bands, Date.now(), 480)
assert.equal(bst.band.current, expectedBand, '当前时段带判定与实时时钟一致')
assert.ok(['peak', 'valley'].includes(bst.band.current), '当前时段属于已配置带')
assert.equal(bst.band.schedule.length, 2, '时段定义表完整')
// 峰段使用带内价 6 元（非基准 2 元）；凌晨 valley 回退基准 2 元 -> 累计 8
assert.equal(bst.total.cost, 8, '峰值 6 + 谷值 2 = 8 元')
assert.equal(bst.bandTotals['peak'].cost, 6, '全局分带累计归入 peak')
assert.equal(bst.bandTotals['valley'].cost, 2, '全局分带累计归入 valley')
assert.equal(bst.todayBands['peak'].cost, 6, '今日分带累计归入 peak')
assert.equal(bst.todayBands['valley'].cost, 2, '今日分带累计归入 valley')
// activePrices 反映「当前真实时段」生效单价：peak 带覆盖价 6，其余时段回退基准价 2
const expectedActive = expectedBand === 'peak' ? 6 : 2
assert.equal(bst.activePrices['deepseek-chat'].inputPerMillion, expectedActive, '当前时段生效单价与带判定一致')
assert.equal(bst.activePrices['deepseek-reasoner'].inputPerMillion, 4, '未覆盖模型回退基准价 4')
const bsummary = bctx.costGuard.summary()
assert.ok(bsummary.includes('当前时段: '), '摘要输出当前时段')
assert.ok(bsummary.includes('今日分带: peak 6'), '摘要输出今日分带累计')
ok('峰谷接入：时段选档定价、分带累计、当前时段与生效单价实时输出正确')

console.log(`\n[${++step}] 冒烟通过 ✓`)
console.log('dsh-cost-guard@0.3.0 lib 产物在真实 Node 环境运行正常（金额 + 积分双维度统计 + 峰谷计费实时追踪）')