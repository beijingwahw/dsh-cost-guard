/**
 * @module dsh-cost-guard/core/official-pricing
 * 官方价目引擎（0.8.0，零 DSH 依赖）—— 让主计量与真实账单逐项对齐。
 * 0.9.0：『官方模型注册表』驱动的 DeepSeek 全模型深度同步。
 * 0.10.0：扩展为世界主流模型官方计价深度同步 —— OpenAI / Anthropic / Google / Mistral
 *         官方 API 计价规则 + 开源权重（Llama）状态登记，全部经官方页 / 官方权威来源核实。
 * 0.11.0：国内主流模型官方计价深度同步 —— 智谱 GLM / 阿里通义 Qwen / 字节豆包 /
 *         月之暗面 Kimi / 百度文心 ERNIE / 百川 / MiniMax / 阶跃星辰 / 讯飞星火，
 *         全部经厂商官方定价页直抓核实（CNY）。
 *
 * 多厂商计价语义（详见 docs/official-pricing-sync.md）：
 *   - 币种：DeepSeek 官方价为 CNY；OpenAI / Anthropic / Google / Mistral 官方价为 USD；
 *     国内厂商（0.11.0）官方价均为 CNY。插件按各厂商原币种计量，不做汇率换算（不虚构汇率）。
 *   - 峰谷策略（peakPolicy）：
 *       'dsn-peak'（DeepSeek）—— 官方峰谷计费：高峰（工作日非节假日 9-12 / 14-18）价 = 空闲 × 2；
 *       'baichuan-tier'（百川 Baichuan2-53B）—— 官方每日峰谷：0:00-8:00 低谷、8:00-24:00 高峰，
 *         高峰 = 低谷 × 2（官方公布两档 0.01 / 0.02 元每千 tokens，换算 10 / 20 元每百万）；
 *       'flat'（其余厂商）—— 官方公布的是恒定价，band 不影响价格（peak = idle）。
 *   - 推理 token：OpenAI / Anthropic / Gemini / DeepSeek 官方均按『输出价』计费
 *     （Gemini 明确 response = output + thinking tokens，thinking 走输出价），
 *     与既有 ReasoningLedger 口径一致，无需新增字段。
 *   - 缓存写价：Anthropic 官方按写入 token 单独计价（cacheWrite）；OpenAI 只有缓存读折扣、
 *     Gemini 有缓存读价、无写价概念。ModelPrice.cacheWritePerMillion 可选承载。
 *   - 来源分级（sourceLevel）：'official' = 官方页面直接核对；'aggregated' = 公开权威聚合
 *     交叉（官方页沙箱不可达时使用，如 Mistral）。来源与核对日期逐条登记，不虚构。
 *
 * DeepSeek 官方计价事实（来源：DeepSeek 官方定价页 / 更新日志 / 新闻，2026-10-05 核对）：
 *   deepseek-flash  : 空闲 命中0.02 / 未命中1.00 / 输出4.00   高峰 ×2 → 0.04 / 2.00 / 8.00
 *   deepseek-v4-pro : 空闲 命中0.15 / 未命中4.50 / 输出13.50  高峰 ×2 → 0.30 / 9.00 / 27.00
 *     —— 更新日志 2026-09-10：9-14 之后继续提供 V4 Pro API，计费方式保持不变。
 *   高峰时段 = 北京时间周一至周五（不含中国法定节假日）9:00-12:00 与 14:00-18:00。
 *
 * OpenAI（USD，flat，来源：Azure 官方同源页 + 官方权威媒体；openai.com 反爬兜底，2026-10-05 核对）：
 *   gpt-6-astra   : 输入10.00 / 缓存输入1.00 / 输出50.00（2026-09-03 发布；>27.2万长上下文加价：输入/缓存×2、输出×1.5）
 *   gpt-6.1-sol   : 输入2.00 / 缓存0.10 / 输出10.00（2026-09-30 发布，约 Astra 1/5 价）
 *   gpt-6-luna    : 输入0.10 / 缓存0.01 / 输出0.50
 *   gpt-5.5       : 输入5.00 / 缓存0.50 / 输出30.00（2026-04-23；媒体传闻 2026-10-14 迁移至 6 系，待官方确认）
 *   gpt-5.5-pro   : 输入30.00 / 输出180.00（订阅专属；缓存价未核实按输入价保守）
 *   gpt-5.4 系列  : standard 2.50/15、mini 0.75/4.50、nano 0.20/1.25（缓存价未核实按输入价保守）
 *   reasoning tokens 按输出价计费（官方文档明确）。
 *
 * Anthropic（USD，flat，来源：claude.com/pricing 官方页直抓，2026-10-05 核对）：
 *   在售：Fable 5.1 10/50（缓存读0.25/写12.50）、Opus 5.5 4/20（读0.20/写5.00）、
 *         Sonnet 5.5 2/10（读0.20/写2.50）、Haiku 4.5 1/5（读0.10/写1.25）。
 *   Legacy：Sonnet 5 2/10、Opus 5 5/25、Fable 5 10/50、Opus 4.8 5/25、Sonnet 4.6 3/15、
 *           Opus 4.7 5/25、Opus 4.6 5/25、Sonnet 4.5 3/15、Opus 4.5 5/25
 *           （官方 Legacy 区列有缓存读写价，插件按输入价保守、不虚构具体数值）。
 *   extended thinking tokens 按输出价计费；batch 五折；仅美国推断 1.1x（不在主表，文档说明）。
 *
 * Google Gemini（USD，flat，来源：DeepMind 官方模型页直抓 + 官方权威媒体交叉，2026-10-05 核对）：
 *   3.7 Flash 0.75/3.75（缓存读0.075；限时至 2026-12-31 后翻倍 1.50/7.50）、3.6 Flash 0.75/3.75、
 *   3.5 Flash 1.50/9.00、3.5 Flash-Lite 0.30/2.50、3.1 Flash-Lite 0.25/1.50、3.1 Pro 2.00/12.00（缓存0.20，聚合来源）、
 *   3 Flash 0.50/3.00；2.5 系列 2026-10 官方 shutdown（已停用）。
 *   thinking tokens 按输出价计费（官方原话：response pricing = output + thinking tokens）。
 *
 * Mistral（USD，flat，来源：公开聚合 two-ais 2026-02-28 验证 + planpulse 交叉；官方站沙箱不可达）：
 *   Large 3 0.50/1.50、Medium 3.1 0.40/2.00、Small 3.2 0.10/0.30、
 *   Ministral 3 14B 0.20/0.20、8B 0.15/0.15、3B 0.10/0.10（缓存价未核实按输入价保守）。
 *
 * Meta Llama（开源权重）：官方仅发布权重，不提供官方托管 API 价目；实际成本以托管平台为准。
 *   登记为 'oss' 状态（不入官方价目表），避免虚构官方托管价。
 */

