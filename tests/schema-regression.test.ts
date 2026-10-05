import { describe, expect, test } from 'vitest'
import { Config } from '../src/index.js'

const base = { enabled: true, pricing: {}, budgets: {}, fallbackProvider: 'deepseek', fallbackModel: 'deepseek-chat' }

describe('Config schema 缺省兼容性（0.5.0 存量配置必须通过）', () => {
  test('完全缺省 cache：与 0.5.0 一致，不抛错', () => {
    const value = Config(base)
    expect(value.cache).toBeUndefined()
  })
  test('缺省 adaptive 的 monthLimit（接口允许回退 budgets.month）', () => {
    const value = Config({ ...base, budgets: { month: { limit: 200 } }, adaptive: { reserveRatio: 0.2 } })
    expect(value.adaptive?.reserveRatio).toBe(0.2)
  })
  test('cache.enabled=false 显式配置', () => {
    const value = Config({ ...base, cache: { enabled: false } })
    expect(value.cache?.enabled).toBe(false)
  })
  test('cache 完整配置通过', () => {
    const value = Config({
      ...base,
      cache: {
        enabled: true,
        priceOverride: {
          global: {
            idle: { inputHit: 0.5, inputMiss: 1, output: 8 },
            peak: { inputHit: 1, inputMiss: 2, output: 16 },
          },
        },
      },
    })
    expect(value.cache?.enabled).toBe(true)
    expect(value.cache?.priceOverride?.global?.idle.inputHit).toBe(0.5)
  })
})

describe('Config schema cache 只配 byRoute 场景', () => {
  test('priceOverride 只提供 byRoute（global 缺省）：不强制 global', () => {
    const value = Config({
      ...base,
      cache: {
        enabled: true,
        priceOverride: {
          byRoute: {
            'provider/model': {
              idle: { inputHit: 0.3, inputMiss: 1, output: 8 },
              peak: { inputHit: 0.6, inputMiss: 2, output: 16 },
            },
          },
        },
      },
    })
    expect(value.cache?.priceOverride?.byRoute?.['provider/model']?.idle.inputHit).toBe(0.3)
    expect(value.cache?.priceOverride?.global).toBeUndefined()
  })

  test('hint 缺省：不强制 minRepeat/minSaving', () => {
    const value = Config({ ...base, cache: { enabled: true, hint: undefined } })
    expect(value.cache?.enabled).toBe(true)
    expect(value.cache?.hint).toBeUndefined()
  })
})

describe('Config schema officialPricing（0.8.0）', () => {
  test('缺省 officialPricing：与 0.7.0 一致，输出 undefined（零回归）', () => {
    const value = Config(base)
    expect(value.officialPricing).toBeUndefined()
  })

  test('officialPricing.enabled=false 显式配置通过', () => {
    const value = Config({ ...base, officialPricing: { enabled: false } })
    expect(value.officialPricing?.enabled).toBe(false)
  })

  test('officialPricing 完整配置（含节假日追加）通过', () => {
    const value = Config({
      ...base,
      officialPricing: { enabled: true, holidays: ['2027-01-01'] },
    })
    expect(value.officialPricing?.enabled).toBe(true)
    expect(value.officialPricing?.holidays).toEqual(['2027-01-01'])
  })
})

describe('Config schema frontier（0.12.0 前沿套件）', () => {
  test('缺省 frontier：输出 undefined（零回归，与 0.11.0 一致）', () => {
    const value = Config(base)
    expect(value.frontier).toBeUndefined()
  })

  test('frontier 只配 focus（可选项两两独立）', () => {
    const value = Config({ ...base, frontier: { focus: { enabled: true } } })
    expect(value.frontier?.focus?.enabled).toBe(true)
    expect(value.frontier?.otel).toBeUndefined()
    expect(value.frontier?.unitEconomy).toBe(false)
    expect(value.frontier?.leverage).toBe(false)
  })

  test('frontier 全量配置通过', () => {
    const value = Config({
      ...base,
      frontier: { focus: { enabled: true }, otel: { enabled: true }, unitEconomy: true, leverage: true },
    })
    expect(value.frontier?.focus?.enabled).toBe(true)
    expect(value.frontier?.otel?.enabled).toBe(true)
    expect(value.frontier?.unitEconomy).toBe(true)
    expect(value.frontier?.leverage).toBe(true)
  })

  test('frontier 内各子项显式 false 通过（不强制 true）', () => {
    const value = Config({ ...base, frontier: { unitEconomy: false, leverage: false } })
    expect(value.frontier?.unitEconomy).toBe(false)
    expect(value.frontier?.leverage).toBe(false)
  })
})
