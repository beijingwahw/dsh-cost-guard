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
import { DEFAULT_TZ_OFFSET_MIN } from './core/clock.js'
import { CostTrail } from './core/trail.js'
import { MadDetector } from './core/anomaly.js'
import { CachePricingEngine } from './core/cache-pricing.js'
import { CacheMetrics } from './core/cache-metrics.js'
import { CacheHintDetector, DEFAULT_HINT_CONFIG } from './core/cache-hint.js'
import type { PricingSource } from './core/cache-types.js'
import { attachMeters } from './harness/listener.js'
import { attachGuard, budgetInputFromMeter, type GuardHandle, type GuardMode } from './harness/guard.js'
import { attachCostTool, buildCostStatus, formatStatusSummary } from './harness/tool.js'
import { buildForecastContext, preStepEstimate, sampleEntry, type PredictiveRuntime } from './harness/predictive.js'
import { buildGovernorInput, governorConfigFromAdaptive, type AdaptiveConfig } from './harness/adaptive.js'
import { attachCacheMeter } from './harness/cache.js'

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
  /** 预测式治理（0.4.0，可选；缺省不启用，语义与 0.3.0 一致）。 */
  predictive?: {
    /** 到期投影：scope -> 预测成本 / limit 阈值。 */
    projections?: Partial<
      Record<
        string,
        {
          /** 展示名（如 '今日结束'/'月末'）。 */
          target?: string
          warnAt?: number
          hardAt?: number
        }
      >
    >
    /** 成本尖峰防护（MAD 检测）。 */
    spike?: { level?: 'spike' | 'extreme'; action?: 'warn' | 'block' }
    /** 请求级预检（发请求前按消息量估算成本，防烧穿）。 */
    preflight?: { mode?: 'min' | 'expected'; action?: 'warn' | 'block'; scope?: string }
    /** 自适应调节治理（0.5.0）：动态水位 + 今日额度耗尽动作。 */
    adaptive?: { scope?: 'session' | 'day' | 'month' | 'total'; onExhausted?: 'warn' | 'block' }
  }
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
    cache: Schema.object({
      enabled: Schema.boolean().default(false),
      priceOverride: Schema.object({
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
        ),
        global: Schema.object({
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
      }),
      hint: Schema.object({
        minRepeat: Schema.number().min(1).default(DEFAULT_HINT_CONFIG.minRepeat),
        minSaving: Schema.number().min(0).default(DEFAULT_HINT_CONFIG.minSaving),
      }),
      onParseFailure: Schema.union(['treat-as-miss'] as const).default('treat-as-miss'),
    }),
  }),
])

export function apply(ctx: Context, config: CostGuardConfig) {
  if (!config.enabled) return

  const logger = ctx.logger('cost-guard')
  const pricing = buildPricingTable(config.pricing as never)
  const bands = (config.bands ?? []).map((b) => ({ id: b.id, start: b.start, end: b.end, prices: b.prices as never }))
  const meter = new Meter(config.tzOffsetMin)
  const windows = new WindowMeter(config.tzOffsetMin)
  const evaluator = createBudgetEvaluator(
    policiesFromConfig(config.budgets),
    predictivePolicyFromConfig(config.predictive as PredictiveConfig | undefined),
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
  const governorCfg = governorConfigFromAdaptive(config.adaptive, config.budgets.month?.limit ?? 0)
  const adaptiveRuntime = {
    meter,
    windows,
    tzOffsetMin: config.tzOffsetMin,
  }
  const adaptiveInput = governorCfg
    ? (forecast?: NonNullable<Parameters<typeof buildGovernorInput>[2]>) =>
        buildGovernorInput(governorCfg, adaptiveRuntime, forecast)
    : undefined

  // 1) 实时计量（峰谷选带按事件本地时刻）+ 预测采样
  attachMeters(
    ctx,
    meter,
    windows,
    pricing,
    fallbackRoute,
    { bands, tzOffsetMin: config.tzOffsetMin },
    (entry, sessionId) => sampleEntry(runtime, entry, sessionId),
  )

  // 2) 熔断防护（含预测式治理上下文）
  let guard: GuardHandle = {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: () => evaluator.decide(budgetInputFromMeter(meter)),
  }
  guard = attachGuard(ctx, evaluator, meter, {
    mode: config.mode,
    cancelOnBlock: config.cancelOnBlock,
    predictive: predictivePolicyFromConfig(config.predictive as PredictiveConfig | undefined),
    forecastInput: () => buildForecastContext(runtime),
    adaptiveInput,
    estimateFromMessages: (chars) => preStepEstimate(chars, runtime),
    onViolation: (decision, scope) => {
      logger.warn(`[cost-guard] ${scope} 预算命中：${decision.action}`)
    },
  })

  // 2.5) 缓存维度计量（0.6.0；默认关闭零回归）
  const cacheEnabled = config.cache?.enabled === true
  const cachePricing = cacheEnabled ? new CachePricingEngine(config.cache?.priceOverride ?? {}) : undefined
  const statsCache: { metrics: CacheMetrics; hint: CacheHintDetector } | undefined = cacheEnabled
    ? {
        metrics: new CacheMetrics(),
        hint: new CacheHintDetector(cachePricing!, {
          minRepeat: config.cache?.hint?.minRepeat ?? DEFAULT_HINT_CONFIG.minRepeat,
          minSaving: config.cache?.hint?.minSaving ?? DEFAULT_HINT_CONFIG.minSaving,
        }),
      }
    : undefined
  if (cacheEnabled && cachePricing && statsCache) {
    attachCacheMeter(ctx, {
      tzOffsetMin: config.tzOffsetMin,
      pricing: cachePricing,
      metrics: statsCache.metrics,
      hint: statsCache.hint,
    })
  }

  // 3) 成本工具（含峰谷实时追踪 + 预测式治理展示 + 自适应与效率洞察）
  if (config.enableTool) {
    attachCostTool(ctx, meter, windows, evaluator, guard, {
      bands,
      baseline: pricing,
      tzOffsetMin: config.tzOffsetMin,
      predictive: { trail, detector },
      costSamples: detector,
      cache: statsCache,
    })
  }

  // 4) 启动摘要
  const predictiveCfg = config.predictive
  logger.info(
    '[cost-guard] 已启用：实时计量 + 峰谷计费(%s) + 预算熔断 (mode=%s)%s%s%s',
    bands.length > 0 ? `${bands.length} 个时段` : '未配置',
    config.mode,
    predictiveCfg ? ' + 预测式治理' : '',
    governorCfg ? ' + 自适应调节' : '',
    cacheEnabled ? ' + 缓存维度计量' : '',
  )

  // 暴露运行时状态供其他插件 / 面板读取
  const statusCtx = () => ({
    bands,
    baseline: pricing,
    tzOffsetMin: config.tzOffsetMin,
    predictive: { trail, detector },
    costSamples: detector,
    cache: statsCache,
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