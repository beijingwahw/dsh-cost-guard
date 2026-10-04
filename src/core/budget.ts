/**
 * @module dsh-cost-guard/core/budget
 * 预算决策引擎：根据各 scope 已花费与策略限额定出水位与动作。
 * 纯函数：输入快照 + 策略，输出决策，无副作用，便于单测。
 *
 * 0.4.0 新增「预测式治理」：在既有水位判定（事后）之上，把预测事实
 * （到期投影 / 成本尖峰 / 请求级预检）纳入决策。预测式治理完全可配置：
 * 未传入 predictive 策略时，本模块行为与 0.3.0 完全一致（零回归）。
 */

import type { BudgetDecision, BudgetPolicy, BudgetScope } from './types.js'
import type { RequestEstimate, SpikeLevel } from './anomaly.js'
import type { GovernorOutput } from './governor.js'

export interface BudgetInput {
  /** scope -> 已花费金额。 */
  spent: Partial<Record<BudgetScope, number>>
  /** 预测式治理输入（0.4.0，可选）。不提供则忽略预测式策略。 */
  forecast?: {
    /** 到期预测成本：scope -> 预测到目标时刻（如日终/月末）的期望花费。 */
    projected?: Partial<Record<BudgetScope, number>>
    /** 当前请求的 MAD 成本尖峰级别。 */
    spike?: { level: SpikeLevel }
    /** 待发请求的成本预检估算。 */
    estimate?: RequestEstimate
  }
  /** 自适应调节输入（0.5.0，可选）：由 governor 计算的动态额度与水位。 */
  adaptive?: {
    /** governor 输出（宿主在决策时实时计算）。 */
    governor: GovernorOutput
  }
}

/** 到期投影治理：预测成本 / limit 达到阈值即提前触发。 */
export interface ProjectionPolicy {
  /** 预测目标时刻说明（仅展示，如 '月末'）。 */
  target?: string
  /** 预测成本 / limit 达到该比例触发 warn（默认 0.8）。 */
  warnAt?: number
  /** 预测成本 / limit 达到该比例触发 block（默认 1.0）。 */
  hardAt?: number
}

/** 成本尖峰治理：MAD 检测出的尖峰请求立即触发保护动作。 */
export interface SpikePolicy {
  /** 触发等级下限：'spike'（含 extreme）或 'extreme'。 */
  level: 'spike' | 'extreme'
  /** 触发后的动作。 */
  action: 'warn' | 'block'
}

/** 请求级预检：在请求发出前按估算成本判定是否放行。 */
export interface PreflightPolicy {
  /** 判定口径：min = 必然发生的输入成本；expected = 期望总成本。 */
  mode: 'min' | 'expected'
  /** 触发动作。 */
  action: 'warn' | 'block'
  /** 作用预算 scope（默认 'total'）。该 scope 未配置 limit 则不预检。 */
  scope?: BudgetScope
}

/**
 * 自适应调节治理（0.5.0，默认关闭）：
 * 用 governor 输出的动态水位（随消费速率背压实时收紧/放松）替代指定 scope 的
 * 静态 warnAt/hardAt，并在决策结果中输出 cost-aware cue（calm/frugal/minimal）。
 * 未配置本策略时，决策行为与 0.4.0 完全一致（零回归）。
 */
export interface AdaptivePolicy {
  /** 应用动态水位的预算 scope（默认 'day'）。 */
  scope?: BudgetScope
  /** 今日动态额度耗尽（exhausted）时的动作（默认 'warn'）。 */
  onExhausted?: 'warn' | 'block'
}

/** 预测式治理策略（0.4.0，整体可选；默认关闭）。 */
export interface PredictivePolicy {
  /** 按 scope 的到期投影治理；默认关闭。 */
  projections?: Partial<Record<BudgetScope, ProjectionPolicy>>
  /** 成本尖峰治理；默认关闭。 */
  spike?: SpikePolicy
  /** 请求级预检；默认关闭。 */
  preflight?: PreflightPolicy
  /** 自适应调节治理（0.5.0）；默认关闭。 */
  adaptive?: AdaptivePolicy
}

/** 预测式触发明细（0.4.0；未启用或未触发时为空数组）。 */
export interface PredictiveTrigger {
  kind: 'projection' | 'spike' | 'preflight' | 'adaptive'
  scope?: BudgetScope
  level: 'warn' | 'hard'
  /** 人读原因，用于日志与工具展示。 */
  detail: string
}

/** 成本感知提示级别（0.5.0）：由 governor 的背压状态推导。 */
export type AdaptiveCue = 'calm' | 'frugal' | 'minimal'

export interface BudgetEvaluator {
  /** 按当前花费快照（+ 可选预测事实）计算决策。 */
  decide(spent: BudgetInput): BudgetDecision
  /** 查询单个 scope 的触发状态（供实时询问）。 */
  check(spent: BudgetInput, scope: BudgetScope): { spent: number; limit: number; ratio: number; level: 'warn' | 'hard' | 'ok' } | undefined
}

