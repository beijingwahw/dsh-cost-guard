# dsh-cost-guard

**DeepSeek Harness 原生「实时成本治理」插件** —— 用量实时计量、多维度预算、熔断防护、成本面板、预测式治理与自适应调节，全部在 Harness 进程内完成。

> 市面现有方案（whale-report 等）全是**事后形态**：跑完一轮才出报告，超支发生后才告诉你。`dsh-cost-guard` 是第一款**原生实时治理插件**：在 `agent/pre-step` 阶段拦下超预算的下一步请求，从源头上阻止模型继续烧钱。
>
> 0.4.0 把「事后治理」升级为**预测式治理（Predictive Governance）**：不止看"现在花了多少"，而是回答"**今天/本月会花多少、预算何时耗完、这一发请求会不会烧穿、你是不是遇到了成本尖峰**"——在超支发生之前拦截，而非之后追责。
>
> 0.5.0 再进一步 —— **自适应调节（Adaptive Governance）**：把预算从「静态配额」升级为「会自我调节的额度」。它是成本治理类插件中首个把**月度→日额度动态派生、消费速率背压动态水位、跨周期结转**与预算决策闭环打通的产品级实现：花得快就自动收紧今天的额度、花得稳就留给你更多空间，上个月省下来的变成下个月可用的池子；同时新增**成本效率洞察（Cost Efficiency Intelligence）**，回答"花得值不值"——每千输出 token 成本、单请求成本分布（P50/P95/Max 长尾识别）与路由替代节约估算，把省钱建议直接给出。

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
| **超支预警** | 事后账单才知道 | **预测式治理**：轨迹外推 → 预测今日/月末花费，超支前提前熔断 |
| **单发防护** | 无 | **请求级预检**：发请求前按消息量估算成本，防止单发烧穿预算 |
| **异常感知** | 月结才发现 | **MAD 成本尖峰检测**：稳健离群识别，尖峰请求即刻分级告警/熔断 |
| **预算僵化** | 月初猛花月底干瞪眼 / 限死冗余 | **自适应调节**：月→日额度动态派生 + 消费速率背压 + 跨周期结转 |
| **效率盲区** | 只知花了多少，不知花得值不值 | **效率洞察**：每千输出 token 成本、请求成本分布、路由替代节约建议 |

实时计量的关键是 DSH 的事件闭环：`session/event`（`assistant/message.usage` + `request/header.config`）提供**逐次调用的精确 token 用量与路由**；`agent/pre-step`（waterfall）提供**阻止下一步模型请求**的唯一干净位置。本插件把这两者接成一条防护链，并叠加预测引擎与自适应调节器构成「事后 + 事前 + 动态」三层治理。

## 特性

- **实时计量**：订阅 `session/event`，把每次调用的精确 usage 按路由价格折算金额，累计到 total / day / month / session 四个维度 + 按 `provider/model` 明细。
- **峰谷计费 + 实时追踪**：支持按本地时区定义任意数量计费时段（如 peak 09:00-18:00、valley 22:00-次日 08:00，支持跨午夜与全天覆盖），每个时段可独立覆盖各模型单价；每次调用按事件发生时刻自动选带定价，未命中时段回退基准价。成本工具/摘要实时输出当前时段、当前时段各模型生效单价、全局/今日分带消耗分布。
- **话费 + 积分双维度统计**：每个模型可独立配置积分单价（`creditsPerMillion`），计费 token 自动折算积分，与金额独立累计、独立展示（`总花费 X · 总积分 Y`)；未配置积分单价的模型积分按 0 计，不遗漏任何被调用的模型。
- **多维预算熔断**：session / day / month / total 各自独立配置 `limit`（金额上限）、`warnAt`（告警水位）、`hardAt`（阻断水位）。命中硬限 → 在 `agent/pre-step` 返回 `{kind:'reject'}` 并调用 `agent.cancel({kind:'hook'})` 终止轮次；命中告警 → 只记日志。积分仅统计展示，不影响熔断判定。
- **预测式治理（0.4.0 新增，默认关闭，零回归）**：
  - **到期成本投影（Projection）**：为每次调用维护「时刻 → 累计成本」轨迹，用最小二乘线性趋势（≥2 观测点）或固定速率模型（单观测点）外推**今日结束 / 本月底**的预计花费，给出置信区间与置信度；预测成本触及水位即**提前告警/熔断**——不等真超支，先按趋势拦截。
  - **Time-to-Exhaustion（预算耗尽时间）**：按当前速率计算预算剩余可用时长，回答"还能撑多久"。
  - **请求级预检（Preflight）**：在每个 `agent/pre-step`，按本轮消息序列的字符量启发式估算本次调用成本（输入 + 按比例预估输出），若"已花 + 本次估算 ≥ 指定预算"则在**请求发出之前**拒绝对话轮——连串中等请求也无法悄悄透支。
  - **成本尖峰检测（MAD）**：对每次请求成本维护滑动窗口，用稳健 MAD（中位数绝对偏差）估计基准，修正 z 分数分级 `normal / spike / extreme`；异常尖峰即刻触达告警或硬熔断（抗单点污染，少量大请求不污染基准）。
