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
 *   7. 预测式治理（0.4.0）：成本轨迹 + 到期投影提前熔断、请求级预检在真实 pre-step 熔断、
 *   8. 自适应调节治理（0.5.0）：月→日额度动态派生 + 预测背压收紧 + 今日耗尽告警/cue + 效率洞察
 *      apply 全装配状态输出预测与尖峰展示
 *
 * 任一断言失败即非零退出；全部通过打印摘要。
 */
import { strict as assert } from 'node:assert'
import { Context } from '@deepseek-ai/cordis'
import { name, Config, apply, costGuardService } from '../lib/index.js'
import { Meter, WindowMeter } from '../lib/core/meter.js'
import { buildPricingTable, computeCost, computeCredits, bandIdForEpoch } from '../lib/core/pricing.js'
import { createBudgetEvaluator, policiesFromConfig, predictivePolicyFromConfig } from '../lib/core/budget.js'
import { parseSessionEvent, toUsageEntry, attachMeters } from '../lib/harness/listener.js'
import { attachGuard, budgetInputFromMeter } from '../lib/harness/guard.js'
import { buildGovernorInput, governorConfigFromAdaptive } from '../lib/harness/adaptive.js'
import { CostTrail } from '../lib/core/trail.js'
import { MadDetector } from '../lib/core/anomaly.js'
import { buildForecastContext, preStepEstimate } from '../lib/harness/predictive.js'
import { buildCostStatus } from '../lib/harness/tool.js'
import { CacheMetrics } from '../lib/core/cache-metrics.js'
import { CacheHintDetector } from '../lib/core/cache-hint.js'
import { CachePricingEngine } from '../lib/core/cache-pricing.js'
import { attachCacheMeter, buildCachePanel, formatCacheLines, readCacheUsage } from '../lib/harness/cache.js'

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

// ---- 7. 预测式治理（0.4.0）----
console.log(`\n[${++step}] 预测式治理（轨迹采样 + 到期投影提前熔断 + 真实 pre-step 预检）`)
// 7.1 确定性核心链路：轨迹外推 → 预测超限 → 提前 block（真实 cordis Context）
const pctx = new Context()
const pmeter = new Meter(480)
const ptrail = new CostTrail()
const pdet = new MadDetector()
const pruntime = {
  trail: ptrail,
  detector: pdet,
  meter: pmeter,
  pricing,
  fallbackRoute: { provider: 'deepseek', model: 'deepseek-chat' },
  tzOffsetMin: 480,
}
const fixedNow = Date.now()
pruntime.now = () => fixedNow
// 注入轨迹：3 分钟前花 2 元、1 分钟前再花 8 元（线性飙升），今日预算 100，warnAt=0.8
// → 日终投影远超 80 元，提前 block
const t1 = fixedNow - 3 * 60_000
const t2 = fixedNow - 60_000
pmeter.record({ ...entry, time: t1, cost: 2, credits: 20 }, 's')
ptrail.push('day', t1, 2)
ptrail.push('month', t1, 2)
pmeter.record({ ...entry, time: t2, cost: 8, credits: 80 }, 's')
ptrail.push('day', t2, 10)
ptrail.push('month', t2, 10)

const pevaluator = createBudgetEvaluator(
  policiesFromConfig({ day: { limit: 100 } }),
  predictivePolicyFromConfig({
    projections: { day: { target: '今日结束', warnAt: 0.8, hardAt: 1 } },
    spike: { level: 'extreme', action: 'block' },
    preflight: { mode: 'expected', action: 'block', scope: 'total' },
  }),
)
const pguard = attachGuard(pctx, pevaluator, pmeter, {
  mode: 'block',
  cancelOnBlock: true,
  forecastInput: () => buildForecastContext(pruntime),
})
const pdec = pguard.inspect()
assert.equal(pdec.action, 'block', '轨迹外推：今日结束预测成本 ≥ hardAt → 提前 block')
assert.ok(pdec.predictive?.some((x) => x.kind === 'projection' && x.level === 'hard'), '预测触发明细包含 projection hard')
assert.ok(pdec.predictive[0]?.detail.includes('今日结束'), '投影 detail 含目标时刻说明')
ok('到期投影：轨迹外推 → 预测超限 → 提前熔断（未等真超支）')

