/**
 * @module dsh-cost-guard/core/reasoning-tax-audit
 * 多维思考税审计（Reasoning Tax Audit，0.18.0，零 DSH 依赖）。
 *
 * 市面空缺：0.17.0 的思考税治理回答「哪条路由在烧思考税」，但用户还缺两问——
 * 「哪个会话在烧」与「什么时候在烧」。本模块在既有路由归因账本之外新增两个
 * 独立切片维度（互不依赖、可单独消费）：
 *   1. 会话维度：按 sessionId 聚合推理 token / 可见输出 / 税成本，输出 Top N
 *      会话排行与主因会话（回答「谁的推理链最贵」）；
 *   2. 时间热力维度：按固定时长桶（bucketMinutes，默认 60 分钟）聚合推理 token
 *      与税成本，保留最近 heatBuckets（默认 24）个桶，输出热力序列与峰值桶
 *      （回答「思考税在一天中何时集中」（热点时段治理））。
 *
 * 与 0.17.0 的路由归因（reasoning-tax.ts）正交：同一 entry 可同时进入
 * 路由账本与本审计账本，互不读写对方状态；本模块亦只读、纯函数、无副作用，
 * 币种与取价全部注入，冒烟与单测可确定性复现。
 */

import type { UsageEntry } from './types.js'
import type { ExplainItem } from './explain.js'

/** 会话 / 时间切片的聚合账目（依据 usage 事实，无推测）。 */
export interface ReasoningTaxAuditSlice {
  /** 切片键：会话 id 或时间桶起点 epoch ms。 */
  key: string
  /** 产生推理 token 的请求数。 */
  requests: number
  /** 推理 token 累计。 */
  reasoningTokens: number
  /** 可见输出 token 累计（不含推理）。 */
  outputTokens: number
  /** 思考税估算成本 = 推理 token × 输出价 / 1e6（币种随模型取价器）。 */
  taxCost: number
}

/** 时间热力桶（固定时长切片）。 */
export interface ReasoningTaxHeatBucket extends ReasoningTaxAuditSlice {
  /** 桶起点 epoch ms（含）。 */
  start: number
  /** 桶终点 epoch ms（不含）= start + bucketMs。 */
  end: number
}

/** 多维思考税审计报表（存量构成归因，不消费 / 更新基线）。 */
export interface ReasoningTaxAuditReport {
  /** 归因窗口（0.18.0 为存量构成归因）。 */
  window: 'current'
  /** 推理 token 累计（全部会话 / 桶）。 */
  totalReasoningTokens: number
  /** 可见输出 token 累计。 */
  totalOutputTokens: number
  /** 推理税成本累计。 */
  totalTaxCost: number
  /** 全局思考税 = 推理 / (推理 + 可见输出)；0~1。 */
  taxRatio: number
  /** 独立参与会话切片的请求数（提供 sessionId 的推理调用数）。 */
  sessionRequests: number
  /** 会话维度 Top N 排行（按 taxCost 降序；无价会话排后；同成本按推理 token 多者优先）。 */
  sessions: ReasoningTaxAuditSlice[]
  /** 时间热力桶序列（按 start 升序，最多 heatBuckets 个）。 */
  heat: ReasoningTaxHeatBucket[]
  /** 主因会话（税成本最高；无样本时不出现）。 */
  dominantSession?: ReasoningTaxAuditSlice
  /** 热力峰值桶（税成本最高；无样本时不出现）。 */
  dominantBucket?: ReasoningTaxHeatBucket
}

/** 多维思考税审计账本配置。 */
export interface ReasoningTaxAuditOptions {
  /** 时间桶时长（分钟），默认 60。 */
  bucketMinutes?: number
  /** 热力序列保留的最近桶数，默认 24。 */
  heatBuckets?: number
  /** 会话排行保留条数（Top N），默认 5。 */
  sessionTopN?: number
}

const DEFAULT_BUCKET_MINUTES = 60
const DEFAULT_HEAT_BUCKETS = 24
const DEFAULT_SESSION_TOP_N = 5

function ratioPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function fmtCost(cost: number): string {
  return cost.toFixed(2)
}

interface SliceAcc {
  requests: number
  reasoningTokens: number
  outputTokens: number
  taxCost: number
}

function accAdd(acc: SliceAcc, entry: UsageEntry, reasoning: number, price: number): void {
  acc.requests += 1
  acc.reasoningTokens += reasoning
  acc.outputTokens += Math.max(0, entry.usage.outputTokens)
  acc.taxCost += (reasoning * price) / 1_000_000
}