- **自适应调节治理（0.5.0 新增，默认关闭，零回归）**：
  - **月度 → 日额度动态派生（Derivation）**：给定月预算、月内已花费与剩余天数，按 `剩余可用 × (1-留存) ÷ 剩余天数` 动态算出「今天还能花多少」，月末没用完的额度折算进剩余天数，反之亦然——无需逐日手配。
  - **消费速率背压动态水位（Backpressure）**：喂入预测引擎的「今日结束 / 月末结束」预测成本，若预测超支，按超支比例自动**收紧**今日额度与告警/阻断水位（背压），预测越险、水位越低、越早熔断；预测从容时适度放开——"花得快就紧，花得稳就松"。
  - **跨周期结转（Carry-over）**：本月未用完的预算按 `carryOverRatio` 结转为下月可用池（`carriedIn`），"上个月省下来的"变成"这个月可以用的"，而不是被清零浪费。
  - **成本感知 cue（calm / frugal / minimal）**：每次决策输出当前成本姿态——平静（从容）/ 节约（收紧中）/ 最小化（今日额度已耗尽），模型与用户一眼看懂"现在该不该省"；今日动态额度耗尽时按 `onExhausted` 告警或熔断本周期。
- **成本效率洞察（0.5.0 新增）**：
  - **每千输出 token 成本**：输出是推理质量的主要载体，按路由给出「每千输出 token 花了多少」，识别"贵在哪儿"。
  - **单请求成本分布**：以单次请求成本样本（窗口内）计算 **P50 / P95 / Max / Avg**，揪出拖垮预算的长尾请求。
  - **路由替代节约估算**：用当前路由的累计用量（input+output token）按更便宜路由的单价重算，给出可执行的「换用 X 预计可省 Y 元（约 Z%）」建议。
