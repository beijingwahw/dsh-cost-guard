/**
 * @module dsh-cost-guard/core/store
 * 快照持久化：把 Meter 快照序列化 / 反序列化，支持跨重启恢复。
 * 存储抽象为最小接口，宿主可对接 DSH 的 storage 或文件系统。
 */

import type { CostSnapshot, UsageBucket } from './types.js'

export interface SnapshotStore {
  load(): Promise<CostSnapshot | undefined>
  save(snapshot: CostSnapshot): Promise<void>
}

/** 内存存储（默认，仅在进程内存活；测试友好）。 */
export class MemorySnapshotStore implements SnapshotStore {
  private data: CostSnapshot | undefined
  load(): Promise<CostSnapshot | undefined> {
    return Promise.resolve(this.data)
  }
  save(snapshot: CostSnapshot): Promise<void> {
    this.data = snapshot
    return Promise.resolve()
  }
}

/** JSON 字符串编码 / 解码（供实现方落盘或存 storage 域）。 */
export function encodeSnapshot(snapshot: CostSnapshot): string {
  return JSON.stringify(snapshot)
}

/** 反序列化并对快照形状做宽容结构校验（防止非法结构污染后续聚合）。 */
export function decodeSnapshot(text: string): CostSnapshot | undefined {
  try {
    const obj: unknown = JSON.parse(text)
    return isCostSnapshot(obj) ? obj : undefined
  } catch {
    return undefined
  }
}

/** 宽容结构守卫：确认反序列化结果是合法快照形状。 */
function isCostSnapshot(obj: unknown): obj is CostSnapshot {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const s = obj as Record<string, unknown>
  if (s['version'] !== 1) return false
  if (typeof s['savedAt'] !== 'number' || !Number.isFinite(s['savedAt'])) return false
  // buckets 必填；routes/sessions/bands 兼容缺失（旧快照）
  if (!isBucketMap(s['buckets'])) return false
  if (s['routes'] !== undefined && !isBucketMap(s['routes'])) return false
  if (s['sessions'] !== undefined && !isBucketMap(s['sessions'])) return false
  if (s['bands'] !== undefined && !isBucketMap(s['bands'])) return false
  return true
}

/** 桶映射守卫：值为对象（非数组 / null）才可入账。 */
function isBucketMap(v: unknown): v is Record<string, UsageBucket> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  for (const value of Object.values(v)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  }
  return true
}

/** 从 CostSnapshot 还原 Meter 需要的数据（映射为 meter.snapshot 形状）。 */
export function snapshotToMeterSeed(snapshot: CostSnapshot) {
  return {
    buckets: snapshot.buckets,
    routes: snapshot.routes,
    sessions: snapshot.sessions,
    bands: snapshot.bands ?? {},
  }
}