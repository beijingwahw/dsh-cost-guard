import { describe, it, expect } from 'vitest'
import {
  OFFICIAL_IDLE_PRICES,
  OFFICIAL_MODEL_ALIASES,
  OFFICIAL_MODEL_REGISTRY,
  PEAK_MULTIPLIER,
  baichuanBandForEpoch,
  buildOfficialCachePricingTable,
  buildOfficialPricingTable,
  canonicalModel,
  officialBandForEpoch,
  officialBandForEpochOf,
  officialCurrencyOf,
  officialEntryPrice,
  officialIdlePriceOf,
  officialModelMetaOf,
  officialModelStatusOf,
  officialPeakPolicyOf,
  officialPriceForInstance,
  officialProviderOf,
  officialSourceLevelOf,
  officialVerifiedAtOf,
  ReasoningLedger,
  type OfficialModelMeta,
} from '../src/core/official-pricing.js'
import { buildPricingTable, computeCost, FALLBACK_PRICE } from '../src/core/pricing.js'

// 官方峰值判定用固定时刻（+08 时区）：
//   工作日 2026-09-14（周一）10:00 前段高峰 / 13:00 午间空闲 / 15:00 后段高峰
const MON = Date.UTC(2026, 8, 14)
const PEAK_TIME = MON + 2 * 3600_000 // 10:00 +08
const IDLE_TIME = MON + 5 * 3600_000 // 13:00 +08
const TZ = 480

describe('official-pricing.价目表', () => {
  it('内置官方 idle 价与官方定价页一致', () => {
    // deepseek-flash：输入命中 0.02 / 未命中 1 / 输出 4
    expect(OFFICIAL_IDLE_PRICES['deepseek-flash']).toEqual({
      inputPerMillion: 1,
      cacheReadPerMillion: 0.02,
      outputPerMillion: 4,
    })
    // deepseek-v4-pro：0.15 / 4.5 / 13.5
    expect(OFFICIAL_IDLE_PRICES['deepseek-v4-pro']).toEqual({
      inputPerMillion: 4.5,
      cacheReadPerMillion: 0.15,
      outputPerMillion: 13.5,
    })
  })

  it('高峰 = 空闲 × 2（PEAK_MULTIPLIER）', () => {
    expect(PEAK_MULTIPLIER).toBe(2)
    const idle = officialIdlePriceOf('deepseek-flash')!
    const peak = officialPriceForInstance('deepseek-flash', 'peak')!
    expect(peak.inputPerMillion).toBeCloseTo(idle.inputPerMillion * PEAK_MULTIPLIER, 9)
    expect(peak.cacheReadPerMillion).toBeCloseTo(idle.cacheReadPerMillion * PEAK_MULTIPLIER, 9)
    expect(peak.outputPerMillion).toBeCloseTo(idle.outputPerMillion * PEAK_MULTIPLIER, 9)
  })

  it('未收录模型返回 undefined（不臆造官方价）', () => {
    expect(officialIdlePriceOf('not-a-model')).toBeUndefined()
    expect(officialPriceForInstance('not-a-model', 'peak')).toBeUndefined()
  })

  it('buildOfficialPricingTable 并入官方价且用户覆盖优先', () => {
    const table = buildOfficialPricingTable({
      'deepseek-flash': { inputPerMillion: 9, cacheReadPerMillion: 8, outputPerMillion: 7 },
    })
    expect(table['deepseek-flash']!.outputPerMillion).toBe(7) // 用户覆盖优先
    expect(table['deepseek-v4-pro']!.outputPerMillion).toBeCloseTo(13.5, 9) // 官方价并入
  })
})