import type { ModelPrice, Route, UsageEntry } from './types.js'
import { FALLBACK_PRICE, BUILTIN_PRICES, type PricingTable } from './pricing.js'
import { deepseekBandForEpoch, HOLIDAYS_2026 } from './cache-pricing.js'
import type { CacheBand, RoutePricing } from './cache-types.js'

/** 官方高峰倍数：deepseek（dsn-peak 策略）高峰价 = 空闲价 × 2。 */
export const PEAK_MULTIPLIER = 2

/** 官方模型状态：在售 / 已下线（路由到现行模型）/ 官方已停用 / 官方 Legacy 档在售 / 开源权重（无官方价）。 */
export type OfficialModelStatus = 'active' | 'routed' | 'decommissioned' | 'legacy' | 'oss'

/** 官方价目来源分级：官方页面直抓 / 公开权威聚合交叉。 */
export type OfficialSourceLevel = 'official' | 'aggregated'

/** 官方价目币种：插件按模型官方原币种计量（DeepSeek=CNY，其余=USD），不做汇率换算。 */
export type OfficialCurrency = 'CNY' | 'USD'

/** 官方峰谷策略：dsn-peak=DeepSeek 官方峰谷（高峰×2）；baichuan-tier=百川 Baichuan2-53B 每日峰谷（0-8 低谷 / 8-24 高峰，×2）；flat=官方恒定价（band 不影响价格）。 */
export type OfficialPeakPolicy = 'dsn-peak' | 'baichuan-tier' | 'flat'

/** 官方模型厂商。 */
export type OfficialProvider =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'meta'
  // 0.11.0：国内主流厂商（全部 CNY，官方定价页直抓）
  | 'zhipu'
  | 'qwen'
  | 'doubao'
  | 'kimi'
  | 'ernie'
  | 'baichuan'
  | 'minimax'
  | 'stepfun'
  | 'spark'

/** 官方模型注册元信息（多厂商扩展，保留 0.9.0 全部既有字段）。 */
export interface OfficialModelMeta {
  /** 官方服务状态。 */
  status: OfficialModelStatus
  /** 所属厂商。 */
  provider: OfficialProvider
  /** 官方价目币种（CNY / USD）。 */
  currency: OfficialCurrency
  /** 峰谷策略（dsn-peak=高峰×2；flat=恒定价）。 */
  peakPolicy: OfficialPeakPolicy
  /** 来源分级（official=官方页直抓；aggregated=公开权威聚合交叉）。 */
  sourceLevel: OfficialSourceLevel
  /** 本次核对日期（YYYY-MM-DD）。 */
  verifiedAt: string
  /** routed：路由到的现行模型名（按该模型价计费）。 */
  routesTo?: string
  /** active/legacy：官方空闲档三通道价（币种见 currency；高峰按 peakPolicy 判定）。 */
  idle?: ModelPrice
  /** decommissioned：官方停用日期（YYYY-MM-DD）。 */
  decommissionedAt?: string
  /** decommissioned：迁移建议（现行可调用模型名）。 */
  migrateTo?: string
  /** 附加说明（路由 / 停用背景 / 价格口径 / 来源注记）。 */
  note?: string
}

/**
 * 官方模型注册表（2026-10-05 核对，单一事实源）。
 * 取价路径：
 *   - active / legacy：查官方价目（idle 必备；peak 按 peakPolicy：dsn-peak × 2、flat 恒定价）；
 *   - routed：归一为目标模型后按目标模型价计费；
 *   - decommissioned：无官方价，回落内置价表 / 兜底（与 0.9.0 相同，零回归）；
 *   - oss：开源权重，无官方托管价，不入价目表（registry 状态展示用途）。
 */