- **成本面板**：注册只读工具 `cost_guard_status`（模型可调用）与 `CostGuardService`（`ctx.costGuard`，其他插件可注入），并暴露人读摘要。0.4.0 起工具/摘要新增 `forecast` 段（今日/月末投影、置信区间、尖峰级别、预测式触发明细）；0.5.0 起新增 `adaptive` 段（动态额度/剩余/背压/动态水位/结转/cue）与 `efficiency` 段（每千输出成本、请求分布、替代节约建议）。
- **价格覆盖**：内置 DeepSeek 官方价（`deepseek-chat` / `deepseek-reasoner`），支持按 `provider/model` 或裸 `model` 覆盖，未识别路由走保守兜底价。
- **安全默认**：默认 `mode=block` 硬熔断 + `cancelOnBlock=true`；想纯观察可 `mode=off`（只计量不干预）。预测式治理与自适应调节默认不配置 = 行为与 0.3.0 完全一致。

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
    # 预测式治理（0.4.0，可选；不配置则行为与 0.3.0 完全一致）
    # - projections：到期投影（预测今日结束/月末花费，触及水位提前告警/熔断，支持 day/month 等）
    # - spike：成本尖峰防护（MAD 检测；level: spike(含extreme) | extreme；action: warn | block）
    # - preflight：请求级预检（每个 pre-step 按消息量估算本次成本，防单发烧穿；mode: min|expected；scope 默认 total）
    # - adaptive：自适应调节治理（0.5.0，需与下方 adaptive 节搭配；scope 默认 day，onExhausted 默认 warn）
    predictive:
      projections:
        day:   { target: 今日结束, warnAt: 0.8, hardAt: 1 }
        month: { target: 月末,     warnAt: 0.9, hardAt: 1 }
      spike: { level: extreme, action: warn }
      preflight: { mode: expected, action: block, scope: total }
      adaptive: { scope: day, onExhausted: warn }
    # 自适应调节（0.5.0，可选；不配置则行为与 0.4.0 完全一致）
    # - monthLimit：月预算上限，缺省回退 budgets.month.limit
    # - reserveRatio：日额度派生时预留的缓冲比例（只敢动用 90%）
    # - backpressure：预测超支时收紧的力度（0~1）
    # - floorRatio：日额度的下限比例（无论如何保留 30% 兜底）
    # - carryOverRatio：本月未用完中可结转到下月的比例
    adaptive:
      monthLimit: 500       # 缺省回退 budgets.month.limit
      reserveRatio: 0.1
      backpressure: 0.5
      floorRatio: 0.3
      carryOverRatio: 1
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
| `predictive` | object | 未配置 | 预测式治理（0.4.0，可选）：`projections`（到期投影阈值）、`spike`（尖峰防护）、`preflight`（请求级预检）、`adaptive`（0.5.0：`{ scope, onExhausted }`）；不配置则与 0.3.0 行为一致 |
| `adaptive` | object | 未配置 | 自适应调节（0.5.0，可选）：`monthLimit`（缺省回退 `budgets.month.limit`）、`reserveRatio`（默认 0.1）、`backpressure`（默认 0.5）、`floorRatio`（默认 0.3）、`carryOverRatio`（默认 1）；不配置则与 0.4.0 行为一致 |

## 使用效果

- 预算内：静默计量，Agent 调用 `cost_guard_status` 可自感知用量（含话费与积分两个维度）。
- 告警水位：`ctx.logger('cost-guard')` 输出 `session 预算达到 82% (8.2/10.0)` 并触发 `onViolation` 回调。
- 硬限命中：日志 `total 预算已耗尽 (20.0/10.0)，已熔断`，本轮模型请求被拒绝、轮次取消；调用方可继续但不会再产生模型费用。
- 状态摘要：`cost_guard_status` 与 `ctx.costGuard.summary()` 输出 `总花费 X · 总积分 Y`，今日/本月/本会话与主要路由行均附积分，任意被调用的模型都按各自积分单价入账。
- 峰谷实时追踪：配置 `bands` 后，每次调用按事件发生时刻的本地时间选带计价；摘要新增 `当前时段: peak (09:00-18:00)` 与 `今日分带: peak 6.00 元 / 积分 300 · valley 2.00 元 / 积分 100` 行；`cost_guard_status` 返回结构新增 `band`（当前时段 id/起止/判定时刻/时段表）、`activePrices`（当前时段各模型生效单价）、`bandTotals`（全局分带累计）与 `todayBands`（今日分带累计），模型可据此感知"现在贵不贵、贵多少"。
- 预测式治理（0.4.0）：配置 `predictive` 后——
  - 摘要新增预测行：`预测: 今日结束 ~12.50（置信 8.00..17.00）· 月末 ~380.00（置信 300.00..460.00）`；
  - 摘要新增尖峰行：`尖峰: 最近请求成本异常 (extreme)`；
  - 摘要新增预测式触发行：`预测式熔断: day 预测成本（今日结束）达 120% (60/50)，预测超限提前熔断`；
  - `cost_guard_status` 返回结构新增 `forecast` 段：`projections`（今日/月末投影与置信区间）、`spike`（最近请求级别）、`predictive`（预测式触发明细）、`samples`（轨迹采样点数）；
  - 请求级预检：每个 `agent/pre-step` 先按消息量估算本次成本，越线即 `reject + cancel`（日志含 `预测式熔断：请求预检...`）。
