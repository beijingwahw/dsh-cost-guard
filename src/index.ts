/**
 * dsh-cost-guard —— DeepSeek Harness 原生实时成本治理插件。
 *
 * 装配：
 *   1. 实时计量：监听 session/event，把每次模型调用的精确 usage 折算为话费（金额）
 *      与积分两类消耗，累计到 会话/日/月/总 四个维度与按路由明细。
 *   2. 峰谷计费：按事件发生的本地时刻选带（TimeBand），带内价格覆盖优先、
 *      未覆盖回退基准价；分带累计（全局 / 今日 / 本月）支持实时追踪。
 *   3. 预算防护：agent/pre-step 前检查预算水位，硬限熔断（reject + cancel），
 *      告警水位只提醒。模式可配置 off/warn/block。积分不参与熔断判定。
 *   4. 成本面板：cost_guard_status 工具 + 日志摘要，输出当前时段与生效单价，
 *      Agent 可自感知成本。
 *   5. 价格表：内置 DeepSeek 官方价，支持配置覆盖任意 provider/model 的金额、
 *      积分单价，以及按峰谷时段的独立价格覆盖。
 *
 * 安全默认：默认 mode=block（硬熔断）、cancelOnBlock=true，防止失控。
 * 如需纯观察，可配置 mode=off。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Meter, WindowMeter } from './core/meter.js'
import { createBudgetEvaluator, policiesFromConfig, predictivePolicyFromConfig, type PredictiveConfig } from './core/budget.js'
import { buildPricingTable } from './core/pricing.js'
import { buildOfficialPricingTable, buildOfficialCachePricingTable, ReasoningLedger, officialIdlePriceOf, officialCurrencyOf, OFFICIAL_MODEL_ALIASES } from './core/official-pricing.js'
import { DEFAULT_TZ_OFFSET_MIN } from './core/clock.js'
import { CostTrail } from './core/trail.js'
import { MadDetector } from './core/anomaly.js'
import { CachePricingEngine, HOLIDAYS_2026 } from './core/cache-pricing.js'
import { CacheMetrics } from './core/cache-metrics.js'
import { CacheHintDetector, DEFAULT_HINT_CONFIG } from './core/cache-hint.js'
import type { PricingSource } from './core/cache-types.js'
import { attachMeters } from './harness/listener.js'
import { attachGuard, budgetInputFromMeter, type GuardHandle, type GuardMode } from './harness/guard.js'
import { attachCostTool, buildCostStatus, formatStatusSummary } from './harness/tool.js'
import { buildForecastContext, preStepEstimate, sampleEntry, type PredictiveRuntime } from './harness/predictive.js'
import { buildGovernorInput, governorConfigFromAdaptive, type AdaptiveConfig } from './harness/adaptive.js'
import { attachCacheMeter } from './harness/cache.js'
import { FrontierRuntime, type FrontierConfigLike } from './harness/frontier.js'
import { ExplainRuntime, attachExplainTool } from './harness/explain.js'
import { attachAlertExplain } from './harness/alert.js'
import { TenantRuntime, attachTenantTool } from './harness/tenant.js'
import { ReasoningTaxRuntime, attachReasoningTaxTool } from './harness/reasoning-tax.js'
import { ReasoningTaxAuditRuntime, attachReasoningTaxAuditTool } from './harness/reasoning-tax-audit.js'
import { tenantResolverOf, type TenantResolveOptions } from './core/tenant.js'

export const name = 'cost-guard'

export interface CostGuardConfig {
  /** 开关。 */
  enabled: boolean
  /** 熔断模式：off | warn | block。 */
  mode: GuardMode
  /** 硬阻断时是否 cancel 当前轮次。 */
  cancelOnBlock: boolean
  /** 时区偏移（分钟），默认东八区。 */
  tzOffsetMin: number
  /** 模型价格覆盖：'provider/model' 或 'model' -> { inputPerMillion, cacheReadPerMillion, outputPerMillion, creditsPerMillion? }。 */
  pricing: Record<
    string,
    {
      inputPerMillion: number
      cacheReadPerMillion: number
      outputPerMillion: number
      /** 积分单价（每百万 token 消耗的积分），可选，未配置按 0 计。 */
      creditsPerMillion?: number
    }
  >
  /** 预算配置：limit(金额) / warnAt(0~1) / hardAt(0~1)。 */
  budgets: Record<
    string,
    {
      limit?: number
      warnAt?: number
      hardAt?: number
    }
  >
  /** 未识别路由时的默认归属（用于计价兜底）。 */
  fallbackProvider: string
  fallbackModel: string
  /** 峰谷时段配置：按本地时区划分计费时段，每个时段可带独立价格覆盖。 */
  bands?: Array<{
    id: string
    start: string
    end: string
    /** 该时段内按路由/模型的价格覆盖；未覆盖的路由回退基准价表。 */
    prices?: Record<
      string,
      {
        inputPerMillion: number
        cacheReadPerMillion: number
        outputPerMillion: number
        /** 积分单价（每百万 token 消耗的积分），可选，未配置按 0 计。 */
        creditsPerMillion?: number
      }
    >
  }>
  /** 是否注册只读成本工具。 */
  enableTool: boolean
  /** 是否输出启动摘要日志。 */
  verbose: boolean
  /**
   * 官方计价引擎（0.8.0，可选）：一键接入 DeepSeek 官方实际计价规则。
   * 启用后主计量自动挂载官方价目（flash / v4-pro 三通道）、官方峰谷
   * （工作日非法定节假日 9-12/14-18 高峰，其余空闲）、声明别名归一
   * （deepseek-v4-flash 等旧名按现行模型价计费），并独立采集推理 token（思维链）洞察。
   * 缺省不启用（enabled=false）——行为与 0.7.0 完全一致（零回归）。
   */
  officialPricing?: {
    enabled: boolean
    /**
     * 追加的法定节假日（YYYY-MM-DD，仅未来年度官方未发布时手动补充用；
     * 内置 2026 年节假日表自动并入）。缺省不追加。
     */
    holidays?: string[]
  }
  /** 预测式治理（0.4.0，可选；缺省不启用，语义与 0.3.0 一致）。 */
  predictive?: PredictiveConfig
  /** 自适应调节（0.5.0，可选）：月度→日额度动态派生 + 消费速率背压 + 跨周期结转。 */
  adaptive?: AdaptiveConfig
  /**
   * 缓存维度计量（0.6.0，可选）：三通道 × 峰谷定价、命中率 / 收益 / 前缀提示。
   * 默认关闭（enabled=false）——未配置或 disabled 时行为与 0.5.0 完全一致（零回归）。
   */
  cache?: {
    /** 是否启用缓存维度计量（默认 false）。 */
    enabled: boolean
    /** 三通道价格覆盖：路由级（'provider/model' 或裸 'model'）> 全局。 */
    priceOverride?: PricingSource
    /** 可优化前缀提示阈值。 */
    hint?: { minRepeat?: number; minSaving?: number }
    /**
     * 解析失败策略（当前固定为 'treat-as-miss'：按未命中计费并标注不确定；
     * 保留字段以隔离未来策略演进）。 */
    onParseFailure?: 'treat-as-miss'
  }
  /**
   * 前沿套件（0.12.0，可选；缺省不启用，语义与 0.11.0 完全一致）：
   * FOCUS 成本台账 / OpenTelemetry GenAI 遥测 / 单位经济学与成本归属 / 成本杠杆洞察。
   */
  frontier?: FrontierConfigLike
  /**
   * 成本根因与可解释叙事（0.14.0，可选）：对当前计量快照做会话/路由双视角
   * 根因归因（增量贡献分解），并输出人类与 Agent 可读的中文成本叙事
   * （总览/因子/建议）。缺省不启用（enabled=false）——行为与 0.13.0 完全一致（零回归）。
   *
   * alert（0.15.0，可选）：根因解释接入告警通知——Guard 触发告警/熔断时，
   * 同一条通知输出「为什么超」的告警根因叙事（scope/水位/Δ + 会话/路由主因 +
   * 建议）。缺省不启用（enabled=false）——行为与 0.14.0 完全一致（零回归）。
   */
  explain?: {
    enabled: boolean
    alert?: {
      enabled?: boolean
    }
  }
  /**
   * 多租户成本解释视图（0.16.0，可选）：把成本归因从会话/路由双视角扩展出
   * 租户（团队/项目/工作区）维度——按租户聚合会话成本，租户间做增量贡献分解，
   * 每个主因租户再下钻到内部主因会话（两级证据链），并输出中文叙事。
   * 缺省不启用（enabled=false）——行为与 0.15.0 完全一致（零回归）。
   *
   * resolve（可选）：sessionId -> 租户 的解析规则（优先级 mapping > prefix > regex），
   * 未命中兜底 defaultTenant（默认 'default'）；不提供 resolve 时全部归 defaultTenant。
   */
  tenant?: {
    enabled: boolean
    resolve?: TenantResolveOptions
  }
  /**
   * 推理成本专项治理（0.17.0，可选）：把 DeepSeek 的推理 token（思维链/思考）作为
   * 独立的隐藏成本维度治理——按路由聚合推理 token 与可见输出，估算「思考税」
   * （taxRatio 与税成本，官方口径推理 token 按输出价计费），提供独立的推理税预算
   * 水位（ok/warn/block）与中文治理建议（思考预算压缩 / 路由降级 / 切换非推理模型）。
   * 缺省不启用（enabled=false）——行为与 0.16.0 完全一致（零回归）。
   *
   * budget（可选）：推理税独立预算（limit 金额 / warnAt 告警水位 0~1 / hardAt
   * 阻断水位 0~1）。未配置 budget 时仅做洞察展示，不做水位判定。
   */
  reasoningTax?: {
    enabled: boolean
    budget?: {
      limit?: number
      warnAt?: number
      hardAt?: number
    }
  }
  /**
   * 多维思考税审计（0.18.0，可选）：在 0.17.0 推理成本专项治理的路由归因之上，
   * 新增「会话维度 Top N 排行 + 时间热力桶」双切片审计——回答「哪个会话在烧
   * 思考税 / 一天中何时烧得最集中」，并给出中文审计叙事（主因会话、热力峰值、
   * 会话思考预算收敛 / 热点错峰 / 时段预算护栏）。
   * 缺省不启用（enabled=false）——行为与 0.17.0 完全一致（零回归）。
   *
   * bucketMinutes（可选）：时间桶时长（分钟），默认 60。
   * heatBuckets（可选）：热力序列保留的最近桶数，默认 24。
   * sessionTopN（可选）：会话排行保留条数，默认 5。
   */
  reasoningTaxAudit?: {
    enabled: boolean
    bucketMinutes?: number
    heatBuckets?: number
    sessionTopN?: number
  }
}