export const OFFICIAL_MODEL_REGISTRY: Record<string, OfficialModelMeta> = {
  // ------------------------------------------------------------------ DeepSeek（CNY, dsn-peak, official）
  'deepseek-flash': {
    status: 'active',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1.0, cacheReadPerMillion: 0.02, outputPerMillion: 4.0 },
  },
  'deepseek-v4-pro': {
    status: 'active',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 4.5, cacheReadPerMillion: 0.15, outputPerMillion: 13.5 },
    note: '更新日志 2026-09-10：9-14 之后继续提供服务，计费不变',
  },
  'deepseek-v4-flash': {
    status: 'routed',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    routesTo: 'deepseek-flash',
    note: '官方已下线，路由 V4.1-Flash 并按 flash 价计费',
  },
  'deepseek-v4-flash-vision-exp': {
    status: 'routed',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    routesTo: 'deepseek-flash',
    note: '官方已下线，路由 V4.1-Flash 并按 flash 价计费（多模态）',
  },
  'deepseek-chat': {
    status: 'decommissioned',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    decommissionedAt: '2026-07-24',
    migrateTo: 'deepseek-flash / deepseek-v4-pro',
    note: '官方停用；原对应 V4-Flash 非思考模式',
  },
  'deepseek-reasoner': {
    status: 'decommissioned',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    decommissionedAt: '2026-07-24',
    migrateTo: 'deepseek-flash（思考模式）/ deepseek-v4-pro',
    note: '官方停用；原对应 V4-Flash 思考模式',
  },
  'deepseek-coder': {
    status: 'decommissioned',
    provider: 'deepseek',
    currency: 'CNY',
    peakPolicy: 'dsn-peak',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    decommissionedAt: '2024-09-05',
    migrateTo: 'deepseek-flash / deepseek-v4-pro',
    note: '官方并入 deepseek-chat 后随其停用',
  },

  // ------------------------------------------------------------------ OpenAI（USD, flat, official）
  'gpt-6-astra': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 10.0, cacheReadPerMillion: 1.0, outputPerMillion: 50.0 },
    note: '2026-09-03 发布；>27.2万 token 长上下文加价：输入/缓存×2、输出×1.5',
  },
  'gpt-6.1-sol': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.0, cacheReadPerMillion: 0.1, outputPerMillion: 10.0 },
    note: '2026-09-30 发布；约 Astra 1/5 价',
  },
  'gpt-6-luna': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.1, cacheReadPerMillion: 0.01, outputPerMillion: 0.5 },
  },
  'gpt-5.5': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5.0, cacheReadPerMillion: 0.5, outputPerMillion: 30.0 },
    note: '2026-04-23 发布；媒体传闻 2026-10-14 迁移至 6 系，未获官方确认 → 不登记 routed（避免虚构）',
  },
  'gpt-5.5-pro': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 30.0, cacheReadPerMillion: 30.0, outputPerMillion: 180.0 },
    note: '订阅专属价；缓存输入价未核实，按输入价保守',
  },
  'gpt-5.4': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.5, cacheReadPerMillion: 2.5, outputPerMillion: 15.0 },
    note: '缓存输入价未核实，按输入价保守',
  },
  'gpt-5.4-mini': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.75, cacheReadPerMillion: 0.75, outputPerMillion: 4.5 },
    note: '缓存输入价未核实，按输入价保守',
  },
  'gpt-5.4-nano': {
    status: 'active',
    provider: 'openai',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.2, cacheReadPerMillion: 0.2, outputPerMillion: 1.25 },
    note: '缓存输入价未核实，按输入价保守',
  },

  // ------------------------------------------------------------------ Anthropic（USD, flat, official）
  'claude-fable-5.1': {
    status: 'active',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: {
      inputPerMillion: 10.0,
      cacheReadPerMillion: 0.25,
      outputPerMillion: 50.0,
      cacheWritePerMillion: 12.5,
    },
    note: '缓存读0.25/写12.50；extended thinking 按输出价',
  },
  'claude-opus-5.5': {
    status: 'active',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: {
      inputPerMillion: 4.0,
      cacheReadPerMillion: 0.2,
      outputPerMillion: 20.0,
      cacheWritePerMillion: 5.0,
    },
    note: '缓存读0.20/写5.00；fast mode 价×2；extended thinking 按输出价',
  },
  'claude-sonnet-5.5': {
    status: 'active',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: {
      inputPerMillion: 2.0,
      cacheReadPerMillion: 0.2,
      outputPerMillion: 10.0,
      cacheWritePerMillion: 2.5,
    },
    note: '缓存读0.20/写2.50；extended thinking 按输出价',
  },
  'claude-haiku-4.5': {
    status: 'active',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: {
      inputPerMillion: 1.0,
      cacheReadPerMillion: 0.1,
      outputPerMillion: 5.0,
      cacheWritePerMillion: 1.25,
    },
    note: '缓存读0.10/写1.25；extended thinking 按输出价',
  },
  // Anthropic Legacy（官方定价页 Legacy 区仍列价；缓存读写具体值未在官方页抓到，按输入价保守）
  'claude-sonnet-5': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.0, cacheReadPerMillion: 2.0, outputPerMillion: 10.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-opus-5': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5.0, cacheReadPerMillion: 5.0, outputPerMillion: 25.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-fable-5': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 10.0, cacheReadPerMillion: 10.0, outputPerMillion: 50.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-opus-4.8': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5.0, cacheReadPerMillion: 5.0, outputPerMillion: 25.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-sonnet-4.6': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 3.0, cacheReadPerMillion: 3.0, outputPerMillion: 15.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-opus-4.7': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5.0, cacheReadPerMillion: 5.0, outputPerMillion: 25.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-opus-4.6': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5.0, cacheReadPerMillion: 5.0, outputPerMillion: 25.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-sonnet-4.5': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 3.0, cacheReadPerMillion: 3.0, outputPerMillion: 15.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },
  'claude-opus-4.5': {
    status: 'legacy',
    provider: 'anthropic',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5.0, cacheReadPerMillion: 5.0, outputPerMillion: 25.0 },
    note: 'Legacy；官方页缓存读写价未核实，按输入价保守',
  },

  // ------------------------------------------------------------------ Google Gemini（USD, flat, official / aggregated）
  'gemini-3.7-flash': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 },
    note: '限至 2026-12-31 特价；其后翻倍为 1.50/7.50；thinking 按输出价',
  },
  'gemini-3.6-flash': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.75, cacheReadPerMillion: 0.75, outputPerMillion: 3.75 },
    note: '缓存读价未核实，按输入价保守；thinking 按输出价',
  },
  'gemini-3.5-flash': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1.5, cacheReadPerMillion: 1.5, outputPerMillion: 9.0 },
    note: '缓存读价未核实，按输入价保守；thinking 按输出价',
  },
  'gemini-3.5-flash-lite': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.3, cacheReadPerMillion: 0.3, outputPerMillion: 2.5 },
    note: 'DeepMind 官方页对照表直给；缓存读价未核实按输入价保守',
  },
  'gemini-3.1-flash-lite': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.25, cacheReadPerMillion: 0.25, outputPerMillion: 1.5 },
    note: 'DeepMind 官方页对照表直给；缓存读价未核实按输入价保守',
  },
  'gemini-3.1-pro': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.0, cacheReadPerMillion: 0.2, outputPerMillion: 12.0 },
    note: '缓存读价 0.20 来自公开聚合（planpulse）；thinking 按输出价',
  },
  'gemini-3-flash': {
    status: 'active',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 3.0 },
    note: '缓存读价未核实，按输入价保守',
  },
  'gemini-2.5-flash': {
    status: 'decommissioned',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    decommissionedAt: '2026-10-01',
    migrateTo: 'gemini-3.5-flash / gemini-3.7-flash',
    note: '官方 2026-10 shutdown（Firebase 官方文档）',
  },
  'gemini-2.5-pro': {
    status: 'decommissioned',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    decommissionedAt: '2026-10-01',
    migrateTo: 'gemini-3.1-pro',
    note: '官方 2026-10 shutdown（Firebase 官方文档）',
  },
  'gemini-2.5-flash-lite': {
    status: 'decommissioned',
    provider: 'google',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    decommissionedAt: '2026-10-01',
    migrateTo: 'gemini-3.5-flash-lite / gemini-3.1-flash-lite',
    note: '官方 2026-10 shutdown（Firebase 官方文档）',
  },

  // ------------------------------------------------------------------ Mistral（USD, flat, aggregated）
  'mistral-large-3': {
    status: 'active',
    provider: 'mistral',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 1.5 },
    note: '官方站沙箱不可达，价目来自公开聚合（two-ais 2026-02-28 / planpulse）；缓存价未核实按输入价保守',
  },
  'mistral-medium-3.1': {
    status: 'active',
    provider: 'mistral',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.4, cacheReadPerMillion: 0.4, outputPerMillion: 2.0 },
    note: '官方站沙箱不可达，价目来自公开聚合；缓存价未核实按输入价保守',
  },
  'mistral-small-3.2': {
    status: 'active',
    provider: 'mistral',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.1, cacheReadPerMillion: 0.1, outputPerMillion: 0.3 },
    note: '官方站沙箱不可达，价目来自公开聚合；缓存价未核实按输入价保守',
  },
  'ministral-3-14b': {
    status: 'active',
    provider: 'mistral',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.2, cacheReadPerMillion: 0.2, outputPerMillion: 0.2 },
    note: '对称价；缓存价未核实按输入价保守',
  },
  'ministral-3-8b': {
    status: 'active',
    provider: 'mistral',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.15, cacheReadPerMillion: 0.15, outputPerMillion: 0.15 },
    note: '对称价；缓存价未核实按输入价保守',
  },
  'ministral-3-3b': {
    status: 'active',
    provider: 'mistral',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'aggregated',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.1, cacheReadPerMillion: 0.1, outputPerMillion: 0.1 },
    note: '对称价；缓存价未核实按输入价保守',
  },

  // ------------------------------------------------------------------ Meta Llama（开源权重，无官方托管 API 价）
  'llama-4-maverick': {
    status: 'oss',
    provider: 'meta',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    note: '开源权重：官方仅发布权重，无官方托管 API 价目；实际成本以托管平台（Groq/Fireworks/Ollama 等）为准',
  },
  'llama-4-scout': {
    status: 'oss',
    provider: 'meta',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    note: '开源权重：官方仅发布权重，无官方托管 API 价目；实际成本以托管平台为准',
  },
  'llama-3.3-70b': {
    status: 'oss',
    provider: 'meta',
    currency: 'USD',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    note: '开源权重：官方仅发布权重，无官方托管 API 价目；实际成本以托管平台为准',
  },

  // ------------------------------------------------------------------ 智谱 GLM（CNY, flat, official）
  'glm-5.3': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28 },
    note: '公开定价页 2026-10-05 直抓；缓存命中 2/输出 28',
  },
  'glm-5.3-flash': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.23, outputPerMillion: 2.8 },
  },
  'glm-5.3-flashx': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2, cacheReadPerMillion: 0.57, outputPerMillion: 7 },
  },
  'glm-5.2': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28 },
  },
  'glm-5.1': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6, cacheReadPerMillion: 1.3, outputPerMillion: 24 },
    note: '阶梯：<32K 上下文 6/24/1.3，≥32K 8/28/2（主档登记低档）',
  },
  'glm-5-turbo': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5, cacheReadPerMillion: 1.2, outputPerMillion: 22 },
    note: '阶梯：<32K 5/22/1.2，≥32K 7/26/1.8（主档登记低档）',
  },
  'glm-5': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 4, cacheReadPerMillion: 1, outputPerMillion: 18 },
    note: '阶梯：<32K 4/18/1，≥32K 6/22/1.5（主档登记低档）',
  },
  'glm-4.7': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2, cacheReadPerMillion: 0.4, outputPerMillion: 8 },
    note: '阶梯：2/8/0.4、3/14/0.6、4/16/0.8 三档（主档登记最低档）',
  },
  'glm-4.5-air': {
    status: 'active',
    provider: 'zhipu',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.16, outputPerMillion: 2 },
    note: '1M 上下文；缓存存储限时免费；更长上下文档 0.8/6、1.2/8（主档登记最低档）',
  },

  // ------------------------------------------------------------------ 月之暗面 Kimi（CNY, flat, official）
  'kimi-k3': {
    status: 'active',
    provider: 'kimi',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 20, cacheReadPerMillion: 2, outputPerMillion: 100, cacheWritePerMillion: 20 },
    note: '官方确认通道口径；缓存写 5min 档 20 / 1h 档 40（登记 5min 档）；ctx 1,048,576',
  },
  'kimi-k2.7-code': {
    status: 'active',
    provider: 'kimi',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6.5, cacheReadPerMillion: 1.3, outputPerMillion: 27 },
    note: 'ctx 262,144；缓存命中 1.30/未命中 6.50/输出 27.00',
  },
  'kimi-k2.7-code-highspeed': {
    status: 'active',
    provider: 'kimi',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 13, cacheReadPerMillion: 2.6, outputPerMillion: 54 },
    note: 'ctx 262,144；高速档 2.60/13.00/54.00',
  },
  'kimi-k2.6': {
    status: 'active',
    provider: 'kimi',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6.5, cacheReadPerMillion: 1.1, outputPerMillion: 27 },
    note: 'ctx 262,144；缓存命中 1.10/未命中 6.50/输出 27.00',
  },

  // ------------------------------------------------------------------ 字节豆包（火山方舟）（CNY, flat, official）
  'doubao-seed-2.1-pro': {
    status: 'active',
    provider: 'doubao',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6, cacheReadPerMillion: 1.2, outputPerMillion: 30 },
    note: '缓存存储按 0.017 元/小时另计（官方口径，不入 token 单价）',
  },
  'doubao-seed-evolving': {
    status: 'active',
    provider: 'doubao',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6, cacheReadPerMillion: 1.2, outputPerMillion: 30 },
    note: '缓存存储按 0.017 元/小时另计（官方口径，不入 token 单价）',
  },
  'doubao-seed-2.1-turbo': {
    status: 'active',
    provider: 'doubao',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 3, cacheReadPerMillion: 0.6, outputPerMillion: 15 },
    note: '缓存存储按 0.017 元/小时另计（官方口径，不入 token 单价）',
  },
  'doubao-seed-character': {
    status: 'active',
    provider: 'doubao',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.16, outputPerMillion: 2 },
    note: '官方公布为起价（0.8 起/2 起/0.16），实际按用量结算',
  },

  // ------------------------------------------------------------------ MiniMax（CNY, flat, official）
  'minimax-m3': {
    status: 'active',
    provider: 'minimax',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.1, cacheReadPerMillion: 0.42, outputPerMillion: 8.4 },
    note: '≤512k 上下文永久五折 2.10/8.40/0.42（原价 4.20/16.80/0.84）；>512k 按原价档',
  },
  'minimax-m2.7': {
    status: 'active',
    provider: 'minimax',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.1, cacheReadPerMillion: 0.42, outputPerMillion: 8.4, cacheWritePerMillion: 2.625 },
    note: '缓存写 2.625；「优先服务」= standard×1.5',
  },
  'minimax-m2.7-highspeed': {
    status: 'active',
    provider: 'minimax',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 4.2, cacheReadPerMillion: 0.42, outputPerMillion: 16.8, cacheWritePerMillion: 2.625 },
    note: '高速版 4.2/16.8/0.42/写 2.625；「优先服务」= standard×1.5',
  },

  // ------------------------------------------------------------------ 百川（CNY, flat / baichuan-tier, official；官方单位 元/千 tokens 已 ×1000 折算每百万）
  'baichuan-m3-plus': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 5, cacheReadPerMillion: 5, outputPerMillion: 9 },
    note: '官方 0.005/0.009 元每千折算；自动触发「医疗搜索」0.03 元/次单独计费；缓存价未公开按输入价保守',
  },
  'baichuan-m3': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 10, cacheReadPerMillion: 10, outputPerMillion: 30 },
    note: '官方 0.01/0.03 元每千折算；缓存价未公开按输入价保守',
  },
  'baichuan-m2-plus': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 10, cacheReadPerMillion: 10, outputPerMillion: 30 },
    note: '官方 0.01/0.03 元每千折算；缓存价未公开按输入价保守',
  },
  'baichuan-m2': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2, cacheReadPerMillion: 2, outputPerMillion: 20 },
    note: '官方 0.002/0.02 元每千折算；缓存价未公开按输入价保守',
  },
  'baichuan4-turbo': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 15, cacheReadPerMillion: 15, outputPerMillion: 15 },
    note: '官方 0.015 元/千 输入输出总价（15/百万）；缓存价未公开按输入价保守',
  },
  'baichuan4': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 100, cacheReadPerMillion: 100, outputPerMillion: 100 },
    note: '官方 0.1 元/千 输入输出总价（100/百万）；缓存价未公开按输入价保守',
  },
  'baichuan4-air': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.98, cacheReadPerMillion: 0.98, outputPerMillion: 0.98 },
    note: '官方 0.00098 元/千 ≈0.98/百万（输入输出总价）；缓存价未公开按输入价保守',
  },
  'baichuan3-turbo': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 12, cacheReadPerMillion: 12, outputPerMillion: 12 },
    note: '官方 0.012 元/千（12/百万，输入输出总价）；缓存价未公开按输入价保守',
  },
  'baichuan3-turbo-128k': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 24, cacheReadPerMillion: 24, outputPerMillion: 24 },
    note: '官方 0.024 元/千（24/百万，输入输出总价）；缓存价未公开按输入价保守',
  },
  'baichuan2-turbo': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 8, cacheReadPerMillion: 8, outputPerMillion: 8 },
    note: '官方 0.008 元/千（8/百万，输入输出总价）；缓存价未公开按输入价保守',
  },
  'baichuan2-53b': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'baichuan-tier',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 10, cacheReadPerMillion: 10, outputPerMillion: 10 },
    note: '国内唯一官方峰谷：0:00-8:00 低谷 0.01 元/千（10/百万）、8:00-24:00 高峰 0.02 元/千（20/百万，×2）；缓存价未公开按输入价保守',
  },
  'baichuan-text-embedding': {
    status: 'active',
    provider: 'baichuan',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 0.5 },
    note: '官方 0.0005 元/千（0.5/百万）嵌入模型；缓存价未公开按输入价保守',
  },

  // ------------------------------------------------------------------ 阶跃星辰（CNY, flat, official）
  'step-5-preview': {
    status: 'active',
    provider: 'stepfun',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 7, cacheReadPerMillion: 0.35, outputPerMillion: 20 },
  },
  'step-3.7-flash': {
    status: 'active',
    provider: 'stepfun',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1.35, cacheReadPerMillion: 0.27, outputPerMillion: 8.1 },
  },
  'step-3.5-flash': {
    status: 'active',
    provider: 'stepfun',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.7, cacheReadPerMillion: 0.14, outputPerMillion: 2.1 },
  },
  'step-3.5-flash-2603': {
    status: 'active',
    provider: 'stepfun',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.7, cacheReadPerMillion: 0.14, outputPerMillion: 2.1 },
    note: '同 3.5-flash 价目版本',
  },
  'step-1o-turbo-vision': {
    status: 'active',
    provider: 'stepfun',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.5, cacheReadPerMillion: 0.5, outputPerMillion: 8 },
  },

  // ------------------------------------------------------------------ 阿里通义 Qwen（CNY, flat, official）
  'qwen3.8-max': {
    status: 'active',
    provider: 'qwen',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 12, cacheReadPerMillion: 1.5, outputPerMillion: 36 },
    note: '华北2-北京 CNY 价；另有国际 USD 价 $2/$6 不换算',
  },
  'qwen3.8-flash': {
    status: 'active',
    provider: 'qwen',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.1, outputPerMillion: 2.7, cacheWritePerMillion: 1.25 },
    note: '2026-08-27 下调（输入 1.00→0.80、输出 3.00→2.70）；显式缓存创建 1.25',
  },
  'qwen3.5-plus': {
    status: 'active',
    provider: 'qwen',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.08, outputPerMillion: 4.8, cacheWritePerMillion: 1 },
    note: '阶梯：≤128K 0.8/4.8（档内缓存命中 0.08/显式缓存创建 1）、128K-256K 2/12、256K-1M 4/24（主档登记低档）；Batch 五折',
  },
  'qwen3-max': {
    status: 'active',
    provider: 'qwen',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 2.5, cacheReadPerMillion: 2.5, outputPerMillion: 10 },
    note: '阶梯：≤32K 2.5/10、32K-128K 4/16、128K-252K 7/28（主档登记低档）；缓存价未公开按输入价保守',
  },
  'qwen3.8-omni-flash': {
    status: 'active',
    provider: 'qwen',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.1, outputPerMillion: 2.7 },
  },
  'qwen-long': {
    status: 'active',
    provider: 'qwen',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 2 },
    note: '长文本模型；Batch 五折；缓存价未公开按输入价保守',
  },

  // ------------------------------------------------------------------ 百度文心 ERNIE（CNY, flat, official；官方单位 元/千 tokens 已 ×1000 折算每百万）
  'ernie-5.0': {
    status: 'active',
    provider: 'ernie',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6, cacheReadPerMillion: 6, outputPerMillion: 24 },
    note: '官方 0.006-0.01 元/千（阶梯区间，输入 6-10/百万、输出 24-40/百万，主档登记下限）；缓存价官方未公开按输入价保守',
  },
  'ernie-5.0-thinking-preview': {
    status: 'active',
    provider: 'ernie',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 6, cacheReadPerMillion: 6, outputPerMillion: 24 },
    note: 'Thinking Preview 同 5.0 阶梯（输入 6-10、输出 24-40，主档登记下限）；缓存价官方未公开按输入价保守',
  },
  'ernie-x1.1-preview': {
    status: 'active',
    provider: 'ernie',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1, cacheReadPerMillion: 1, outputPerMillion: 4 },
    note: '官方 0.001/0.004 元每千折算；思考模型；缓存价官方未公开按输入价保守',
  },
  'ernie-4.5-turbo-vl': {
    status: 'active',
    provider: 'ernie',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 3, cacheReadPerMillion: 3, outputPerMillion: 9 },
    note: '官方 0.003/0.009 元每千折算；多模态；缓存价官方未公开按输入价保守',
  },
  'ernie-4.5-turbo-128k': {
    status: 'active',
    provider: 'ernie',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0.8, cacheReadPerMillion: 0.8, outputPerMillion: 3.2 },
    note: '官方 0.0008/0.0032 元每千折算；缓存价官方未公开按输入价保守',
  },
  'ernie-4.5-vl-28b-a3b': {
    status: 'active',
    provider: 'ernie',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1, cacheReadPerMillion: 1, outputPerMillion: 10 },
    note: '官方 0.001/0.01 元每千折算；轻量 VL；缓存价官方未公开按输入价保守',
  },

  // ------------------------------------------------------------------ 讯飞星火 Spark（CNY, flat, official）
  'spark-x2.5': {
    status: 'active',
    provider: 'spark',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1.6, cacheReadPerMillion: 0.24, outputPerMillion: 6 },
    note: '293B，ctx 256k；开放平台限时五折 1.60/6.00/缓存 0.24（原价 3.2/12.0/0.48）；MaaS 限时三折 0.96/3.6/0.14',
  },
  'spark-x2.5-4b': {
    status: 'active',
    provider: 'spark',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0, cacheReadPerMillion: 0, outputPerMillion: 0 },
    note: '限时免费（官方 0 元）',
  },
  'spark-x2.5-1.7b': {
    status: 'active',
    provider: 'spark',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0, cacheReadPerMillion: 0, outputPerMillion: 0 },
    note: '限时免费（官方 0 元）',
  },
  'spark-x2': {
    status: 'active',
    provider: 'spark',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 3, cacheReadPerMillion: 3, outputPerMillion: 3 },
    note: 'MaaS 按量价 2026-09-04（输入 3/输出 3）；缓存价未公开按输入价保守',
  },
  'spark-x2-flash': {
    status: 'active',
    provider: 'spark',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 1, cacheReadPerMillion: 1, outputPerMillion: 2 },
    note: '缓存价未公开按输入价保守',
  },
  'spark-lite': {
    status: 'active',
    provider: 'spark',
    currency: 'CNY',
    peakPolicy: 'flat',
    sourceLevel: 'official',
    verifiedAt: '2026-10-05',
    idle: { inputPerMillion: 0, cacheReadPerMillion: 0, outputPerMillion: 0 },
    note: '官方永久免费（0 元）；传统 Spark 4.0 Ultra/Max/Pro 无现行官方价目，不登记（避免虚构）',
  },
}

