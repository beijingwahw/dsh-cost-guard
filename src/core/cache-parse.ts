/**
 * @module dsh-cost-guard/core/cache-parse
 * 缓存用量解析器（CacheUsageParser）：把原始用量快照拆分为三通道 Token，
 * 校验缓存命中字段的合法性，并对缺失 / 异常走回退分支（零 DSH 依赖）。
 *
 * 解析规则（方案文档 4.2 / 4.3）：
 *   - cachedTokens 为 >= 0 的有限整数且 cachedTokens <= promptTokens：正常解析，
 *     命中 = cachedTokens，未命中 = promptTokens - cachedTokens。
 *   - cachedTokens 缺失 / 为 undefined：无法确认，回退分支（reason: 'missing'）。
 *   - cachedTokens 为负数 / 非整数 / 大于 promptTokens：数据异常，回退分支
 *     （reason: 'malformed'）。
 *
 * 回退分支处理（与「默认关闭」区分开）：
 *   - 该请求全部输入按未命中价计费（与插件保守口径一致）。
 *   - 指标标注 uncertainty，命中率不纳入可信汇总。
 */

import type { ParseOutcome, RawUsageSnapshot, TokenSplit } from './cache-types.js'

/**
 * 解析原始用量快照为三通道拆分结果。
 * 任何异常都不抛错，统一走 ParseOutcome 判别。
 */
export function parseCachedUsage(raw: RawUsageSnapshot | null | undefined): ParseOutcome {
  if (!raw) return { ok: false, reason: 'missing', rawPrompt: 0 }
  const prompt = raw.promptTokens
  if (!Number.isFinite(prompt) || prompt < 0) {
    // 输入总量本身异常：视为无法确认（数据异常）
    return { ok: false, reason: 'malformed', rawPrompt: prompt }
  }
  const cached = raw.cachedTokens
  if (cached === undefined || cached === null) {
    // 缓存命中信息缺失：回退按未命中计费
    return { ok: false, reason: 'missing', rawPrompt: prompt }
  }
  if (!Number.isFinite(cached) || cached < 0 || !Number.isInteger(cached) || cached > prompt) {
    return { ok: false, reason: 'malformed', rawPrompt: prompt }
  }
  return { ok: true, cached, uncached: prompt - cached }
}

/**
 * 把解析结果转换为三通道 Token 拆分。
 * 回退分支统一生成 uncertainty 标注：缺失 -> 'cached-unknown'，异常 -> 'malformed'。
 */
export function outcomeToSplit(outcome: ParseOutcome, outputTokens: number): TokenSplit {
  if (outcome.ok) {
    return { inputHit: outcome.cached, inputMiss: outcome.uncached, output: outputTokens }
  }
  const uncertainty: 'cached-unknown' | 'malformed' =
    outcome.reason === 'missing' ? 'cached-unknown' : 'malformed'
  return {
    inputHit: 0,
    // 回退：全部输入按未命中处理
    inputMiss: Math.max(0, outcome.rawPrompt),
    output: outputTokens,
    uncertainty,
  }
}

/**
 * 便携解析：raw -> TokenSplit 一步到位（默认输出 token 0）。
 * 供 harness 与测试直接使用。
 */
export function splitCachedUsage(raw: RawUsageSnapshot | null | undefined, outputTokens = 0): TokenSplit {
  return outcomeToSplit(parseCachedUsage(raw), outputTokens)
}