// 7.2 请求级预检：真实 agent/pre-step + 长消息 → 估算成本越线 → reject + cancel
const porn = new Context()
const pm2 = new Meter(480)
const pe2 = createBudgetEvaluator(
  policiesFromConfig({ total: { limit: 5 } }),
  predictivePolicyFromConfig({ preflight: { mode: 'expected', action: 'block', scope: 'total' } }),
)
// 已花 4.95/5，剩余 0.05；消息字符 ~40000 → 估算 input ~10000 tokens × 2 元/1M = 0.02 元
// expected 模式 = input + 0.5×output = 0.02 + 0.04 = 0.06 > 剩余 0.05 → 越线拦截
pm2.record({ ...entry, cost: 4.95, credits: 49.5 }, 's')
const pguard2 = attachGuard(porn, pe2, pm2, {
  mode: 'block',
  cancelOnBlock: true,
  estimateFromMessages: (chars) => preStepEstimate(chars, pruntime),
})
let pcancelled = null
const pnext = () => Promise.resolve({ kind: 'enter', messages: [] })
porn.emit(
  'agent/pre-step',
  {
    agent: { cancel: (c) => { pcancelled = c } },
    messages: [{ role: 'user', content: 'x'.repeat(40_000) }],
    turn: 0,
    step: 1,
    signal: new AbortController().signal,
  },
  pnext,
)
assert.equal(pguard2.lastDecision.action, 'block', '预检：本请求估算将越线 → block（未发出即拦截）')
assert.ok(pguard2.lastDecision.predictive?.some((x) => x.kind === 'preflight'), '决策含 preflight 触发明细')
assert.ok(pcancelled && pcancelled.kind === 'hook', '预检熔断同样触发 agent.cancel')
ok('请求级预检：pre-step 长消息 → 花出去之前估算越线 → reject + cancel')

// 7.3 apply 全装配 + predictive 配置：状态输出预测与尖峰展示
console.log(`\n  apply 装配（config.predictive）+ 状态展示预测/尖峰`)
const pactx = new Context()
const ptools = []
pactx.tools = { register: (def) => ptools.push(def) }
apply(pactx, {
  enabled: true,
  mode: 'block',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {
    'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8, creditsPerMillion: 100 },
  },
  budgets: { day: { limit: 100 } },
  predictive: {
    projections: { day: { target: '今日结束', warnAt: 0.8, hardAt: 1 } },
    spike: { level: 'extreme', action: 'warn' },
    preflight: { mode: 'expected', action: 'block', scope: 'total' },
  },
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-chat',
  enableTool: true,
  verbose: false,
})
assert.ok(pactx.costGuard, 'ctx.costGuard 服务已 provide（predictive 装配）')
pactx.emit(
  'session/event',
  { get id() { return 'smoke-pred' } },
  { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 50_000, outputTokens: 0 } } },
)
const pst = pactx.costGuard.status()
assert.ok(pst.forecast, '状态包含 forecast 段')
assert.ok(Object.keys(pst.forecast.projections).includes('day'), 'forecast 包含 day 投影')
assert.ok(pst.forecast.projections.day.expected >= pst.day.cost, '投影成本 ≥ 已花费（非负外推）')
assert.equal(pst.forecast.samples, 1, '轨迹采样点计数正确')
assert.ok(['normal', 'spike', 'extreme'].includes(pst.forecast.spike), '尖峰级别字段合法')
const psummary = pactx.costGuard.summary()
assert.ok(psummary.includes('预测:') || psummary.includes('今日结束'), '摘要可输出预测行（样本 1 点可能不足以投影，允许缺省）')
ok('apply 全装配：predictive 配置生效，状态输出 forecast 段与尖峰级别，摘要含预测行')

