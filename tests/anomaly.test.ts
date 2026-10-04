/**
 * 成本异常检测 —— MAD 尖峰 / 请求级预检估算 / 预检拦截 的确定性单测。
 */
import { describe, expect, it } from 'vitest'
import {
  MadDetector,
  estimateRequestCost,
  preflightCheck,
  MAD_SCALE,
} from '../src/core/anomaly.js'

describe('MadDetector（MAD 成本尖峰检测）', () => {
  it('样本不足 7 个时不可判定（score=0 / normal）', () => {
    const d = new MadDetector()
    for (let i = 0; i < 6; i++) d.push(1)
    expect(d.score(100)).toBe(0)
    expect(d.classify(100)).toBe('normal')
  })

  it('稳定基准下的离群请求被识别为 spike / extreme（分档正确）', () => {
    const d = new MadDetector()
    // 30 个正常样本：成本接近 10~12，含少量噪声；median=11, MAD=1
    for (let i = 0; i < 30; i++) d.push(10 + (i % 3))
    // z(16) = (16-11)/(1.4826*1) ≈ 3.37 -> spike
    expect(d.classify(16)).toBe('spike')
    // z(24) = 13/1.4826 ≈ 8.77 -> extreme
    expect(d.classify(24)).toBe('extreme')
    // 正常样本回到 normal
    expect(d.classify(11)).toBe('normal')
  })

  it('中位数稳健：少量大离群点不污染基准', () => {
    const d = new MadDetector()
    for (let i = 0; i < 20; i++) d.push(5)
    d.push(1000) // 污染样本
    const stats = d.stats()!
    expect(stats.median).toBe(5)
    expect(stats.mad).toBe(0)
    expect(stats.n).toBe(21)
  })

  it('窗口容量限制：超限丢最旧', () => {
    const d = new MadDetector(10)
    for (let i = 0; i < 15; i++) d.push(1)
    expect(d.size).toBe(10)
  })

  it('MAD_SCALE 归一化与公式自洽', () => {
    expect(MAD_SCALE).toBeCloseTo(1.4826, 4)
    const d = new MadDetector()
    // 变异窗口：median=10, MAD=1（四周±1 往返分布）
    for (let i = 0; i < 30; i++) d.push(9 + (i % 3))
    const stats = d.stats()!
    expect(stats.median).toBe(10)
    expect(stats.mad).toBe(1)
    // 与中位数相差恰好 1 个缩放 MAD 的样本，修正 z = 1
    expect(d.score(stats.median + MAD_SCALE * stats.mad)).toBeCloseTo(1, 6)
  })

  it('clear() 清空窗口', () => {
    const d = new MadDetector()
    for (let i = 0; i < 10; i++) d.push(1)
    d.clear()
    expect(d.size).toBe(0)
    expect(d.stats()).toBeUndefined()
  })
})

describe('estimateRequestCost（请求级预检估算）', () => {
  const price = { inputPerMillion: 2, outputPerMillion: 8 }

  it('输入 1M token：最低=输入价，期望=输入+输出预估', () => {
    const est = estimateRequestCost(1_000_000, price)
    expect(est.minCost).toBeCloseTo(2, 10) // 1M × 2 / 1M
    expect(est.expectedCost).toBeCloseTo(2 + 8 * 0.5, 10) // 输出 0.5M × 8 / 1M
    expect(est.predictedOutputTokens).toBe(500_000)
    expect(est.ceilingCost).toBeCloseTo(2 + 8 * 2, 10) // 上限输出 2M × 8 / 1M
  })

  it('自定义输出比例生效', () => {
    const est = estimateRequestCost(1_000_000, price, { outputRatio: 1, maxOutputRatio: 3 })
    expect(est.expectedCost).toBeCloseTo(2 + 8, 10)
    expect(est.ceilingCost).toBeCloseTo(2 + 8 * 3, 10)
  })

  it('负数输入 token 按 0 处理，不产生负成本', () => {
    const est = estimateRequestCost(-100, price)
    expect(est.minCost).toBe(0)
    expect(est.expectedCost).toBe(0)
  })
})

describe('preflightCheck（预检拦截）', () => {
  it('期望成本越线 -> 拦截并返回理由', () => {
    const est = estimateRequestCost(1_000_000, { inputPerMillion: 2, outputPerMillion: 8 })
    const reason = preflightCheck(est, 9, 10)
    expect(reason).not.toBeNull()
    expect(reason).toContain('预检拦截')
  })

  it('期望成本不越线 -> 放行', () => {
    const est = estimateRequestCost(100_000, { inputPerMillion: 2, outputPerMillion: 8 })
    expect(preflightCheck(est, 1, 10)).toBeNull()
  })

  it('min 模式：即便期望不越线，最低成本越线也拦截', () => {
    const est = estimateRequestCost(1_000_000, { inputPerMillion: 2, outputPerMillion: 8 }, { outputRatio: 0.1 })
    // min = 2 < 10-7 = 3 预期：expected=2.8 不越线(7+2.8=9.8? 9.8<10) 但 min 模式下 7+2=9<10 也不越
    // 重新构造：spent=8.5，min=2 -> 10.5 > 10 拦截
    expect(preflightCheck(est, 8.5, 10, 'min')).not.toBeNull()
  })

  it('无限制时始终放行', () => {
    const est = estimateRequestCost(1_000_000, { inputPerMillion: 2, outputPerMillion: 8 })
    expect(preflightCheck(est, 100, 0)).toBeNull()
  })
})