- 自适应调节（0.5.0）：配置 `adaptive` + `predictive.adaptive` 后——
  - 摘要新增自适应行：`自适应: 节约（今日额度 12.50 / 剩余 3.20 · 动态水位 70%/88% · 背压 82% · 月末预测剩余 120.00 · 下月结转 120.00）`，今日额度耗尽时追加 `自适应: 今日额度已耗尽，请降低调用频率`；
  - `cost_guard_status` 返回结构新增 `adaptive` 段：`scope` / `dayAllowance`（今日动态额度）/ `dayRemaining` / `pressure`（背压因子）/ `warnAt` / `hardAt`（动态水位）/ `projectedMonthRemaining` / `carryOver`（下月结转）/ `exhausted` / `cue`（calm/frugal/minimal）；
  - 动态水位实际参与决策：背压越强，day 预算的告警/阻断越早触发；今日额度耗尽时按 `onExhausted` 告警或熔断本周期。
- 成本效率洞察（0.5.0）：摘要新增效率行，如 `效率: 每千输出 token 成本最高 deepseek-reasoner 16.000 元（输出是质量杠杆）`、`分布: 单次请求成本 P50 1.00 · P95 8.00 · Max 30.00（5 次）` 与 `将 deepseek-reasoner 的用量切换到 deepseek-chat，预计可省 5.00 元（约 50%）`；`cost_guard_status` 返回结构新增 `efficiency` 段：`routes`（各路由每千输出成本与每百万 token 成本）/ `distribution`（P50/P95/Max/Avg）/ `replacement`（替代节约建议）。

## 架构

六边形架构，领域核心与 DSH 运行时解耦：

```
src/
  core/        # 零 DSH 依赖的纯领域层
    types.ts     领域类型（用量/价格/预算/快照/时段）
    clock.ts     时区日/月分桶 + 今日结束/月末时刻 + 本月剩余天数（可注入时钟，可测）
    math.ts      统计与数值工具（clamp / 排序 / 百分位插值）
    pricing.ts   定价表 + 计价（用户配置优先、内置兜底；按本地时刻选带 + 带内价覆盖）
    meter.ts     四维计量器 + 日/月窗口表 + 分带累计桶
    trail.ts     成本轨迹采样（时刻→累计，有序/幂等/有界，喂预测引擎）
    forecast.ts  预测引擎（OLS 线性趋势 + 固定速率双模型自动降级、置信区间、Time-to-Exhaustion）
    anomaly.ts   异常检测（滑动窗口 MAD 尖峰分级 + 请求级成本预检估算）
    governor.ts  自适应预算调节器（月→日额度派生 + 消费速率背压动态水位 + 跨周期结转）
    efficiency.ts 成本效率洞察（每千输出 token 成本 + 请求分布 P50/P95/Max + 路由替代节约估算）
    budget.ts    预算决策引擎（纯函数；0.4.0 预测式策略 projection/spike/preflight；0.5.0 自适应 adaptive 策略）
    store.ts     快照持久化契约
  harness/     # 薄适配层（唯一接触 DSH API 的地方）
    listener.ts   session/event → UsageEntry（实时计量，按事件时刻选带）+ 轨迹/尖峰采样
    predictive.ts 预测上下文装配（buildForecastContext / preStepEstimate / sampleEntry）
    adaptive.ts   自适应调节装配（governorConfigFromAdaptive / buildGovernorInput）
    guard.ts      agent/pre-step → reject/cancel（熔断）+ 请求级预检 + 预测式触发达告警 + 自适应输入注入
    tool.ts       cost_guard_status 工具 + 人读摘要（当前时段/生效单价/分带分布/预测尖峰/自适应/效率洞察）
  index.ts      插件装配（Config / apply）
  service.ts    CostGuardService 契约（inject 给其他插件）
tests/         单元测试（vitest，128 用例）
scripts/smoke.mjs  冒烟测试（真实 lib 产物 + 真实 cordis Context，9 节）
```

数据流：

