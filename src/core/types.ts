/**
 * @module dsh-cost-guard/core/types
 * 领域类型：用量、价格、预算、快照 —— 全部与 DSH 运行时解耦。
 */

/** 一次模型调用的 Token 用量（与 TokenUsage 形状对齐，但零依赖自持）。 */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 单模型价格（金额 / 每百万 token；币种由调用方说明，默认 CNY）。 */
export interface ModelPrice {
  /** 输入（缓存未命中）价格。 */
  inputPerMillion: number
  /** 输入（缓存命中）价格。 */
  cacheReadPerMillion: number
  /** 输出价格。 */
  outputPerMillion: number
  /** 积分单价（每百万 token 消耗的积分）。可选，未配置时该模型积分消耗按 0 计。 */
  creditsPerMillion?: number
}

/** 路由标识：provider + model，对应 DSH 的 LlmCallConfig。 */
export interface Route {
  provider: string
  model: string
}

/**
 * 峰谷时段（time band）：本地时区内的计费时段，支持跨午夜与全天。
 * - `start === end`：全天覆盖（00:00-00:00）。
 * - `start < end`：当日 [start, end) 区间。
 * - `start > end`：跨午夜 [start, 24:00) ∪ [00:00, end)。
 */
export interface TimeBand {
  /** 时段标识，如 'peak' / 'offpeak' / 'valley'。 */
  id: string
  /** 起始时刻 'HH:mm'（含）。 */
  start: string
  /** 结束时刻 'HH:mm'（不含）。 */
  end: string
  /** 该时段内按路由/模型的价格覆盖；未覆盖的路由回退基准价表。 */
  prices?: Record<string, ModelPrice>
}

/** 默认时段标识：未配置时段（或无命中）时所有用量归入该带，按基准价计。 */
export const BASE_BAND = 'base'

/** 一条已折算的用量明细。 */
export interface UsageEntry {
  /** 事件发生时间（epoch ms）。 */
  time: number
  route: Route
  usage: Required<Pick<TokenUsageLike, 'inputTokens' | 'outputTokens'>>
  cacheReadTokens: number
  reasoningTokens: number
  /** 按路由价格折算的金额。 */
  cost: number
  /** 按路由积分单价折算的积分消耗（未配置积分单价时为 0）。 */
  credits: number
  /** 计费总 token（input + cacheRead + output）。 */
  totalTokens: number
  /** 入账时命中的峰谷时段（BASE_BAND = 基准价）。 */
  band: string
}

/** 聚合桶（按时间或会话维度）。 */
export interface UsageBucket {
  requests: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  totalTokens: number
  /** 累计金额。 */
  cost: number
  /** 累计积分消耗（与金额独立累计）。 */
  credits: number
}

/** 预算范围。 */
export type BudgetScope = 'session' | 'day' | 'month' | 'total'

/** 预算策略配置。 */
export interface BudgetPolicy {
  scope: BudgetScope
  /** 预算上限（金额）。 */
  limit: number
  /** 告警水位（0~1），到达该比例触发告警而非阻断。 */
  warnAt: number
  /** 阻断水位（0~1），到达该比例硬阻断。 */
  hardAt: number
}

/** 熔断模式。 */
export type GuardMode = 'off' | 'warn' | 'block'

/** 预算决策结果。 */
export interface BudgetDecision {
  /** 综合决策动作。 */
  action: 'allow' | 'warn' | 'block'
  /** 触发的策略明细（按水位从紧到松排序）。 */
  triggers: Array<{
    scope: BudgetScope
    spent: number
    limit: number
    ratio: number
    level: 'warn' | 'hard'
  }>
  /** 预测式治理触发明细（0.4.0；仅在启用预测式策略并触发时存在）。 */
  predictive?: Array<{
    kind: 'projection' | 'spike' | 'preflight' | 'adaptive'
    scope?: BudgetScope
    level: 'warn' | 'hard'
    detail: string
  }>
  /** 自适应调节状态（0.5.0；仅在启用 adaptive 策略并注入 governor 时存在）。 */
  adaptive?: {
    /** 应用动态水位的 scope。 */
    scope: BudgetScope
    /** governor 输出：动态额度 / 背压 / 水位。 */
    governor: {
      dayAllowance: number
      dayRemaining: number
      pressure: number
      warnAt: number
      hardAt: number
      projectedMonthRemaining: number
      carryOver: number
      exhausted: boolean
    }
    /** 成本感知提示级别：calm（从容）/ frugal（节约）/ minimal（最小化）。 */
    cue: 'calm' | 'frugal' | 'minimal'
  }
}

/** 持久化快照：跨重启恢复用量累计。 */
export interface CostSnapshot {
  version: 1
  savedAt: number
  /** scope -> 桶金额。total 使用 'total' 键。 */
  buckets: Partial<Record<BudgetScope, UsageBucket>>
  /** 按路由累计（金额与 token）。 */
  routes: Record<string, UsageBucket>
  /** 按会话累计。 */
  sessions: Record<string, UsageBucket>
  /** 按峰谷时段累计（bandId -> 桶）；旧快照缺失时按空处理。 */
  bands: Record<string, UsageBucket>
}

/** 空桶工厂。 */
export function emptyBucket(): UsageBucket {
  return {
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    credits: 0,
  }
}