/**
 * 将对象 schema 的缺省输入置为 undefined。
 *
 * schemastery 的 object 类型构造时会把 meta.default 设为 {}，导致「整块配置未提供」
 * 的输入被 clone 成 {} 后继续递归校验内部字段，最终误报 missing required value
 * （0.5.0 存量配置无 cache 字段即触发此缺陷）。显式把缺省值设为 undefined 后，
 * resolver 的 isNullable(fallback) 分支直接短路、输出 undefined，语义为
 * 「对象整体可选；一旦提供，内部 required 字段必须给全」。类型签名不接受
 * undefined，故在此做一次受控投影并注明原因。
 *
 * @example
 * cache: optionalObject(Schema.object({ ... }))
 */
function optionalObject<S, T>(schema: Schema<S, T>): Schema<S, T | undefined> {
  return (schema as unknown as { default(value: undefined): Schema<S, T | undefined> }).default(undefined)
}

export const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true),
    mode: Schema.union(['off', 'warn', 'block'] as const).default('block'),
    cancelOnBlock: Schema.boolean().default(true),
    tzOffsetMin: Schema.number().default(DEFAULT_TZ_OFFSET_MIN),
  }),
  Schema.object({
    pricing: Schema.dict(
      Schema.object({
        inputPerMillion: Schema.number().required(),
        cacheReadPerMillion: Schema.number().default(0),
        outputPerMillion: Schema.number().required(),
        creditsPerMillion: Schema.number().min(0).default(0),
      }),
    ).default({}),
    budgets: Schema.dict(
      Schema.object({
        limit: Schema.number().min(0).default(0),
        warnAt: Schema.number().min(0).max(1).default(0.8),
        hardAt: Schema.number().min(0).max(1).default(1),
      }),
    ).default({}),
    bands: Schema.array(
      Schema.object({
        id: Schema.string().required(),
        start: Schema.string().required(),
        end: Schema.string().required(),
        prices: Schema.dict(
          Schema.object({
            inputPerMillion: Schema.number().required(),
            cacheReadPerMillion: Schema.number().default(0),
            outputPerMillion: Schema.number().required(),
            creditsPerMillion: Schema.number().min(0).default(0),
          }),
        ).default({}),
      }),
    ).default([]),
    fallbackProvider: Schema.string().default('deepseek'),
    fallbackModel: Schema.string().default('deepseek-chat'),
  }),
  Schema.object({
    enableTool: Schema.boolean().default(true),
    verbose: Schema.boolean().default(true),
    predictive: Schema.object({
      projections: Schema.dict(
        Schema.object({
          target: Schema.string(),
          warnAt: Schema.number().min(0).max(1).default(0.8),
          hardAt: Schema.number().min(0).max(1).default(1),
        }),
      ).default({}),
      spike: Schema.object({
        level: Schema.union(['spike', 'extreme'] as const).default('spike'),
        action: Schema.union(['warn', 'block'] as const).default('warn'),
      }),
      preflight: Schema.object({
        mode: Schema.union(['min', 'expected'] as const).default('expected'),
        action: Schema.union(['warn', 'block'] as const).default('block'),
        scope: Schema.union(['session', 'day', 'month', 'total'] as const).default('total'),
      }),
      adaptive: Schema.object({
        scope: Schema.union(['session', 'day', 'month', 'total'] as const).default('day'),
        onExhausted: Schema.union(['warn', 'block'] as const).default('warn'),
      }),
    }),
    adaptive: Schema.intersect([
      Schema.object({
        reserveRatio: Schema.number().min(0).max(1).default(0.1),
        backpressure: Schema.number().min(0).max(1).default(0.5),
        floorRatio: Schema.number().min(0).max(1).default(0.3),
        carryOverRatio: Schema.number().min(0).max(1).default(1),
      }),
      Schema.object({
        monthLimit: Schema.number().min(0),
      }),
    ]),
    cache: optionalObject(Schema.object({
      enabled: Schema.boolean().default(false),
      priceOverride: optionalObject(Schema.object({
        byRoute: Schema.dict(
          Schema.object({
            idle: Schema.object({
              inputHit: Schema.number().min(0).required(),
              inputMiss: Schema.number().min(0).required(),
              output: Schema.number().min(0).required(),
            }),
            peak: Schema.object({
              inputHit: Schema.number().min(0).required(),
              inputMiss: Schema.number().min(0).required(),
              output: Schema.number().min(0).required(),
            }),
          }),
        ).default({}),
        global: optionalObject(Schema.object({
          idle: Schema.object({
            inputHit: Schema.number().min(0).required(),
            inputMiss: Schema.number().min(0).required(),
            output: Schema.number().min(0).required(),
          }),
          peak: Schema.object({
            inputHit: Schema.number().min(0).required(),
            inputMiss: Schema.number().min(0).required(),
            output: Schema.number().min(0).required(),
          }),
        })),
      })),
      hint: optionalObject(Schema.object({
        minRepeat: Schema.number().min(1).default(DEFAULT_HINT_CONFIG.minRepeat),
        minSaving: Schema.number().min(0).default(DEFAULT_HINT_CONFIG.minSaving),
      })),
      onParseFailure: Schema.union(['treat-as-miss'] as const).default('treat-as-miss'),
    })),
    officialPricing: optionalObject(Schema.object({
      enabled: Schema.boolean().default(false),
      holidays: Schema.array(Schema.string()).default([]),
    })),
    frontier: optionalObject(Schema.object({
      focus: optionalObject(Schema.object({
        enabled: Schema.boolean().default(false),
      })),
      otel: optionalObject(Schema.object({
        enabled: Schema.boolean().default(false),
      })),
      unitEconomy: Schema.boolean().default(false),
      leverage: Schema.boolean().default(false),
    })),
    explain: optionalObject(
      Schema.object({
        enabled: Schema.boolean().default(false),
        alert: optionalObject(
          Schema.object({
            enabled: Schema.boolean().default(false),
          }),
        ),
      }),
    ),
    tenant: optionalObject(
      Schema.object({
        enabled: Schema.boolean().default(false),
        resolve: optionalObject(
          Schema.object({
            mapping: Schema.dict(Schema.string()),
            prefix: Schema.dict(Schema.string()),
            regex: optionalObject(
              Schema.object({
                source: Schema.string().required(),
                flags: Schema.string().default(''),
              }),
            ),
          }),
        ),
      }),
    ),
    reasoningTax: optionalObject(
      Schema.object({
        enabled: Schema.boolean().default(false),
        budget: optionalObject(
          Schema.object({
            limit: Schema.number().min(0),
            warnAt: Schema.number().min(0).max(1).default(0.8),
            hardAt: Schema.number().min(0).max(1).default(1),
          }),
        ),
      }),
    ),
    reasoningTaxAudit: optionalObject(
      Schema.object({
        enabled: Schema.boolean().default(false),
        bucketMinutes: Schema.number().min(1).max(1440).default(60),
        heatBuckets: Schema.number().min(1).max(168).default(24),
        sessionTopN: Schema.number().min(1).max(50).default(5),
      }),
    ),
  }),
])