```
session/event ──► listener.ts ──► Meter/WindowMeter（实时累计）
                        │
                        └──► CostTrail + MadDetector（轨迹采样 + 尖峰检测）
                                    │
        ――――――――――――――――――――――――┘
        ▼ 预测引擎（forecast.ts / anomaly.ts）
   buildForecastContext（投影 / 尖峰 / 预检估算）
        │
        ▼ 自适应调节器（governor.ts）
   buildGovernorInput（月→日额度 / 背压 / 结转 / 动态水位）
        │
agent/pre-step ◄─ guard.ts ◄── BudgetEvaluator（水位 + 预测式策略 + 自适应策略）
      ▾  reject + cancel              │
   模型请求被阻断                 cost_guard_status 工具 / ctx.costGuard 服务
                                     （forecast + adaptive + efficiency 段）
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
- 新增预测策略：`core/budget.ts` 的 `PredictivePolicy` 是纯声明（projection/spike/preflight），决策逻辑为纯函数，直接加单测；harness 侧只需在 `harness/predictive.ts` 提供对应的事实构造器（如新的投影目标时刻解析器）。
- 新增事件消费：在 `harness/` 加适配器，领域逻辑放 `core/`，保持核心零 DSH 依赖。
- 持久化：`core/store.ts` 定义 `CostSnapshot` 形状（含 `bands` 分带分布）；接入 `ctx.costGuard` 服务即可跨重启恢复。

## 与现有方案对比

| 方案 | 形态 | 实时性 | 阻断能力 | 进程内 | 事前治理 | 动态预算 |
| --- | --- | --- | --- | --- | --- | --- |
| whale-report | 事后报告插件 | 无（轮次结束后） | 无 | 是 | 无 | 无 |
| Token Monitor | 外部桌面工具 | 弱（外挂采集） | 无 | 否 | 无 | 无 |
| OTel / 按量计费网关 | 外部上报链路 | 中（链路延迟） | 无/网关级 | 否 | 无 | 无 |
| **dsh-cost-guard** | **原生插件** | **逐 token 调用计量** | **请求前熔断** | **是** | **预测外推 + 请求预检 + 尖峰检测** | **月→日额度派生 + 预测背压 + 跨周期结转** |

## 版本演进

| 版本 | 增量 |
| --- | --- |
| 0.1.0 | 实时计量 + 四维预算 + 请求前熔断 + 成本工具 |
| 0.2.0 | 峰值时段计费（实时追踪） |
| 0.3.0 | 话费 + 积分双维度统计 |
| 0.4.0 | 预测式治理（投影 / 预检 / 尖峰），单测 56→104，冒烟 7→8 节 |
| **0.5.0** | **自适应调节（月→日额度派生 / 背压水位 / 跨周期结转）+ 成本效率洞察（每千输出成本 / 请求分布 / 替代节约建议），单测 104→128，冒烟 8→9 节** |

0.5.0 的行业增量点（全部在 core 层零 DSH 依赖实现，默认关闭、未配置时与 0.4.0 语义完全一致）：

1. **费用自适应而不是配额僵化**：市面预算插件把 `day.limit` 当静态配额，月初猛花月底干瞪眼，或全程限死浪费冗余。0.5.0 把「今天还能花多少」变为动态派生：月剩余可用 ÷ 剩余天数，配合预测引擎的背压——花得快就紧、花得稳就松，预算自动跟随消费节奏。
2. **预测驱动的水位不是拍脑袋阈值**：静态 `warnAt/hardAt` 对所有人一刀切；0.5.0 的告警/阻断水位由当月消费速率与剩余天数实时计算，越接近月末、预测越险，水位自动下探，等于「预算越紧张，防线越靠前」。
3. **省下来的能结转，而不是归零清零**：本月末未用完 × `carryOverRatio` 结转为次月 `carriedIn` 可用池，持续"奖励"节约行为，解决"月底不敢用、月初没得用"的周期性浪费。
4. **从"花了多少"到"花得值不值"**：每千输出 token 成本把质量与成本挂钩（输出是推理质量的载体），请求成本分布暴露长尾拖累，路由替代估算直接给出行得通的省钱动作，而非一句"请控制用量"。

## License

MIT