/** 官方价目（空闲档；币种见注册表）：由注册表 active/legacy 且有 idle 的条目派生。 */
export const OFFICIAL_IDLE_PRICES: Record<string, ModelPrice> = Object.fromEntries(
  Object.entries(OFFICIAL_MODEL_REGISTRY)
    .map(([name, meta]) => {
      const idle = meta.idle
      return idle === undefined ? null : ([name, { ...idle }] as const)
    })
    .filter((x): x is readonly [string, ModelPrice] => x !== null),
)

/** 官方已下线模型名的归一映射（旧名 → 现行模型名，按现行模型价计费）：由注册表 routed 条目派生。 */
export const OFFICIAL_MODEL_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(OFFICIAL_MODEL_REGISTRY)
    .map(([name, meta]) => {
      const to = meta.routesTo
      return to === undefined ? null : ([name, to] as const)
    })
    .filter((x): x is readonly [string, string] => x !== null),
)

/** 官方模型注册信息（按原始模型名查；未登记返回 undefined）。 */
export function officialModelMetaOf(model: string): OfficialModelMeta | undefined {
  return OFFICIAL_MODEL_REGISTRY[model]
}

/** 官方模型服务状态（按原始模型名查，不做别名归一；未登记返回 undefined）。 */
export function officialModelStatusOf(model: string): OfficialModelStatus | undefined {
  return OFFICIAL_MODEL_REGISTRY[model]?.status
}

