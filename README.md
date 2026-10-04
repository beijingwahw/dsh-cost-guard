# dsh-cost-guard

**DeepSeek Harness 原生「实时成本治理」插件** —— 用量实时计量、多维度预算、熔断防护、成本面板，全部在 Harness 进程内完成。

> 市面现有方案（whale-report 等）全是**事后形态**：跑完一轮才出报告，超支发生后才告诉你。`dsh-cost-guard` 是第一款**原生实时治理插件**：在 `agent/pre-step` 阶段拦下超预算的下一步请求，从源头上阻止模型继续烧钱。

---

## 为什么是它

DeepSeek Harness（DSH）是官方开源的 Agent Harness（"一切皆插件"，Cordis 驱动，npm 分发）。社区插件生态目前缺失一块刚需能力：

| 场景 | 现状 | dsh-cost-guard |
| --- | --- | --- |
| 成本可见性 | 事后报告 / 外部工具 | **进程内实时计量**，会话/日/月/总四维 + 按路由拆分 |
| 超支防护 | 无 / 只能手动停 | **模型请求前熔断**，硬限 reject + cancel，预算用尽即停 |
| 成本感知 | 模型无感知 | 注册 `cost_guard_status` 工具，Agent 可自查询预算水位 |
| 价格适配 | 固定写死 | 内置 DeepSeek 官方价 + 任意 provider/model 价格覆盖 |
| 峰谷计价 | 无 | **按本地时段选档计价**，跨午夜/全天时段 + 按带价格覆盖 |

实时计量的关键是 DSH 的事件闭环：`session/event`（`assistant/message.usage` + `request/header.config`）提供**逐次调用的精确 token 用量与路由**；`agent/pre-step`（waterfall）提供**阻止下一步模型请求**的唯一干净位置。本插件把这两者接成一条防护链。

## 特性

- **实时计量**：订阅 `session/event`，把每次调用的精确 usage 按路由价格折算金额，累计到 total / day / month / session 四个维度 + 按 `provider/model` 明细。
- **峰谷计费 + 实时追踪**：支持按本地时区定义任意数量计费时段（如 peak 09:00-18:00、valley 22:00-次日 08:00，支持跨午夜与全天覆盖），每个时段可独立覆盖各模型单价；每次调用按事件发生时刻自动选带定价，未命中时段回退基准价。成本工具/摘要实时输出当前时段、当前时段各模型生效单价、全局/今日分带消耗分布。
- **话费 + 积分双维度统计**：每个模型可独立配置积分单价（`creditsPerMillion`），计费 token 自动折算积分，与金额独立累计、独立展示（`总花费 X · 总积分 Y`)；未配置积分单价的模型积分按 0 计，不遗漏任何被调用的模型。
- **多维预算熔断**：session / day / month / total 各自独立配置 `limit`（金额上限）、`warnAt`（告警水位）、`hardAt`（阻断水位）。命中硬限 → 在 `agent/pre-step` 返回 `{kind:'reject'}` 并调用 `agent.cancel({kind:'hook'})` 终止轮次；命中告警 → 只记日志。积分仅统计展示，不影响熔断判定。
- **成本面板**：注册只读工具 `cost_guard_status`（模型可调用）与 `CostGuardService`（`ctx.costGuard`，其他插件可注入），并暴露 `cost_guard_status` 人读摘要。
- **价格覆盖**：内置 DeepSeek 官方价（`deepseek-chat` / `deepseek-reasoner`），支持按 `provider/model` 或裸 `model` 覆盖，未识别路由走保守兜底价。
- **安全默认**：默认 `mode=block` 硬熔断 + `cancelOnBlock=true`；想纯观察可 `mode=off`（只计量不干预）。

## 安装

```bash
dsh plugin add dsh-cost-guard
```

要求 Node `^22.19.0 || >=24.0.0`（与 DSH 一致），peer 依赖与 DSH 0.1.1-rc.2 系列对齐。

