import { describe, it, expect } from 'vitest'
import {
  BUILTIN_CACHE_PRICES,
  FALLBACK_CACHE_PRICE,
  HOLIDAYS_2026,
  CachePricingEngine,
  deepseekBandAt,
  deepseekBandForEpoch,
  modelOf,
} from '../src/core/cache-pricing.js'
import type { RoutePricing } from '../src/core/cache-types.js'

/** 北京时间 helper：返回北京时刻对应 epoch ms（UTC+8）。 */
function bj(y: number, m: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) - 8 * 60 * 60 * 1000
}

describe('cache-pricing 三通道定价', () => {
  it('内置官方价表（表 2）：flash 与 v4-pro 空闲/高峰三通道价，高峰 = 空闲 × 2', () => {
    expect(BUILTIN_CACHE_PRICES['deepseek-flash']!.idle).toEqual({ inputHit: 0.02, inputMiss: 1.0, output: 4.0 })
    expect(BUILTIN_CACHE_PRICES['deepseek-flash']!.peak).toEqual({ inputHit: 0.04, inputMiss: 2.0, output: 8.0 })
    expect(BUILTIN_CACHE_PRICES['deepseek-v4-pro']!.idle).toEqual({ inputHit: 0.15, inputMiss: 4.5, output: 13.5 })
    expect(BUILTIN_CACHE_PRICES['deepseek-v4-pro']!.peak).toEqual({ inputHit: 0.3, inputMiss: 9.0, output: 27.0 })
    for (const key of ['deepseek-flash', 'deepseek-v4-pro'] as const) {
      expect(BUILTIN_CACHE_PRICES[key]!.peak.inputHit).toBeCloseTo(BUILTIN_CACHE_PRICES[key]!.idle.inputHit * 2)
      expect(BUILTIN_CACHE_PRICES[key]!.peak.inputMiss).toBeCloseTo(BUILTIN_CACHE_PRICES[key]!.idle.inputMiss * 2)
      expect(BUILTIN_CACHE_PRICES[key]!.peak.output).toBeCloseTo(BUILTIN_CACHE_PRICES[key]!.idle.output * 2)
    }
  })

  it('engine.resolve 按路由取内置价：provider/model 两种写法都命中 flash', () => {
    const engine = new CachePricingEngine()
    expect(engine.resolve('deepseek/deepseek-flash', 'idle')).toEqual(BUILTIN_CACHE_PRICES['deepseek-flash']!.idle)
    expect(engine.resolve('deepseek-flash', 'idle')).toEqual(BUILTIN_CACHE_PRICES['deepseek-flash']!.idle)
    expect(engine.resolve('deepseek/deepseek-v4-pro', 'peak')).toEqual(BUILTIN_CACHE_PRICES['deepseek-v4-pro']!.peak)
  })

  it('加载内置价的来源标记 source=builtin', () => {
    const engine = new CachePricingEngine()
    const r = engine.resolveWithSource('deepseek/deepseek-flash', 'idle')
    expect(r.source).toBe('builtin')
  })

  it('未知路由走保守兜底价（FALLBACK）且标记 source=fallback', () => {
    const engine = new CachePricingEngine()
    const r = engine.resolveWithSource('deepseek/deepseek-unknown', 'idle')
    expect(r.price).toEqual(FALLBACK_CACHE_PRICE)
    expect(r.source).toBe('fallback')
  })

  it('路由级覆盖优先于全局覆盖，全局覆盖优先于内置', () => {
    const override: RoutePricing = {
      idle: { inputHit: 0.01, inputMiss: 0.5, output: 2 },
      peak: { inputHit: 0.02, inputMiss: 1, output: 4 },
    }
    const global: RoutePricing = {
      idle: { inputHit: 0.03, inputMiss: 1.5, output: 6 },
      peak: { inputHit: 0.06, inputMiss: 3, output: 12 },
    }
    const eng = new CachePricingEngine({ byRoute: { 'deepseek/deepseek-chat': override }, global })
    // 路由键：provider/model 写法可被覆盖
    expect(eng.resolveWithSource('deepseek/deepseek-chat', 'idle').source).toBe('override')
    expect(eng.resolve('deepseek/deepseek-chat', 'idle')).toEqual(override.idle)
    // 未覆盖路由：回退全局
    expect(eng.resolveWithSource('deepseek/deepseek-flash', 'idle').source).toBe('override')
    expect(eng.resolve('deepseek/deepseek-flash', 'idle')).toEqual(global.idle)
  })

  it('裸 model 键覆盖 provider/model 路由（跨 provider 宽泛命中）', () => {
    const override: RoutePricing = {
      idle: { inputHit: 0.005, inputMiss: 0.25, output: 1 },
      peak: { inputHit: 0.01, inputMiss: 0.5, output: 2 },
    }
    const eng = new CachePricingEngine({ byRoute: { 'deepseek-chat': override } })
    expect(eng.resolveWithSource('deepseek/deepseek-chat', 'peak').source).toBe('override')
    expect(eng.resolve('deepseek/deepseek-chat', 'peak')).toEqual(override.peak)
    expect(eng.resolve('other/deepseek-chat', 'peak')).toEqual(override.peak)
  })

  it('时段缺省时回退另一带（宽容配置），不产生 NaN', () => {
    const onlyIdle = { idle: { inputHit: 0.5, inputMiss: 2, output: 8 } } as RoutePricing
    const eng = new CachePricingEngine({ byRoute: { 'deepseek/deepseek-chat': onlyIdle } })
    expect(eng.resolve('deepseek/deepseek-chat', 'peak')).toEqual(onlyIdle.idle)
  })

  it('modelOf 提取路由中的裸 model 名', () => {
    expect(modelOf('deepseek/deepseek-flash')).toBe('deepseek-flash')
    expect(modelOf('deepseek-flash')).toBe('deepseek-flash')
    expect(modelOf('a/b/c')).toBe('b/c')
  })
})

