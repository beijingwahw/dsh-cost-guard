/**
 * @module dsh-cost-guard/core/meter
 * 用量计量器：把 UsageEntry 累计进 会话 / 日 / 月 / 总 四个维度，
 * 并记录按路由与按会话的明细快照。与 DSH 运行时解耦，纯内存 + 可持久化。
 */

import type { BudgetScope, UsageBucket, UsageEntry } from './types.js'
import { emptyBucket, BASE_BAND } from './types.js'
import { dayKey, monthKey } from './clock.js'

export interface MeterSnapshot {
  /** scope -> 桶。total 的键是 'total'。 */
  buckets: Partial<Record<BudgetScope, UsageBucket>>
  routes: Record<string, UsageBucket>
  sessions: Record<string, UsageBucket>
  /** 按峰谷时段累计（bandId -> 桶）。 */
  bands: Record<string, UsageBucket>
}

export class Meter {
  private readonly buckets: Partial<Record<BudgetScope, UsageBucket>> = {}
  private readonly routes: Record<string, UsageBucket> = {}
  private readonly sessions: Record<string, UsageBucket> = {}
  private readonly bands: Record<string, UsageBucket> = {}

  constructor(
    private readonly tzOffsetMin: number,
    seed?: MeterSnapshot,
  ) {
    if (seed) {
      this.buckets = seed.buckets ? { ...seed.buckets } : {}
      this.routes = { ...seed.routes }
      this.sessions = { ...seed.sessions }
      this.bands = seed.bands ? { ...seed.bands } : {}
    }
  }

  private bucketOf(scope: BudgetScope): UsageBucket {
    let b = this.buckets[scope]
    if (!b) {
      b = emptyBucket()
      this.buckets[scope] = b
    }
    return b
  }

  private add(bucket: UsageBucket, e: UsageEntry): void {
    bucket.requests += 1
    bucket.inputTokens += e.usage.inputTokens
    bucket.cacheReadTokens += e.cacheReadTokens
    bucket.outputTokens += e.usage.outputTokens
    bucket.totalTokens += e.totalTokens
    bucket.cost += e.cost
    // ?? 0：兼容旧版快照 / 缺失积分字段的条目，避免 NaN 污染累计
    bucket.credits += e.credits ?? 0
  }

  /** 记录一次模型调用用量。 */
  record(entry: UsageEntry, sessionId?: string): void {
    // 时间维度
    this.add(this.bucketOf('total'), entry)
    this.add(this.bucketOf('day'), entry)
    if (sessionId) {
      this.add(this.bucketOf('session'), entry)
    }
    // 峰谷时段维度（实时追踪分带累计）
    const bandId = entry.band ?? BASE_BAND
    let bb = this.bands[bandId]
    if (!bb) {
      bb = emptyBucket()
      this.bands[bandId] = bb
    }
    this.add(bb, entry)
    // 路由与会话明细
    const routeKey = `${entry.route.provider}/${entry.route.model}`
    let rb = this.routes[routeKey]
    if (!rb) {
      rb = emptyBucket()
      this.routes[routeKey] = rb
    }
    this.add(rb, entry)
    if (sessionId) {
      let sb = this.sessions[sessionId]
      if (!sb) {
        sb = emptyBucket()
        this.sessions[sessionId] = sb
      }
      this.add(sb, entry)
    }
  }

  /** 读取某 scope 当前累计（不含实时精度调整）。 */
  spent(scope: BudgetScope): UsageBucket {
    const b = this.buckets[scope]
    if (b) return { ...b }
    return emptyBucket()
  }

  snapshot(): MeterSnapshot {
    const buckets: Partial<Record<BudgetScope, UsageBucket>> = {}
    for (const [k, v] of Object.entries(this.buckets)) {
      if (k === 'session' || k === 'day' || k === 'month' || k === 'total') {
        buckets[k] = { ...v }
      }
    }
    const routes: Record<string, UsageBucket> = {}
    for (const [k, v] of Object.entries(this.routes)) routes[k] = { ...v }
    const sessions: Record<string, UsageBucket> = {}
    for (const [k, v] of Object.entries(this.sessions)) sessions[k] = { ...v }
    const bands: Record<string, UsageBucket> = {}
    for (const [k, v] of Object.entries(this.bands)) bands[k] = { ...v }
    return { buckets, routes, sessions, bands }
  }

  /** 按峰谷时段读取累计（bandId -> 桶），供实时追踪展示。 */
  bandTotals(): Record<string, UsageBucket> {
    const out: Record<string, UsageBucket> = {}
    for (const [k, v] of Object.entries(this.bands)) out[k] = { ...v }
    return out
  }
}

