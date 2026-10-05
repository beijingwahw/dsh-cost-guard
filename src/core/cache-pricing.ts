/**
 * 三通道 × 峰谷定价引擎（CachePricingEngine，零 DSH 依赖）。
 *
 * 价格获取顺序（方案文档 5.1 / 0.10.0 多厂商扩展）：
 *   1. 用户按路由、按时段的显式覆盖（覆盖 > 路由级缺失时回退全局）
 *   2. 用户全局三通道覆盖
 *   3. 官方多厂商缓存表（0.10.0：officialPricing 启用时由 index 注入，
 *      由 OFFICIAL_MODEL_REGISTRY 派生：DeepSeek dsn-peak 峰谷×2、其余厂商 flat 恒定价；
 *      缺省 undefined = 与 0.9.0 完全一致，零回归）
 *   4. 内置官方价格表（DeepSeek 2026-09-10 生效价）
 *
 * 高峰时段（方案文档 2.2 / 5.2，北京时间）：
 *   周一至周五（非法定节假日）9:00-12:00 与 14:00-18:00；
 *   其余时间（含周末、法定节假日全天）为空闲时段。
 *   仅 DeepSeek（dsn-peak 策略）高峰价 = 空闲价 × 2；多厂商（flat 策略）官方恒定价，peak = idle。
 *   跨午夜会话按请求发起时刻所在账期归属，不做请求内切分。
 *
 * 内置官方价（CNY / 1M token，2026-09-10 生效）：
 *   deepseek-flash  : 空闲 命中0.02 / 未命中1.00 / 输出4.00  高峰 0.04 / 2.00 / 8.00
 *   deepseek-v4-pro : 空闲 命中0.15 / 未命中4.50 / 输出13.50 高峰 0.30 / 9.00 / 27.00
 */

import type { BandPrice, CacheBand, PricingSource, RoutePricing } from './cache-types.js'
import { dayKey } from './clock.js'

/** 内置官方三通道价格表（按 model 键；2026-09-10 生效）。 */
export const BUILTIN_CACHE_PRICES: Record<string, RoutePricing> = {
  'deepseek-flash': {
    idle: { inputHit: 0.02, inputMiss: 1.0, output: 4.0 },
    peak: { inputHit: 0.04, inputMiss: 2.0, output: 8.0 },
  },
  'deepseek-v4-pro': {
    idle: { inputHit: 0.15, inputMiss: 4.5, output: 13.5 },
    peak: { inputHit: 0.3, inputMiss: 9.0, output: 27.0 },
  },
}

/** 未知路由的保守兜底三通道价（CNY / 1M，取内置最贵档，防止漏计）。 */
export const FALLBACK_CACHE_PRICE: BandPrice = { inputHit: 0.3, inputMiss: 9.0, output: 27.0 }

/**
 * 2026 年法定节假日（YYYY-MM-DD，供高峰判定排除）。
 * 数据来源：国务院办公厅 2026 年部分节假日安排通知。
 */
