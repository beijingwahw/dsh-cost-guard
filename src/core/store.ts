/**
 * @module dsh-cost-guard/core/store
 * 快照持久化：把 Meter 快照序列化 / 反序列化，支持跨重启恢复。
 * 存储抽象为最小接口，宿主可对接 DSH 的 storage 或文件系统。
 */

import type { CostSnapshot } from './types.js'

export interface SnapshotStore {
  load(): Promise<CostSnapshot | undefined>
  save(snapshot: CostSnapshot): Promise<void>
}

/** 内存存储（默认，仅在进程内存活；测试友好）。 */
export class MemorySnapshotStore implements SnapshotStore {
  private data: CostSnapshot | undefined
  async load(): Promise<CostSnapshot | undefined> {
    return this.data
  }
  async save(snapshot: CostSnapshot): Promise<void> {
    this.data = snapshot
  }
}

/** JSON 字符串编码 / 解码（供实现方落盘或存 storage 域）。 */
export function encodeSnapshot(snapshot: CostSnapshot): string {
  return JSON.stringify(snapshot)
}

export function decodeSnapshot(text: string): CostSnapshot | undefined {
  try {
    const obj = JSON.parse(text) as CostSnapshot
    if (!obj || obj.version !== 1) return undefined
    return obj
  } catch {
    return undefined
  }
}

/** 从 CostSnapshot 还原 Meter 需要的数据（映射为 meter.snapshot 形状）。 */
export function snapshotToMeterSeed(snapshot: CostSnapshot) {
  return {
    buckets: snapshot.buckets,
    routes: snapshot.routes,
    sessions: snapshot.sessions,
  }
}