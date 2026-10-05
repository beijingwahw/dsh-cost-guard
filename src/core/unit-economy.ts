/**
 * @module dsh-cost-guard/core/unit-economy
 * 单位经济学与成本归属（Unit Economics / Showback，0.12.0，零 DSH 依赖）。
 *
 * 前沿背景：FinOps for GenAI 的实践共识是——除了「花了多少」，还必须回答
 * 「每个业务单元（任务 / 会话 / 租户）花多少」：单位经济学把成本落到
 * 可归因的最小业务粒度，Showback/Chargeback 再把成本归属到业务线或场景，
 * 让「省成本」变成「可执行的业务决策」而非纯工程优化。
 * 本模块以「会话（任务）」为归属单元：
 * - cost per task（每会话成本）、cost per request、cost per 1M tokens；
 * - 会话成本占比（谁在烧钱）与 Top-N 成本归属；
 * - 路由维度成本构成（输入 / 缓存 / 输出/ 推理）辅助定位优化点。
 *
 * 输入是 Meter 的会话桶与路由桶（纯内存快照），输出为排序后的归属报表。
 */

import type { UsageBucket } from './types.js'

/** 会话（任务）级单位经济与归属行。 */
export interface SessionUnitEconomic {
  /** 会话标识。 */
  sessionId: string
  /** 会话累计成本（金额）。 */
  cost: number
  /** 会话累计积分。 */
  credits: number
  /** 请求次数。 */
  requests: number
  /** 计费总 token。 */
  tokens: number
  /** 每任务（会话）成本 = 累计成本。 */
  costPerTask: number
  /** 每请求成本。 */
  costPerRequest: number
  /** 每百万 token 成本（原币种）。 */
  costPerMTokens: number
  /** 占全部会话成本比例（0~1）。 */
  share: number
}

/** 路由器经济：通道成本构成（供定位优化点）。 */
export interface RouteUnitEconomic {
  /** 路由键。 */
  route: string
  /** 累计成本。 */
  cost: number
  /** 请求次数。 */
  requests: number
  /** 计费总 token。 */
  tokens: number
  /** 每百万 token 成本。 */
  costPerMTokens: number
  /** 输入 token 数（不含缓存）。 */
  inputTokens: number
  /** 缓存命中输入 token。 */
  cacheReadTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 推理 token。 */
  reasoningTokens: number
  /** 占全部路由成本比例（0~1）。 */
  share: number
}

/** 单位经济学报表。 */
export interface UnitEconomicsReport {
  /** 全部会话成本合计。 */
  totalCost: number
  /** 全局每请求成本（空样本时为 0）。 */
  costPerRequest: number
  /** 全局每百万 token 成本。 */
  costPerMTokens: number
  /** 会话成本归属（按 cost 降序）。 */
  sessions: SessionUnitEconomic[]
  /** Top-N 会话归属（成本占比最大的前 N 个）。 */
  topSessions: SessionUnitEconomic[]
  /** 路由成本构成（按 cost 降序）。 */
  routes: RouteUnitEconomic[]
}

function bucketCost(b: UsageBucket): number {
  return b.cost ?? 0
}

/** 由会话桶与路由桶构建单位经济学报表（纯函数，不改入参）。 */
export function buildUnitEconomics(
  sessions: Record<string, UsageBucket>,
  routes: Record<string, UsageBucket> = {},
  topN = 5,
): UnitEconomicsReport {
  const totalCost = Object.values(sessions).reduce((s, b) => s + bucketCost(b), 0)
  const totalRequests = Object.values(sessions).reduce((s, b) => s + (b.requests ?? 0), 0)
  const totalTokens = Object.values(sessions).reduce((s, b) => s + (b.totalTokens ?? 0), 0)

  const sessionRows: SessionUnitEconomic[] = Object.entries(sessions)
    .map(([sessionId, b]) => {
      const cost = bucketCost(b)
      const requests = b.requests ?? 0
      const tokens = b.totalTokens ?? 0
      return {
        sessionId,
        cost,
        credits: b.credits ?? 0,
        requests,
        tokens,
        costPerTask: cost,
        costPerRequest: requests > 0 ? cost / requests : 0,
        costPerMTokens: tokens > 0 ? (cost * 1_000_000) / tokens : 0,
        share: totalCost > 0 ? cost / totalCost : 0,
      }
    })
    .sort((a, b) => b.cost - a.cost)

  const routeRows: RouteUnitEconomic[] = Object.entries(routes)
    .map(([route, b]) => {
      const cost = bucketCost(b)
      const tokens = b.totalTokens ?? 0
      return {
        route,
        cost,
        requests: b.requests ?? 0,
        tokens,
        costPerMTokens: tokens > 0 ? (cost * 1_000_000) / tokens : 0,
        inputTokens: b.inputTokens ?? 0,
        cacheReadTokens: b.cacheReadTokens ?? 0,
        outputTokens: b.outputTokens ?? 0,
        reasoningTokens: 0,
        share: totalCost > 0 ? cost / totalCost : 0,
      }
    })
    .sort((a, b) => b.cost - a.cost)

  return {
    totalCost,
    costPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    costPerMTokens: totalTokens > 0 ? (totalCost * 1_000_000) / totalTokens : 0,
    sessions: sessionRows,
    topSessions: sessionRows.slice(0, Math.max(1, topN)),
    routes: routeRows,
  }
}