/** 多维思考税审计账本：会话切片 + 时间热力双维度聚合。 */
export class ReasoningTaxAuditLedger {
  private readonly sessions = new Map<string, SliceAcc>()
  private readonly buckets = new Map<number, SliceAcc>()
  private readonly bucketMs: number
  private readonly heatBuckets: number
  private readonly sessionTopN: number

  constructor(
    private readonly outputPriceOf: (model: string) => number,
    options?: ReasoningTaxAuditOptions,
  ) {
    this.bucketMs = (options?.bucketMinutes ?? DEFAULT_BUCKET_MINUTES) * 60_000
    this.heatBuckets = options?.heatBuckets ?? DEFAULT_HEAT_BUCKETS
    this.sessionTopN = Math.max(1, options?.sessionTopN ?? DEFAULT_SESSION_TOP_N)
  }

  /** 追加一次调用（reasoningTokens <= 0 不入账；sessionId 缺失只记热力、不记会话切片）。 */
  append(entry: UsageEntry, sessionId?: string): void {
    const reasoning = Math.max(0, entry.reasoningTokens)
    if (reasoning <= 0) return
    const price = Math.max(0, this.outputPriceOf(entry.route.model))
    if (sessionId !== undefined && sessionId.length > 0) {
      const acc = this.sessions.get(sessionId) ?? { requests: 0, reasoningTokens: 0, outputTokens: 0, taxCost: 0 }
      accAdd(acc, entry, reasoning, price)
      this.sessions.set(sessionId, acc)
    }
    const bucketStart = Math.floor(entry.time / this.bucketMs) * this.bucketMs
    const bucketAcc = this.buckets.get(bucketStart) ?? { requests: 0, reasoningTokens: 0, outputTokens: 0, taxCost: 0 }
    accAdd(bucketAcc, entry, reasoning, price)
    this.buckets.set(bucketStart, bucketAcc)
  }

  reset(): void {
    this.sessions.clear()
    this.buckets.clear()
  }

  /** 汇总审计报表（无推理样本时返回 null）。 */
  report(): ReasoningTaxAuditReport | null {
    // 热力：保留最近的 heatBuckets 个桶，按 start 升序
    const starts = [...this.buckets.keys()].sort((a, b) => a - b)
    const recent = starts.slice(-this.heatBuckets)
    const heat: ReasoningTaxHeatBucket[] = []
    for (const start of recent) {
      const acc = this.buckets.get(start)
      if (acc === undefined) continue
      heat.push({
        key: String(start),
        start,
        end: start + this.bucketMs,
        requests: acc.requests,
        reasoningTokens: acc.reasoningTokens,
        outputTokens: acc.outputTokens,
        taxCost: acc.taxCost,
      })
    }

    // 会话排行：税成本降序（无价排后），同成本推理 token 多者优先
    const sessions: ReasoningTaxAuditSlice[] = [...this.sessions.entries()]
      .map(([key, acc]) => ({ key, ...acc }))
      .sort(
        (a, b) =>
          b.taxCost !== a.taxCost ? b.taxCost - a.taxCost : b.reasoningTokens - a.reasoningTokens,
      )
      .slice(0, this.sessionTopN)

    let totalReasoningTokens = 0
    let totalOutputTokens = 0
    let totalTaxCost = 0
    for (const bucket of heat) {
      totalReasoningTokens += bucket.reasoningTokens
      totalOutputTokens += bucket.outputTokens
      totalTaxCost += bucket.taxCost
    }
    if (totalReasoningTokens <= 0) return null

    const sum = totalReasoningTokens + totalOutputTokens
    const taxRatio = sum > 0 ? totalReasoningTokens / sum : 0
    const sessionRequests = [...this.sessions.values()].reduce((n, acc) => n + acc.requests, 0)
    const dominantSession = sessions[0]
    const dominantBucket =
      heat.length > 0 ? [...heat].sort((a, b) => (b.taxCost !== a.taxCost ? b.taxCost - a.taxCost : b.reasoningTokens - a.reasoningTokens))[0] : undefined

    return {
      window: 'current',
      totalReasoningTokens,
      totalOutputTokens,
      totalTaxCost,
      taxRatio,
      sessionRequests,
      sessions,
      heat,
      ...(dominantSession !== undefined ? { dominantSession } : {}),
      ...(dominantBucket !== undefined ? { dominantBucket } : {}),
    }
  }
}

/**
 * 生成多维思考税审计中文叙事（纯函数；与 reasoning-tax 同构：summary / factor /
 * suggestion）。只消费报表事实，不额外注入阈值参数。
 */
