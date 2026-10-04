/**
 * @module dsh-cost-guard/core/pricing
 * 定价表与计价 —— 与 DSH 运行时解耦的纯逻辑。
 *
 * 计费口径（与 DeepSeek 官方一致）：
 *   cost = input(miss) × inputPerMillion + cacheRead(hit) × cacheReadPerMillion
 *          + output × outputPerMillion
 * 金额按『每百万 token』计价，默认币种 CNY，可通过 defineModelPrice 覆盖任意路由。
 *
 * 内置默认价（CNY / 1M token）：
 *   deepseek-v4-flash / deepseek-v4-pro 等官方模型。
 * 价格变更为高频事件，插件以『配置优先、内置兜底』为原则：用户可通过设置覆盖。
 */

import type { ModelPrice, Route, TokenUsageLike } from './types.js'

/** 内置默认价格表（CNY / 1M token）。以官方定价页为准，可在配置中覆盖。 */
export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  'deepseek-chat': {
    inputPerMillion: 2,
    cacheReadPerMillion: 0.5,
    outputPerMillion: 8,
  },
  'deepseek-reasoner': {
    inputPerMillion: 4,
    cacheReadPerMillion: 1,
    outputPerMillion: 16,
  },
}

/** 未配置价格的模型使用的保守兜底价（CNY / 1M），防止漏计导致失控。 */
export const FALLBACK_PRICE: ModelPrice = {
  inputPerMillion: 4,
  cacheReadPerMillion: 1,
  outputPerMillion: 16,
}

export interface PricingTable {
  /** 主表：'provider/model' -> 价格。 */
  [route: string]: ModelPrice
}

function routeKeyOf(route: Route): string {
  return `${route.provider}/${route.model}`
}

/** 合并内置价与用户配置（用户优先）。 */
export function buildPricingTable(
  overrides: Record<string, ModelPrice> = {},
): PricingTable {
  return { ...BUILTIN_PRICES, ...overrides }
}

/** 查询路由价格；未命中任何显式价格时用保守兜底价并标记。 */
export function priceFor(table: PricingTable, route: Route): { price: ModelPrice; fallback: boolean } {
  const direct = table[routeKeyOf(route)]
  if (direct) return { price: direct, fallback: false }
  // 模型级价格（内置或用户覆盖）命中：价格可用且明确，不算兜底。
  const byModel = table[route.model]
  if (byModel) return { price: byModel, fallback: false }
  return { price: FALLBACK_PRICE, fallback: true }
}

/**
 * 按 TokenUsage 与价格折算金额。
 * 计费 token = input + cacheRead + output（cacheWrite 不单独计价）。
 */
export function computeCost(
  price: ModelPrice,
  usage: Pick<TokenUsageLike, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>,
): number {
  const input = usage.inputTokens || 0
  const output = usage.outputTokens || 0
  const cacheRead = usage.cacheReadTokens || 0
  return (
    (input * price.inputPerMillion +
      cacheRead * price.cacheReadPerMillion +
      output * price.outputPerMillion) /
    1_000_000
  )
}

/** 计费总 token。 */
export function billedTokens(usage: Pick<TokenUsageLike, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>): number {
  return (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0)
}

/** 格式化金额：保留 4 位有效小数，用于人读输出。 */
export function formatCost(cost: number): string {
  return cost >= 100 ? cost.toFixed(2) : cost >= 1 ? cost.toFixed(3) : cost.toFixed(4)
}