describe('cache-pricing 高峰时段判定', () => {
  it('上午边界：9:00 含进高峰，8:59 前与 12:00 起为空闲', () => {
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 8, 59), 480)).toBe('idle')
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 9, 0), 480)).toBe('peak')
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 11, 59), 480)).toBe('peak')
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 12, 0), 480)).toBe('idle')
  })

  it('下午边界：14:00 含进高峰，13:59 前与 18:00 起为空闲', () => {
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 13, 59), 480)).toBe('idle')
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 14, 0), 480)).toBe('peak')
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 17, 59), 480)).toBe('peak')
    expect(deepseekBandForEpoch(bj(2026, 9, 7, 18, 0), 480)).toBe('idle')
  })

  it('周末全天空闲（2026-10-03 周六）', () => {
    expect(deepseekBandForEpoch(bj(2026, 10, 3, 10, 0), 480)).toBe('idle')
    expect(deepseekBandForEpoch(bj(2026, 10, 3, 23, 0), 480)).toBe('idle')
  })

  it('法定节假日全天空闲（2026-10-05 国庆补假周一 10:00 应为 idle）', () => {
    expect(deepseekBandForEpoch(bj(2026, 10, 5, 10, 0), 480)).toBe('idle')
    // 假日表完整覆盖元旦/春节/清明/劳动/端午/中秋/国庆
    for (const h of ['2026-01-01', '2026-02-15', '2026-04-04', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-07']) {
      expect(HOLIDAYS_2026.has(h)).toBe(true)
    }
  })

  it('deepseekBandAt 接受 Date 与 epoch 且等价；非东八区按本地时刻判定', () => {
    const at = bj(2026, 9, 7, 15, 30)
    expect(deepseekBandAt(at, 480)).toBe('peak')
    expect(deepseekBandAt(new Date(at), 480)).toBe('peak')
    // UTC 周五 01:00：北京 9:00 周五 → peak；纽约周四 21:00 → idle
    const utcFriday = Date.UTC(2026, 8, 11, 1, 0)
    expect(deepseekBandForEpoch(utcFriday, 480)).toBe('peak')
    expect(deepseekBandForEpoch(utcFriday, -240)).toBe('idle')
  })

  it('跨午夜归属：凌晨请求发起时刻为空闲，不按日内切分', () => {
    expect(deepseekBandForEpoch(bj(2026, 9, 8, 0, 30), 480)).toBe('idle')
    expect(deepseekBandForEpoch(bj(2026, 9, 8, 6, 0), 480)).toBe('idle')
  })
})