/** 按策略构造决策器。predictive 缺省时 = 0.3.0 语义。 */
export function createBudgetEvaluator(policies: BudgetPolicy[], predictive?: PredictivePolicy): BudgetEvaluator {
  const sorted = [...policies].sort((a, b) => {
    const order: Record<BudgetScope, number> = { session: 0, day: 1, month: 2, total: 3 }
    return (order[a.scope] ?? 9) - (order[b.scope] ?? 9)
  })

  /** 尖峰等级排序：normal < spike < extreme。 */
  const spikeRank: Record<SpikeLevel, number> = { normal: 0, spike: 1, extreme: 2 }

  const decide = (spent: BudgetInput): BudgetDecision => {
    const triggers: BudgetDecision['triggers'] = []
    const predictiveTriggers: PredictiveTrigger[] = []
    let action: BudgetDecision['action'] = 'allow'

    // —— 0. 自适应调节（0.5.0）：启用时用 governor 动态水位替代静态水位 ——
    const adaptiveCfg = predictive?.adaptive
    const adaptiveScope = adaptiveCfg?.scope ?? 'day'
    const governor = adaptiveCfg ? spent.adaptive?.governor : undefined
    const adaptiveActive = adaptiveCfg !== undefined && governor !== undefined

    // —— 1. 既有水位判定（0.3.0 语义；adaptive 启用时指定 scope 用动态水位）——
    for (const p of sorted) {
      const used = spent.spent[p.scope] ?? 0
      if (p.limit <= 0) continue
      const ratio = used / p.limit
      const warnAt = adaptiveActive && p.scope === adaptiveScope ? governor!.warnAt : p.warnAt
      const hardAt = adaptiveActive && p.scope === adaptiveScope ? governor!.hardAt : p.hardAt
      if (ratio >= hardAt) {
        triggers.push({ scope: p.scope, spent: used, limit: p.limit, ratio, level: 'hard' })
        action = 'block'
      } else if (ratio >= warnAt && action !== 'block') {
        triggers.push({ scope: p.scope, spent: used, limit: p.limit, ratio, level: 'warn' })
        if (action === 'allow') action = 'warn'
      }
    }

    // —— 1.5 自适应调节补充（0.5.0）——
    if (adaptiveActive) {
      // 今日动态额度耗尽：立即按策略告警/熔断，不等到水位
      if (governor!.exhausted) {
        const exhaustedAction: 'warn' | 'block' = adaptiveCfg!.onExhausted ?? 'warn'
        predictiveTriggers.push({
          kind: 'adaptive',
          scope: adaptiveScope,
          level: exhaustedAction === 'block' ? 'hard' : 'warn',
          detail: `今日自适应额度已耗尽（已花 ≥ ${governor!.dayAllowance.toFixed(2)}）${exhaustedAction === 'block' ? '，已熔断本周期' : '，请降低调用频率'}`,
        })
        if (exhaustedAction === 'block') action = 'block'
        else if (action === 'allow') action = 'warn'
      }
    }

    // —— 2. 到期投影治理（预测成本提前触发）——
    if (predictive?.projections && spent.forecast?.projected) {
      for (const [scope, proj] of Object.entries(predictive.projections)) {
        if (!proj) continue
        const s = scope as BudgetScope
        const policy = sorted.find((x) => x.scope === s)
        if (!policy || policy.limit <= 0) continue
        const projected = spent.forecast.projected[s]
        if (projected === undefined || projected <= 0) continue
        const ratio = projected / policy.limit
        const hardAt = proj.hardAt ?? 1
        const warnAt = proj.warnAt ?? 0.8
        const target = proj.target ? `（${proj.target}）` : ''
        if (ratio >= hardAt) {
          predictiveTriggers.push({
            kind: 'projection',
            scope: s,
            level: 'hard',
            detail: `${s} 预测成本${target}达 ${(ratio * 100).toFixed(0)}% (${projected.toFixed(2)}/${policy.limit.toFixed(2)})，预测超限提前熔断`,
          })
          action = 'block'
        } else if (ratio >= warnAt) {
          predictiveTriggers.push({
            kind: 'projection',
            scope: s,
            level: 'warn',
            detail: `${s} 预测成本${target}达 ${(ratio * 100).toFixed(0)}% (${projected.toFixed(2)}/${policy.limit.toFixed(2)})，预测接近上限请留意`,
          })
          if (action === 'allow') action = 'warn'
        }
      }
    }

    // —— 3. 成本尖峰治理（MAD 异常请求立即保护）——
    const spikeCfg = predictive?.spike
    const spikeIn = spent.forecast?.spike
    if (spikeCfg && spikeIn && spikeRank[spikeIn.level] >= spikeRank[spikeCfg.level]) {
      predictiveTriggers.push({
        kind: 'spike',
        level: spikeCfg.action === 'block' ? 'hard' : 'warn',
        detail: `检测到成本尖峰（${spikeIn.level}），按策略${spikeCfg.action === 'block' ? '熔断' : '告警'}`,
      })
      if (spikeCfg.action === 'block') action = 'block'
      else if (action === 'allow') action = 'warn'
    }

    // —— 4. 请求级预检（花出去之前判断）——
    const preCfg = predictive?.preflight
    const estimate = spent.forecast?.estimate
    if (preCfg && estimate) {
      const scope = preCfg.scope ?? 'total'
      const policy = sorted.find((x) => x.scope === scope)
      const limit = policy?.limit ?? 0
      if (limit > 0) {
        const used = spent.spent[scope] ?? 0
        const cost = preCfg.mode === 'min' ? estimate.minCost : estimate.expectedCost
        if (cost > 0 && used + cost >= limit) {
          predictiveTriggers.push({
            kind: 'preflight',
            scope,
            level: preCfg.action === 'block' ? 'hard' : 'warn',
            detail: `请求预检（${preCfg.mode}）预计花费 ${cost.toFixed(4)}，将使 ${scope} 预算 ${used.toFixed(2)}/${limit.toFixed(2)} 越线，${preCfg.action === 'block' ? '已拦截' : '请留意'}`,
          })
          if (preCfg.action === 'block') action = 'block'
          else if (action === 'allow') action = 'warn'
        }
      }
    }

    const decision: BudgetDecision = { action, triggers }
    if (predictiveTriggers.length > 0) decision.predictive = predictiveTriggers
    // 自适应调节状态与成本感知 cue（0.5.0；仅启用时存在）
    if (adaptiveActive) {
      // cue：今日额度耗尽 -> minimal（最小化）；高压力 -> frugal（节约）；否则 calm（从容）
      const cue: AdaptiveCue = governor!.exhausted ? 'minimal' : governor!.pressure >= 0.85 ? 'calm' : 'frugal'
      decision.adaptive = {
        scope: adaptiveScope,
        governor: governor!,
        cue,
      }
    }
    return decision
  }

  const check = (spent: BudgetInput, scope: BudgetScope) => {
    const p = sorted.find((x) => x.scope === scope)
    if (!p || p.limit <= 0) return undefined
    const used = spent.spent[scope] ?? 0
    const ratio = used / p.limit
    let level: 'warn' | 'hard' | 'ok' = 'ok'
    if (ratio >= p.hardAt) level = 'hard'
    else if (ratio >= p.warnAt) level = 'warn'
    return { spent: used, limit: p.limit, ratio, level }
  }

  return { decide, check }
}

