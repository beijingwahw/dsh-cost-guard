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
}

/** 路由标识：provider + model，对应 DSH 的 LlmCallConfig。 */
export interface Route {
  provider: string
  model: string
}

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
  /** 计费总 token（input + cacheRead + output）。 */
  totalTokens: number
}

/** 聚合桶（按时间或会话维度）。 */
export interface UsageBucket {
  requests: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
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
  }
}