export function apply(ctx: Context, config: CostGuardConfig) {
  if (!config.enabled) return

  const logger = ctx.logger('cost-guard')
  // 官方计价引擎（0.8.0）：缺省关闭 = 零回归；启用后主计量并入官方价/峰谷/别名/推理洞察
  const officialEnabled = config.officialPricing?.enabled === true
  const officialHolidays = new Set<string>([...HOLIDAYS_2026, ...(config.officialPricing?.holidays ?? [])])
  const pricing = officialEnabled ? buildOfficialPricingTable(config.pricing) : buildPricingTable(config.pricing)
  const bands = (config.bands ?? []).map((b) => ({
    id: b.id,
    start: b.start,
    end: b.end,
    ...(b.prices !== undefined ? { prices: b.prices } : {}),
  }))
  const meter = new Meter(config.tzOffsetMin)
  const windows = new WindowMeter(config.tzOffsetMin)
  const evaluator = createBudgetEvaluator(
    policiesFromConfig(config.budgets),
    predictivePolicyFromConfig(config.predictive),
  )

  // 预测式治理运行时（0.4.0）：成本轨迹 + MAD 尖峰检测器
  const trail = new CostTrail()
  const detector = new MadDetector()
  const fallbackRoute = { provider: config.fallbackProvider, model: config.fallbackModel }
  const runtime: PredictiveRuntime = {
    trail,
    detector,
    meter,
    pricing,
    fallbackRoute,
    tzOffsetMin: config.tzOffsetMin,
  }

  // 自适应调节（0.5.0）：月度额度缺省回退 budgets.month.limit
  const governorCfg = governorConfigFromAdaptive(config.adaptive, config.budgets['month']?.limit ?? 0)
  const adaptiveRuntime = {
    meter,
    windows,
    tzOffsetMin: config.tzOffsetMin,
  }
  const adaptiveInput = governorCfg
    ? (forecast?: NonNullable<Parameters<typeof buildGovernorInput>[2]>) =>
        buildGovernorInput(governorCfg, adaptiveRuntime, forecast)
    : undefined

  // 推理 token（思维链）取价器：用户输出价覆盖 > 官方空闲输出价（估算口径，
  // 与结算略有偏差时按官方价为准）。供 reasoning 账本（0.8.0）与推理税治理
  // （0.17.0）共用；无官方价时返回 0（成本不臆造）。
  const outputPriceOf = (model: string): number => {
    const byModel = config.pricing[model]?.outputPerMillion
    if (byModel !== undefined) return byModel
    for (const [k, v] of Object.entries(config.pricing)) {
      if (k.endsWith(`/${model}`) && v.outputPerMillion !== undefined) return v.outputPerMillion
    }
    return officialIdlePriceOf(model)?.outputPerMillion ?? 0
  }
  // 推理 token（思维链）账本（0.8.0）：官方口径推理 token 按输出价计费。
  const reasoning = officialEnabled ? new ReasoningLedger(outputPriceOf) : undefined

  // 前沿套件（0.12.0）：FOCUS 台账 / OTel 遥测 / 单位经济学 / 成本杠杆。
  // 缺省不启用（frontier 未配置时 runtime 整体 undefined = 零回归）。
  // 币种解析：官方注册表已知模型按其官方币种（DeepSeek/国内 CNY、海外 USD），
  // 未注册的兜底路由默认 CNY（与官方计价引擎口径一致，不跨币种换算）。
  const frontier = config.frontier
    ? new FrontierRuntime(config.frontier, { currencyOf: (routeKey) => officialCurrencyOf(routeKey.split('/')[1] ?? routeKey) ?? 'CNY' })
    : undefined

  // 成本根因与可解释叙事（0.14.0）：会话/路由双视角增量归因 + 中文叙事。
  // 缺省不启用（explain 未配置时 runtime 整体 undefined = 零回归）。
  const explainEnabled = config.explain?.enabled === true
  const explain = explainEnabled ? new ExplainRuntime(meter) : undefined

  // 根因解释接入告警通知（0.15.0）：Guard 告警/熔断触发时，
  // 同一条通知输出「为什么超」的告警根因叙事（core/alert-explain.ts）。
  // 缺省不启用（explain.alert 未配置时整体 undefined = 与 0.14.0 一致零回归）。
  const explainAlarmEnabled = explainEnabled && config.explain?.alert?.enabled === true
  const explainAlarm = explainAlarmEnabled && explain !== undefined ? attachAlertExplain(ctx, explain) : undefined

  // 多租户成本解释视图（0.16.0）：在会话/路由双视角之外扩展租户（团队/项目/工作区）
  // 维度——按租户聚合会话成本，租户间增量归因 + 租户内主因会话两级证据链 + 中文叙事。
  // 缺省不启用（tenant 未配置或 enabled=false 时 runtime 整体 undefined = 零回归）。
  const tenantEnabled = config.tenant?.enabled === true
  const tenant = tenantEnabled ? new TenantRuntime(meter, tenantResolverOf(config.tenant?.resolve)) : undefined

  // 推理成本专项治理（0.17.0）：独立账本按路由聚合推理 token / 可见输出，
  // 按输出价估算「思考税」（推理 token 常为可见输出 5~20 倍，是账单里最大的
  // 隐藏成本），输出思考税占比、独立推理税预算水位（ok/warn/block）与中文
  // 治理建议（思考预算压缩 / 路由降级 / 切换非推理模型）。与 reasoning 账本
  // 独立计数、互不依赖；缺省不启用（reasoningTax 未配置或 enabled=false 时
  // runtime 整体 undefined = 零回归）。预算 limit > 0 时启用独立水位判定，
  // 否则仅做洞察（无水位判定）。
  const reasoningTaxEnabled = config.reasoningTax?.enabled === true
  const rawTaxBudget = config.reasoningTax?.budget
  const reasoningTaxBudget =
    rawTaxBudget !== undefined && (rawTaxBudget.limit ?? 0) > 0
      ? {
          limit: rawTaxBudget.limit ?? 0,
          warnAt: rawTaxBudget.warnAt ?? 0.8,
          hardAt: rawTaxBudget.hardAt ?? 1,
        }
      : undefined
  const reasoningTax = reasoningTaxEnabled ? new ReasoningTaxRuntime(outputPriceOf, reasoningTaxBudget) : undefined

  // 多维思考税审计（0.18.0）：在 0.17.0 路由归因之上新增「会话维度 Top N 排行 +
  // 时间热力桶」双切片审计——回答「哪个会话在烧思考税 / 一天中何时烧得最集中」，
  // 输出中文审计叙事（主因会话 / 热力峰值 / 会话收敛与错峰建议）。缺省不启用
  // （reasoningTaxAudit 未配置或 enabled=false 时 runtime 整体 undefined = 零回归）。
  const reasoningTaxAuditEnabled = config.reasoningTaxAudit?.enabled === true
  const reasoningTaxAudit = reasoningTaxAuditEnabled
    ? new ReasoningTaxAuditRuntime(outputPriceOf, {
        ...(config.reasoningTaxAudit?.bucketMinutes !== undefined
          ? { bucketMinutes: config.reasoningTaxAudit.bucketMinutes }
          : {}),
        ...(config.reasoningTaxAudit?.heatBuckets !== undefined
          ? { heatBuckets: config.reasoningTaxAudit.heatBuckets }
          : {}),
        ...(config.reasoningTaxAudit?.sessionTopN !== undefined
          ? { sessionTopN: config.reasoningTaxAudit.sessionTopN }
          : {}),
      })
    : undefined

  // 1) 实时计量（峰谷选带按事件本地时刻）+ 预测采样 + 推理账本 + 前沿台账/遥测
  attachMeters(
    ctx,
    meter,
    windows,
    pricing,
    fallbackRoute,
    {
      bands,
      tzOffsetMin: config.tzOffsetMin,
      ...(officialEnabled ? { official: { enabled: true, overrides: config.pricing, holidays: officialHolidays } } : {}),
    },
    (entry, sessionId) => {
      sampleEntry(runtime, entry, sessionId)
      reasoning?.append(entry)
      reasoningTax?.append(entry)
      reasoningTaxAudit?.append(entry, sessionId)
      frontier?.record(entry, sessionId)
    },
  )

  // 2) 熔断防护（含预测式治理上下文）
  let guard: GuardHandle = {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: () => evaluator.decide(budgetInputFromMeter(meter)),
  }
  const predictivePolicy = predictivePolicyFromConfig(config.predictive)
  guard = attachGuard(ctx, evaluator, meter, {
    mode: config.mode,
    cancelOnBlock: config.cancelOnBlock,
    ...(predictivePolicy !== undefined ? { predictive: predictivePolicy } : {}),
    forecastInput: () => buildForecastContext(runtime),
    ...(adaptiveInput !== undefined ? { adaptiveInput } : {}),
    estimateFromMessages: (chars) => preStepEstimate(chars, runtime),
    onViolation: (decision, scope) => {
      logger.warn(`[cost-guard] ${scope} 预算命中：${decision.action}`)
      // 告警根因解释（0.15.0；仅 explain.alert.enabled=true 时挂载，未启用时零回归）：
      // 同一条通知追加「为什么超」的告警根因叙事（scope/水位/Δ + 会话/路由主因 + 建议），
      // 由 explainAlarm.notify 合成并经宿主 onExplainAlarm 回调转发（未配置回调时仅落日志）。
      const alarmLines = explainAlarm?.notify(decision, scope)
      if (alarmLines !== undefined && alarmLines.length > 0) {
        for (const line of alarmLines) {
          logger.warn(`[cost-guard] 告警根因：${line}`)
        }
      }
    },
  })

  // 2.5) 缓存维度计量（0.6.0；默认关闭零回归）
  /**
   * cache.enabled=false（默认）时整个块不构造任何缓存运行时：
   * pricing / metrics / hint 均为 undefined，与 0.5.0 行为完全一致（零回归）。
   */
  const cacheEnabled = config.cache?.enabled === true
  const cacheRuntime = cacheEnabled
    ? (() => {
        // 官方计价启用时，缓存引擎同步获得模型名别名归一（旧名按现行模型价计费）
        // 与官方多厂商三通道缓存表（0.10.0：DeepSeek dsn-peak 峰谷×2、其余厂商 flat 恒定价；
        // 未启用官方计价时第三参缺省 = 0.9.0 行为，零回归）
        const pricing = new CachePricingEngine(
          config.cache?.priceOverride ?? {},
          officialEnabled ? OFFICIAL_MODEL_ALIASES : {},
          officialEnabled ? buildOfficialCachePricingTable() : {},
        )
        return {
          pricing,
          metrics: new CacheMetrics(),
          hint: new CacheHintDetector(pricing, {
            minRepeat: config.cache?.hint?.minRepeat ?? DEFAULT_HINT_CONFIG.minRepeat,
            minSaving: config.cache?.hint?.minSaving ?? DEFAULT_HINT_CONFIG.minSaving,
          }),
        }
      })()
    : undefined
  if (cacheRuntime) {
    attachCacheMeter(ctx, {
      tzOffsetMin: config.tzOffsetMin,
      pricing: cacheRuntime.pricing,
      metrics: cacheRuntime.metrics,
      hint: cacheRuntime.hint,
    })
  }

  // 3) 成本工具（含峰谷实时追踪 + 预测式治理展示 + 自适应与效率洞察 + 官方计价段 + 前沿套件 + 根因解释）
  if (config.enableTool) {
    attachCostTool(ctx, meter, windows, evaluator, guard, {
      bands,
      baseline: pricing,
      tzOffsetMin: config.tzOffsetMin,
      predictive: { trail, detector },
      costSamples: detector,
      ...(cacheRuntime !== undefined ? { cache: cacheRuntime } : {}),
      ...(officialEnabled
        ? {
            official: {
              enabled: true,
              overrides: config.pricing,
              holidays: officialHolidays,
              ...(reasoning !== undefined ? { reasoning } : {}),
            },
          }
        : {}),
      ...(frontier !== undefined ? { frontier } : {}),
      ...(explain !== undefined ? { explain } : {}),
      ...(tenant !== undefined ? { tenant } : {}),
      ...(reasoningTax !== undefined ? { reasoningTax } : {}),
      ...(reasoningTaxAudit !== undefined ? { reasoningTaxAudit } : {}),
    })
    // 成本根因与可解释叙事工具（0.14.0；仅 explain.enabled=true 时注册）
    if (explain !== undefined) {
      attachExplainTool(ctx, explain)
    }
    // 多租户成本解释视图工具（0.16.0；仅 tenant.enabled=true 时注册）
    if (tenant !== undefined) {
      attachTenantTool(ctx, tenant)
    }
    // 推理成本专项治理工具（0.17.0；仅 reasoningTax.enabled=true 时注册）
    if (reasoningTax !== undefined) {
      attachReasoningTaxTool(ctx, reasoningTax)
    }
    // 多维思考税审计工具（0.18.0；仅 reasoningTaxAudit.enabled=true 时注册）
    if (reasoningTaxAudit !== undefined) {
      attachReasoningTaxAuditTool(ctx, reasoningTaxAudit)
    }
  }

  // 4) 启动摘要
  const predictiveCfg = config.predictive
  logger.info(
    '[cost-guard] 已启用：实时计量 + 峰谷计费(%s) + 预算熔断 (mode=%s)%s%s%s%s%s%s%s%s%s%s',
    bands.length > 0 ? `${bands.length} 个时段` : officialEnabled ? '官方峰谷(自动)' : '未配置',
    config.mode,
    predictiveCfg ? ' + 预测式治理' : '',
    governorCfg ? ' + 自适应调节' : '',
    cacheEnabled ? ' + 缓存维度计量' : '',
    officialEnabled ? ' + 官方计价引擎' : '',
    frontier?.any ? ` + 前沿套件(${frontier.focus ? 'FOCUS,' : ''}${frontier.otel ? 'OTel,' : ''}${frontier.unitEconomy ? '单位经济,' : ''}${frontier.leverage ? '杠杆' : ''})` : '',
    explainEnabled ? ' + 成本根因解释' : '',
    explainAlarmEnabled ? ' + 告警根因通知' : '',
    tenantEnabled ? ' + 多租户成本视图' : '',
    reasoningTaxEnabled ? ' + 推理税治理' : '',
    reasoningTaxAuditEnabled ? ' + 多维思考税审计' : '',
  )

  // 暴露运行时状态供其他插件 / 面板读取
  const statusCtx = () => ({
    bands,
    baseline: pricing,
    tzOffsetMin: config.tzOffsetMin,
    predictive: { trail, detector },
    costSamples: detector,
    ...(cacheRuntime !== undefined ? { cache: cacheRuntime } : {}),
    ...(officialEnabled
      ? {
          official: {
            enabled: true as const,
            overrides: config.pricing,
            holidays: officialHolidays,
            ...(reasoning !== undefined ? { reasoning } : {}),
          },
        }
      : {}),
    ...(frontier !== undefined ? { frontier } : {}),
    ...(explain !== undefined ? { explain } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    ...(reasoningTax !== undefined ? { reasoningTax } : {}),
    ...(reasoningTaxAudit !== undefined ? { reasoningTaxAudit } : {}),
  })
  ctx.provide('costGuard', {
    meter,
    windows,
    evaluator,
    guard,
    status: () => buildCostStatus(meter, windows, evaluator, guard, statusCtx()),
    summary: () => formatStatusSummary(buildCostStatus(meter, windows, evaluator, guard, statusCtx())),
  })
}

export { costGuardService } from './service.js'