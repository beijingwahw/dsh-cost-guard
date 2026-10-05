/**
 * @module dsh-cost-guard/harness/explain
 * 成本根因与可解释叙事（0.14.0，可选）DSH 适配层：
 * - 由 Meter 快照构建成本根因报表（rca.ts）与中文叙事（explain.ts）；
 * - 注册只读工具 `cost_guard_explain`：Agent 可请求「为什么这个月成本涨了」，
 *   拿到结构化根因 + 证据 + 建议（自我诊断成本的 Agent 能力，市面无同类工具）；
 * - 面板负载 `explain` 并入成本状态，未配置时整体 undefined（零回归）。
 *
 * 兼容边界：`explain` 配置未提供时本适配层不构造（undefined），
 * 事件流与状态输出与 0.13.0 完全一致（零回归）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Meter } from '../core/meter.js'
import { analyzeCostRca, type RcaFactor, type RcaFactorView, type RcaInput, type RootCauseReport } from '../core/rca.js'
import { buildExplanation, type ExplainContext, type ExplainItem } from '../core/explain.js'

/** 面板负载（并入 CostStatusPayload.explain；未启用时为 undefined 零回归）。 */
export interface ExplainPanelPayload {
  enabled: true
  /** 归因窗口：current=存量构成归因 / delta=与上次查询基线增量归因。 */
  window: 'current' | 'delta'
  /** 根因报表（JSON 安全，供面板与工具复用）。 */
  report: RootCauseReport
}

/** 解释运行时：持上次查询快照作基线，输出根因 + 叙事。 */
export class ExplainRuntime {
  private lastInput: RcaInput | undefined

  constructor(
    private readonly meter: Meter,
    private readonly explainCtx: ExplainContext = {},
  ) {}

  /**
   * 查询成本根因并生成叙事。
   * - mode='current'：对当前快照做存量构成归因（不消费/更新基线）；
   * - mode='delta'：与上次 delta/current 查询留下的基线对比（首次查询退化为
   *   存量归因并建立基线）。两次连续查询即得「与上次相比」的增量根因。
   */
  explain(mode: 'current' | 'delta' = 'current'): {
    report: RootCauseReport
    items: ExplainItem[]
  } {
    const snapshot = this.meter.snapshot()
    const input: RcaInput = { sessions: snapshot.sessions, routes: snapshot.routes }
    const useBaseline = mode === 'delta' && this.lastInput !== undefined
    const report = analyzeCostRca(
      input,
      useBaseline && this.lastInput !== undefined ? { baseline: this.lastInput } : undefined,
    )
    if (mode === 'delta') {
      this.lastInput = input
    }
    const items = buildExplanation(report, this.explainCtx)
    return { report, items }
  }

  /** 只读查询当前存量构成归因（不建立/消费基线），用于面板。 */
  panel(): ExplainPanelPayload | undefined {
    const snapshot = this.meter.snapshot()
    if (Object.keys(snapshot.sessions).length === 0 && Object.keys(snapshot.routes).length === 0) {
      return undefined
    }
    const { report } = this.explain('current')
    return { enabled: true, window: 'current', report }
  }
}

export interface ExplainToolOptions {
  /** 查询模式：current=存量归因；delta=与上次查询增量归因（默认 current）。 */
  mode?: 'current' | 'delta'
  /** 是否在工具返回中包含自然语言叙事行（默认 true）。 */
  narrative?: boolean
}

const DEFAULT_TOOL_OPTIONS: Required<ExplainToolOptions> = { mode: 'current', narrative: true }

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

/** 根因报表 -> 无损 JSON（无 NaN/Infinity/-0/undefined 键，与 dsh-session JsonValue 契约一致）。 */
function reportToJson(report: RootCauseReport): Record<string, JsonValue> {
  return {
    window: report.window,
    totalCost: report.totalCost,
    baselineTotalCost: report.baselineTotalCost,
    deltaCost: report.deltaCost,
    deltaRatio: report.deltaRatio,
    bySession: viewToJson(report.bySession),
    byRoute: viewToJson(report.byRoute),
    channelMix: {
      inputTokens: report.channelMix.inputTokens,
      cacheReadTokens: report.channelMix.cacheReadTokens,
      outputTokens: report.channelMix.outputTokens,
      totalTokens: report.channelMix.totalTokens,
      inputShare: report.channelMix.inputShare,
      cacheReadShare: report.channelMix.cacheReadShare,
      outputShare: report.channelMix.outputShare,
    },
    summary: report.summary,
  }
}

/**
 * 注册只读工具 `cost_guard_explain`：
 * 「为什么成本涨了/花了多少在哪」——返回根因报表（会话/路由双视角主因、
 * Δ 与贡献占比、通道构成）与中文叙事（总览/因子/建议）。
 */
export function attachExplainTool(
  ctx: Context,
  runtime: ExplainRuntime,
  options: ExplainToolOptions = {},
): void {
  const opts = { ...DEFAULT_TOOL_OPTIONS, ...options }
  ctx.tools.register(
    defineTool({
      name: 'cost_guard_explain',
      description:
        '读取当前成本根因与可解释叙事（只读）：回答「为什么花了这么多 / 花在哪」——' +
        '按会话（任务）与路由（模型）双视角给出主因、次因与噪声归因（含占比、' +
        '较基线 Δ 与增量贡献），以及输入/缓存/输出通道构成与可执行省钱建议。' +
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
        const { report, items } = runtime.explain(mode)
        const out: Record<string, JsonValue> = {
          window: report.window,
          summary: report.summary,
          report: reportToJson(report),
        }
        if (opts.narrative) {
          out['narrative'] = items.map((item) => item.text)
        }
        return Promise.resolve(out)
      },
    }),
  )
}

/** 人读解释面板行（供 formatStatusSummary 复用）。 */
export function formatExplainLines(payload: ExplainPanelPayload): string[] {
  return [
    `根因解释: 当前累计 ${payload.report.totalCost.toFixed(2)} · 会话主因 ${payload.report.bySession.dominant?.key ?? '无'} · 路由主因 ${payload.report.byRoute.dominant?.key ?? '无'} · 输出占比 ${Math.round(payload.report.channelMix.outputShare * 100)}%`,
  ]
}