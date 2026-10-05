/**
 * @module dsh-cost-guard/harness/tenant
 * 多租户成本解释视图（0.16.0，可选）DSH 适配层：
 * - 由 Meter 快照按租户解析器聚合会话桶，输出租户间归因报表（core/tenant.ts）
 *   与中文叙事，并在每个主因租户内下钻到会话视角（两级证据链）；
 * - 注册只读工具 `cost_guard_tenant`：Agent 可请求「哪个租户在烧钱 / 为什么」，
 *   拿到结构化租户根因 + 内部会话证据 + 建议；
 * - 面板负载 `tenant` 并入成本状态，未配置时整体 undefined（零回归）。
 *
 * 兼容边界：`tenant` 配置未提供时本适配层不构造（undefined），
 * 事件流与状态输出与 0.15.0 完全一致（零回归）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Meter } from '../core/meter.js'
import {
  analyzeTenantRca,
  buildTenantExplanation,
  type TenantCostReport,
  type TenantRcaInput,
  type TenantResolver,
} from '../core/tenant.js'
import type { RcaFactor, RcaFactorView } from '../core/rca.js'
import type { ExplainItem } from '../core/explain.js'

/** 面板负载（并入 CostStatusPayload.tenant；未启用时为 undefined 零回归）。 */
export interface TenantPanelPayload {
  enabled: true
  /** 归因窗口：current=存量构成归因 / delta=与上次查询基线增量归因。 */
  window: 'current' | 'delta'
  /** 多租户成本解释报表（JSON 安全，供面板与工具复用）。 */
  report: TenantCostReport
}

/** 租户解释运行时：持租户解析器，输出租户报表 + 叙事。 */
export class TenantRuntime {
  private lastInput: TenantRcaInput | undefined

  constructor(
    private readonly meter: Meter,
    private readonly resolve?: TenantResolver,
  ) {}

  /**
   * 查询多租户成本解释。
   * - mode='current'：对当前快照做存量构成归因（不消费/更新基线）；
   * - mode='delta'：与上次 delta/current 查询留下的基线对比（首次查询退化为
   *   存量归因并建立基线）。两次连续查询即得「与上次相比」的租户增量根因。
   */
  view(mode: 'current' | 'delta' = 'current'): {
    report: TenantCostReport
    items: ExplainItem[]
  } {
    const snapshot = this.meter.snapshot()
    const input: TenantRcaInput = { sessions: snapshot.sessions }
    const useBaseline = mode === 'delta' && this.lastInput !== undefined
    const report = analyzeTenantRca(
      input,
      useBaseline && this.lastInput !== undefined
        ? {
            baseline: this.lastInput,
            ...(this.resolve !== undefined ? { resolve: this.resolve } : {}),
          }
        : this.resolve !== undefined
          ? { resolve: this.resolve }
          : undefined,
    )
    if (mode === 'delta') {
      this.lastInput = input
    }
    const items = buildTenantExplanation(report)
    return { report, items }
  }

  /** 只读查询当前存量构成归因（不建立/消费基线），用于面板。 */
  panel(): TenantPanelPayload | undefined {
    const snapshot = this.meter.snapshot()
    if (Object.keys(snapshot.sessions).length === 0) {
      return undefined
    }
    const { report } = this.view('current')
    return { enabled: true, window: 'current', report }
  }
}

export interface TenantToolOptions {
  /** 查询模式：current=存量归因；delta=与上次查询增量归因（默认 current）。 */
  mode?: 'current' | 'delta'
  /** 是否在工具返回中包含自然语言叙事行（默认 true）。 */
  narrative?: boolean
}

const DEFAULT_TOOL_OPTIONS: Required<TenantToolOptions> = { mode: 'current', narrative: true }

/** 因子行的 JsonValue 投影（保真、无 undefined 键；数值均为有限数）。 */
function factorToJson(factor: RcaFactor): Record<string, JsonValue> {
  return {
    kind: factor.kind,
    key: factor.key,
    cost: factor.cost,
    share: factor.share,
    delta: factor.delta,
    deltaShare: factor.deltaShare,
    grade: factor.grade,
  }
}

function viewToJson(view: RcaFactorView): Record<string, JsonValue> {
  return {
    factors: view.factors.map(factorToJson),
    primary: view.primary.map(factorToJson),
    secondary: view.secondary.map(factorToJson),
    noise: { count: view.noise.count, cost: view.noise.cost, deltaShare: view.noise.deltaShare },
    ...(view.dominant !== undefined ? { dominant: factorToJson(view.dominant) } : {}),
  }
}

