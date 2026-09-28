/**
 * useLastCallback：useCallback 但永远调用最新闭包、依赖恒为空。
 *
 * 消灭「回调捕获旧 state」这一整类 bug 和依赖数组噪音。
 * 回调 identity 稳定，可安全传给 memo 子组件。
 */
import { useCallback } from 'react'

import useStateRef from './useStateRef'

export default function useLastCallback<T extends AnyFunction>(callback?: T): T {
  const ref = useStateRef(callback)

  // eslint-disable-next-line react-hooks/exhaustive-deps -- 引用恒定是本 hook 的语义
  return useCallback((...args: Parameters<T>) => ref.current?.(...args), []) as T
}
