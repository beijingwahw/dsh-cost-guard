/**
 * @module dsh-cost-guard/core/pricing
 * 定价表与计价 —— 与 DSH 运行时解耦的纯逻辑。
 *
 * 计费口径（与 DeepSeek 官方一致）：
 *   cost = input(miss) × inputPerMillion + cacheRead(hit) × cacheReadPerMillion
 *          + output × outputPerMillion
 * 金额按『每百万 token』计价，默认币种 CNY，可通过 defineModelPrice 覆盖任意路由。
 *
 * 积分口径（与金额独立）：
 *   credits = billedTokens × creditsPerMillion / 1_000_000
 * 每个模型可配置独立的积分单价（creditsPerMillion），未配置的模型积分消耗按 0 计。
 * 积分仅用于统计展示，不参与预算熔断判定。
 *
 * 峰谷计费（与基准价分层）：
 *   - 基准价表：内置官方价 + 用户 pricing 覆盖，任意时刻兜底。
 *   - TimeBand：用户可按本地时区定义若干时段（支持跨午夜），每个时段可配置
 *     独立的价格覆盖（band.prices）。入账时按事件发生的本地分钟选带，
 *     带内命中覆盖价即用覆盖价，未覆盖的路由回退基准价表。
 *   - 无时段配置时全部用量归入 BASE_BAND（基准价），行为与旧版完全一致。
 *
 * 内置默认价（CNY / 1M token）：
 *   deepseek-chat / deepseek-reasoner 等官方模型。
 * 价格变更为高频事件，插件以『配置优先、内置兜底』为原则：用户可通过设置覆盖。
 */

import type { ModelPrice, Route, TimeBand, TokenUsageLike } from './types.js'
import { BASE_BAND } from './types.js'

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
 * 计费 token = input + cacheRead + output。
 * 可选缓存写价（Anthropic 官方按写入 token 单独计价）：
 *   price.cacheWritePerMillion 存在且 usage 提供 cacheWriteTokens 时加算；
 *   未配置写价或用量缺省时该项为 0 —— 与既有三通道口径完全一致（零回归）。
 */
export function computeCost(
  price: ModelPrice,
  usage: Pick<TokenUsageLike, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
): number {
  const input = usage.inputTokens || 0
  const output = usage.outputTokens || 0
  const cacheRead = usage.cacheReadTokens || 0
  const cacheWritePerMillion = price.cacheWritePerMillion
  const cacheWrite = cacheWritePerMillion === undefined ? 0 : usage.cacheWriteTokens || 0
  return (
    (input * price.inputPerMillion +
      cacheRead * price.cacheReadPerMillion +
      output * price.outputPerMillion +
      cacheWrite * (cacheWritePerMillion ?? 0)) /
    1_000_000
  )
}

/** 计费总 token。 */
export function billedTokens(usage: Pick<TokenUsageLike, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>): number {
  return (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0)
}

/**
 * 按 TokenUsage 与价格折算积分消耗。
 * 口径：计费 token（input + cacheRead + output）× 模型积分单价（每百万 token）。
 * 未配置积分单价（creditsPerMillion 缺失或为 0）的模型返回 0，积分与金额完全独立。
 */
export function computeCredits(
  price: ModelPrice,
  usage: Pick<TokenUsageLike, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>,
): number {
  const perMillion = price.creditsPerMillion ?? 0
  if (!perMillion) return 0
  return (billedTokens(usage) * perMillion) / 1_000_000
}

/** 格式化金额：保留 4 位有效小数，用于人读输出。 */
export function formatCost(cost: number): string {
  return cost >= 100 ? cost.toFixed(2) : cost >= 1 ? cost.toFixed(3) : cost.toFixed(4)
}

/** 格式化积分：整数按原值，非整数保留 2 位小数。 */
export function formatCredits(credits: number): string {
  return Number.isInteger(credits) ? String(credits) : credits.toFixed(2)
}

// ---------------------------------------------------------------------------
// 峰谷时段（TimeBand）：本地时区内的按带计费。
// 语义：bandForEpoch 把事件发生时刻换算为本地分钟，按配置顺序取第一个命中带；
//       命中带的覆盖价优先于基准价表；未命中任何带则归 BASE_BAND（基准价）。
// ---------------------------------------------------------------------------

/** 解析 'HH:mm' 为当日分钟数（0..1439），非法输入返回 -1。 */
export function parseBandMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return -1
  // 正则已保证捕获组存在；防御性取值避免 NaN 路径（noUncheckedIndexedAccess）。
  const h = m[1] === undefined ? -1 : Number(m[1])
  const min = m[2] === undefined ? -1 : Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1
  return h * 60 + min
}

/** 判断本地分钟是否落在时段内（支持跨午夜与全天）。 */
export function inBand(minutes: number, band: TimeBand): boolean {
  const s = parseBandMinutes(band.start)
  const e = parseBandMinutes(band.end)
  if (s < 0 || e < 0) return false
  if (s === e) return true // 全天
  if (s < e) return minutes >= s && minutes < e
  // 跨午夜：start <= t 或 t < end
  return minutes >= s || minutes < e
}

/** 按本地分钟选带；取配置顺序中第一个命中，无命中返回 BASE_BAND。 */
export function bandIdForMinutes(bands: TimeBand[], minutes: number): string {
  for (const b of bands) {
    if (inBand(minutes, b)) return b.id
  }
  return BASE_BAND
}

/** 按事件时刻（epoch ms）+ 时区偏移选带。 */
export function bandIdForEpoch(bands: TimeBand[], timeMs: number, tzOffsetMin: number): string {
  const localMinutes = (Math.floor((timeMs + tzOffsetMin * 60_000) / 60_000) % 1440 + 1440) % 1440
  return bandIdForMinutes(bands, localMinutes)
}

/** 带内价格覆盖表：bandId -> 路由键 -> ModelPrice。 */
export type BandPriceTable = Record<string, Record<string, ModelPrice>>

/** 构建按带覆盖表（仅包含显式配置了 prices 的带）。 */
export function buildBandPriceTable(bands: TimeBand[]): BandPriceTable {
  const table: BandPriceTable = {}
  for (const b of bands) {
    if (b.prices && Object.keys(b.prices).length > 0) {
      table[b.id] = b.prices
    }
  }
  return table
}

/**
 * 查询带内路由价格：优先带覆盖（'provider/model' 或裸 'model'），
 * 未命中则回退基准价表（内置 + 用户 pricing 覆盖 + 兜底）。
 */
export function priceForAt(
  base: PricingTable,
  bandTable: BandPriceTable,
  route: Route,
  band: string,
): { price: ModelPrice; fallback: boolean } {
  const bandPrices = bandTable[band]
  if (bandPrices) {
    const direct = bandPrices[routeKeyOf(route)]
    if (direct) return { price: direct, fallback: false }
    const byModel = bandPrices[route.model]
    if (byModel) return { price: byModel, fallback: false }
  }
  return priceFor(base, route)
}