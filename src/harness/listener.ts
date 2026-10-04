/**
 * @module dsh-cost-guard/harness/listener
 * DSH 事件适配层：把 `session/event`（assistant/message.usage + request/header）转换为
 * DetectionEntry 送入 Meter，实现实时计量。
 *
 * 数据链路：
 *   session/event(request/header)  -> 记录当前路由（provider/model）
 *   session/event(assistant/message) -> 携带 usage，按当前路由计价后记录
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsageLike, UsageEntry } from '../core/types.js'
import { computeCost, billedTokens, priceFor, type PricingTable } from '../core/pricing.js'
import type { Meter } from '../core/meter.js'
import type { WindowMeter } from '../core/meter.js'

/** 宿主侧会话事件解析出的可用字段。 */
export interface ParsedSessionEvent {
  type: string
  time: number
  sessionId?: string
  usage?: TokenUsageLike
  provider?: string
  model?: string
}

/** 从 DSH 的 SessionEvent 提取我们需要的字段（宽容解析，字段缺失不抛错）。 */
export function parseSessionEvent(event: SessionEvent & { sessionId?: string }): ParsedSessionEvent {
  const base: ParsedSessionEvent = {
    type: event.type,
    time: event.time,
    sessionId: event.sessionId,
  }
  const data = (event as unknown as { data?: unknown }).data
  if (!data || typeof data !== 'object') return base

  const record = data as Record<string, unknown>

  // request/header -> 路由
  if (event.type === 'request/header') {
    const header = record.header as { config?: { provider?: string; model?: string } } | undefined
    const config = header?.config
    if (config?.provider) base.provider = config.provider
    if (config?.model) base.model = config.model
  }

  // assistant/message -> usage
  if (event.type === 'assistant/message') {
    const usage = record.usage as TokenUsageLike | undefined
    if (usage && typeof usage.inputTokens === 'number') {
      base.usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
      }
    }
  }

  return base
}

/** 由解析后的宿主事件构造计价入账条目。 */
export function toUsageEntry(
  parsed: ParsedSessionEvent,
  routes: PricingTable,
  fallbackRoute: { provider: string; model: string },
): UsageEntry | undefined {
  if (!parsed.usage || parsed.usage.inputTokens + parsed.usage.outputTokens + (parsed.usage.cacheReadTokens ?? 0) <= 0) {
    return undefined
  }
  const route = {
    provider: parsed.provider ?? fallbackRoute.provider,
    model: parsed.model ?? fallbackRoute.model,
  }
  const { price } = priceFor(routes, route)
  const usage = {
    inputTokens: parsed.usage.inputTokens,
    outputTokens: parsed.usage.outputTokens,
    cacheReadTokens: parsed.usage.cacheReadTokens ?? 0,
  }
  return {
    time: parsed.time,
    route,
    usage,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: parsed.usage.reasoningTokens ?? 0,
    cost: computeCost(price, usage),
    totalTokens: billedTokens(usage),
  }
}

export interface MeterSink {
  record(entry: UsageEntry, sessionId?: string): void
  /** 日/月窗口。 */
  recordWindow(entry: UsageEntry): void
}

/** 订阅宿主事件的计量管道（inject 由插件入口决定）。 */
export function attachSessionMeter(
  ctx: Context,
  sink: MeterSink,
  routes: PricingTable,
  fallbackRoute: { provider: string; model: string },
): () => void {
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const parsed = parseSessionEvent({ ...event, sessionId: String(session.id) })
    const entry = toUsageEntry(parsed, routes, fallbackRoute)
    if (!entry) return
    sink.record(entry, parsed.sessionId)
    sink.recordWindow(entry)
  })
  return () => {
    /* ctx.on 在插件卸载时自动回收 */
  }
}

/** 便捷工厂：直接绑定 Meter + WindowMeter。 */
export function attachMeters(
  ctx: Context,
  meter: Meter,
  windows: WindowMeter,
  routes: PricingTable,
  fallbackRoute: { provider: string; model: string },
): () => void {
  return attachSessionMeter(
    ctx,
    {
      record: (entry, sessionId) => meter.record(entry, sessionId),
      recordWindow: (entry) => windows.record(entry),
    },
    routes,
    fallbackRoute,
  )
}