/**
 * 开合过渡统一原语。
 *
 * 解决「React 直接卸载 = 动画被腰斩」：isOpen 变 false 后保持挂载，
 * 等关闭动画播完才报告 shouldRender=false，调用方据此卸载。
 *
 * 实现：CSS transition 监听（transitionend + 时长兜底定时器）。
 * 用法：
 *   const { ref, shouldRender } = useShowTransition({ isOpen })
 *   // 退出动画时长从元素 computed transition-duration 读取，无需手配；
 *   // 无过渡元素（transition: none）立即 shouldRender=false。
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** 兜底：transitionend 丢失（标签页切走/中断）时的最长等待。 */
const CLOSE_FALLBACK_MS = 350

export function useShowTransition<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onCloseAnimationEnd,
  fallbackDurationMs = CLOSE_FALLBACK_MS,
}: {
  isOpen: boolean | undefined
  /** 关闭动画播完（真实卸载时机）回调。 */
  onCloseAnimationEnd?: NoneToVoidFunction
  fallbackDurationMs?: number
}): { ref: RefObject<T | null>; shouldRender: boolean; isClosing: boolean } {
  const [shouldRender, setShouldRender] = useState(Boolean(isOpen))
  const [isClosing, setIsClosing] = useState(false)
  const fallbackTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true)
      setIsClosing(false)
      return
    }
    // 关闭：先保持挂载播退出动画
    setIsClosing(true)
    fallbackTimerRef.current = window.setTimeout(() => {
      setShouldRender(false)
      setIsClosing(false)
      onCloseAnimationEnd?.()
    }, fallbackDurationMs)
    return () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    }
    // onCloseAnimationEnd 走 ref 化由调用方保证稳定（useLastCallback）；
    // 这里只跟随 isOpen。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 语义：isOpen 是唯一驱动
  }, [isOpen])

  // transitionend 提前结算（比兜底定时器准）
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!isClosing) return
    const el = ref.current
    if (!el) return
    const onEnd = (e: TransitionEvent): void => {
      if (e.target !== el) return
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
      setShouldRender(false)
      setIsClosing(false)
      onCloseAnimationEnd?.()
    }
    el.addEventListener('transitionend', onEnd)
    return () => el.removeEventListener('transitionend', onEnd)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isClosing 是唯一驱动
  }, [isClosing])

  return { ref, shouldRender, isClosing }
}
