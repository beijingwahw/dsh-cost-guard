/**
 * @module dsh-cost-guard/core/focus-ledger
 * FOCUS 兼容成本台账（0.12.0，零 DSH 依赖）。
 *
 * 前沿背景：FOCUS（FinOps Open Cost and Usage Specification）是 FinOps 基金会
 * （Linux 基金会成员项目）主导的开放云成本数据规范，统一了「成本与用量」的
 * 列规格（Dimension / Metric）与功能级别（Mandatory / Conditional / Optional /
 * Recommended），微软 Azure 等厂商已对齐 FOCUS 输出并支持导入任意 FinOps 工具链。
 * 本模块把插件内部每次入账的 UsageEntry 映射为 FOCUS 兼容成本行——
 * 让 LLM 调用的成本明细首次能以行业标准格式流出，直接送入 FOCUS 兼容的
 * 成本管理 / 分摊 / 单位经济学平台，而不再局限于插件面板。
 *
 * 映射口径：
 * - ChargeCategory = 'Usage'（用量消费；本插件不产生调整/折扣行）。
 * - ChargePeriodStart/End = 请求时间戳（ISO 8601），事件级粒度。
 * - BillingCurrency = 路由所属币种（DeepSeek/国内厂商 CNY；OpenAI 等 USD），
 *   由装配层注入 currencyOf 解析，缺省 CNY（不过汇率换算，与计价引擎口径一致）。
 * - ConsumedQuantity / ConsumedUnit：计费总 token，单位 'tokens'。
 * - PricingQuantity / PricingUnit：计价口径数量，单位 'tokens-per-million'。
 * - EffectiveCost = ListCost = entry.cost（本插件不引入折扣/返点，实付=标价）。
 * - ListUnitPrice = 每百万 token 综合单价（有效成本倒算，展示用）。
 * - ProviderName = 路由厂商；ServiceName = 'deepseek-harness'（承载服务）；
 *   ResourceId = provider/model（LLM 推理资源标识）。
 * - 扩展维度（FOCUS 允许自定义维度）：Route / Band / 各通道 Token / 积分。
 *
 * 设计约束：
 * - 纯内存环形缓冲（默认 4096 行，超限丢最旧），行经 sink 回调即时流出，
 *   不承担持久化职责；sink 由装配层注入（如写 JSONL 文件 / 转发远端）。
 * - 常量与映射均为纯函数，便于单测。
 */

/** FOCUS 兼容成本行（列名遵循 FOCUS 规范命名，另加插件扩展维度）。 */
export interface FocusUsageLine {
  // —— FOCUS 标准列 ——
  /** 费用类别：'Usage'。 */
  ChargeCategory: 'Usage'
  /** 计费周期开始（ISO 8601，事件级粒度）。 */
  ChargePeriodStart: string
  /** 计费周期结束（ISO 8601）。 */
  ChargePeriodEnd: string
  /** 账单币种（CNY / USD 等原币种，不做汇率换算）。 */
  BillingCurrency: string
  /** 消耗数量（计费总 token）。 */
  ConsumedQuantity: number
  /** 消耗单位。 */
  ConsumedUnit: string
  /** 实付成本（= ListCost，无折扣场景）。 */
  EffectiveCost: number
  /** 标价成本。 */
  ListCost: number
  /** 每百万 token 综合单价（EffectiveCost / PricingQuantity 折算展示）。 */
  ListUnitPrice: number
  /** 计价数量（百万 token）。 */
  PricingQuantity: number
  /** 计价单位。 */
  PricingUnit: string
  /** 提供方（模型厂商）。 */
  ProviderName: string
  /** 承载服务（DeepSeek Harness 推理链路）。 */
  ServiceName: string
  /** 资源标识（provider/model）。 */
  ResourceId: string
  /** 可选区域维度（未配置时缺省）。 */
  RegionId?: string
  // —— 插件扩展维度 ——
  /** 路由键（provider/model）。 */
  Route: string
  /** 入账峰谷时段。 */
  Band: string
  /** 输入 token（未命中）。 */
  InputTokens: number
  /** 缓存命中输入 token。 */
  CacheReadTokens: number
  /** 输出 token。 */
  OutputTokens: number
  /** 推理（思维链）token。 */
  ReasoningTokens: number
  /** 积分消耗（未配置积分单价时为 0）。 */
  Credits: number
}

/** toFocusLine 选项。 */
export interface FocusLineOptions {
  /** 路由币种解析器；缺省一律 'CNY'。 */
  currencyOf?: (routeKey: string) => string
  /** 承载服务名（缺省 'deepseek-harness'）。 */
  serviceName?: string
}

/** 将一次用量入账映射为 FOCUS 兼容行。 */
export function toFocusLine(
  routeKey: string,
  entry: { time: number; cost: number; credits: number; totalTokens: number; band: string },
  tokens: { inputTokens: number; cacheReadTokens: number; outputTokens: number; reasoningTokens: number },
  opts: FocusLineOptions = {},
): FocusUsageLine {
  const currency = (opts.currencyOf?.(routeKey) ?? 'CNY').toUpperCase()
  const start = new Date(entry.time).toISOString()
  const pricingQuantity = Math.max(0, entry.totalTokens / 1_000_000)
  const listUnitPrice = pricingQuantity > 0 ? entry.cost / pricingQuantity : 0
  return {
    ChargeCategory: 'Usage',
    ChargePeriodStart: start,
    ChargePeriodEnd: start,
    BillingCurrency: currency,
    ConsumedQuantity: entry.totalTokens,
    ConsumedUnit: 'tokens',
    EffectiveCost: entry.cost,
    ListCost: entry.cost,
    ListUnitPrice: listUnitPrice,
    PricingQuantity: pricingQuantity,
    PricingUnit: 'tokens-per-million',
    ProviderName: routeKey.split('/')[0] ?? 'deepseek',
    ServiceName: opts.serviceName ?? 'deepseek-harness',
    ResourceId: routeKey,
    Route: routeKey,
    Band: entry.band,
    InputTokens: tokens.inputTokens,
    CacheReadTokens: tokens.cacheReadTokens,
    OutputTokens: tokens.outputTokens,
    ReasoningTokens: tokens.reasoningTokens,
    Credits: entry.credits,
  }
}

/** FOCUS 台账：有限容量缓冲 + sink 即时流出（内存有界、零副作用）。 */
export class FocusLedger {
  private readonly rows: FocusUsageLine[] = []
  private readonly capacity: number
  private readonly sink: ((line: FocusUsageLine) => void) | undefined

  constructor(opts: { capacity?: number; sink?: (line: FocusUsageLine) => void } = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 4096)
    this.sink = opts.sink
  }

  /** 追加一行：满则丢最旧；sink 存在时同步流出。 */
  append(line: FocusUsageLine): void {
    this.rows.push(line)
    while (this.rows.length > this.capacity) this.rows.shift()
    this.sink?.(line)
  }

  /** 行数（当前缓冲）。 */
  get count(): number {
    return this.rows.length
  }

  /** 缓冲副本（时间正序到达）。 */
  lines(): FocusUsageLine[] {
    return this.rows.map((r) => ({ ...r }))
  }

  /** JSONL 序列化（每行一个 JSON 对象）。 */
  toJsonl(): string {
    return this.rows.map((r) => JSON.stringify(r)).join('\n')
  }

  /** 清空缓冲。 */
  clear(): void {
    this.rows.length = 0
  }
}