function channelMixToJson(mix: { inputTokens: number; cacheReadTokens: number; outputTokens: number; totalTokens: number; inputShare: number; cacheReadShare: number; outputShare: number }): Record<string, JsonValue> {
  return {
    inputTokens: mix.inputTokens,
    cacheReadTokens: mix.cacheReadTokens,
    outputTokens: mix.outputTokens,
    totalTokens: mix.totalTokens,
    inputShare: mix.inputShare,
    cacheReadShare: mix.cacheReadShare,
    outputShare: mix.outputShare,
  }
}

/** 多租户报表 -> 无损 JSON（无 NaN/Infinity/-0/undefined 键，与 dsh-session JsonValue 契约一致）。 */
function tenantReportToJson(report: TenantCostReport): Record<string, JsonValue> {
  return {
    window: report.window,
    totalCost: report.totalCost,
    baselineTotalCost: report.baselineTotalCost,
    deltaCost: report.deltaCost,
    deltaRatio: report.deltaRatio,
    tenantCount: report.tenantCount,
    byTenant: viewToJson(report.byTenant),
    details: report.details.map((d) => ({
      tenantId: d.tenantId,
      cost: d.cost,
      share: d.share,
      delta: d.delta,
      deltaShare: d.deltaShare,
      grade: d.grade,
      sessionCount: d.sessionCount,
      topSessions: d.topSessions.map(factorToJson),
      channelMix: channelMixToJson(d.channelMix),
    })),
    channelMix: channelMixToJson(report.channelMix),
    summary: report.summary,
  }
}

/**
 * 注册只读工具 `cost_guard_tenant`：
 * 「哪个租户（团队/项目/工作区）在烧钱、为什么」——返回租户间归因
 * （主因/次因/噪声租户、Δ 与贡献占比、通道构成）、每个主因租户的内部
 * 会话主因证据链，以及中文叙事（总览/因子/建议）。
 */
export function attachTenantTool(
  ctx: Context,
  runtime: TenantRuntime,
  options: TenantToolOptions = {},
): void {
  const opts = { ...DEFAULT_TOOL_OPTIONS, ...options }
  ctx.tools.register(
    defineTool({
      name: 'cost_guard_tenant',
      description:
        '读取多租户成本解释视图（只读）：回答「哪个租户（团队/项目/工作区）花了多少 / 为什么」——' +
        '按租户维度给出主因、次因与噪声归因（含占比、较基线 Δ 与增量贡献），' +
        '每个主因租户再下钻到其内部主因会话（两级证据链：租户 -> 会话），' +
        '以及输入/缓存/输出通道构成与治理建议。' +
        '首次调用为存量构成归因；再次调用（mode=delta）返回与上次查询相比的增量根因。',
      parameters: {
        mode: {
          type: 'string',
          enum: ['current', 'delta'],
          description: 'current=当前存量归因；delta=与上次查询对比的增量归因（默认 current）。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute(args: { mode?: 'current' | 'delta' }): Promise<Record<string, JsonValue>> {
        const mode = args.mode ?? opts.mode
        const { report, items } = runtime.view(mode)
        const out: Record<string, JsonValue> = {
          window: report.window,
          summary: report.summary,
          report: tenantReportToJson(report),
        }
        if (opts.narrative) {
          out['narrative'] = items.map((item) => item.text)
        }
        return Promise.resolve(out)
      },
    }),
  )
}

/** 人读多租户视图面板行（供 formatStatusSummary 复用）。 */
export function formatTenantLines(payload: TenantPanelPayload): string[] {
  const r = payload.report
  const dominant = r.byTenant.dominant
  const detail = dominant !== undefined ? r.details.find((d) => d.tenantId === dominant.key) : undefined
  const insideSession = detail?.topSessions[0]?.key
  return [
    `多租户视图: ${r.tenantCount} 个租户 · 当前累计 ${r.totalCost.toFixed(2)}` +
      (dominant !== undefined ? ` · 主因租户 ${dominant.key} 占 ${Math.round(dominant.share * 100)}%` : '') +
      (insideSession !== undefined ? ` · 其主因会话 ${insideSession}` : ''),
  ]
}