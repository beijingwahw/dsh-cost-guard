/**
 * @module dsh-cost-guard/core/leverage
 * 成本杠杆洞察（Cost Leverage Intelligence，0.12.0，零 DSH 依赖）。
 *
 * 前沿背景：2026 年 LLM 成本优化的行业共识有两条硬结论——
 * 1) Prompt Caching 是第一优先级杠杆：缓存读取价约为标准输入价的 0.1 倍
 *   （DeepSeek flash 0.02 vs 1.00、Kimi 20 vs 40 等），命中率每提升 1 点
 *   都直接落在「输入账单 × 价差」上，可优化空间最大；
 * 2) 输出 token 单价普遍高于输入约 3~4 倍，控制输出长度是 ROI 最高的
 *   优化动作——同样的 token 数，省输出比省输入划算得多。
 * 本模块把这两条结论数值化：对每个路由算出
 * - 缓存折扣杠杆（cache discount leverage）：命中/未命中价差倍数、当前
 *   命中率下的「已实现节省率」与「若全量命中可再省比例」；
 * - 输出杠杆（output leverage）：输出/输入价差倍数、输出成本占比、
 *   「压缩 10% 输出」的预计节省金额。
 * 输出排序后的行动项清单，供 Agent 与用户直接执行。
 */

import type { ModelPrice } from './types.js'
import type { PricingTable } from './pricing.js'

/** 缓存折扣杠杆行。 */
export interface CacheDiscountLever {
  /** 路由键。 */
  route: string
  /** 未命中单价（每百万 token）。 */
  missPrice: number
  /** 命中单价（每百万 token）。 */
  hitPrice: number
  /** 价差倍数 = miss / hit（>= 1；越大缓存越划算）。 */
  discountX: number
  /** 当前 Token 加权命中率（0~1）。 */
  hitRate: number
  /** 已实现节省率（相对「全部按未命中计费」的基线，0~1）。 */
  realizedSavingRate: number
  /** 若未命中部分全部转为命中，相对基线可再省的比例（0~1）。 */
  potentialSavingRate: number
  /** 人读行动项。 */
  action: string
}

/** 输出杠杆行。 */
export interface OutputLever {
  /** 路由键。 */
  route: string
  /** 输入（未命中）单价。 */
  inputPrice: number
  /** 输出单价。 */
  outputPrice: number
  /** 输出/输入价差倍数。 */
  priceRatioX: number
  /** 输出 token 在计费总 token 中的占比（0~1）。 */
  outputTokenShare: number
  /** 输出成本估算占比（按价格权重，0~1）。 */
  outputCostShare: number
  /** 压缩 10% 输出流量的预计节省金额（按当前累计量估算）。 */
  compress10pctSaving: number
  /** 人读行动项。 */
  action: string
}

/** 缓存杠杆输入：某路由的三通道价（未命中 / 命中）与 Token 拆分。 */
export interface CacheLeverInput {
  /** 路由键。 */
  route: string
  /** 未命中单价。 */
  missPrice: number
  /** 命中单价。 */
  hitPrice: number
  /** 命中 token。 */
  hitTokens: number
  /** 未命中 token。 */
  missTokens: number
}

