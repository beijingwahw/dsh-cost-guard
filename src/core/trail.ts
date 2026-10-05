/**
 * @module dsh-cost-guard/core/trail
 * 成本轨迹采样（零 DSH 依赖）：按 scope 维护「时刻 -> 累计成本」观测点序列，
 * 供预测引擎（buildForecast / exhaustAt）消费。
 *
 * 设计要点：
 * - 观测点按时间升序追加；同一时刻重复写入按最新值覆盖（幂等，规避事件重放）。
 * - 每个 scope 独立容量上限（默认 1000 点），超限丢最旧，内存有界。
 * - 读取返回副本，调用方不可污染内部状态。
 */

import type { BudgetScope } from './types.js'

/** 一个观测点：某时刻（epoch ms）的累计成本。 */
export interface TrailSample {
  time: number
  cost: number
}

export class CostTrail {
  private readonly series: Map<BudgetScope, TrailSample[]> = new Map()
  private readonly capacity: number

  constructor(capacity = 1000) {
    this.capacity = Math.max(1, capacity)
  }

  /** 写入一个观测点；同 scope 同时刻覆盖旧值。返回写入后该 scope 的点数。 */
  push(scope: BudgetScope, time: number, cost: number): number {
    let arr = this.series.get(scope)
    if (!arr) {
      arr = []
      this.series.set(scope, arr)
    }
    // 有序插入：事件可能乱序 / 回放，保证时间升序（预测引擎依赖排序）
    // 从尾部向前找第一个 time <= 新点的位置；防御性取值避免索引未定义。
    let i = arr.length - 1
    while (i >= 0) {
      const cur = arr[i]
      if (cur === undefined || cur.time <= time) break
      i--
    }
    if (i >= 0) {
      const cur = arr[i]
      if (cur !== undefined && cur.time === time) {
        cur.cost = cost // 同一时刻幂等覆盖
        return arr.length
      }
    }
    arr.splice(i + 1, 0, { time, cost })
    while (arr.length > this.capacity) arr.shift()
    return arr.length
  }

  /** 该 scope 的观测点（时间升序，深拷贝）。 */
  points(scope: BudgetScope): TrailSample[] {
    return (this.series.get(scope) ?? []).map((s) => ({ ...s }))
  }

  /** 最近一个观测点。 */
  last(scope: BudgetScope): TrailSample | undefined {
    const arr = this.series.get(scope)
    return arr?.[arr.length - 1]
  }

  /** 最近累计成本（无观测返回 0）。 */
  latestCost(scope: BudgetScope): number {
    return this.last(scope)?.cost ?? 0
  }

  /** 已跟踪的 scope 列表。 */
  scopes(): BudgetScope[] {
    return [...this.series.keys()]
  }

  /** 清空（全部或指定 scope）。 */
  clear(scope?: BudgetScope): void {
    if (scope) {
      this.series.delete(scope)
      return
    }
    this.series.clear()
  }
}