export const HOLIDAYS_2026: ReadonlySet<string> = new Set([
  // 元旦 1/1-1/3
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节 2/15-2/23
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节 4/4-4/6
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节 5/1-5/5
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节 6/19-6/21
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节 9/25-9/27
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节 10/1-10/7
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

/** 提取路由中的裸 model 名（'provider/model' -> 'model'；无 '/' 原样返回）。 */
export function modelOf(route: string): string {
  const idx = route.indexOf('/')
  return idx >= 0 ? route.slice(idx + 1) : route
}

// 高峰时段（本地分钟，含起点不含终点）：[09:00, 12:00) 与 [14:00, 18:00)
const PEAK_MORNING_START_MIN = 9 * 60
const PEAK_MORNING_END_MIN = 12 * 60
const PEAK_AFTERNOON_START_MIN = 14 * 60
const PEAK_AFTERNOON_END_MIN = 18 * 60

/**
 * 按事件时刻判定 DeepSeek 官方计费时段（本地时刻选带）。
 * 周一至周五且非法定节假日、本地分钟落在 [09:00,12:00) 或 [14:00,18:00) -> peak，否则 idle。
 */
export function deepseekBandForEpoch(
  timeMs: number,
  tzOffsetMin: number,
  holidays: ReadonlySet<string> = HOLIDAYS_2026,
): CacheBand {
  const shifted = new Date(timeMs + tzOffsetMin * 60_000)
  const dow = shifted.getUTCDay() // 0=周日 ... 6=周六
  if (dow === 0 || dow === 6) return 'idle' // 周末
  if (holidays.has(dayKey(timeMs, tzOffsetMin))) return 'idle' // 法定节假日全天
  const minutes = (Math.floor((timeMs + tzOffsetMin * 60_000) / 60_000) % 1440 + 1440) % 1440
  const isPeak =
    (minutes >= PEAK_MORNING_START_MIN && minutes < PEAK_MORNING_END_MIN) ||
    (minutes >= PEAK_AFTERNOON_START_MIN && minutes < PEAK_AFTERNOON_END_MIN)
  return isPeak ? 'peak' : 'idle'
}

/** 按本地时刻判定（接受 Date 或 epoch ms），供测试与预览使用。 */
export function deepseekBandAt(
  at: number | Date,
  tzOffsetMin: number,
  holidays: ReadonlySet<string> = HOLIDAYS_2026,
): CacheBand {
  const ms = typeof at === 'number' ? at : at.getTime()
  return deepseekBandForEpoch(ms, tzOffsetMin, holidays)
}

/** 三通道定价引擎：覆盖 > 全局 > 官方多厂商表 > 内置官方表（模型名经别名归一后再查内置表）。 */
export class CachePricingEngine {
  private readonly source: PricingSource
  private readonly aliases: Record<string, string>
  /** 0.10.0：官方多厂商缓存表（officialPricing 启用时注入；缺省 = 0.9.0 行为，零回归）。 */
  private readonly official: Record<string, RoutePricing>

  constructor(
    source: PricingSource = {},
    aliases: Record<string, string> = {},
    official: Record<string, RoutePricing> = {},
  ) {
    this.source = source
    this.aliases = aliases
    this.official = official
  }

  /** 解析某路由在某时段的三通道单价。 */
  resolve(route: string, band: CacheBand): BandPrice {
    return this.resolveWithSource(route, band).price
  }

  /** 解析单价并返回来源（'override' | 'builtin' | 'fallback'），供展示与测试。 */
  resolveWithSource(route: string, band: CacheBand): { price: BandPrice; source: 'override' | 'builtin' | 'fallback' } {
    const byRoute = this.source.byRoute ?? {}
    for (const key of [route, modelOf(route)]) {
      const rp = byRoute[key]
      if (rp) return { price: this.bandPriceOf(rp, band), source: 'override' }
    }
    if (this.source.global) return { price: this.bandPriceOf(this.source.global, band), source: 'override' }
    // 模型名别名归一：官方已下线但仍在使用的旧名路由到现行模型并按现行价计费
    const canonical = this.aliases[modelOf(route)] ?? modelOf(route)
    // 官方多厂商表（0.10.0）：officialPricing 启用时注入（含 DeepSeek 与全厂商，来源同注册表）
    const official = this.official[canonical]
    if (official) return { price: this.bandPriceOf(official, band), source: 'builtin' }
    const builtin = BUILTIN_CACHE_PRICES[canonical]
    if (builtin) return { price: this.bandPriceOf(builtin, band), source: 'builtin' }
    return { price: { ...FALLBACK_CACHE_PRICE }, source: 'fallback' }
  }

  /** 取路由某时段价格；该带缺失时回退另一带（配置宽容）。 */
  private bandPriceOf(rp: RoutePricing, band: CacheBand): BandPrice {
    const price = rp[band]
    if (price) return { ...price }
    // 该带未配置：回退另一带（高峰缺省用空闲价，反之亦然），保证不出现 NaN
    return { ...(band === 'peak' ? rp.idle : rp.peak) }
  }
}