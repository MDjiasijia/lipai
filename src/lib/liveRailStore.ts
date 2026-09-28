/**
 * 全局展台内容 store（LiveRail 的数据源）。
 *
 * LiveRail 挂在 App 外壳（header 下方、全页面共享、可隐藏），
 * 「现在展台上放什么」由各页面写入：
 *  - Home：用户点选某条分享的帧组（切组 = 切展台）
 *  - Control：当前编辑槽位的实时渲染帧（切槽位 = 切展台）
 *  - Upload：解析文件的预览帧
 *  - 都不写 = 展台收起（占位「选择内容上展台」）
 *
 * 与 deviceStore 同款模式：模块级单例 + useSyncExternalStore 订阅。
 */
import { useSyncExternalStore } from 'react'

export interface LiveRailState {
  /** 135×240 JPEG base64 帧（无 data: 前缀） */
  frames: string[]
  /** 一行说明（来源 · 谁的分享 / 槽位名） */
  label: string
  /** 哪个「选择主体」写的（分享 id / 'control' / 'upload'）——
   *  多主体竞争（首页多行都写）时，只有当前主体能继续更新；
   *  其他主体的挂载 effect / 懒加载补全不再覆盖别人的选择 */
  owner?: string
}

const EMPTY: LiveRailState = { frames: [], label: '' }

let state: LiveRailState = EMPTY
const listeners = new Set<() => void>()

/**
 * 写入展台内容。
 *
 * owner 语义：显式用户选择（点 chips/封面/切槽位）带 owner 抢占；
 * 背景写入（挂载 effect / 懒加载详情补全）也带 owner 但只有「当前主体」能写 ——
 * 首页多条分享同时挂载/补帧时，最后写入的主体不再无条件覆盖别人的选择。
 */
export function setLiveRail(next: LiveRailState, opts: { force?: boolean } = {}): void {
  // 同主体可更新；不同主体（非 force）让位 —— 显式用户操作传 force: true
  if (
    state.owner !== undefined &&
    next.owner !== undefined &&
    state.owner !== next.owner &&
    !opts.force
  ) {
    return
  }
  if (
    state.label === next.label &&
    state.frames.length === next.frames.length &&
    state.frames.every((f, i) => f === next.frames[i])
  ) {
    return
  }
  state = next
  for (const l of listeners) l()
}

export function subscribeLiveRail(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 收走展台内容（置空 = LiveRail 自动收起）。
 * 带 owner：只清自己写的那份（别人的选择不被误伤）；无参：无条件清空。
 * 此前没有这个出口 —— 离开 Control 后「编辑中 · 槽位 N」会永久滞留全站顶栏。
 */
export function clearLiveRail(owner?: string): void {
  if (owner !== undefined && state.owner !== undefined && state.owner !== owner) return
  if (state === EMPTY) return
  state = EMPTY
  for (const l of listeners) l()
}

export function getLiveRail(): LiveRailState {
  return state
}

/** React hook：订阅全局展台内容 */
export function useLiveRail(): LiveRailState {
  return useSyncExternalStore(subscribeLiveRail, getLiveRail)
}
