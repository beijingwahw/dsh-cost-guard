/**
 * 预测式成本治理 —— 轨道预测 / 触顶预警 / 剩余时长 的确定性单测。
 */
import { describe, expect, it } from 'vitest'
import {
  buildForecast,
  exhaustAt,
  formatRemaining,
  linearRegression,
  type ForecastPoint,
} from '../src/core/forecast.js'

const HOUR = 3_600_000
const DAY = 86_400_000

describe('linearRegression（OLS）', () => {
  it('完美线性点：斜率与截距精确复原', () => {
    const pts: ForecastPoint[] = [
      { t: 0, y: 10 },
      { t: HOUR, y: 30 },
      { t: 2 * HOUR, y: 50 },
    ]
    const fit = linearRegression(pts)!
    expect(fit.slope).toBeCloseTo(20 / HOUR, 10)
    expect(fit.intercept).toBeCloseTo(10, 10)
    expect(fit.r2).toBeCloseTo(1, 10)
    expect(fit.se).toBe(0)
    expect(fit.n).toBe(3)
  })

  it('样本不足 2 个时返回 undefined', () => {
    expect(linearRegression([{ t: 0, y: 1 }])).toBeUndefined()
  })

  it('完全重叠时刻（sxx=0）返回 undefined', () => {
    expect(
      linearRegression([
        { t: 5, y: 1 },
        { t: 5, y: 2 },
      ]),
    ).toBeUndefined()
  })
})

describe('buildForecast（趋势模型）', () => {
  it('两点以上：外推目标时刻的期望成本并给出非负置信带', () => {
    const now = 1_700_000_000_000
    const fc = buildForecast({
      points: [
        { t: now - 2 * HOUR, y: 2 },
        { t: now - HOUR, y: 4 },
        { t: now, y: 6 },
      ],
      targetAt: now + 2 * HOUR,
      now,
    })!
    // 速率 2 元/小时 -> 2 小时后预计 6 + 4 = 10
    expect(fc.model).toBe('trend')
    expect(fc.expected).toBeCloseTo(10, 6)
    expect(fc.lower).toBeGreaterThanOrEqual(0)
    expect(fc.upper).toBeGreaterThanOrEqual(fc.expected)
    expect(fc.confidence).toBeGreaterThan(0.5)
    expect(fc.ratePerMs).toBeCloseTo(2 / HOUR, 10)
  })

  it('目标时刻已过 -> undefined', () => {
    const now = 1_700_000_000_000
    expect(
      buildForecast({
        points: [{ t: now - HOUR, y: 1 }],
        targetAt: now - 1,
        now,
      }),
    ).toBeUndefined()
  })

  it('无观测点 -> undefined', () => {
    expect(buildForecast({ points: [], targetAt: 0, now: 0 })).toBeUndefined()
  })
})

describe('buildForecast（固定速率模型）', () => {
  it('单观测点：spent/elapsed × period 外推，置信带随观测跨度缩短而变宽', () => {
    const now = 1_700_000_000_000
    const fc = buildForecast({
      points: [{ t: now - 30 * 60_000, y: 3 }],
      targetAt: now + 30 * 60_000,
      now,
    })!
    // 30 分钟花 3 元 -> 速率 6 元/小时；目标时刻距观测点 60 分钟 -> 3 + 6 = 9
    expect(fc.model).toBe('rate')
    expect(fc.expected).toBeCloseTo(9, 6)
    expect(fc.upper).toBeGreaterThanOrEqual(fc.expected)
    expect(fc.lower).toBeGreaterThanOrEqual(0)
    expect(fc.confidence).toBeGreaterThan(0)
  })

  it('10 分钟观测点：置信带比 5 小时观测点更宽（不确定性更大）', () => {
    const now = 1_700_000_000_000
    const short = buildForecast({
      points: [{ t: now - 10 * 60_000, y: 1 }],
      targetAt: now + DAY,
      now,
    })!
    const long = buildForecast({
      points: [
        { t: now - 5 * HOUR, y: 1 },
        { t: now, y: 2 },
      ],
      targetAt: now + DAY,
      now,
    })!
    expect(short.upper - short.expected).toBeGreaterThan(long.upper - long.expected)
  })
})

describe('exhaustAt（Time-to-Exhaustion）', () => {
  it('按速率计算耗尽时刻', () => {
    const now = 1_700_000_000_000
    const ex = exhaustAt(5, 20, 5 / HOUR, now)!
    // 还需 15 元，速率 5 元/小时 -> 3 小时
    expect(ex.remainingMs).toBeCloseTo(3 * HOUR, 6)
    expect(ex.at).toBe(now + 3 * HOUR)
  })

  it('已超限 / 无限制 / 速率非正 -> null', () => {
    const now = 1_700_000_000_000
    expect(exhaustAt(20, 10, 1, now)).toBeNull()
    expect(exhaustAt(1, 0, 1, now)).toBeNull()
    expect(exhaustAt(1, 10, 0, now)).toBeNull()
  })
})

describe('formatRemaining（人读剩余时长）', () => {
  it('分钟 / 小时 / 天 各档位输出正确', () => {
    expect(formatRemaining(45 * 60_000)).toBe('45 分钟')
    expect(formatRemaining((3 * HOUR + 12 * 60_000))).toBe('3 小时 12 分钟')
    expect(formatRemaining(2 * DAY + 5 * HOUR + 8 * 60_000)).toBe('2 天 5 小时 8 分钟')
  })

  it('非正输入输出 0 分钟', () => {
    expect(formatRemaining(-1)).toBe('0 分钟')
  })
})