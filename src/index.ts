/**
 * dsh-cost-guard —— DeepSeek Harness 原生实时成本治理插件。
 *
 * 装配：
 *   1. 实时计量：监听 session/event，把每次模型调用的精确 usage 折算为成本，
 *      累计到 会话/日/月/总 四个维度与按路由明细。
 *   2. 预算防护：agent/pre-step 前检查预算水位，硬限熔断（reject + cancel），
 *      告警水位只提醒。模式可配置 off/warn/block。
 *   3. 成本面板：cost_guard_status 工具 + 日志摘要，Agent 可自感知成本。
 *   4. 价格表：内置 DeepSeek 官方价，支持配置覆盖任意 provider/model。
 *
 * 安全默认：默认 mode=block（硬熔断）、cancelOnBlock=true，防止失控。
 * 如需纯观察，可配置 mode=off。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Meter, WindowMeter } from './core/meter.js'
import { createBudgetEvaluator, policiesFromConfig } from './core/budget.js'
import { buildPricingTable } from './core/pricing.js'
import { DEFAULT_TZ_OFFSET_MIN } from './core/clock.js'
import { attachMeters } from './harness/listener.js'
import { attachGuard, type GuardHandle, type GuardMode } from './harness/guard.js'
import { attachCostTool, buildCostStatus, formatStatusSummary } from './harness/tool.js'

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
  /** 模型价格覆盖：'provider/model' 或 'model' -> { inputPerMillion, cacheReadPerMillion, outputPerMillion }。 */
  pricing: Record<string, { inputPerMillion: number; cacheReadPerMillion: number; outputPerMillion: number }>
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
  /** 是否注册只读成本工具。 */
  enableTool: boolean
  /** 是否输出启动摘要日志。 */
  verbose: boolean
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
      }),
    ).default({}),
    budgets: Schema.dict(
      Schema.object({
        limit: Schema.number().min(0).default(0),
        warnAt: Schema.number().min(0).max(1).default(0.8),
        hardAt: Schema.number().min(0).max(1).default(1),
      }),
    ).default({}),
    fallbackProvider: Schema.string().default('deepseek'),
    fallbackModel: Schema.string().default('deepseek-chat'),
  }),
  Schema.object({
    enableTool: Schema.boolean().default(true),
    verbose: Schema.boolean().default(true),
  }),
])

export function apply(ctx: Context, config: CostGuardConfig) {
  if (!config.enabled) return

  const logger = ctx.logger('cost-guard')
  const pricing = buildPricingTable(config.pricing as never)
  const meter = new Meter(config.tzOffsetMin)
  const windows = new WindowMeter(config.tzOffsetMin)
  const evaluator = createBudgetEvaluator(policiesFromConfig(config.budgets))

  // 1) 实时计量
  attachMeters(ctx, meter, windows, pricing, {
    provider: config.fallbackProvider,
    model: config.fallbackModel,
  })

  // 2) 熔断防护
  let guard: GuardHandle = {
    lastDecision: { action: 'allow', triggers: [] },
    inspect: () => evaluator.decide({ spent: {} }),
  }
  guard = attachGuard(ctx, evaluator, meter, {
    mode: config.mode,
    cancelOnBlock: config.cancelOnBlock,
    onViolation: (decision, scope) => {
      logger.warn(`[cost-guard] ${scope} 预算命中：${decision.action}`)
    },
  })

  // 3) 成本工具
  if (config.enableTool) {
    attachCostTool(ctx, meter, windows, evaluator, guard)
  }

  // 4) 启动摘要
  logger.info('[cost-guard] 已启用：实时计量 + 预算熔断 (mode=%s)', config.mode)

  // 暴露运行时状态供其他插件 / 面板读取
  ctx.provide('costGuard', {
    meter,
    windows,
    evaluator,
    guard,
    status: () => buildCostStatus(meter, windows, evaluator, guard),
    summary: () => formatStatusSummary(buildCostStatus(meter, windows, evaluator, guard)),
  })
}

export { costGuardService } from './service.js'