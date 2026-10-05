/**
 * @module dsh-cost-guard/harness/reasoning-tax-audit
 * 多维思考税审计（0.18.0，可选）DSH 适配层：
 * - 由用量事件流喂入思考税审计账本（core/reasoning-tax-audit.ts），按会话与
 *   时间热力双维度聚合推理 token / 可见输出 / 税成本，输出会话 Top N 排行、
 *   热力峰值时段与中文审计叙事；
 * - 注册只读工具 `cost_guard_reasoning_audit`：Agent 可请求「哪个会话在烧
 *   思考税 / 一天中何时烧得最集中 / 怎么收」，拿到会话排行 + 热力序列 +
 *   证据 + 建议（定位「谁烧的、何时烧的」的 Agent 能力，市面无同类工具）；
 * - 面板负载 `reasoningTaxAudit` 并入成本状态，未配置时整体 undefined
 *   （与 0.17.0 完全一致，零回归）。
 *
 * 兼容边界：`reasoningTaxAudit` 配置未提供时本适配层不构造（undefined），
 * 事件流与状态输出与 0.17.0 完全一致（零回归）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { UsageEntry } from '../core/types.js'
import {
  ReasoningTaxAuditLedger,
  buildReasoningTaxAuditExplanation,
  formatReasoningTaxAuditExplanation,
  type ReasoningTaxAuditOptions,
  type ReasoningTaxAuditReport,
  type ReasoningTaxAuditSlice,
  type ReasoningTaxHeatBucket,
} from '../core/reasoning-tax-audit.js'
import type { ExplainItem } from '../core/explain.js'

/** 面板负载（并入 CostStatusPayload.reasoningTaxAudit；未启用时为 undefined 零回归）。 */
export interface ReasoningTaxAuditPanelPayload {
  enabled: true
  /** 归因窗口（0.18.0 为存量构成归因）。 */
  window: 'current'
  /** 会话 Top N 排行条目数。 */
  sessionTopN: number
  /** 热力保留桶数。 */
  heatBuckets: number
  /** 审计报表（JSON 安全，供面板与工具复用）。 */
  report: ReasoningTaxAuditReport
}

/** 多维思考税审计运行时：持账本 + 维度配置，输出报表 + 叙事。 */
export class ReasoningTaxAuditRuntime {
  private readonly ledger: ReasoningTaxAuditLedger

  constructor(outputPriceOf: (model: string) => number, options?: ReasoningTaxAuditOptions) {
    this.ledger = new ReasoningTaxAuditLedger(outputPriceOf, options)
  }

  /** 由主计量 sampler 喂入一次用量入账（reasoningTokens > 0 才入账；sessionId 可选）。 */
  append(entry: UsageEntry, sessionId?: string): void {
    this.ledger.append(entry, sessionId)
  }

  /** 查询当前思考税审计存量（不消费 / 更新基线）。无样本时 null。 */
  view(): { report: ReasoningTaxAuditReport; items: ExplainItem[] } | null {
    const report = this.ledger.report()
    if (report === null) return null
    return { report, items: buildReasoningTaxAuditExplanation(report) }
  }

  /** 只读查询当前存量审计（供面板）。无样本时 undefined。 */
  panel(): ReasoningTaxAuditPanelPayload | undefined {
    const { report } = this.view() ?? {}
    if (report === undefined) return undefined
    const opts = this.ledgerOptions()
    return {
      enabled: true,
      window: 'current',
      sessionTopN: opts.sessionTopN,
      heatBuckets: opts.heatBuckets,
      report,
    }
  }

  private ledgerOptions(): { sessionTopN: number; heatBuckets: number } {
    // 与账本构造同步的默认值（core 已按相同规则展开）
    return { sessionTopN: 5, heatBuckets: 24 }
  }
}

/** 切片行 JSON 投影（保真、无 undefined 键；数值均为有限数）。 */
function sliceToJson(slice: ReasoningTaxAuditSlice): Record<string, JsonValue> {
  return {
    key: slice.key,
    requests: slice.requests,
    reasoningTokens: slice.reasoningTokens,
    outputTokens: slice.outputTokens,
    taxCost: slice.taxCost,
  }
}