// ---- 8. 自适应调节治理（0.5.0）：动态额度 + 背压水位 + 成本感知 cue + 效率洞察 ----
console.log(`\n[${++step}] 自适应调节治理（月度→日额度动态派生 + 消费速率背压 + 效率洞察）`)
// 8.1 确定性核心链路：真实 Meter/WindowMeter + governor → 预测超支收紧日额度并触发 exhausted
const g8ctx = new Context()
const g8meter = new Meter(480)
const g8windows = new WindowMeter(480)
const agoraCfg = governorConfigFromAdaptive({ monthLimit: 300, backpressure: 0.5 }, 0)
assert.ok(agoraCfg, 'governor 配置归一化成功')
assert.equal(agoraCfg.monthLimit, 300, 'monthLimit 生效')
// 已花 60/月 与 60/今天；月末预测 400 > 月预算 300 → 背压收紧
g8meter.record({ ...entry, cost: 60, credits: 600 }, 's')
g8windows.record({ ...entry, cost: 60, credits: 600 })
// 固定时钟：2026-10-20 12:00 +08（离 10 月末还有 12 天），保证跨日运行确定性
const g8Now = Date.UTC(2026, 9, 20, 4, 0, 0)
const ainput = buildGovernorInput(agoraCfg, { meter: g8meter, windows: g8windows, tzOffsetMin: 480, now: () => g8Now }, {
  projected: { month: 400 },
})
assert.ok(ainput, '自适应输入构造成功')
assert.ok(ainput.governor.exhausted, '今日花费 ≥ 动态日额度 → exhausted')
assert.ok(ainput.governor.pressure < 1, '预测月末超支 → 背压收紧（pressure < 1）')
assert.ok(ainput.governor.dayAllowance < 60, '动态日额度低于今日已花费（背压收紧）')
ok('8.1 月度→日额度动态派生 + 预测背压：压力 < 1、日额度收紧、今日耗尽识别正确')
// 8.2 真实 cordis Context：adaptive 决策把动态水位用于 day scope → 今日耗尽告警
const aev = createBudgetEvaluator(
  policiesFromConfig({ day: { limit: 100 } }),
  predictivePolicyFromConfig({ adaptive: {} }),
)
const adec = aev.decide(budgetInputFromMeter(g8meter, undefined, ainput))
assert.equal(adec.action, 'warn', '自适应治理：今日耗尽触发告警（warn）')
assert.ok(adec.adaptive, '决策输出 adaptive 段（动态水位 + cue）')
assert.equal(adec.adaptive.cue, 'minimal', '今日额度耗尽 → cue=minimal（最小化）')
assert.ok(adec.adaptive.governor.exhausted, 'adaptive 段含 exhausted 状态')
const aguard = attachGuard(g8ctx, aev, g8meter, {
  mode: 'block',
  cancelOnBlock: true,
  adaptiveInput: (fc) => buildGovernorInput(agoraCfg, { meter: g8meter, windows: g8windows, tzOffsetMin: 480, now: () => g8Now }, fc),
  forecastInput: () => ({ projected: { month: 400 } }),
})
const aus = aguard.inspect()
assert.equal(aus.action, 'warn', 'Guard 经 adaptive 接线：今日耗尽 -> warn（未硬熔断）')
ok('8.2 真实 cordis Context：adaptive 接线，决策带动态水位 + cue，Guard 正常告警')
// 8.3 apply 全装配：自适应 + 效率洞察展示
console.log(`\n  apply 装配（config.adaptive）+ 状态展示自适应与效率洞察`)
const aactx = new Context()
const atools = []
aactx.tools = { register: (def) => atools.push(def) }
apply(aactx, {
  enabled: true,
  mode: 'warn',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {
    'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
    'deepseek-reasoner': { inputPerMillion: 4, cacheReadPerMillion: 1, outputPerMillion: 16 },
  },
  budgets: { month: { limit: 300 } },
  adaptive: { backpressure: 0.5 },
  predictive: { adaptive: { scope: 'day', onExhausted: 'warn' } },
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-reasoner',
  enableTool: true,
  verbose: false,
})
assert.ok(aactx.costGuard, 'ctx.costGuard 服务已 provide（adaptive 装配）')
assert.equal(atools.length, 1, '工具注册正常')
aactx.emit(
  'session/event',
  { get id() { return 'smoke-adapt' } },
  { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 50_000, outputTokens: 50_000 } } },
)
const ast = aactx.costGuard.status()
assert.ok(ast.adaptive, '状态包含 adaptive 段')
assert.ok(['calm', 'frugal', 'minimal'].includes(ast.adaptive.cue), 'cue 级别合法')
assert.equal(typeof ast.adaptive.pressure, 'number', '背压因子为数字')
assert.ok(ast.efficiency, '状态包含 efficiency 段')
assert.ok(ast.efficiency.routes.length > 0, '效率洞察含路由指标')
const aIn = ast.efficiency.routes.find((r) => r.route.includes('deepseek-reasoner'))
assert.ok(aIn && aIn.costPerKOutput > 0, '每千输出 token 成本已计算')
const asummary = aactx.costGuard.summary()
assert.ok(typeof asummary === 'string' && asummary.length > 0, '摘要可用')
// 8.4 成本效率洞察：请求分布 + 替代节约
const a2ctx = new Context()
const a2meter = new Meter(480)
const a2win = new WindowMeter(480)
const det2 = new MadDetector()
for (const c of [1, 1, 2, 2, 30]) det2.push(c) // 长尾请求构成分布
const a2eval = createBudgetEvaluator(policiesFromConfig({ day: { limit: 1000 } }))
const a2guard = { lastDecision: { action: 'allow', triggers: [] }, inspect: () => ({ action: 'allow', triggers: [] }) }
const a2pricing = buildPricingTable({
  'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
  'deepseek-reasoner': { inputPerMillion: 4, cacheReadPerMillion: 1, outputPerMillion: 16 },
})
// chat 路由 10 元；若换 reasoner：input 50万×4/1M + output 50万×16/1M = 2 + 8 = 10 元 -> 无节约（不产出建议）
a2meter.record({ ...entry, route: { provider: 'deepseek', model: 'deepseek-chat' }, time: Date.now(), cost: 10, credits: 100, totalTokens: 1_000_000, usage: { inputTokens: 500_000, outputTokens: 500_000 } }, 's')
const st2 = buildCostStatus(a2meter, a2win, a2eval, a2guard, {
  baseline: a2pricing,
  tzOffsetMin: 480,
  costSamples: det2,
})
assert.ok(st2.efficiency.distribution, '请求成本分布已计算（5 样本）')
assert.equal(st2.efficiency.distribution.n, 5, '分布样本数正确')
assert.ok(st2.efficiency.distribution.p95 > st2.efficiency.distribution.p50, 'P95 ≥ P50（长尾分布）')
assert.ok(Array.isArray(st2.efficiency.replacement), '替代节约建议字段存在')
ok('8.4 效率洞察：请求成本分布（P50/P95/Max）+ 路由每千输出 token 成本正确')

