import { describe, it, expect } from 'vitest'
import { cacheDiscountLeverOf, buildCacheDiscountLevers, outputLeverOf, buildOutputLevers } from '../src/core/leverage.js'

describe('cacheDiscountLeverOf 缓存折扣杠杆', () => {
  it('flash 级价差：miss 1.0 / hit 0.02 = 50x；全命中已省 98%（方案 7.2）', () => {
    const l = cacheDiscountLeverOf({ route: 'deepseek/deepseek-flash', missPrice: 1.0, hitPrice: 0.02, hitTokens: 1_000_000, missTokens: 0 })
    expect(l.discountX).toBeCloseTo(50, 6)
    expect(l.hitRate).toBe(1)
    expect(l.realizedSavingRate).toBeCloseTo(0.98, 6)
    expect(l.potentialSavingRate).toBeCloseTo(0.98, 6)
    expect(l.action).toContain('50.0x')
  })

  it('部分命中：realized 与 potential 分列（未命中转命中的可再省空间）', () => {
    const l = cacheDiscountLeverOf({ route: 'deepseek/deepseek-chat', missPrice: 1.0, hitPrice: 0.02, hitTokens: 300_000, missTokens: 700_000 })
    // 基线 = 1.0 元（全部未命中价）；实际 = 0.006 + 0.7 = 0.706；realized = 0.294
    // 全量命中 = 0.02 元；potential = 0.98
    expect(l.hitRate).toBeCloseTo(0.3, 6)
    expect(l.realizedSavingRate).toBeCloseTo(0.294, 6)
    expect(l.potentialSavingRate).toBeCloseTo(0.98, 6)
  })

  it('无价差（hit === miss）时 discountX=1 且不进入行动列表', () => {
    const l = cacheDiscountLeverOf({ route: 'p/m', missPrice: 2, hitPrice: 2, hitTokens: 100, missTokens: 100 })
    expect(l.discountX).toBe(1)
    expect(buildCacheDiscountLevers([{ route: 'p/m', missPrice: 2, hitPrice: 2, hitTokens: 100, missTokens: 100 }])).toEqual([])
  })

  it('排序：按潜在再省比例降序', () => {
    const list = buildCacheDiscountLevers([
      { route: 'p/low', missPrice: 1, hitPrice: 0.5, hitTokens: 0, missTokens: 100 },
      { route: 'p/high', missPrice: 1, hitPrice: 0.1, hitTokens: 0, missTokens: 100 },
    ])
    expect(list[0]!.route).toBe('p/high')
    expect(list[1]!.route).toBe('p/low')
  })

  it('零流量防御分支：无 token 时命中率 / 已省 / 可省均为安全值', () => {
    const l = cacheDiscountLeverOf({ route: 'p/m', missPrice: 2, hitPrice: 1, hitTokens: 0, missTokens: 0 })
    expect(l.hitRate).toBe(0)
    expect(l.realizedSavingRate).toBe(0)
    expect(l.potentialSavingRate).toBe(0)
    expect(l.discountX).toBe(2)
  })

  it('hit 价为零时折扣倍数回退 1（不进入行动名单）', () => {
    const l = cacheDiscountLeverOf({ route: 'p/m', missPrice: 1, hitPrice: 0, hitTokens: 10, missTokens: 10 })
    expect(l.discountX).toBe(1)
    expect(buildCacheDiscountLevers([{ route: 'p/m', missPrice: 1, hitPrice: 0, hitTokens: 10, missTokens: 10 }])).toEqual([])
  })
})

describe('outputLeverOf 输出杠杆', () => {
  it('输出/输入价差与输出成本占比；压缩 10% 输出可省金额（方案 7.3）', () => {
    const l = outputLeverOf({ route: 'deepseek/deepseek-chat', inputPrice: 1, outputPrice: 4, inputTokens: 1_000_000, outputTokens: 200_000 })
    expect(l.priceRatioX).toBe(4)
    // 输入成本 1.0 元 + 输出成本 0.8 元 = 1.8；输出占 44.4%
    expect(l.outputTokenShare).toBeCloseTo(200_000 / 1_200_000, 6)
    expect(l.outputCostShare).toBeCloseTo(0.8 / 1.8, 6)
    // 压缩 10% 输出：省 0.08 元
    expect(l.compress10pctSaving).toBeCloseTo(0.08, 6)
    expect(l.action).toContain('4.0x')
  })

  it('负向/零价差防御：ratio 保持 >= 0，可省金额不为负', () => {
    const l = outputLeverOf({ route: 'p/m', inputPrice: 4, outputPrice: 1, inputTokens: 1000, outputTokens: 1000 })
    expect(l.priceRatioX).toBeCloseTo(0.25, 6)
    expect(l.compress10pctSaving).toBeGreaterThanOrEqual(0)
  })

  it('compressRate 可调（默认 0.1）', () => {
    const l = outputLeverOf({ route: 'p/m', inputPrice: 1, outputPrice: 4, inputTokens: 1000, outputTokens: 1000, compressRate: 0.2 })
    expect(l.compress10pctSaving).toBeCloseTo((4 / 1_000_000 * 1000) * 0.2, 6)
  })

  it('输入价为零时价差回退 1；零流量占比为 0', () => {
    const l1 = outputLeverOf({ route: 'p/m', inputPrice: 0, outputPrice: 4, inputTokens: 0, outputTokens: 0 })
    expect(l1.priceRatioX).toBe(1)
    expect(l1.outputTokenShare).toBe(0)
    expect(l1.outputCostShare).toBe(0)
    expect(l1.compress10pctSaving).toBe(0)
  })

  it('compressRate 越界钳制到 [0,1]', () => {
    const l = outputLeverOf({ route: 'p/m', inputPrice: 1, outputPrice: 4, inputTokens: 1000, outputTokens: 1000, compressRate: 2 })
    expect(l.compress10pctSaving).toBeCloseTo((4 / 1_000_000 * 1000) * 1, 6)
  })
})

describe('buildOutputLevers', () => {
  it('按价表路由构建并按可省金额降序；无价路由跳过', () => {
    const levers = buildOutputLevers(
      {
        'deepseek/deepseek-chat': { cost: 2, inputTokens: 1_000_000, outputTokens: 500_000 },
        'deepseek/deepseek-flash': { cost: 1, inputTokens: 1_000_000, outputTokens: 100_000 },
        'p/unknown': { cost: 1, inputTokens: 1000, outputTokens: 1000 },
      },
      {
        'deepseek/deepseek-chat': { inputPerMillion: 1, cacheReadPerMillion: 0, outputPerMillion: 4 },
        'deepseek/deepseek-flash': { inputPerMillion: 1, cacheReadPerMillion: 0, outputPerMillion: 2 },
      },
    )
    expect(levers).toHaveLength(2)
    expect(levers[0]!.route).toBe('deepseek/deepseek-chat')
    // chat 输出可省 = 4 * 0.5M / 1M * 0.1 = 0.2；flash = 2 * 0.1M / 1M * 0.1 = 0.02
    expect(levers[0]!.compress10pctSaving).toBeCloseTo(0.2, 6)
    expect(levers[1]!.compress10pctSaving).toBeCloseTo(0.02, 6)
  })
})