/** 热力桶 JSON 投影。 */
function bucketToJson(bucket: ReasoningTaxHeatBucket): Record<string, JsonValue> {
  return {
    key: bucket.key,
    start: bucket.start,
    end: bucket.end,
    requests: bucket.requests,
    reasoningTokens: bucket.reasoningTokens,
    outputTokens: bucket.outputTokens,
    taxCost: bucket.taxCost,
  }
}

/** 审计报表 -> 无损 JSON（无 NaN/Infinity/-0/undefined 键，与 dsh-session JsonValue 契约一致）。 */
function reportToJson(report: ReasoningTaxAuditReport): Record<string, JsonValue> {
  return {
    window: report.window,
    totalReasoningTokens: report.totalReasoningTokens,
    totalOutputTokens: report.totalOutputTokens,
    totalTaxCost: report.totalTaxCost,
    taxRatio: report.taxRatio,
    sessionRequests: report.sessionRequests,
    sessions: report.sessions.map(sliceToJson),
    heat: report.heat.map(bucketToJson),
    ...(report.dominantSession !== undefined ? { dominantSession: sliceToJson(report.dominantSession) } : {}),
    ...(report.dominantBucket !== undefined ? { dominantBucket: bucketToJson(report.dominantBucket) } : {}),
  }
}

/**
 * 注册只读工具 `cost_guard_reasoning_audit`：
 * 「哪个会话 / 哪个时段在烧思考税」——返回会话 Top N 排行、时间热力序列、
 * 主因会话、热力峰值桶与中文审计叙事（总览/因子/建议）。
 */
export function attachReasoningTaxAuditTool(ctx: Context, runtime: ReasoningTaxAuditRuntime): void {
  ctx.tools.register(
    defineTool({
      name: 'cost_guard_reasoning_audit',
      description:
        '读取多维思考税审计报表（只读）：回答「哪个会话在烧思考税 / 一天中何时烧得最集中 / 怎么收」——' +
        '按会话给出推理 token 聚合排行（Top N，含推理占比与税成本），按时间热力桶给出分布序列与峰值时段，' +
        '以及中文治理建议（会话思考预算收敛 / 热点错峰 / 时段预算护栏）。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute(): Promise<Record<string, JsonValue>> {
        const view = runtime.view()
        const out: Record<string, JsonValue> =
          view === null
            ? {
                window: 'current',
                summary: '暂无推理 token 样本（reasoningTokens > 0 的调用尚未发生）',
              }
            : {
                window: view.report.window,
                summary:
                  view.report.dominantSession !== undefined
                    ? `主因会话 ${view.report.dominantSession.key}`
                    : '暂无主因会话',
                report: reportToJson(view.report),
              }
        if (view !== null && view.items.length > 0) {
          out['narrative'] = view.items.map((item) => item.text)
          out['explanation'] = formatReasoningTaxAuditExplanation(view.items)
        }
        return Promise.resolve(out)
      },
    }),
  )
}

/** 人读多维思考税审计面板行（供 formatStatusSummary 复用）。 */
export function formatReasoningTaxAuditLines(payload: ReasoningTaxAuditPanelPayload): string[] {
  const r = payload.report
  const lines: string[] = []
  const session = r.dominantSession
  const bucket = r.dominantBucket
  const head = `推理税审计: 推理 ${r.totalReasoningTokens.toLocaleString()} tokens（思考税 ${Math.round(r.taxRatio * 100)}% · 估算 ${r.totalTaxCost.toFixed(2)}）`
  lines.push(
    head +
      (session !== undefined ? ` · 主因会话 ${session.key}` : '') +
      (bucket !== undefined ? ` · 热力峰值 ${clockText(bucket.start)} 起 1h` : ''),
  )
  if (r.sessions.length > 1) {
    const others = r.sessions.slice(1)
    lines.push(`  会话排行：${others.map((s) => `${s.key}（${s.reasoningTokens.toLocaleString()} tokens）`).join('、')}`)
  }
  return lines
}

/** epoch ms -> 'HH:mm'（UTC 口径，与 core 侧一致）。 */
function clockText(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}