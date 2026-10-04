/**
 * @module dsh-cost-guard/core/cache-metrics
 * 缓存维度指标聚合（CacheMetrics，零 DSH 依赖）。
 *
 * 职责：
 *   - 按请求追加三通道账目行（CacheLedgerRow），累计 Token 加权命中率、
 *     缓存收益金额与不确定请求数。
 *   - 支持全局 / 按会话 / 按路由三级汇总（方案文档：命中率按 Token 加权）。
 *   - 成本与收益公式（方案文档 5.3）：
 *       cost        = hit/1e6 * hitPrice + miss/1e6 * missPrice + output/1e6 * outputPrice
 *       baselineCost= (hit+miss)/1e6 * missPrice + output/1e6 * outputPrice
 *       saving      = baselineCost - cost
 *   - 不确定请求（uncertainty 标注）单独计数，命中率口径不含不确定请求，
 *     避免污染可信指标（方案文档 4.3）。
 */

import type { BandPrice, CacheLedgerRow, CacheLedgerStore, CacheSummary, TokenSplit } from './cache-types.js'
import { emptyCacheSummary } from './cache-types.js'

/** 按三通道单价折算成本 / 基线成本 / 收益。 */
export function computeCacheCost(split: TokenSplit, price: BandPrice): {
  cost: number
  baselineCost: number
  saving: number
} {
  const hit = Math.max(0, split.inputHit)
  const miss = Math.max(0, split.inputMiss)
  const output = Math.max(0, split.output)
  const cost = (hit * price.inputHit + miss * price.inputMiss + output * price.output) / 1_000_000
  const baselineCost = ((hit + miss) * price.inputMiss + output * price.output) / 1_000_000
  return { cost, baselineCost, saving: baselineCost - cost }
}

/** 单维汇总累加器。 */
interface CacheAccumulator {
  inputTotal: number
  hitTotal: number
  savingTotal: number
  uncertainCount: number
}

function emptyAccum(): CacheAccumulator {
  return { inputTotal: 0, hitTotal: 0, savingTotal: 0, uncertainCount: 0 }
}

/** 缓存账本：全局 + 会话 + 路由三级 Token 加权汇总。 */
export class CacheMetrics implements CacheLedgerStore {
  private readonly global: CacheAccumulator = emptyAccum()
  private readonly sessions = new Map<string, CacheAccumulator>()
  private readonly routes = new Map<string, CacheAccumulator>()

  /** 追加一行账目。 */
  append(row: CacheLedgerRow, meta?: { sessionId?: string; route?: string }): void {
    this.addTo(this.global, row.split, row.saving)
    if (meta?.sessionId) this.addTo(this.byKey(this.sessions, meta.sessionId), row.split, row.saving)
    if (meta?.route) this.addTo(this.byKey(this.routes, meta.route), row.split, row.saving)
  }

  private byKey(map: Map<string, CacheAccumulator>, key: string): CacheAccumulator {
    let acc = map.get(key)
    if (!acc) {
      acc = emptyAccum()
      map.set(key, acc)
    }
    return acc
  }

  private addTo(acc: CacheAccumulator, split: TokenSplit, saving: number): void {
    if (split.uncertainty) {
      // 不确定请求：不纳入命中率与收益，仅单独计数
      acc.uncertainCount += 1
      return
    }
    acc.inputTotal += split.inputHit + split.inputMiss
    acc.hitTotal += split.inputHit
    acc.savingTotal += saving
  }

  /** 全局汇总（Token 加权命中率）。 */
  summary(_scope: 'global'): CacheSummary {
    return toSummary(this.global)
  }

  /** 会话维度汇总（sessionId -> 汇总）。 */
  byScope(scope: 'session' | 'route'): Record<string, CacheSummary> {
    const map = scope === 'session' ? this.sessions : this.routes
    const out: Record<string, CacheSummary> = {}
    for (const [k, acc] of map) out[k] = toSummary(acc)
    return out
  }

  /** 全部移除（测试与重置用）。 */
  clear(): void {
    this.sessions.clear()
    this.routes.clear()
    const g = this.global
    g.inputTotal = 0
    g.hitTotal = 0
    g.savingTotal = 0
    g.uncertainCount = 0
  }
}

/** Accumulator -> CacheSummary（Token 加权命中率）。 */
export function toSummary(acc: CacheAccumulator): CacheSummary {
  return {
    inputTotal: acc.inputTotal,
    hitTotal: acc.hitTotal,
    hitRate: acc.inputTotal > 0 ? acc.hitTotal / acc.inputTotal : 0,
    savingTotal: acc.savingTotal,
    uncertainCount: acc.uncertainCount,
  }
}

export type { CacheSummary }
export { emptyCacheSummary }