## 配置

在 DSH 配置中为 `cost-guard` 提供配置对象：

```yaml
plugins:
  cost-guard:
    enabled: true
    mode: block            # off | warn | block
    cancelOnBlock: true
    tzOffsetMin: 480       # 东八区；日/月预算按此时区切分
    # 价格覆盖（CNY / 每百万 token）：支持 'provider/model' 或裸 'model' 键
    # creditsPerMillion：该模型每百万计费 token 消耗的积分，可选，未配置按 0 计
    pricing:
      "deepseek/deepseek-chat": { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8, creditsPerMillion: 100 }
    # 峰谷时段（可选）：按本地时区（tzOffsetMin）选档计价；不配置则全部按基准价
    # start === end 表示全天覆盖；start > end 表示跨午夜（如 22:00-08:00 覆盖 22:00~24:00 + 00:00~08:00）
    # 时段内未覆盖的路由/模型回退基准价表
    bands:
      - id: peak
        start: "09:00"
        end: "18:00"
        prices:
          "deepseek/deepseek-chat": { inputPerMillion: 6, cacheReadPerMillion: 1.5, outputPerMillion: 24 }
      - id: valley
        start: "22:00"
        end: "08:00"
        # 未给 valley 配 prices：带内按基准价（相当于夜间不打折的对照时段）
    # 预算：不配置的 scope 不设限
    budgets:
      session: { limit: 10,   warnAt: 0.8, hardAt: 1 }
      day:     { limit: 50,   warnAt: 0.8, hardAt: 1 }
      month:   { limit: 500,  warnAt: 0.9, hardAt: 1 }
      total:   { limit: 1000, warnAt: 0.9, hardAt: 1 }
    fallbackProvider: deepseek
    fallbackModel: deepseek-chat
    enableTool: true
    verbose: true
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `mode` | `off`/`warn`/`block` | `block` | `off` 只计量；`warn` 超限告警不阻断；`block` 硬阻断 |
| `cancelOnBlock` | boolean | `true` | 硬阻断时同时 `agent.cancel` 终止轮次 |
| `tzOffsetMin` | number | `480` | 日/月窗口切分的时区偏移（分钟） |
| `pricing` | dict | `{}` | 价格覆盖：`inputPerMillion`/`cacheReadPerMillion`/`outputPerMillion`（金额）+ 可选 `creditsPerMillion`（每百万 token 积分单价） |
| `bands` | array | `[]` | 峰谷时段（可选）：`{ id, start, end, prices? }`；`start===end` 全天、`start>end` 跨午夜；带内 `prices` 覆盖基准价，未覆盖回退基准价。不配置则全部按基准价 |
| `budgets` | dict | `{}` | `session`/`day`/`month`/`total` 的 `limit`/`warnAt`/`hardAt` |
| `fallbackProvider` | string | `deepseek` | 路由缺失时的默认 provider |
| `fallbackModel` | string | `deepseek-chat` | 路由缺失时的默认模型 |
| `enableTool` | boolean | `true` | 是否注册 `cost_guard_status` 工具 |
| `verbose` | boolean | `true` | 启动摘要日志 |

## 使用效果

- 预算内：静默计量，Agent 调用 `cost_guard_status` 可自感知用量（含话费与积分两个维度）。
- 告警水位：`ctx.logger('cost-guard')` 输出 `session 预算达到 82% (8.2/10.0)` 并触发 `onViolation` 回调。
- 硬限命中：日志 `total 预算已耗尽 (20.0/10.0)，已熔断`，本轮模型请求被拒绝、轮次取消；调用方可继续但不会再产生模型费用。
- 状态摘要：`cost_guard_status` 与 `ctx.costGuard.summary()` 输出 `总花费 X · 总积分 Y`，今日/本月/本会话与主要路由行均附积分，任意被调用的模型都按各自积分单价入账。
- 峰谷实时追踪：配置 `bands` 后，每次调用按事件发生时刻的本地时间选带计价；摘要新增 `当前时段: peak (09:00-18:00)` 与 `今日分带: peak 6.00 元 / 积分 300 · valley 2.00 元 / 积分 100` 行；`cost_guard_status` 返回结构新增 `band`（当前时段 id/起止/判定时刻/时段表）、`activePrices`（当前时段各模型生效单价）、`bandTotals`（全局分带累计）与 `todayBands`（今日分带累计），模型可据此感知"现在贵不贵、贵多少"。

## 架构

六边形架构，领域核心与 DSH 运行时解耦：

```
src/
  core/        # 零 DSH 依赖的纯领域层
    types.ts     领域类型（用量/价格/预算/快照/时段）
    clock.ts     时区日/月分桶（可注入时钟，可测）
    pricing.ts   定价表 + 计价（用户配置优先、内置兜底；按本地时刻选带 + 带内价覆盖）
    meter.ts     四维计量器 + 日/月窗口表 + 分带累计桶
    budget.ts    预算决策引擎（纯函数）
    store.ts     快照持久化契约
  harness/     # 薄适配层（唯一接触 DSH API 的地方）
    listener.ts   session/event → UsageEntry（实时计量，按事件时刻选带）
    guard.ts      agent/pre-step → reject/cancel（熔断）
    tool.ts       cost_guard_status 工具 + 人读摘要（当前时段/生效单价/分带分布）
  index.ts      插件装配（Config / apply）
  service.ts    CostGuardService 契约（inject 给其他插件）
