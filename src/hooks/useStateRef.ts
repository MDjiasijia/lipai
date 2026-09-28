/**
 * useStateRef：ref 与 state 的合体 —— 值持续跟随最新，且变更不触发重渲染。
 *
 * 所有「回调里要读最新值」的场景的地基
 * （useLastCallback / useShowTransition / 调度器回调 都靠它）。
 */
import { useRef } from 'react'
import { useEffect } from 'react'

export default function useStateRef<T>(initialValue: T): { current: T } {
  const ref = useRef<T>(initialValue)

  // 渲染期同步赋值会让并发模式下读到撕裂值，effect 时机足够
  // （useLastCallback 的回调只可能在 commit 后被调用）。
  useEffect(() => {
    ref.current = initialValue
  })

  return ref
}