/** 归一模型名：命中官方别名表则映射到现行名，否则原样返回。 */
export function canonicalModel(model: string): string {
  return OFFICIAL_MODEL_ALIASES[model] ?? model
}

/** 官方模型归一后的路由（用于匹配用户覆盖与内置价表）。 */
export function canonicalRoute(route: Route): Route {
  const model = canonicalModel(route.model)
  if (model === route.model) return route
  return { provider: route.provider, model }
}

/** 模型所属厂商（按归一模型查注册表；未收录返回 undefined）。 */
export function officialProviderOf(model: string): OfficialProvider | undefined {
  return OFFICIAL_MODEL_REGISTRY[canonicalModel(model)]?.provider
}

/** 模型官方价目币种（按归一模型查注册表；未收录返回 undefined）。 */
export function officialCurrencyOf(model: string): OfficialCurrency | undefined {
  return OFFICIAL_MODEL_REGISTRY[canonicalModel(model)]?.currency
}

/** 模型峰谷策略（按归一模型查注册表；未收录返回 undefined）。 */
export function officialPeakPolicyOf(model: string): OfficialPeakPolicy | undefined {
  return OFFICIAL_MODEL_REGISTRY[canonicalModel(model)]?.peakPolicy
}

/** 模型价目来源分级（按归一模型查注册表；未收录返回 undefined）。 */
export function officialSourceLevelOf(model: string): OfficialSourceLevel | undefined {
  return OFFICIAL_MODEL_REGISTRY[canonicalModel(model)]?.sourceLevel
}