// ---------- 长效日 / 月桶 ----------
/**
 * 日 / 月桶独立由 Meter 之外的窗口表维护：
 * 每个日历日 / 月一个独立 Bucket，可跨『日』、『月』读取历史曲线。
 */
export class WindowMeter {
  private readonly days: Map<string, UsageBucket> = new Map()
  private readonly months: Map<string, UsageBucket> = new Map()
  private readonly dayBandBuckets: Map<string, Record<string, UsageBucket>> = new Map()
  private readonly monthBandBuckets: Map<string, Record<string, UsageBucket>> = new Map()

  constructor(
    private readonly tzOffsetMin: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 记录一次调用用量（仅日 / 月窗口）。 */
  record(entry: UsageEntry): void {
    const dk = dayKey(entry.time, this.tzOffsetMin)
    const mk = monthKey(entry.time, this.tzOffsetMin)
    let db = this.days.get(dk)
    if (!db) {
      db = emptyBucket()
      this.days.set(dk, db)
    }
    let mb = this.months.get(mk)
    if (!mb) {
      mb = emptyBucket()
      this.months.set(mk, mb)
    }
    this.add(db, entry)
    this.add(mb, entry)

    // 峰谷时段分布（日 / 月）
    const bandId = entry.band ?? BASE_BAND
    let dbs = this.dayBandBuckets.get(dk)
    if (!dbs) {
      dbs = {}
      this.dayBandBuckets.set(dk, dbs)
    }
    let dbBucket = dbs[bandId]
    if (!dbBucket) {
      dbBucket = emptyBucket()
      dbs[bandId] = dbBucket
    }
    this.add(dbBucket, entry)
    let mbs = this.monthBandBuckets.get(mk)
    if (!mbs) {
      mbs = {}
      this.monthBandBuckets.set(mk, mbs)
    }
    let mbBucket = mbs[bandId]
    if (!mbBucket) {
      mbBucket = emptyBucket()
      mbs[bandId] = mbBucket
    }
    this.add(mbBucket, entry)
  }

  private add(bucket: UsageBucket, e: UsageEntry): void {
    bucket.requests += 1
    bucket.inputTokens += e.usage.inputTokens
    bucket.cacheReadTokens += e.cacheReadTokens
    bucket.outputTokens += e.usage.outputTokens
    bucket.totalTokens += e.totalTokens
    bucket.cost += e.cost
    // ?? 0：兼容旧版快照 / 缺失积分字段的条目，避免 NaN 污染累计
    bucket.credits += e.credits ?? 0
  }

  day(key: string): UsageBucket {
    return { ...(this.days.get(key) ?? emptyBucket()) }
  }

  month(key: string): UsageBucket {
    return { ...(this.months.get(key) ?? emptyBucket()) }
  }

  today(): UsageBucket {
    return this.day(dayKey(this.now(), this.tzOffsetMin))
  }

  thisMonth(): UsageBucket {
    return this.month(monthKey(this.now(), this.tzOffsetMin))
  }

  /** 今日按峰谷时段分布（bandId -> 桶）。 */
  todayBands(): Record<string, UsageBucket> {
    return this.dayBands(dayKey(this.now(), this.tzOffsetMin))
  }

  /** 本月按峰谷时段分布（bandId -> 桶）。 */
  thisMonthBands(): Record<string, UsageBucket> {
    return this.monthBands(monthKey(this.now(), this.tzOffsetMin))
  }

  /** 某日按峰谷时段分布。 */
  dayBands(key: string): Record<string, UsageBucket> {
    const inner = this.dayBandBuckets.get(key)
    if (!inner) return {}
    const out: Record<string, UsageBucket> = {}
    for (const [k, v] of Object.entries(inner)) out[k] = { ...v }
    return out
  }

  /** 某月按峰谷时段分布。 */
  monthBands(key: string): Record<string, UsageBucket> {
    const inner = this.monthBandBuckets.get(key)
    if (!inner) return {}
    const out: Record<string, UsageBucket> = {}
    for (const [k, v] of Object.entries(inner)) out[k] = { ...v }
    return out
  }

  recentDays(n: number): Array<{ key: string; bucket: UsageBucket }> {
    const out: Array<{ key: string; bucket: UsageBucket }> = []
    const now = this.now()
    for (let i = n - 1; i >= 0; i--) {
      const ms = now - i * 86_400_000
      const key = dayKey(ms, this.tzOffsetMin)
      out.push({ key, bucket: this.day(key) })
    }
    return out
  }
}