// ---- 9. 缓存维度计量（0.6.0）：三通道解析 + 命中率/收益/不确定 + 面板输出 ----
console.log(`\n[${++step}] 缓存维度计量（真实 Context 事件 → 命中率 / 收益 / 不确定 / 面板输出）`)
// 9.1 apply 全装配 + cache.enabled=true：事件驱动缓存账本
const cctx = new Context()
const ctools = []
cctx.tools = { register: (def) => ctools.push(def) }
apply(cctx, {
  enabled: true,
  mode: 'warn',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {
    'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
  },
  cache: {
    enabled: true,
    hint: { minRepeat: 2, minSaving: 0.05 },
  },
  budgets: { total: { limit: 100 } },
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-chat',
  enableTool: true,
  verbose: false,
})
assert.ok(cctx.costGuard, 'ctx.costGuard 服务已 provide（cache 装配）')
// 事件①：OpenAI 原生缓存字段（details.cached_tokens）
cctx.emit(
  'session/event',
  { get id() { return 'smoke-cache-1' } },
  {
    type: 'assistant/message',
    time: Date.now(),
    data: {
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 300_000 },
      },
    },
  },
)
// 事件②：DSH 归一化 inputTokens + cacheReadTokens
cctx.emit(
  'session/event',
  { get id() { return 'smoke-cache-2' } },
  {
    type: 'assistant/message',
    time: Date.now(),
    data: { usage: { inputTokens: 500_000, outputTokens: 50_000, cacheReadTokens: 100_000 } },
  },
)
// 事件③：缺失缓存字段 → 回退未命中 + 不确定（不入命中率）
cctx.emit(
  'session/event',
  { get id() { return 'smoke-cache-3' } },
  {
    type: 'assistant/message',
    time: Date.now(),
    data: { usage: { inputTokens: 400_000, outputTokens: 50_000 } },
  },
)
const cst = cctx.costGuard.status()
assert.ok(cst.cache, '状态包含 cache 段（cache.enabled=true）')
// Token 加权命中率：可信输入 = 1M(事件①0.3M 命中) + 500k+100k(事件②0.1M 命中) = 1.6M；命中 = 0.4M
assert.equal(cst.cache.summary.inputTotal, 1_600_000, '输入 token 汇总仅含可信请求')
assert.equal(cst.cache.summary.hitTotal, 400_000, '缓存命中 token 汇总')
assert.ok(Math.abs(cst.cache.summary.hitRate - 0.25) < 1e-9, 'Token 加权命中率 = 0.4M/1.6M = 25%')
assert.equal(cst.cache.summary.uncertainCount, 1, '缺失缓存字段的事件计为不确定')
assert.ok(cst.cache.summary.savingTotal > 0, '缓存收益 > 0（相对全未命中基线）')
// 面板与摘要行
const clines = formatCacheLines(cst.cache)
assert.ok(clines.some((l) => l.includes('缓存: 命中率 25.0%') && l.includes('不确定 1 次')), '面板行输出命中率与不确定数')
const csummary = cctx.costGuard.summary()
assert.ok(csummary.includes('缓存: 命中率 25.0%'), '摘要输出缓存命中率行')
ok('缓存计量全链路：原生字段/归一化字段解析 + 命中率 + 收益 + 不确定计数 + 面板/摘要输出正确')