/** 模型价目核对日期（按归一模型查注册表；未收录返回 undefined）。 */
export function officialVerifiedAtOf(model: string): string | undefined {
  return OFFICIAL_MODEL_REGISTRY[canonicalModel(model)]?.verifiedAt
}

/**
 * 官方空闲档单价：模型归一并查官方价表；未收录返回 undefined。
 * 非官方模型（如用户自定义模型）不受官方价影响，回退用户配置 / 兜底价。
 */
export function officialIdlePriceOf(model: string): ModelPrice | undefined {
  const canonical = canonicalModel(model)
  const idle = OFFICIAL_IDLE_PRICES[canonical]
  if (!idle) return undefined
  return { ...idle }
}

/**
 * 官方分带单价（多厂商）：
 *   - dsn-peak 策略（DeepSeek）：idle 用空闲档；peak 用空闲档 × PEAK_MULTIPLIER；
 *   - baichuan-tier 策略（百川 Baichuan2-53B）：idle 用低谷档；peak 用低谷档 × PEAK_MULTIPLIER
 *     （官方公布 0.01/0.02 元每千 = 10/20 元每百万，倍数恰为 ×2）；
 *   - flat 策略（其余厂商）：官方公布为恒定价，peak = idle（band 不影响价格）。
 * 未收录返回 undefined。
 */
