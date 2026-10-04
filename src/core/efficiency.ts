/**
 * @module dsh-cost-guard/core/efficiency
 * 成本效率洞察（Cost Efficiency Intelligence，0.5.0，零 DSH 依赖）。
 *
 * 行业现状：成本工具告诉你『花了多少』，但从不告诉你『花得值不值』。
 * 本模块回答三个效率问题：
 *
 *   1. 每千输出 token 多少钱？（质量-成本杠杆：输出是推理质量的主要载体）
 *   2. 单请求成本分布长什么样？（P50 / P95 / Max：识别拖垮预算的长尾请求）
 *   3. 换用更便宜的模型能省多少？（路由替代节约估算：给可执行的省钱建议）
 *
 * 全部为纯函数：输入路由累计桶 + 单请求成本样本 → 输出效率指标。
 */

import type { UsageBucket } from './types.js'
import type { PricingTable } from './pricing.js'
import { sortedAsc, percentile } from './math.js'

/** 单请求成本分布统计。 */
export interface RequestCostDistribution {
  /** 样本数。 */
  n: number
  /** 中位请求成本。 */
  p50: number
  /** 95 分位请求成本（长尾代表值）。 */
  p95: number
  /** 单次最大请求成本。 */
  max: number
  /** 平均请求成本。 */
  avg: number
}

/** 路由效率指标。 */
export interface RouteEfficiency {
  /** 路由键（provider/model）。 */
  route: string
  /** 累计金额。 */
  cost: number
  /** 输出 token。 */
  outputTokens: number
  /** 每千输出 token 成本（元）。 */
  costPerKOutput: number
  /** 每百万总 token 成本（元）。 */
  costPerMTokens: number
  /** 请求数。 */
  requests: number
}

/** 路由替代节约估算。 */
export interface ReplacementEstimate {
  /** 当前路由。 */
  from: string
  /** 建议替代路由。 */
  to: string
  /** 当前累计花费。 */
  currentCost: number
  /** 按替代路由单价折算的预计花费。 */
  replacementCost: number
  /** 预计节约金额。 */
  saving: number
  /** 节约比例（0~1）。 */
  savingPercent: number
  /** 人读建议。 */
  suggestion: string
}

/** 从单请求成本样本计算分布统计。样本不足 3 个时返回 undefined。 */
export function requestCostDistribution(samples: number[]): RequestCostDistribution | undefined {
  const valid = samples.filter((s) => Number.isFinite(s) && s >= 0)
  if (valid.length < 3) return undefined
  const sorted = sortedAsc(valid)
  const sum = valid.reduce((a, b) => a + b, 0)
  return {
    n: valid.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
    avg: sum / valid.length,
  }
}

/** 计算各路由的效率指标（输出 token 为质量载体口径）。 */
export function routeEfficiency(routes: Record<string, UsageBucket>): RouteEfficiency[] {
  const out: RouteEfficiency[] = []
  for (const [route, b] of Object.entries(routes)) {
    const costPerKOutput = b.outputTokens > 0 ? (b.cost * 1000) / b.outputTokens : 0
    const costPerMTokens = b.totalTokens > 0 ? (b.cost * 1_000_000) / b.totalTokens : 0
    out.push({
      route,
      cost: b.cost,
      outputTokens: b.outputTokens,
      costPerKOutput,
      costPerMTokens,
      requests: b.requests,
    })
  }
  return out.sort((a, b) => b.cost - a.cost)
}

/**
 * 路由替代节约估算：
 * 用当前路由的累计用量（input + output token），按目标路由单价重算成本。
 * 仅当替代路由存在明确定价、且有总量 token 时输出建议。
 */
export function estimateReplacement(
  routes: Record<string, UsageBucket>,
  pricing: PricingTable,
  /** 候选替代路由键；缺省时遍历价表全部键。 */
  candidates?: string[],
): ReplacementEstimate[] {
  const out: ReplacementEstimate[] = []
  const keys = candidates && candidates.length > 0 ? candidates : Object.keys(pricing)
  for (const [route, b] of Object.entries(routes)) {
    if (b.totalTokens <= 0 || b.cost <= 0) continue
    const inputTokens = b.inputTokens + b.cacheReadTokens
    const outputTokens = b.outputTokens
    let best: ReplacementEstimate | undefined
    for (const alt of keys) {
      if (alt === route) continue
      const price = pricing[alt]
      if (!price) continue
      const altCost = (inputTokens * price.inputPerMillion) / 1_000_000 + (outputTokens * price.outputPerMillion) / 1_000_000
      const saving = b.cost - altCost
      if (saving <= 0) continue
      const savingPercent = b.cost > 0 ? saving / b.cost : 0
      const est: ReplacementEstimate = {
        from: route,
        to: alt,
        currentCost: b.cost,
        replacementCost: altCost,
        saving,
        savingPercent,
        suggestion: `将 ${route} 的用量切换到 ${alt}，预计可省 ${saving.toFixed(2)} 元（约 ${(savingPercent * 100).toFixed(0)}%）`,
      }
      if (!best || est.saving > best.saving) best = est
    }
    if (best) out.push(best)
  }
  return out.sort((a, b) => b.saving - a.saving)
}