describe('official-pricing.别名归一', () => {
  it('官方已下线旧名归一到 flash', () => {
    expect(canonicalModel('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(canonicalModel('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash')
    expect(canonicalModel('deepseek-flash')).toBe('deepseek-flash')
  })

  it('别名表与官方口径一致', () => {
    expect(OFFICIAL_MODEL_ALIASES['deepseek-v4-flash']).toBe('deepseek-flash')
    expect(OFFICIAL_MODEL_ALIASES['deepseek-v4-flash-vision-exp']).toBe('deepseek-flash')
  })
})

describe('official-pricing.官方峰谷', () => {
  it('工作日高峰时段 -> peak', () => {
    expect(officialBandForEpoch(PEAK_TIME, TZ)).toBe('peak')
  })

  it('工作日午间 -> idle', () => {
    expect(officialBandForEpoch(IDLE_TIME, TZ)).toBe('idle')
  })

  it('2026 法定节假日（国庆 10-05）全天 -> idle', () => {
    const holidayPeak = Date.UTC(2026, 9, 5) + 2 * 3600_000 // 国庆 10:00 +08
    expect(officialBandForEpoch(holidayPeak, TZ)).toBe('idle')
  })

  it('周末全天 -> idle 且不因带内时间翻高峰', () => {
    const sat = Date.UTC(2026, 8, 19) + 2 * 3600_000 // 周六 10:00 +08
    expect(officialBandForEpoch(sat, TZ)).toBe('idle')
  })

  it('用户追加节假日可覆盖工作日（2027 未发布场景）', () => {
    const extra = new Set(['2026-09-14']) // 把周一标为假日
    expect(officialBandForEpoch(PEAK_TIME, TZ, extra)).toBe('idle')
  })
})

describe('official-pricing.取价优先级', () => {
  it('官方模型 -> official 分带价', () => {
    const r = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-flash' }, 'peak')
    expect(r.source).toBe('official')
    expect(r.price.inputPerMillion).toBeCloseTo(2, 9) // idle 1 × 2
  })

  it('用户覆盖（最终单价）优先且不随峰谷翻倍', () => {
    const overrides = {
      'deepseek-flash': { inputPerMillion: 0.8, cacheReadPerMillion: 0.01, outputPerMillion: 3.2 },
    }
    const r = officialEntryPrice(overrides, { provider: 'deepseek', model: 'deepseek-flash' }, 'peak')
    expect(r.source).toBe('override')
    expect(r.price.inputPerMillion).toBeCloseTo(0.8, 9) // 不 ×2
  })

  it('旧模型名归一到官方价（不再命中保守兜底）', () => {
    const r = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-v4-flash' }, 'idle')
    expect(r.source).toBe('official')
    expect(r.price.inputPerMillion).toBeCloseTo(1, 9)
  })

  it('非官方模型回退基准价表（builtin），兜底价仅当基准表也无', () => {
    const base = buildPricingTable({})
    const chat = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-chat' }, 'peak', base)
    expect(chat.source).toBe('builtin') // deepseek-chat 在旧内置表
    expect(chat.price.inputPerMillion).toBeCloseTo(2, 9)
    const unknown = officialEntryPrice({}, { provider: 'deepseek', model: 'no-such' }, 'peak', base)
    expect(unknown.source).toBe('fallback')
    expect(unknown.price).toEqual(FALLBACK_PRICE)
  })
})

describe('official-pricing.推理账本', () => {
  function entry(model: string, output: number, reasoning: number) {
    return {
      time: 1,
      route: { provider: 'deepseek', model },
      usage: { inputTokens: 0, outputTokens: output },
      cacheReadTokens: 0,
      reasoningTokens: reasoning,
      cost: 0,
      credits: 0,
      totalTokens: output,
      band: 'idle',
    }
  }

  it('无推理样本时 summary 为 null', () => {
    const ledger = new ReasoningLedger(() => 4)
    ledger.append(entry('deepseek-flash', 100, 0))
    expect(ledger.summary()).toBeNull()
  })

  it('累计推理 tokens / 占比 / 成本（按官方空闲输出价）', () => {
    const ledger = new ReasoningLedger((model) => OFFICIAL_IDLE_PRICES[canonicalModel(model)]?.outputPerMillion ?? 0)
    ledger.append(entry('deepseek-flash', 1000, 200)) // 200×4/1e6
    ledger.append(entry('deepseek-v4-flash', 3000, 600)) // 归一 flash：600×4/1e6
    const s = ledger.summary()
    expect(s).not.toBeNull()
    expect(s!.requests).toBe(2)
    expect(s!.reasoningTokens).toBe(800)
    expect(s!.outputTokens).toBe(4000)
    expect(s!.share).toBeCloseTo(0.2, 9) // 800/4000
    expect(s!.avgPerRequest).toBe(400)
    expect(s!.cost).toBeCloseTo((800 * 4) / 1e6, 9)
  })

  it('用户输出价覆盖优先于官方价', () => {
    const ledger = new ReasoningLedger(() => 13.5) // v4-pro 官方输出价
    ledger.append({ ...entry('deepseek-v4-pro', 1000, 500), route: { provider: 'deepseek', model: 'deepseek-v4-pro' } })
    expect(ledger.summary()!.cost).toBeCloseTo((500 * 13.5) / 1e6, 9)
  })

  it('reset 后清空', () => {
    const ledger = new ReasoningLedger(() => 4)
    ledger.append(entry('deepseek-flash', 100, 100))
    ledger.reset()
    expect(ledger.summary()).toBeNull()
  })
})

describe('official-pricing.全模型注册表（0.9.0 → 0.10.0 多厂商）', () => {
  it('登记 DeepSeek 官方全部 7 个模型名 + 世界主流模型（OpenAI/Anthropic/Google/Mistral/Meta）', () => {
    const keys = Object.keys(OFFICIAL_MODEL_REGISTRY).sort()
    // DeepSeek 7 条完整保留（零回归）
    expect(
      [
        'deepseek-flash',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
        'deepseek-chat',
        'deepseek-reasoner',
        'deepseek-coder',
      ].every((m) => keys.includes(m)),
    ).toBe(true)
    // 多厂商主流模型已登记
    expect(keys).toContain('gpt-6-astra')
    expect(keys).toContain('gpt-6.1-sol')
    expect(keys).toContain('gpt-5.5')
    expect(keys).toContain('claude-opus-5.5')
    expect(keys).toContain('claude-sonnet-5.5')
    expect(keys).toContain('claude-haiku-4.5')
    expect(keys).toContain('gemini-3.7-flash')
    expect(keys).toContain('gemini-3.5-flash')
    expect(keys).toContain('mistral-large-3')
    expect(keys).toContain('mistral-small-3.2')
    expect(keys).toContain('llama-4-maverick')
    // 各厂商 provider 字段正确
    expect(OFFICIAL_MODEL_REGISTRY['gpt-6-astra']?.provider).toBe('openai')
    expect(OFFICIAL_MODEL_REGISTRY['claude-opus-5.5']?.provider).toBe('anthropic')
    expect(OFFICIAL_MODEL_REGISTRY['gemini-3.7-flash']?.provider).toBe('google')
    expect(OFFICIAL_MODEL_REGISTRY['mistral-large-3']?.provider).toBe('mistral')
    expect(OFFICIAL_MODEL_REGISTRY['llama-4-maverick']?.provider).toBe('meta')
  })

  it('状态字段约束：active/legacy 有官方价、routed 有路由目标、decommissioned 有停用日期与迁移建议、oss 无官方价', () => {
    const entries = Object.entries(OFFICIAL_MODEL_REGISTRY)
    expect(entries.length).toBeGreaterThan(30)
    for (const [, meta] of entries) {
      if (meta.status === 'active' || meta.status === 'legacy') {
        expect(meta.idle).toBeDefined()
        expect(meta.routesTo).toBeUndefined()
        expect(meta.decommissionedAt).toBeUndefined()
        expect(meta.provider).toBeDefined()
        expect(meta.currency).toBeDefined()
        expect(meta.peakPolicy).toBeDefined()
        expect(meta.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      } else if (meta.status === 'routed') {
        expect(meta.routesTo).toBeDefined()
        expect(meta.idle).toBeUndefined()
        expect(meta.decommissionedAt).toBeUndefined()
      } else if (meta.status === 'decommissioned') {
        expect(meta.decommissionedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(meta.migrateTo).toBeDefined()
        expect(meta.idle).toBeUndefined()
        expect(meta.routesTo).toBeUndefined()
      } else {
        expect(meta.status).toBe('oss')
        expect(meta.idle).toBeUndefined() // 开源权重不虚构官方托管价
      }
    }
    // 在售两 DeepSeek 模型官方价（2026-09-10 生效，零回归锚点）
    expect(OFFICIAL_MODEL_REGISTRY['deepseek-flash']?.idle).toEqual({
      inputPerMillion: 1,
      cacheReadPerMillion: 0.02,
      outputPerMillion: 4,
    })
    expect(OFFICIAL_MODEL_REGISTRY['deepseek-v4-pro']?.idle).toEqual({
      inputPerMillion: 4.5,
      cacheReadPerMillion: 0.15,
      outputPerMillion: 13.5,
    })
    // 多厂商价目（官方核对锚点）
    expect(OFFICIAL_MODEL_REGISTRY['claude-opus-5.5']?.idle).toEqual({
      inputPerMillion: 4,
      cacheReadPerMillion: 0.2,
      outputPerMillion: 20,
      cacheWritePerMillion: 5,
    })
    expect(OFFICIAL_MODEL_REGISTRY['gemini-3.7-flash']?.idle).toEqual({
      inputPerMillion: 0.75,
      cacheReadPerMillion: 0.075,
      outputPerMillion: 3.75,
    })
  })

  it('派生导出与注册表一致：价目表 = active/legacy 条目、别名表 = routed 条目', () => {
    // OFFICIAL_IDLE_PRICES 恰好等于注册表中 active/legacy 且有 idle 的条目
    const expectedIdle: Record<string, unknown> = {}
    for (const [name, meta] of Object.entries(OFFICIAL_MODEL_REGISTRY)) {
      if ((meta.status === 'active' || meta.status === 'legacy') && meta.idle !== undefined) expectedIdle[name] = meta.idle
    }
    expect(OFFICIAL_IDLE_PRICES).toEqual(expectedIdle)
    // OFFICIAL_MODEL_ALIASES 恰好等于注册表中 routed 条目的映射
    const expectedAlias: Record<string, string> = {}
    for (const [name, meta] of Object.entries(OFFICIAL_MODEL_REGISTRY)) {
      if (meta.status === 'routed' && meta.routesTo !== undefined) expectedAlias[name] = meta.routesTo
    }
    expect(OFFICIAL_MODEL_ALIASES).toEqual(expectedAlias)
    // 派生后数值仍与官方价一致（零回归锚点）
    expect(OFFICIAL_IDLE_PRICES['deepseek-flash']?.outputPerMillion).toBeCloseTo(4, 9)
    expect(OFFICIAL_IDLE_PRICES['deepseek-v4-pro']?.inputPerMillion).toBeCloseTo(4.5, 9)
    expect(OFFICIAL_IDLE_PRICES['claude-opus-5.5']?.cacheWritePerMillion).toBeCloseTo(5, 9)
  })

  it('状态查询：在售 / 下线路由 / 已停用 / 未登记', () => {
    expect(officialModelStatusOf('deepseek-flash')).toBe('active')
    expect(officialModelStatusOf('deepseek-v4-pro')).toBe('active')
    expect(officialModelStatusOf('deepseek-v4-flash')).toBe('routed')
    expect(officialModelStatusOf('deepseek-v4-flash-vision-exp')).toBe('routed')
    expect(officialModelStatusOf('deepseek-chat')).toBe('decommissioned')
    expect(officialModelStatusOf('deepseek-reasoner')).toBe('decommissioned')
    expect(officialModelStatusOf('deepseek-coder')).toBe('decommissioned')
    expect(officialModelStatusOf('not-a-model')).toBeUndefined()
    const chat: OfficialModelMeta | undefined = officialModelMetaOf('deepseek-chat')
    expect(chat?.decommissionedAt).toBe('2026-07-24')
    expect(chat?.migrateTo).toContain('deepseek-flash')
  })

  it('已停用模型无官方价（不虚构），取价回落内置价表/兜底', () => {
    const base = buildPricingTable({})
    for (const model of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']) {
      expect(officialIdlePriceOf(model)).toBeUndefined()
      expect(officialPriceForInstance(model, 'peak')).toBeUndefined()
    }
    // deepseek-chat / deepseek-reasoner 在内置价表 → builtin（与 0.8.0 一致）
    const chat = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-chat' }, 'peak', base)
    expect(chat.source).toBe('builtin')
    expect(chat.price.inputPerMillion).toBeCloseTo(2, 9)
    const reasoner = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-reasoner' }, 'peak', base)
    expect(reasoner.source).toBe('builtin')
    expect(reasoner.price.outputPerMillion).toBeCloseTo(16, 9)
    // deepseek-coder 不在内置价表 → 保守兜底
    const coder = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-coder' }, 'peak', base)
    expect(coder.source).toBe('fallback')
    expect(coder.price).toEqual(FALLBACK_PRICE)
  })

  it('routed 模型仍按目标模型官方价计费（不受注册表改动影响）', () => {
    const r = officialEntryPrice({}, { provider: 'deepseek', model: 'deepseek-v4-flash' }, 'peak')
    expect(r.source).toBe('official')
    expect(r.price.inputPerMillion).toBeCloseTo(2, 9) // flash 空闲 1 × 2
    expect(officialModelStatusOf('deepseek-v4-flash')).toBe('routed')
  })
})

/* —— 0.10.0 多厂商官方计价深度同步 —— */
describe('official-pricing.多厂商官方计价（0.10.0）', () => {
  it('OpenAI：flat 恒定价，peak = idle（时段不影响价格）', () => {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5-pro']) {
      const idle = officialPriceForInstance(model, 'idle')
      const peak = officialPriceForInstance(model, 'peak')
      expect(idle).toBeDefined()
      expect(peak).toEqual(idle)
    }
    // 官方价目数值锚点（官方媒体/官方同源页交叉，2026-10-05 核对）
    expect(officialIdlePriceOf('gpt-6-astra')).toEqual({ inputPerMillion: 10, cacheReadPerMillion: 1, outputPerMillion: 50 })
    expect(officialIdlePriceOf('gpt-6.1-sol')).toEqual({ inputPerMillion: 2, cacheReadPerMillion: 0.1, outputPerMillion: 10 })
    expect(officialIdlePriceOf('gpt-6-luna')).toEqual({ inputPerMillion: 0.1, cacheReadPerMillion: 0.01, outputPerMillion: 0.5 })
    expect(officialIdlePriceOf('gpt-5.5')).toEqual({ inputPerMillion: 5, cacheReadPerMillion: 0.5, outputPerMillion: 30 })
  })

  it('Anthropic：在售含缓存读/写双价；Legacy 档仍在售并登记 legacy 状态', () => {
    // 在售：Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 4.5（官方页直抓，2026-10-05）
    expect(officialIdlePriceOf('claude-fable-5.1')).toEqual({ inputPerMillion: 10, cacheReadPerMillion: 0.25, outputPerMillion: 50, cacheWritePerMillion: 12.5 })
    expect(officialIdlePriceOf('claude-opus-5.5')).toEqual({ inputPerMillion: 4, cacheReadPerMillion: 0.2, outputPerMillion: 20, cacheWritePerMillion: 5 })
    expect(officialIdlePriceOf('claude-sonnet-5.5')).toEqual({ inputPerMillion: 2, cacheReadPerMillion: 0.2, outputPerMillion: 10, cacheWritePerMillion: 2.5 })
    expect(officialIdlePriceOf('claude-haiku-4.5')).toEqual({ inputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 5, cacheWritePerMillion: 1.25 })
    // Legacy 区：官方仍列价，缓存读写具体值未核实 → 按输入价保守（不虚构）
    expect(officialModelStatusOf('claude-sonnet-5')).toBe('legacy')
    expect(officialIdlePriceOf('claude-sonnet-5')).toEqual({ inputPerMillion: 2, cacheReadPerMillion: 2, outputPerMillion: 10 })
    expect(officialIdlePriceOf('claude-opus-4.5')).toEqual({ inputPerMillion: 5, cacheReadPerMillion: 5, outputPerMillion: 25 })
    expect(officialModelStatusOf('claude-opus-5')).toBe('legacy')
  })

  it('Google：在售按官方/聚合价登记；2.5 系列官方 shutdown 已停用', () => {
    expect(officialIdlePriceOf('gemini-3.7-flash')).toEqual({ inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 })
    expect(officialIdlePriceOf('gemini-3.6-flash')!.inputPerMillion).toBeCloseTo(0.75, 9)
    expect(officialIdlePriceOf('gemini-3.5-flash')!.outputPerMillion).toBeCloseTo(9, 9)
    expect(officialIdlePriceOf('gemini-3.5-flash-lite')).toEqual({ inputPerMillion: 0.3, cacheReadPerMillion: 0.3, outputPerMillion: 2.5 })
    expect(officialIdlePriceOf('gemini-3.1-pro')).toEqual({ inputPerMillion: 2, cacheReadPerMillion: 0.2, outputPerMillion: 12 })
    // 2.5 系列官方 2026-10 shutdown → decommissioned，无价
    for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']) {
      expect(officialModelStatusOf(model)).toBe('decommissioned')
      expect(officialIdlePriceOf(model)).toBeUndefined()
    }
  })

  it('Mistral：官方站不可达，价目按公开聚合登记（aggregated）；Meta 开源无官方价（oss）', () => {
    expect(officialIdlePriceOf('mistral-large-3')).toEqual({ inputPerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 1.5 })
    expect(officialIdlePriceOf('mistral-small-3.2')).toEqual({ inputPerMillion: 0.1, cacheReadPerMillion: 0.1, outputPerMillion: 0.3 })
    expect(OFFICIAL_MODEL_REGISTRY['mistral-large-3']?.sourceLevel).toBe('aggregated')
    // Meta 开源：只登记状态，不虚构官方托管价
    expect(officialModelStatusOf('llama-4-maverick')).toBe('oss')
    expect(officialIdlePriceOf('llama-4-maverick')).toBeUndefined()
    expect(officialModelStatusOf('llama-3.3-70b')).toBe('oss')
  })

  it('元数据查询：provider / currency / peakPolicy / sourceLevel / verifiedAt', () => {
    expect(officialProviderOf('gpt-6-astra')).toBe('openai')
    expect(officialCurrencyOf('gpt-6-astra')).toBe('USD')
    expect(officialPeakPolicyOf('gpt-6-astra')).toBe('flat')
    expect(officialProviderOf('deepseek-flash')).toBe('deepseek')
    expect(officialCurrencyOf('deepseek-flash')).toBe('CNY')
    expect(officialPeakPolicyOf('deepseek-flash')).toBe('dsn-peak')
    expect(officialSourceLevelOf('claude-opus-5.5')).toBe('official')
    expect(officialVerifiedAtOf('gemini-3.7-flash')).toBe('2026-10-05')
    // 未登记模型不臆造
    expect(officialProviderOf('no-such-model')).toBeUndefined()
    expect(officialCurrencyOf('no-such-model')).toBeUndefined()
  })

  it('多厂商用户覆盖优先：按 provider/model 键覆盖官方价且不随时段变化', () => {
    const overrides = {
      'openai/gpt-6-astra': { inputPerMillion: 1.5, cacheReadPerMillion: 0.15, outputPerMillion: 7.5 },
    }
    const r = officialEntryPrice(overrides, { provider: 'openai', model: 'gpt-6-astra' }, 'peak')
    expect(r.source).toBe('override')
    expect(r.price.inputPerMillion).toBeCloseTo(1.5, 9)
  })

  it('官方缓存表派生：flat 厂商 peak=idle、dsn-peak 厂商 peak=idle×2、legacy 在售进表、停用/开源不进表', () => {
    const table = buildOfficialCachePricingTable()
    expect(table['gpt-6-astra']).toEqual({ idle: { inputHit: 1, inputMiss: 10, output: 50 }, peak: { inputHit: 1, inputMiss: 10, output: 50 } })
    expect(table['deepseek-flash']!.peak.inputMiss).toBeCloseTo(2, 9)
    expect(table['claude-sonnet-5']).toBeDefined() // legacy 在售进缓存表
    expect(table['gemini-2.5-flash']).toBeUndefined()
    expect(table['llama-4-maverick']).toBeUndefined()
  })

  it('缓存写价：Anthropic cacheWrite 参与成本折算；未配置写价的模型零回归', () => {
    const opus = OFFICIAL_IDLE_PRICES['claude-opus-5.5']!
    expect(opus.cacheWritePerMillion).toBe(5)
    // 1M 写 token 单独计 $5（与输入/缓存读/输出独立）
    const costWithWrite = computeCost(opus, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 })
    expect(costWithWrite).toBeCloseTo(5, 9)
    // DeepSeek 无写价：即使传写 token 也不加算（零回归锚点）
    const flash = OFFICIAL_IDLE_PRICES['deepseek-flash']!
    const costDs = computeCost(flash, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 })
    expect(costDs).toBeCloseTo(1, 9) // 仅输入 1M × 1
  })
})