/** 由单路由输入计算缓存折扣杠杆（纯函数）。 */
export function cacheDiscountLeverOf(input: CacheLeverInput): CacheDiscountLever {
  const total = input.hitTokens + input.missTokens
  const hitRate = total > 0 ? input.hitTokens / total : 0
  const baselineCost = ((input.hitTokens + input.missTokens) * input.missPrice) / 1_000_000
  const actualCost = (input.hitTokens * input.hitPrice + input.missTokens * input.missPrice) / 1_000_000
  const realized = baselineCost > 0 ? Math.max(0, (baselineCost - actualCost) / baselineCost) : 0
  const fullHitCost = (total * input.hitPrice) / 1_000_000
  const potential = baselineCost > 0 ? Math.max(0, (baselineCost - fullHitCost) / baselineCost) : 0
  const discountX = input.hitPrice > 0 ? input.missPrice / input.hitPrice : 1
  const savingRatePct = (Math.max(0, potential - realized) * 100).toFixed(1)
  return {
    route: input.route,
    missPrice: input.missPrice,
    hitPrice: input.hitPrice,
    discountX,
    hitRate,
    realizedSavingRate: realized,
    potentialSavingRate: potential,
    action: `缓存杠杆 ${discountX.toFixed(1)}x（命中价 ${input.hitPrice} / 未命中价 ${input.missPrice}）· 命中率 ${(hitRate * 100).toFixed(1)}% · 已省 ${(realized * 100).toFixed(1)}%，全量命中还可再省 ${savingRatePct}%；稳定 system prompt 与工具定义顺序以提升命中`,
  }
}

/** 由路由桶 + 三通道价计算全量缓存杠杆（按可再省比例降序）。 */
export function buildCacheDiscountLevers(
  inputs: CacheLeverInput[],
): CacheDiscountLever[] {
  return inputs
    .map(cacheDiscountLeverOf)
    .filter((l) => l.missPrice > 0 && l.hitPrice > 0 && l.discountX > 1)
    .sort((a, b) => b.potentialSavingRate - a.potentialSavingRate)
}

/** 输出杠杆输入。 */
export interface OutputLeverInput {
  /** 路由键。 */
  route: string
  /** 单价（每百万 token）。 */
  inputPrice: number
  /** 输出单价。 */
  outputPrice: number
  /** 输入 token（含缓存）。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 输出压缩率（0~1，默认 0.1）。 */
  compressRate?: number
}

/** 由单路由输入计算输出杠杆（纯函数）。 */
export function outputLeverOf(input: OutputLeverInput): OutputLever {
  const rate = Math.min(1, Math.max(0, input.compressRate ?? 0.1))
  const inCost = (input.inputTokens * input.inputPrice) / 1_000_000
  const outCost = (input.outputTokens * input.outputPrice) / 1_000_000
  const totalCost = inCost + outCost
  const outputTokenShare =
    input.inputTokens + input.outputTokens > 0 ? input.outputTokens / (input.inputTokens + input.outputTokens) : 0
  const outputCostShare = totalCost > 0 ? outCost / totalCost : 0
  const ratioX = input.inputPrice > 0 ? input.outputPrice / input.inputPrice : 1
  return {
    route: input.route,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
    priceRatioX: ratioX,
    outputTokenShare,
    outputCostShare,
    compress10pctSaving: outCost * rate,
    action:
      `输出杠杆 ${ratioX.toFixed(1)}x（输出价 ${input.outputPrice} / 输入价 ${input.inputPrice}）· 输出占成本约 ${(outputCostShare * 100).toFixed(1)}% · ` +
      `压缩 ${(rate * 100).toFixed(0)}% 输出流量约可省 ${(outCost * rate).toFixed(4)} 元；已按输出占比 ${(outputTokenShare * 100).toFixed(1)}% 估算`,
  }
}

/** 由路由桶 + 价表计算全量输出杠杆（按可省金额降序）。 */
export function buildOutputLevers(
  routes: Record<string, { cost: number; inputTokens: number; outputTokens: number }>,
  pricing: PricingTable,
  compressRate = 0.1,
): OutputLever[] {
  const out: OutputLever[] = []
  for (const [route, bucket] of Object.entries(routes)) {
    const price: ModelPrice | undefined = pricing[route]
    if (!price || price.inputPerMillion <= 0 || price.outputPerMillion <= 0) continue
    out.push(
      outputLeverOf({
        route,
        inputPrice: price.inputPerMillion,
        outputPrice: price.outputPerMillion,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        compressRate,
      }),
    )
  }
  return out.sort((a, b) => b.compress10pctSaving - a.compress10pctSaving)
}