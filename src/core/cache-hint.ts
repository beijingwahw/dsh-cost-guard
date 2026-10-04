/**
 * @module dsh-cost-guard/core/cache-hint
 * 可优化前缀提示检测器（CacheHintDetector，零 DSH 依赖）。
 *
 * 识别高频重复且未命中占比高的输入前缀，估算潜在节省，输出提示候选。
 * 只提示、不自动改写 Prompt（方案文档 6.4）。
 *
 * 判定条件：
 *   - 同一归一化前缀签名（prefixId）重复次数 >= minRepeat（默认 3）。
 *   - 潜在节省金额 >= minSaving（默认 0.50 元）。
 *   - 潜在节省口径：若该前缀全部命中可省的金额
 *     = Σ (inputMiss × (missPrice - hitPrice)) / 1e6（按观测事件所在时段单价估算）。
 *
 * 提示噪音防护：不确定请求（uncertainty 标注）不参与命中率与节省估算；
 * 前缀命中率稳定后仍低于阈值才提示（阈值过滤见 candidates）。
 */

import type { CachePricingProvider, PrefixCandidate, TokenSplit } from './cache-types.js'
import { deepseekBandForEpoch } from './cache-pricing.js'

/** 前缀提示判定阈值配置。 */
export interface CacheHintConfig {
  /** 同一前缀重复次数阈值（>= 触发候选），默认 3。 */
  minRepeat: number
  /** 潜在节省阈值（元），低于不提示，默认 0.50。 */
  minSaving: number
}

/** 默认阈值。 */
export const DEFAULT_HINT_CONFIG: CacheHintConfig = { minRepeat: 3, minSaving: 0.5 }

interface PrefixStat {
  /** 可计入统计的重复次数（不含不确定请求）。 */
  repeatCount: number
  inputTotal: number
  hitTotal: number
  /** 潜在节省累计（元）。 */
  potentialSaving: number
}

/** 可优化前缀检测器。 */
export class CacheHintDetector {
  private readonly stats = new Map<string, PrefixStat>()

  constructor(
    private readonly pricing: CachePricingProvider,
    private readonly config: CacheHintConfig = DEFAULT_HINT_CONFIG,
  ) {}

  /**
   * 观测一次请求。
   * @param prefixId 归一化前缀签名（harness 按输入体前若干 Token 生成；core 不关心生成方式）
   * @param route 路由（'provider/model'），用于估算该前缀的时段单价
   * @param split 三通道拆分
   * @param time 请求时刻（epoch ms），用于判定时段
   * @param tzOffsetMin 时区偏移（分钟）
   */
  observe(prefixId: string, route: string, split: TokenSplit, time: number, tzOffsetMin: number): void {
    if (split.uncertainty) return // 不确定请求不参与提示统计
    const stat = this.byPrefix(prefixId)
    stat.repeatCount += 1
    stat.inputTotal += split.inputHit + split.inputMiss
    stat.hitTotal += split.inputHit
    if (split.inputMiss > 0) {
      const band = deepseekBandForEpoch(time, tzOffsetMin)
      const price = this.pricing.resolve(route, band)
      const saving = (split.inputMiss * (price.inputMiss - price.inputHit)) / 1_000_000
      stat.potentialSaving += Math.max(0, saving)
    }
  }

  private byPrefix(prefixId: string): PrefixStat {
    let s = this.stats.get(prefixId)
    if (!s) {
      s = { repeatCount: 0, inputTotal: 0, hitTotal: 0, potentialSaving: 0 }
      this.stats.set(prefixId, s)
    }
    return s
  }

  /** 输出达到阈值的前缀候选（按潜在节省降序）。 */
  candidates(): PrefixCandidate[] {
    const out: PrefixCandidate[] = []
    for (const [prefixId, s] of this.stats) {
      if (s.repeatCount < this.config.minRepeat) continue
      if (s.potentialSaving < this.config.minSaving) continue
      out.push({
        prefixId,
        repeatCount: s.repeatCount,
        potentialSaving: s.potentialSaving,
        observedHitRate: s.inputTotal > 0 ? s.hitTotal / s.inputTotal : 0,
      })
    }
    return out.sort((a, b) => b.potentialSaving - a.potentialSaving)
  }

  /** 清除全部统计（测试用）。 */
  clear(): void {
    this.stats.clear()
  }
}