export function officialPriceForInstance(model: string, band: CacheBand): ModelPrice | undefined {
  const canonical = canonicalModel(model)
  const meta = OFFICIAL_MODEL_REGISTRY[canonical]
  const idle = meta?.idle
  if (!idle) return undefined
  if (band === 'idle' || meta.peakPolicy === 'flat') return { ...idle }
  return {
    inputPerMillion: idle.inputPerMillion * PEAK_MULTIPLIER,
    cacheReadPerMillion: idle.cacheReadPerMillion * PEAK_MULTIPLIER,
    outputPerMillion: idle.outputPerMillion * PEAK_MULTIPLIER,
    ...(idle.cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion: idle.cacheWritePerMillion * PEAK_MULTIPLIER }),
    ...(idle.creditsPerMillion === undefined ? {} : { creditsPerMillion: idle.creditsPerMillion }),
  }
}

/**
 * 官方基准价表（主计量）：旧内置价 + 官方空闲档价，用户定价覆盖仍最后并入。
 * 启用 officialPricing 时作为主计量基准价表；未启用时仍用 buildPricingTable（零回归）。
 */
export function buildOfficialPricingTable(overrides: Record<string, ModelPrice> = {}): PricingTable {
  return { ...BUILTIN_PRICES, ...OFFICIAL_IDLE_PRICES, ...overrides }
}

/**
 * 官方缓存三通道表（缓存维度计量用）：由注册表 active/legacy 且有 idle 的条目派生。
 * flat 策略（多厂商）peak = idle（官方恒定价）；dsn-peak（DeepSeek）peak = idle × PEAK_MULTIPLIER。
 * 缓存写价（Anthropic）不在缓存三通道引擎计量（三通道 = 命中/未命中/输出），
 * 写 token 由主计量 computeCost 按 cacheWritePerMillion 单独计费。
 */
export function buildOfficialCachePricingTable(): Record<string, RoutePricing> {
  const table: Record<string, RoutePricing> = {}
  for (const [name, meta] of Object.entries(OFFICIAL_MODEL_REGISTRY)) {
    if ((meta.status !== 'active' && meta.status !== 'legacy') || meta.idle === undefined) continue
    const idle = meta.idle
    const idleBand = { inputHit: idle.cacheReadPerMillion, inputMiss: idle.inputPerMillion, output: idle.outputPerMillion }
    const peakBand =
      meta.peakPolicy === 'flat'
        ? { ...idleBand }
        : {
            inputHit: idle.cacheReadPerMillion * PEAK_MULTIPLIER,
            inputMiss: idle.inputPerMillion * PEAK_MULTIPLIER,
            output: idle.outputPerMillion * PEAK_MULTIPLIER,
          }
    table[name] = { idle: idleBand, peak: peakBand }
  }
  return table
}