tests/         单元测试（vitest）
scripts/smoke.mjs  冒烟测试（真实 lib 产物 + 真实 cordis Context）
```

数据流：

```
session/event ──► listener.ts ──► Meter/WindowMeter（实时累计）
                                        │
agent/pre-step ◄─ guard.ts ◄── BudgetEvaluator ◄─ 各 scope 已花费
      ▾  reject + cancel              │
   模型请求被阻断                 cost_guard_status 工具 / ctx.costGuard 服务
```

## 二次开发

```bash
npm install        # 安装依赖（Node ≥ 22.19）
npm run typecheck  # 类型检查
npm test           # 单元测试（vitest）
npm run build      # 产出 lib/（tsc + 类型声明）
npm run smoke      # 冒烟测试：加载 lib 产物跑真实链路
npm pack           # 发布包预检
```

- 新增价格口径：改 `core/pricing.ts` 的 `BUILTIN_PRICES`，规则为"用户配置优先、内置兜底"。
- 新增峰谷时段：在配置 `bands` 中加 `{ id, start, end, prices }`，`pricing.ts` 的 `bandIdForEpoch` 负责选带、`priceForAt` 负责带内覆盖与回退（core 内已含 `inBand`/跨午夜/全天解析与单测）。
- 新增预算维度：扩展 `core/types.ts` 的 `BudgetScope`，并在 `budget.ts` 的 `policiesFromConfig` 注册顺序。
- 新增事件消费：在 `harness/` 加适配器，领域逻辑放 `core/`，保持核心零 DSH 依赖。
- 持久化：`core/store.ts` 定义 `CostSnapshot` 形状（含 `bands` 分带分布）；接入 `ctx.costGuard` 服务即可跨重启恢复。

## 与现有方案对比

| 方案 | 形态 | 实时性 | 阻断能力 | 进程内 |
| --- | --- | --- | --- | --- |
| whale-report | 事后报告插件 | 无（轮次结束后） | 无 | 是 |
| Token Monitor | 外部桌面工具 | 弱（外挂采集） | 无 | 否 |
| OTel / 按量计费网关 | 外部上报链路 | 中（链路延迟） | 无/网关级 | 否 |
| **dsh-cost-guard** | **原生插件** | **逐 token 调用计量** | **请求前熔断** | **是** |

## License

MIT