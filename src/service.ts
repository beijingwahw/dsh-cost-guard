/**
 * @module dsh-cost-guard/service
 * 对外服务契约：一条干净的能力 seam，供其他插件 / 面板消费。
 */

import type { Meter, WindowMeter } from './core/meter.js'
import type { BudgetEvaluator } from './core/budget.js'
import type { GuardHandle } from './harness/guard.js'
import type { CostStatusPayload } from './harness/tool.js'

export interface CostGuardService {
  readonly meter: Meter
  readonly windows: WindowMeter
  readonly evaluator: BudgetEvaluator
  readonly guard: GuardHandle
  /** 当前状态快照（JSON 安全）。 */
  status(): CostStatusPayload
  /** 人读摘要。 */
  summary(): string
}

/** 服务注册名称（供其他插件 inject 使用）。 */
export const costGuardService = 'costGuard' as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    [costGuardService]: CostGuardService
  }
}