/* —— 0.11.0 国内主流模型官方计价深度同步 —— */
describe('official-pricing.国内主流模型官方计价（0.11.0）', () => {
  it('登记国内主流厂商模型：智谱 GLM / 阿里 Qwen / 字节豆包 / 月之暗面 Kimi / 百度 ERNIE / 百川 / MiniMax / 阶跃 / 讯飞星火', () => {
    const keys = Object.keys(OFFICIAL_MODEL_REGISTRY).sort()
    // 每家厂商代表模型已登记（官方定价页，2026-10-05 核对）
    const domestic = [
      'glm-5.3', 'glm-5.3-flash', 'glm-4.5-air', // 智谱
      'qwen3.8-max', 'qwen3.8-flash', 'qwen3.5-plus', 'qwen3-max', 'qwen-long', // 阿里
      'doubao-seed-2.1-pro', 'doubao-seed-2.1-turbo', // 豆包
      'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', // Kimi
      'ernie-5.0', 'ernie-4.5-turbo-128k', // 百度
      'baichuan-m3-plus', 'baichuan2-53b', // 百川
      'minimax-m3', 'minimax-m2.7', // MiniMax
      'step-5-preview', 'step-3.5-flash', // 阶跃
      'spark-x2.5', 'spark-x2', // 讯飞
    ]
    for (const m of domestic) expect(keys).toContain(m)
    // provider 字段正确
    expect(OFFICIAL_MODEL_REGISTRY['glm-5.3']?.provider).toBe('zhipu')
    expect(OFFICIAL_MODEL_REGISTRY['qwen3.8-max']?.provider).toBe('qwen')
    expect(OFFICIAL_MODEL_REGISTRY['doubao-seed-2.1-pro']?.provider).toBe('doubao')
    expect(OFFICIAL_MODEL_REGISTRY['kimi-k3']?.provider).toBe('kimi')
    expect(OFFICIAL_MODEL_REGISTRY['ernie-5.0']?.provider).toBe('ernie')
    expect(OFFICIAL_MODEL_REGISTRY['baichuan2-53b']?.provider).toBe('baichuan')
    expect(OFFICIAL_MODEL_REGISTRY['minimax-m3']?.provider).toBe('minimax')
    expect(OFFICIAL_MODEL_REGISTRY['step-5-preview']?.provider).toBe('stepfun')
    expect(OFFICIAL_MODEL_REGISTRY['spark-x2.5']?.provider).toBe('spark')
    // 国内厂商全部：active、CNY、official、2026-10-05 核对
    const cnyDomestic = keys.map((m) => OFFICIAL_MODEL_REGISTRY[m])
    for (const meta of cnyDomestic) {
      if (['zhipu', 'qwen', 'doubao', 'kimi', 'ernie', 'baichuan', 'minimax', 'stepfun', 'spark'].includes(meta.provider)) {
        expect(meta.status).toBe('active')
        expect(meta.currency).toBe('CNY')
        expect(meta.sourceLevel).toBe('official')
        expect(meta.verifiedAt).toBe('2026-10-05')
      }
    }
  })

  it('智谱 GLM：官方价一字对齐（8/28/2 与 0.8/2.8/0.23），flat 恒定价', () => {
    expect(officialIdlePriceOf('glm-5.3')).toEqual({ inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28 })
    expect(officialIdlePriceOf('glm-5.3-flash')).toEqual({ inputPerMillion: 0.8, cacheReadPerMillion: 0.23, outputPerMillion: 2.8 })
    expect(officialIdlePriceOf('glm-5.2')).toEqual({ inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28 })
    expect(officialIdlePriceOf('glm-4.5-air')).toEqual({ inputPerMillion: 0.8, cacheReadPerMillion: 0.16, outputPerMillion: 2 })
    expect(officialPriceForInstance('glm-5.3', 'peak')).toEqual(officialPriceForInstance('glm-5.3', 'idle'))
    expect(officialPeakPolicyOf('glm-5.3')).toBe('flat')
  })

  it('阿里 Qwen：Qwen3.8-Max 12/36/1.5、Flash 含显式缓存创建 1.25（2026-08-27 下调）', () => {
    expect(officialIdlePriceOf('qwen3.8-max')).toEqual({ inputPerMillion: 12, cacheReadPerMillion: 1.5, outputPerMillion: 36 })
    expect(officialIdlePriceOf('qwen3.8-flash')).toEqual({ inputPerMillion: 0.8, cacheReadPerMillion: 0.1, outputPerMillion: 2.7, cacheWritePerMillion: 1.25 })
    expect(officialIdlePriceOf('qwen3.5-plus')).toEqual({ inputPerMillion: 0.8, cacheReadPerMillion: 0.08, outputPerMillion: 4.8, cacheWritePerMillion: 1 })
    expect(officialIdlePriceOf('qwen3-max')).toEqual({ inputPerMillion: 2.5, cacheReadPerMillion: 2.5, outputPerMillion: 10 })
    expect(officialIdlePriceOf('qwen-long')).toEqual({ inputPerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 2 })
  })

  it('Kimi：K3 缓存写 5min 档 20（1h 档 40 note）、K2.7-code 命中 1.30/未命中 6.50/输出 27.00', () => {
    expect(officialIdlePriceOf('kimi-k3')).toEqual({ inputPerMillion: 20, cacheReadPerMillion: 2, outputPerMillion: 100, cacheWritePerMillion: 20 })
    expect(officialIdlePriceOf('kimi-k2.7-code')).toEqual({ inputPerMillion: 6.5, cacheReadPerMillion: 1.3, outputPerMillion: 27 })
    expect(officialIdlePriceOf('kimi-k2.7-code-highspeed')).toEqual({ inputPerMillion: 13, cacheReadPerMillion: 2.6, outputPerMillion: 54 })
    expect(officialIdlePriceOf('kimi-k2.6')).toEqual({ inputPerMillion: 6.5, cacheReadPerMillion: 1.1, outputPerMillion: 27 })
    expect(officialModelMetaOf('kimi-k3')?.note).toContain('1h 档 40')
  })

  it('豆包 / MiniMax：存储按小时另计不入单价；M2.7 缓存写 2.625', () => {
    expect(officialIdlePriceOf('doubao-seed-2.1-pro')).toEqual({ inputPerMillion: 6, cacheReadPerMillion: 1.2, outputPerMillion: 30 })
    expect(officialIdlePriceOf('doubao-seed-2.1-turbo')).toEqual({ inputPerMillion: 3, cacheReadPerMillion: 0.6, outputPerMillion: 15 })
    expect(officialModelMetaOf('doubao-seed-2.1-pro')?.note).toContain('0.017')
    expect(officialIdlePriceOf('minimax-m3')).toEqual({ inputPerMillion: 2.1, cacheReadPerMillion: 0.42, outputPerMillion: 8.4 })
    expect(officialIdlePriceOf('minimax-m2.7')).toEqual({ inputPerMillion: 2.1, cacheReadPerMillion: 0.42, outputPerMillion: 8.4, cacheWritePerMillion: 2.625 })
    expect(OFFICIAL_MODEL_REGISTRY['minimax-m3']?.note).toContain('五折')
  })

  it('百川 / 百度：官方「元/千 tokens」×1000 折算每百万；缓存价未公开按输入价保守', () => {
    // 百川：0.005/0.009 元每千 → 5/9 元每百万
    expect(officialIdlePriceOf('baichuan-m3-plus')).toEqual({ inputPerMillion: 5, cacheReadPerMillion: 5, outputPerMillion: 9 })
    expect(officialIdlePriceOf('baichuan-m3')).toEqual({ inputPerMillion: 10, cacheReadPerMillion: 10, outputPerMillion: 30 })
    expect(officialIdlePriceOf('baichuan4-turbo')).toEqual({ inputPerMillion: 15, cacheReadPerMillion: 15, outputPerMillion: 15 })
    expect(officialIdlePriceOf('baichuan4')).toEqual({ inputPerMillion: 100, cacheReadPerMillion: 100, outputPerMillion: 100 })
    expect(officialModelMetaOf('baichuan-m3-plus')?.note).toContain('医疗搜索')
    // 百度：0.006-0.01 元每千 → 6-10 元每百万（主档登记下限 6/24）
    expect(officialIdlePriceOf('ernie-5.0')).toEqual({ inputPerMillion: 6, cacheReadPerMillion: 6, outputPerMillion: 24 })
    expect(officialIdlePriceOf('ernie-x1.1-preview')).toEqual({ inputPerMillion: 1, cacheReadPerMillion: 1, outputPerMillion: 4 })
    expect(officialIdlePriceOf('ernie-4.5-turbo-128k')).toEqual({ inputPerMillion: 0.8, cacheReadPerMillion: 0.8, outputPerMillion: 3.2 })
    expect(officialModelMetaOf('ernie-5.0')?.note).toContain('阶梯区间')
  })

  it('百川 Baichuan2-53B：国内唯一官方峰谷（0-8 点低谷 10、8-24 点高峰 20，×2）', () => {
    const meta = OFFICIAL_MODEL_REGISTRY['baichuan2-53b']
    expect(meta?.peakPolicy).toBe('baichuan-tier')
    expect(officialPriceForInstance('baichuan2-53b', 'idle')).toEqual({ inputPerMillion: 10, cacheReadPerMillion: 10, outputPerMillion: 10 })
    expect(officialPriceForInstance('baichuan2-53b', 'peak')).toEqual({ inputPerMillion: 20, cacheReadPerMillion: 20, outputPerMillion: 20 })
    // 缓存表派生：peak = idle × 2
    const table = buildOfficialCachePricingTable()
    expect(table['baichuan2-53b']).toEqual({ idle: { inputHit: 10, inputMiss: 10, output: 10 }, peak: { inputHit: 20, inputMiss: 20, output: 20 } })
    // 其余国内厂商 flat 恒定价，band 不影响
    expect(officialPriceForInstance('glm-5.3', 'peak')).toEqual(officialPriceForInstance('glm-5.3', 'idle'))
    expect(officialPriceForInstance('qwen3.8-max', 'peak')).toEqual(officialPriceForInstance('qwen3.8-max', 'idle'))
    expect(meta?.note).toContain('8:00-24:00')
  })

  it('阶跃 / 讯飞：官方价一字对齐；免费模型 0 价不触发 FALLBACK', () => {
    expect(officialIdlePriceOf('step-5-preview')).toEqual({ inputPerMillion: 7, cacheReadPerMillion: 0.35, outputPerMillion: 20 })
    expect(officialIdlePriceOf('step-3.5-flash')).toEqual({ inputPerMillion: 0.7, cacheReadPerMillion: 0.14, outputPerMillion: 2.1 })
    expect(officialIdlePriceOf('spark-x2.5')).toEqual({ inputPerMillion: 1.6, cacheReadPerMillion: 0.24, outputPerMillion: 6 })
    expect(OFFICIAL_MODEL_REGISTRY['spark-x2.5']?.note).toContain('五折')
    // 免费模型：官方 0 元 → official 源全 0，不回落兜底
    for (const m of ['spark-x2.5-4b', 'spark-x2.5-1.7b', 'spark-lite']) {
      const r = officialEntryPrice({}, { provider: 'spark', model: m }, 'peak', buildPricingTable({}))
      expect(r.source).toBe('official')
      expect(r.price).toEqual({ inputPerMillion: 0, cacheReadPerMillion: 0, outputPerMillion: 0 })
    }
  })

  it('国内厂商缓存写价参与成本折算（Kimi-K3 / Qwen3.8-Flash / MiniMax-M2.7）', () => {
    for (const m of ['kimi-k3', 'qwen3.8-flash', 'minimax-m2.7']) {
      const p = OFFICIAL_IDLE_PRICES[m]!
      expect(p.cacheWritePerMillion).toBeDefined()
      const cost = computeCost(p, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 })
      expect(cost).toBeCloseTo(p.cacheWritePerMillion!, 9)
    }
  })

  it('按模型选带：dsn-peak 用 DeepSeek 官方规则、baichuan-tier 用百川每日规则、flat 恒定价', () => {
    // 回归锚点：2026-09-14（周一）13:00 +08 = 空闲 / 10:00 = 高峰（DeepSeek 官方）
    expect(officialBandForEpoch(IDLE_TIME, TZ)).toBe('idle')
    expect(officialBandForEpoch(PEAK_TIME, TZ)).toBe('peak')
    // 百川每日 0-8 低谷：2026-09-14 本地 03:00 +08 → idle（UTC = 前日 19:00）
    const night = MON - 5 * 3600_000
    expect(baichuanBandForEpoch(night, TZ)).toBe('idle')
    // 百川 13:00 → peak（Daily 8-24）
    expect(baichuanBandForEpoch(IDLE_TIME, TZ)).toBe('peak')
    // 按模型策略：baichuan2-53b 在 DeepSeek 午间空闲时段仍为 peak（百川官方规则）
    expect(officialBandForEpochOf('baichuan2-53b', IDLE_TIME, TZ)).toBe('peak')
    expect(officialBandForEpochOf('deepseek-flash', IDLE_TIME, TZ)).toBe('idle')
    expect(officialBandForEpochOf('glm-5.3', IDLE_TIME, TZ)).toBe(officialBandForEpoch(IDLE_TIME, TZ))
  })

  it('国内厂商无 routed/decommissioned/oss（全部在售），别名表不受影响', () => {
    const domestic = ['zhipu', 'qwen', 'doubao', 'kimi', 'ernie', 'baichuan', 'minimax', 'stepfun', 'spark']
    const entries = Object.entries(OFFICIAL_MODEL_REGISTRY).filter(([, m]) => domestic.includes(m.provider))
    expect(entries.length).toBeGreaterThan(40)
    for (const [, meta] of entries) {
      expect(meta.status).toBe('active')
      expect(meta.routesTo).toBeUndefined()
      expect(meta.decommissionedAt).toBeUndefined()
      expect(meta.migrateTo).toBeUndefined()
    }
    // 别名表仍只由既有 routed 条目派生（deepseek-v4-flash 等）
    expect(OFFICIAL_MODEL_ALIASES['deepseek-v4-flash']).toBe('deepseek-flash')
  })
})