export function buildReasoningTaxAuditExplanation(report: ReasoningTaxAuditReport): ExplainItem[] {
  const items: ExplainItem[] = []

  const summaryParts = [`推理 token 累计 ${report.totalReasoningTokens.toLocaleString()}`]
  if (report.taxRatio > 0) summaryParts.push(`思考税 ${ratioPct(report.taxRatio)}`)
  if (report.totalTaxCost > 0) summaryParts.push(`估算成本 ${fmtCost(report.totalTaxCost)}`)
  summaryParts.push(`覆盖会话切片 ${report.sessionRequests} 次调用`)
  const peakText =
    report.dominantBucket !== undefined
      ? `热力峰值 ${bucketClock(report.dominantBucket.start)} 起 1 小时`
      : '暂无热力样本'
  summaryParts.push(peakText)
  items.push({ kind: 'summary', text: `多维思考税审计：${summaryParts.join(' · ')}。` })

  // 因子句：主因会话 + 热力峰值桶各一句
  const session = report.dominantSession
  if (session !== undefined) {
    const total = session.reasoningTokens + session.outputTokens
    const ratio = total > 0 ? session.reasoningTokens / total : 0
    const share =
      report.totalReasoningTokens > 0 ? session.reasoningTokens / report.totalReasoningTokens : 0
    const costPart = session.taxCost > 0 ? `，税成本 ${fmtCost(session.taxCost)}` : '（无官方价，成本未估）'
    items.push({
      kind: 'factor',
      text: `  主因会话「${session.key}」推理 ${session.reasoningTokens.toLocaleString()} token（占该会话输出 ${ratioPct(ratio)}，占全局推理 ${ratioPct(share)}，${session.requests} 次）${costPart}`,
    })
  }
  const bucket = report.dominantBucket
  if (bucket !== undefined) {
    const share = report.totalReasoningTokens > 0 ? bucket.reasoningTokens / report.totalReasoningTokens : 0
    const costPart = bucket.taxCost > 0 ? `，税成本 ${fmtCost(bucket.taxCost)}` : '（无官方价，成本未估）'
    items.push({
      kind: 'factor',
      text: `  热力峰值时段 ${bucketClock(bucket.start)} 起 1 小时推理 ${bucket.reasoningTokens.toLocaleString()} token（占全局推理 ${ratioPct(share)}，${bucket.requests} 次）${costPart}`,
    })
  }

  // 建议句：会话收敛 / 热点错峰两条治理线（只陈述有据结论）
  const suggestions: string[] = []
  if (session !== undefined && report.totalReasoningTokens > 0) {
    const share = session.reasoningTokens / report.totalReasoningTokens
    if (share >= 0.5) {
      suggestions.push(
        `建议：主因会话「${session.key}」贡献 ${ratioPct(share)} 的推理 token——` +
          `可在该会话内收缩 thinking_budget 或按任务复杂度切换非推理模型，收敛单会话思考税。`,
      )
    } else if (session.taxCost > 0) {
      suggestions.push(
        `建议：会话「${session.key}」是当前思考税最高会话（税成本 ${fmtCost(session.taxCost)}）——` +
          `优先对该会话做推理链压缩或路由降级。`,
      )
    }
  }
  if (bucket !== undefined && report.totalReasoningTokens > 0) {
    const share = bucket.reasoningTokens / report.totalReasoningTokens
    if (share >= 0.5) {
      suggestions.push(
        `建议：思考税集中在 ${bucketClock(bucket.start)} 起的 1 小时内（占全局 ${ratioPct(share)}）——` +
          `若为批量任务，可错峰拆分；若必有此高峰，为该时段设置独立推理税预算护栏。`,
      )
    } else if (bucket.taxCost > 0) {
      suggestions.push(
        `建议：热力峰值时段税成本 ${fmtCost(bucket.taxCost)}——可在该时段前提前收紧全局思考预算或切换轻量模型，平滑高峰消耗。`,
      )
    }
  }
  if (suggestions.length === 0) {
    suggestions.push(
      `建议：可为高思考税会话单独设置预算（limit + warn/hard 水位），并把热力峰值时段纳入错峰治理。`,
    )
  }
  for (const s of suggestions) {
    items.push({ kind: 'suggestion', text: s })
  }
  return items
}

/** 把审计叙事拼为单段文本（供工具文本输出 / 日志）。 */
export function formatReasoningTaxAuditExplanation(items: ExplainItem[]): string {
  return items.map((item) => item.text).join('\n')
}

/** epoch ms -> 'HH:mm'（按 UTC 时区换算；与 0.17.0 面板口径一致的环境相关）。 */
function bucketClock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}