// 9.2 独立引擎链路：收益 = baseline - cost 可复算
const ceng = new CachePricingEngine()
const cmetrics = new CacheMetrics()
const chint = new CacheHintDetector(ceng, { minRepeat: 3, minSaving: 0.5 })
const cctx2 = new Context()
attachCacheMeter(cctx2, { tzOffsetMin: 480, pricing: ceng, metrics: cmetrics, hint: chint })
// 指定路由 deepseek-flash（内置价表 flash 空闲：hit=0.02 / miss=1.0 / out=4.0）
cctx2.emit(
  'session/event',
  { get id() { return 'smoke-cache-hdr' } },
  { type: 'request/header', time: Date.UTC(2026, 8, 7, 22, 0), data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } } },
)
// 全命中 1M 输入 + 100k 输出（北京凌晨 -> 空闲）
cctx2.emit(
  'session/event',
  { get id() { return 'smoke-cache-4' } },
  {
    type: 'assistant/message',
    time: Date.UTC(2026, 8, 7, 22, 0),
    data: { usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 1_000_000 } } },
  },
)
const c2 = cmetrics.summary('global')
assert.equal(c2.inputTotal, 1_000_000)
assert.equal(c2.hitRate, 1)
// 收益 = (miss - hit)单价差 × 1M = (1.0 - 0.02) = 0.98
assert.ok(Math.abs(c2.savingTotal - 0.98) < 1e-6, '全命中收益复算 = (1.0-0.02) × 1M/1M = 0.98 元')
ok('9.2 内置官方价复算：全命中收益 = 未命中价 - 命中价（flash 空闲 0.98 元）')

