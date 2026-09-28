/**
 * 共享时钟：模块级单例 250ms tick + 订阅集。
 *
 * 此前 NixieTube 每行各自 setInterval（12 行 = 48 次/秒 setState 各自重渲染），
 * 现在全站共享一个 interval：有订阅者才启动，空了自动停（后台标签不空转）。
 * 帧号按秒派生（tubeIndexes 读表取帧），250ms 只影响换帧滞后 ≤ 250ms，不改变对齐语义。
 */
import { useEffect, useState } from 'react'

const TICK_MS = 250

const listeners = new Set<(now: Date) => void>()
let timer: ReturnType<typeof setInterval> | null = null

function start(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    const now = new Date()
    for (const fn of listeners) fn(now)
  }, TICK_MS)
}

function stop(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/** 订阅共享时钟（挂载期间 250ms 粒度更新 now；卸载自动退订，最后一个退订停表）。
 *  live=false：不订阅（编辑态预览用 —— 帧内容变化时才重渲染，
 *  返回挂载时刻的静态时间）。 */
export function useSharedClock(live = true): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!live) return
    const fn = (t: Date) => setNow(t)
    listeners.add(fn)
    start()
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0) stop()
    }
  }, [live])
  return now
}