/** 从配置构造策略集（未配置的 scope 不产生策略）。 */
export function policiesFromConfig(cfg: Record<string, { limit?: number; warnAt?: number; hardAt?: number }>): BudgetPolicy[] {
  const out: BudgetPolicy[] = []
  const scopes: BudgetScope[] = ['session', 'day', 'month', 'total']
  for (const s of scopes) {
    const c = cfg[s]
    if (!c || !c.limit || c.limit <= 0) continue
    out.push({
      scope: s,
      limit: c.limit,
      warnAt: c.warnAt ?? 0.8,
      hardAt: c.hardAt ?? 1,
    })
  }
  return out
}

/** 预测式治理配置（与插件 Config.predictive 对齐，可选）。 */
export interface PredictiveConfig {
  /** 到期投影：scope -> 阈值与展示名。 */
  projections?: Partial<
    Record<BudgetScope, { target?: string; warnAt?: number; hardAt?: number }>
  >
  /** 尖峰防护。 */
  spike?: { level?: 'spike' | 'extreme'; action?: 'warn' | 'block' }
  /** 请求级预检。 */
  preflight?: { mode?: 'min' | 'expected'; action?: 'warn' | 'block'; scope?: BudgetScope }
  /** 自适应调节治理（0.5.0，默认关闭）。 */
  adaptive?: { scope?: BudgetScope; onExhausted?: 'warn' | 'block' }
}

/** 从配置构造预测式治理策略；未配置任何项返回 undefined（不改变既有语义）。 */
export function predictivePolicyFromConfig(cfg?: PredictiveConfig): PredictivePolicy | undefined {
  if (!cfg) return undefined
  const out: PredictivePolicy = {}
  if (cfg.projections) {
    const projections: NonNullable<PredictivePolicy['projections']> = {}
    for (const [scope, p] of Object.entries(cfg.projections)) {
      if (!p) continue
      projections[scope as BudgetScope] = {
        target: p.target,
        warnAt: p.warnAt ?? 0.8,
        hardAt: p.hardAt ?? 1,
      }
    }
    if (Object.keys(projections).length > 0) out.projections = projections
  }
  if (cfg.spike) {
    out.spike = {
      level: cfg.spike.level ?? 'spike',
      action: cfg.spike.action ?? 'warn',
    }
  }
  if (cfg.preflight) {
    out.preflight = {
      mode: cfg.preflight.mode ?? 'expected',
      action: cfg.preflight.action ?? 'block',
      scope: cfg.preflight.scope ?? 'total',
    }
  }
  if (cfg.adaptive) {
    out.adaptive = {
      scope: cfg.adaptive.scope ?? 'day',
      onExhausted: cfg.adaptive.onExhausted ?? 'warn',
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}