// ---- 10. 回退与零回归（0.6.0）：缺失字段按未命中计费 + 连续回退提示 + 未启用零回归 ----
console.log(`\n[${++step}] 回退与零回归（缺失字段按未命中计费 / 连续 5 次提示 / 未启用时输出与 0.5.0 一致）`)
// 10.1 未启用 cache：apply 输出不含 cache 段，摘要无缓存行（零回归）
const zctx = new Context()
const ztools = []
zctx.tools = { register: (def) => ztools.push(def) }
apply(zctx, {
  enabled: true,
  mode: 'warn',
  cancelOnBlock: true,
  tzOffsetMin: 480,
  pricing: {
    'deepseek-chat': { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
  },
  budgets: { total: { limit: 100 } },
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-chat',
  enableTool: true,
  verbose: false,
})
zctx.emit(
  'session/event',
  { get id() { return 'smoke-zero' } },
  { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 100_000, outputTokens: 10_000 } } },
)
const zst = zctx.costGuard.status()
assert.equal(zst.cache, undefined, 'cache.enabled 默认 false：状态无 cache 段（零回归）')
const zsummary = zctx.costGuard.summary()
assert.ok(!zsummary.includes('缓存:'), '摘要不含缓存行（零回归）')
assert.ok(!zsummary.includes('前缀'), '摘要不含前缀提示（零回归）')
// 既有计量不受影响：100k in + 10k out → 2M 输入价 + 8M 输出价 → 0.2 + 0.08 = 0.28 元
assert.equal(zst.total.cost, 0.28, '未启用时既有话费计量与 0.5.0 一致')
ok('10.1 未启用 cache：输出与 0.5.0 完全一致（无 cache 段 / 无缓存行 / 既有计量不变）')

// 10.2 连续 5 次回退 → 一次性提示回调（每 10 分钟限一条）
const rctx = new Context()
const rmetrics = new CacheMetrics()
const rengine = new CachePricingEngine()
const rhint = new CacheHintDetector(rengine)
let fallbackStreakFired = 0
attachCacheMeter(rctx, {
  tzOffsetMin: 480,
  pricing: rengine,
  metrics: rmetrics,
  hint: rhint,
  onFallbackStreak: (n) => {
    fallbackStreakFired = n
  },
})
for (let i = 0; i < 5; i++) {
  rctx.emit(
    'session/event',
    { get id() { return `smoke-fb-${i}` } },
    { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 100_000, outputTokens: 10_000 } } },
  )
}
assert.equal(fallbackStreakFired, 5, '连续 5 次缺失缓存字段 → 一次性提示回调')
const rs = rmetrics.summary('global')
assert.equal(rs.uncertainCount, 5, '5 次缺失全部按未命中计费并计不确定')
assert.equal(rs.inputTotal, 0, '不确定请求不污染可信命中率口径')
ok('10.2 连续 5 次回退：一次性提示 + 全部按未命中计费 + uncertainCount=5 且不污染命中率')

console.log(`\n[${++step}] 冒烟通过 ✓`)
console.log('dsh-cost-guard@0.6.0 lib 产物在真实 Node 环境运行正常（实时计量 + 峰谷计费 + 预测式治理 + 自适应调节 + 效率洞察 + 缓存维度计量）')