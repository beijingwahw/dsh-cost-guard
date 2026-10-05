import { describe, it, expect } from 'vitest'
import {
  tenantResolverOf,
  aggregateTenantBuckets,
  analyzeTenantRca,
  buildTenantExplanation,
  type TenantResolveOptions,
} from '../src/core/tenant.js'
import type { UsageBucket } from '../src/core/types.js'

function bucket(cost: number, tokens = 0, requests = 1): UsageBucket {
  return { cost, credits: 0, requests, inputTokens: tokens, cacheReadTokens: 0, outputTokens: 0, totalTokens: tokens }
}

describe('tenantResolverOf 租户解析器', () => {
  it('mapping 精确映射优先', () => {
    const resolve = tenantResolverOf({ mapping: { 'team-a/s1': 'team-a' } })
    expect(resolve('team-a/s1')).toBe('team-a')
    expect(resolve('team-b/s2')).toBeUndefined()
  })

  it('prefix 前缀映射（最长前缀优先）', () => {
    const resolve = tenantResolverOf({ prefix: { 'team-a/': 'team-a', 'team-a/prod/': 'team-a-prod' } })
    expect(resolve('team-a/prod/x')).toBe('team-a-prod')
    expect(resolve('team-a/dev/x')).toBe('team-a')
    expect(resolve('team-b/x')).toBeUndefined()
  })

  it('regex 正则提取（取第一个捕获组，无组取整个匹配）', () => {
    const resolve = tenantResolverOf({ regex: { source: '^proj-(\\w+)/' } })
    expect(resolve('proj-cost/s1')).toBe('cost')
    expect(resolve('other/s1')).toBeUndefined()
  })

  it('优先级 mapping > prefix > regex；未命中 undefined', () => {
    const opts: TenantResolveOptions = {
      mapping: { 'm/s': 'mapped' },
      prefix: { 'p/': 'prefix' },
      regex: { source: '^r-(\\w+)' },
    }
    const resolve = tenantResolverOf(opts)
    expect(resolve('m/s')).toBe('mapped')
    expect(resolve('p/x')).toBe('prefix')
    expect(resolve('r-abc')).toBe('abc')
    expect(resolve('whatever')).toBeUndefined()
  })

  it('空配置：全部 undefined', () => {
    const resolve = tenantResolverOf()
    expect(resolve('anything')).toBeUndefined()
  })
})

describe('aggregateTenantBuckets 租户聚合', () => {
  it('按解析器归并会话桶；未命中归 defaultTenant', () => {
    const resolve = tenantResolverOf({ prefix: { 'team-a/': 'team-a' } })
    const tenants = aggregateTenantBuckets(
      {
        'team-a/s1': bucket(3, 100, 2),
        'team-a/s2': bucket(4, 200, 1),
        'other/s3': bucket(5, 300, 1),
      },
      resolve,
    )
    expect(tenants['team-a']?.cost).toBe(7)
    expect(tenants['team-a']?.requests).toBe(3)
    expect(tenants['team-a']?.totalTokens).toBe(300)
    expect(tenants['default']?.cost).toBe(5)
    expect(tenants['default']?.requests).toBe(1)
  })

  it('自定义 defaultTenant 兜底', () => {
    const tenants = aggregateTenantBuckets({ s1: bucket(1) }, () => undefined, 'workspace')
    expect(tenants['workspace']?.cost).toBe(1)
  })
})

describe('analyzeTenantRca 多租户成本解释', () => {
  it('空输入：安全空值，无主导租户', () => {
    const r = analyzeTenantRca({ sessions: {} })
    expect(r.window).toBe('current')
    expect(r.totalCost).toBe(0)
    expect(r.tenantCount).toBe(0)
    expect(r.byTenant.factors).toEqual([])
    expect(r.byTenant.dominant).toBeUndefined()
    expect(r.summary).toContain('当前累计成本 0.00')
  })

  it('无基线存量归因：租户间分级 + 租户内主因会话两级证据链', () => {
    const resolve = tenantResolverOf({ prefix: { 'a/': 'a', 'b/': 'b' } })
    const r = analyzeTenantRca(
      {
        sessions: {
          'a/s1': bucket(60),
          'a/s2': bucket(10),
          'b/s1': bucket(30),
        },
      },
      { resolve },
    )
    expect(r.window).toBe('current')
    expect(r.totalCost).toBe(100)
    expect(r.tenantCount).toBe(2)
    // 租户间：a 主因（70%）、b 次因（30%）
    const a = r.byTenant.factors.find((f) => f.key === 'a')
    expect(a?.share).toBeCloseTo(0.7, 6)
    expect(a?.grade).toBe('primary')
    expect(r.byTenant.dominant?.key).toBe('a')
    // 租户内：a 的主因会话为 a/s1（60/100 → 内部 60/70）
    const detailA = r.details.find((d) => d.tenantId === 'a')
    expect(detailA?.sessionCount).toBe(2)
    expect(detailA?.topSessions[0]?.key).toBe('a/s1')
    expect(detailA?.topSessions[0]?.share).toBeCloseTo(60 / 70, 6)
    const detailB = r.details.find((d) => d.tenantId === 'b')
    expect(detailB?.topSessions[0]?.key).toBe('b/s1')
    // 中文叙事：summary + factor + suggestion 均有
    const items = buildTenantExplanation(r)
    expect(items[0]?.kind).toBe('summary')
    expect(items.some((i) => i.kind === 'factor')).toBe(true)
    expect(items.some((i) => i.kind === 'suggestion')).toBe(true)
    expect(r.summary).toContain('主因租户「a」占 70%')
  })

  it('有基线增量归因：Δ 贡献分解定位租户增长主因', () => {
    const resolve = tenantResolverOf({ prefix: { 'a/': 'a', 'b/': 'b' } })
    const r = analyzeTenantRca(
      { sessions: { 'a/s1': bucket(8), 'b/s1': bucket(4) } },
      {
        resolve,
        baseline: { sessions: { 'a/s1': bucket(2), 'b/s1': bucket(5) } },
      },
    )
    expect(r.window).toBe('delta')
    expect(r.totalCost).toBe(12)
    expect(r.baselineTotalCost).toBe(7)
    expect(r.deltaCost).toBe(5)
    const a = r.byTenant.factors.find((f) => f.key === 'a')
    expect(a?.delta).toBe(6)
    const b = r.byTenant.factors.find((f) => f.key === 'b')
    expect(b?.delta).toBe(-1)
    // |Δ| 归一 7：a≈0.857 primary、b≈-0.143 secondary
    expect(a?.deltaShare).toBeCloseTo(6 / 7, 6)
    expect(a?.grade).toBe('primary')
    expect(b?.grade).toBe('secondary')
    expect(r.byTenant.dominant?.key).toBe('a')
    // 基线缺失会话（b/s1 从 5 → 4 属增量负贡献）与新增前不存在会话一致处理
  })

  it('无解析器：全部归 default，单租户视图仍可解释', () => {
    const r = analyzeTenantRca({ sessions: { s1: bucket(9), s2: bucket(1) } })
    expect(r.tenantCount).toBe(1)
    expect(r.byTenant.factors[0]?.key).toBe('default')
    expect(r.details[0]?.topSessions[0]?.key).toBe('s1')
    expect(r.summary).toContain('主因租户「default」占 100%')
  })
})