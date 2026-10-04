/**
 * @module dsh-cost-guard/core/cache-types
 * 缓存维度计量领域类型与端口（六边形架构，零 DSH 依赖）。
 *
 * DeepSeek 三通道计费口径（2026-09-10 生效）：
 *   - 输入-缓存命中（inputHit）：按命中价计费。
 *   - 输入-缓存未命中（inputMiss）：按未命中价计费。
 *   - 输出（output）：按统一输出价计费。
 * 缓存对用户透明（平台自动判定），插件仅做计量与收益核算，绝不改写请求。
 *
 * 缓存收益口径：
 *   baselineCost = 全部输入按未命中价计费的参照成本（本插件历史保守口径）。
 *   cost         = 实际三通道计费成本。
 *   saving       = baselineCost - cost。
 */

/** 缓存计费时段（DeepSeek 官方高峰 / 空闲两档）。 */
export type CacheBand = 'idle' | 'peak'

/** 三通道单价（元 / 百万 token）。 */
export interface BandPrice {
  /** 输入-缓存命中单价。 */
  inputHit: number
  /** 输入-缓存未命中单价。 */
  inputMiss: number
  /** 输出单价。 */
  output: number
}

/** 单路由三通道价格（高峰 / 空闲两档）。 */
export interface RoutePricing {
  /** 空闲时段价格。 */
  idle: BandPrice
  /** 高峰时段价格。 */
  peak: BandPrice
}

/** 价格覆盖源：路由级 > 全局级（均为可选项）。 */
export interface PricingSource {
  /** 按路由的价格覆盖；键可为 'provider/model' 或裸 'model'。 */
  byRoute?: Record<string, RoutePricing>
  /** 全局价格覆盖（未按路由配置时兜底）。 */
  global?: RoutePricing
}

/** 一次请求的三通道用量（命中 / 未命中 / 输出）。 */
export interface TokenSplit {
  /** 命中输入 Token。 */
  inputHit: number
  /** 未命中输入 Token。 */
  inputMiss: number
  /** 输出 Token。 */
  output: number
  /**
   * 不确定度：缓存命中信息缺失或异常时的标注。
   * - 'cached-unknown'：缓存字段缺失，按未命中计费，指标不纳入命中率汇总。
   * - 'malformed'：缓存字段异常（负数 / 非整数 / 超过输入总量）。
   */
  uncertainty?: 'cached-unknown' | 'malformed'
}

/** 缓存维度账目行（并入既有四维账本的话费维度）。 */
export interface CacheLedgerRow {
  /** 三通道拆分。 */
  split: TokenSplit
  /** 三通道计费后的实际成本。 */
  cost: number
  /** 全部输入按未命中价计费的基线成本。 */
  baselineCost: number
  /** 缓存收益 = baselineCost - cost。 */
  saving: number
}

/** 缓存维度汇总（Token 加权命中率口径）。 */
export interface CacheSummary {
  /** 输入 Token 总量（命中 + 未命中；不确定请求不纳入）。 */
  inputTotal: number
  /** 命中 Token 总量。 */
  hitTotal: number
  /** 命中率 = hitTotal / inputTotal（Token 加权）。 */
  hitRate: number
  /** 缓存收益累计（元）。 */
  savingTotal: number
  /** 不确定请求数（缓存字段缺失 / 异常，按未命中计费）。 */
  uncertainCount: number
}

/** 可优化前缀候选（后端只读提示，不自动改写）。 */
export interface PrefixCandidate {
  /** 归一化前缀签名（由 harness 按输入体前若干 Token 提取）。 */
  prefixId: string
  /** 该前缀观测到的重复请求次数（>= minRepeat 才触发候选）。 */
  repeatCount: number
  /** 潜在节省金额（元）：若该前缀全部命中可省的多大金额。 */
  potentialSaving: number
  /** 该前缀下观测到的缓存命中率。 */
  observedHitRate: number
}

/** 缓存字段解析结果判别（方案文档 4.2 / 4.3）。 */
export type ParseOutcome =
  | { ok: true; cached: number; uncached: number }
  | { ok: false; reason: 'missing' | 'malformed'; rawPrompt: number }

/** 原始用量快照（harness 层从响应 usage 提取出的字段）。 */
export interface RawUsageSnapshot {
  /** 输入 token（prompt_tokens）。 */
  promptTokens: number
  /** 输出 token（completion_tokens）。 */
  completionTokens: number
  /** 缓存命中 token（prompt_tokens_details.cached_tokens）；缺失为 undefined。 */
  cachedTokens?: number
}

/** CacheUsageReader 端口返回：字段缺失或读取失败时 status='missing'。 */
export type CacheUsageResult =
  | { status: 'missing'; raw: null }
  | { status: 'ok'; raw: RawUsageSnapshot }

// ---------------------------------------------------------------------------
// 端口（Ports）：core 只依赖接口，harness 适配层负责实现。
// ---------------------------------------------------------------------------

/** 缓存用量读取端口：从宿主事件 / 响应中提取原始用量快照。 */
export interface CacheUsageReader {
  /** 读取一次已完成请求的原始用量；取不到时返回 missing。 */
  read(event: unknown): CacheUsageResult
}

/** 缓存定价端口：按路由与时段返回三通道单价（覆盖 > 全局 > 内置）。 */
export interface CachePricingProvider {
  /** 解析某路由在某时段的三通道单价。 */
  resolve(route: string, band: CacheBand): BandPrice
}

/** 缓存账本端口：追加账目行并取 Token 加权汇总。 */
export interface CacheLedgerStore {
  /** 追加一行；meta 提供会话 / 路由维度标签（可选）。 */
  append(row: CacheLedgerRow, meta?: CacheLedgerMeta): void
  /** 取全局汇总（Token 加权命中率 / 收益 / 不确定数）。 */
  summary(scope: 'global'): CacheSummary
  /** 按会话 / 路由维度取汇总（键 -> 汇总）。 */
  byScope(scope: 'session' | 'route'): Record<string, CacheSummary>
}

/** 账目行维度标签。 */
export interface CacheLedgerMeta {
  /** 会话标识（可选，用于会话维度汇总）。 */
  sessionId?: string
  /** 路由键（可选，用于路由维度汇总）。 */
  route?: string
}

/** 空缓存汇总工厂。 */
export function emptyCacheSummary(): CacheSummary {
  return { inputTotal: 0, hitTotal: 0, hitRate: 0, savingTotal: 0, uncertainCount: 0 }
}