/**
 * 官方计价取价（优先级从高到低）：
 *   1. 用户覆盖（provider/model、裸 model、归一后的多种键）→ 最终单价，不随峰谷翻倍；
 *   2. 官方价表（按归一模型）→ 空闲/高峰两档（peak 按 peakPolicy：dsn-peak ×2、flat 恒定价）；
 *   3. 基准价表（合并表：旧内置 + 用户覆盖）→ 非官方模型沿用既有定价，不翻倍；
 *   4. 保守兜底价。
 * 返回来源标记供展示与测试（'override' | 'official' | 'builtin' | 'fallback'）。
 */
export function officialEntryPrice(
  userOverrides: Record<string, ModelPrice>,
  route: Route,
  band: CacheBand,
  base?: PricingTable,
): { price: ModelPrice; source: 'override' | 'official' | 'builtin' | 'fallback' } {
  const r = canonicalRoute(route)
  const keys = [
    `${r.provider}/${r.model}`,
    r.model,
    `${route.provider}/${route.model}`,
    route.model,
  ]
  for (const k of keys) {
    const p = userOverrides[k]
    if (p) return { price: { ...p }, source: 'override' }
  }
  const official = officialPriceForInstance(r.model, band)
  if (official) return { price: official, source: 'official' }
  if (base) {
    for (const k of keys) {
      const p = base[k]
      if (p) return { price: { ...p }, source: 'builtin' }
    }
  }
  return { price: { ...FALLBACK_PRICE }, source: 'fallback' }
}

/**
 * 官方峰谷选带（全局展示口径）：复用 cache-pricing 的 DeepSeek 官方判定（工作日非节假日
 * 9-12/14-18 → peak，含周末 / 法定节假全天 → idle）。holidays 为内置 2026 表与用户追加的并集。
 * 展示口径沿用 DeepSeek 官方规则；flat 策略模型恒定价，band 不影响价格。
 */
export function officialBandForEpoch(
  timeMs: number,
  tzOffsetMin: number,
  holidays?: ReadonlySet<string>,
): CacheBand {
  return deepseekBandForEpoch(timeMs, tzOffsetMin, holidays ?? HOLIDAYS_2026)
}

/**
 * 百川 Baichuan2-53B 官方每日峰谷：0:00-8:00 低谷（idle）、8:00-24:00 高峰（peak）。
 * 官方公布两档价 0.01 / 0.02 元每千 tokens（= 10 / 20 元每百万，高峰 = 低谷 × 2）。
 * 无周末 / 节假日例外（官方按每日时段，不区分工作日）。
 */
export function baichuanBandForEpoch(timeMs: number, tzOffsetMin: number): CacheBand {
  const minutes = (Math.floor((timeMs + tzOffsetMin * 60_000) / 60_000) % 1440 + 1440) % 1440
  return minutes < 8 * 60 ? 'idle' : 'peak'
}

/**
 * 按模型峰谷策略选带（计量口径）：dsn-peak → DeepSeek 官方时段判定；
 * baichuan-tier → 百川每日 0-8 低谷 / 8-24 高峰；flat → 恒定价不受时段影响。
 */
export function officialBandForEpochOf(
  model: string,
  timeMs: number,
  tzOffsetMin: number,
  holidays?: ReadonlySet<string>,
): CacheBand {
  const policy = officialPeakPolicyOf(model)
  if (policy === 'baichuan-tier') return baichuanBandForEpoch(timeMs, tzOffsetMin)
  return deepseekBandForEpoch(timeMs, tzOffsetMin, holidays ?? HOLIDAYS_2026)
}

// ---------------------------------------------------------------------------
// 推理 token（思维链）洞察：独立于预算熔断的展示口径，全厂商官方均按输出价计费。
// ---------------------------------------------------------------------------

/** 推理 token 汇总（跨请求累计）。 */
export interface ReasoningSummary {
  /** 产生推理 token 的请求数（指 reasoningTokens > 0 的请求）。 */
  requests: number
  /** 推理 token 累计。 */
  reasoningTokens: number
  /** 输出 token 累计（含推理与正文）。 */
  outputTokens: number
  /** 推理占输出比例（0~1；输出为 0 时为 0）。 */
  share: number
  /** 推理成本 = 推理 token × 官方空闲输出价 / 1e6（币种随模型：DeepSeek CNY，其余 USD）。 */
  cost: number
  /** 平均每请求推理 token（仅有推理请求）。 */
  avgPerRequest: number
}

/** 推理账本：累积 entry 的 reasoningTokens 与 output，产出展示摘要。 */
export class ReasoningLedger {
  private requests = 0
  private reasoningTokens = 0
  private outputTokens = 0
  private cost = 0

  /**
   * @param outputPerMillionOf 按（归一）模型返回官方『空闲』输出单价（每百万 token；币种随模型）。
   *   OpenAI / Anthropic / Gemini / DeepSeek 官方口径统一：推理 token 与正文输出同价计费；
   *   非官方模型返回 0（官方价表未收录，不臆造单价）。
   */
  constructor(private readonly outputPerMillionOf: (model: string) => number) {}

  /** 追加一次调用。reasoningTokens > 0 才计入推理请求数；成本 = 推理 token × 官方输出价 / 1e6。 */
  append(entry: UsageEntry): void {
    const reasoning = Math.max(0, entry.reasoningTokens)
    if (reasoning > 0) {
      this.requests += 1
      this.reasoningTokens += reasoning
      this.outputTokens += Math.max(0, entry.usage.outputTokens)
      const price = Math.max(0, this.outputPerMillionOf(canonicalModel(entry.route.model)))
      this.cost += (reasoning * price) / 1_000_000
    }
  }

  reset(): void {
    this.requests = 0
    this.reasoningTokens = 0
    this.outputTokens = 0
    this.cost = 0
  }

  /** 汇总（无推理样本时返回 null）。 */
  summary(): ReasoningSummary | null {
    if (this.requests <= 0) return null
    const outputTokens = this.outputTokens
    return {
      requests: this.requests,
      reasoningTokens: this.reasoningTokens,
      outputTokens,
      share: outputTokens > 0 ? this.reasoningTokens / outputTokens : 0,
      cost: this.cost,
      avgPerRequest: this.reasoningTokens / this.requests,
    }
  }
}