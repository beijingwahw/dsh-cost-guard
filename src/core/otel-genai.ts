/**
 * @module dsh-cost-guard/core/otel-genai
 * OpenTelemetry GenAI 语义遥测（0.12.0，零 DSH 依赖）。
 *
 * 前沿背景：OpenTelemetry（CNCF 毕业项目）GenAI Semantic Conventions 为
 * LLM 调用定义了标准 span 语义——一次推理请求是一个 span，携带
 * gen_ai.operation.name / gen_ai.request.model / gen_ai.response.model /
 * gen_ai.system / gen_ai.usage.input_tokens / gen_ai.usage.output_tokens 等
 * 标准属性。本模块把插件入账事件映射为该规范的兼容记录，让成本与用量
 * 以行业标准可观测性格式流出：traceId 关联整段会话（成本 trace），
 * spanId 区分单次调用，成本/积分/时段作为扩展属性旁挂——
 * 可被 OTel Collector / GenAI 可观测平台（如 Elastic、Langfuse 等）直接消费。
 *
 * 设计约束：
 * - 纯数据结构 + 纯函数映射，不引入 OTel SDK（零外部依赖）。
 * - traceId 由 sessionId 稳定派生（同一会话所有 span 同 trace），
 *   spanId 由时间 + 路由派生，保证确定性可测。
 * - 属性命名遵循 SemConv：标准 gen_ai.* 前缀 + 插件扩展 dsh.* 前缀。
 */

/** GenAI span 属性（OTel GenAI SemConv 标准 + dsh 扩展）。 */
export interface GenAiSpanAttributes {
  /** 操作名：'chat'（单次 LLM 对话推理）。 */
  'gen_ai.operation.name': string
  /** 模型系统（厂商）：如 'deepseek' / 'openai'。 */
  'gen_ai.system': string
  /** 请求模型。 */
  'gen_ai.request.model': string
  /** 响应模型（缺失时与请求一致）。 */
  'gen_ai.response.model'?: string
  /** 输入 token（未命中）。 */
  'gen_ai.usage.input_tokens'?: number
  /** 输出 token。 */
  'gen_ai.usage.output_tokens'?: number
  /** 缓存命中输入 token。 */
  'gen_ai.usage.cache_read_input_tokens'?: number
  // —— 插件扩展（dsh.*）——
  /** 本次调用成本（金额，币种随路由）。 */
  'dsh.cost.amount'?: number
  /** 币种。 */
  'dsh.cost.currency'?: string
  /** 推理（思维链）token。 */
  'dsh.cost.reasoning_tokens'?: number
  /** 入账峰谷时段。 */
  'dsh.cost.band'?: string
  /** 积分消耗。 */
  'dsh.cost.credits'?: number
  /** 会话标识（供关联会话级成本归属）。 */
  'dsh.session.id'?: string
}

/** 单条 GenAI span 记录（OTel 语义映射后的可观测结构）。 */
export interface GenAiSpan {
  /** 关联 trace 标识（32 位 hex，由 sessionId 稳定派生）。 */
  traceId: string
  /** 单次调用 span 标识（16 位 hex）。 */
  spanId: string
  /** span 名称（'chat'）。 */
  name: string
  /** span 类型（OTel INTERNAL）。 */
  kind: 'INTERNAL'
  /** 开始时间（Unix 纳秒）。 */
  startTimeUnixNano: number
  /** 结束时间（Unix 纳秒，事件级粒度与开始一致）。 */
  endTimeUnixNano: number
  /** 标准 + 扩展属性。 */
  attributes: GenAiSpanAttributes
}

/** FNV-1a 32 位散列（字符串 -> 非负整数），用于稳定派生标识。 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash
}

/** 由任意字符串派生稳定的 32 位 hex trace 段。 */
export function stableHex(input: string, length: number): string {
  let out = ''
  let seed = input
  while (out.length < length) {
    out += fnv1a32(seed).toString(16).padStart(8, '0')
    seed = `${seed}#${out.length}`
  }
  return out.slice(0, length)
}

/** toGenAiSpan 选项。 */
export interface GenAiSpanOptions {
  /** 币种解析器；缺省 'CNY'。 */
  currencyOf?: (routeKey: string) => string
}

/** 把一次入账事件映射为 OTel GenAI 语义 span。 */
export function toGenAiSpan(
  routeKey: string,
  entry: {
    time: number
    cost: number
    credits: number
    band: string
    totalTokens: number
  },
  tokens: { inputTokens: number; cacheReadTokens: number; outputTokens: number; reasoningTokens: number },
  sessionId?: string,
  opts: GenAiSpanOptions = {},
): GenAiSpan {
  const [provider, model] = routeKey.split('/')
  const currency = (opts.currencyOf?.(routeKey) ?? 'CNY').toUpperCase()
  const nano = entry.time * 1_000_000
  return {
    traceId: stableHex(sessionId ?? `anon:${routeKey}`, 32),
    spanId: stableHex(`${routeKey}:${entry.time}`, 16),
    name: 'chat',
    kind: 'INTERNAL',
    startTimeUnixNano: nano,
    endTimeUnixNano: nano,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': provider ?? 'unknown',
      'gen_ai.request.model': model ?? routeKey,
      'gen_ai.response.model': model ?? routeKey,
      'gen_ai.usage.input_tokens': tokens.inputTokens,
      'gen_ai.usage.output_tokens': tokens.outputTokens,
      'gen_ai.usage.cache_read_input_tokens': tokens.cacheReadTokens,
      'dsh.cost.amount': entry.cost,
      'dsh.cost.currency': currency,
      'dsh.cost.reasoning_tokens': tokens.reasoningTokens,
      'dsh.cost.band': entry.band,
      'dsh.cost.credits': entry.credits,
      ...(sessionId !== undefined ? { 'dsh.session.id': sessionId } : {}),
    },
  }
}

/** OTel 遥测缓冲：有限容量 + sink 即时流出。 */
export class OtelLedger {
  private readonly spans: GenAiSpan[] = []
  private readonly capacity: number
  private readonly sink: ((span: GenAiSpan) => void) | undefined

  constructor(opts: { capacity?: number; sink?: (span: GenAiSpan) => void } = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 4096)
    this.sink = opts.sink
  }

  /** 追加一条 span；满则丢最旧；sink 存在时同步流出。 */
  append(span: GenAiSpan): void {
    this.spans.push(span)
    while (this.spans.length > this.capacity) this.spans.shift()
    this.sink?.(span)
  }

  /** span 数量。 */
  get count(): number {
    return this.spans.length
  }

  /** 缓冲副本。 */
  spansOf(): GenAiSpan[] {
    return this.spans.map((s) => ({ ...s, attributes: { ...s.attributes } }))
  }

  /** JSONL 序列化。 */
  toJsonl(): string {
    return this.spans.map((s) => JSON.stringify(s)).join('\n')
  }

  /** 清空缓冲。 */
  clear(): void {
    this.spans.length = 0
  }
}