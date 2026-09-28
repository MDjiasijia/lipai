/**
 * Menu：非模态下拉浮层原语。
 *
 * 编排：useShowTransition（开合动画、动画完才卸载）+ 触发器记忆（关闭还原焦点）
 * + Esc/点外关闭 + 面板内首焦点。与 Modal 的分工：Menu 无背板、不锁焦点、
 * 锚定触发器；Modal 全屏模态。
 *
 * 面板定位由调用方 className 给（默认右上角挂靠）；触发器自理（hook 版见 useMenuRef）。
 */
import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useShowTransition } from '../../hooks/useShowTransition'
import buildClassName from '../../util/buildClassName'

const EXIT_FALLBACK_MS = 150

export function Menu({
  isOpen,
  onClose,
  children,
  ariaLabel,
  panelClassName,
}: {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  ariaLabel: string
  /** 面板附加类（宽度/锚点偏移等）。 */
  panelClassName?: string
}): ReactElement | null {
  const { ref, shouldRender, isClosing } = useShowTransition<HTMLDivElement>({
    isOpen,
    fallbackDurationMs: EXIT_FALLBACK_MS,
  })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const isMountedRef = useRef(false)

  const isOpenNow = isOpen && shouldRender

  useEffect(() => {
    if (!isOpenNow) return
    // 只在「打开」那次记触发器（关闭动画期间 isOpen 已 false，不覆盖）
    if (!isMountedRef.current) {
      triggerRef.current = document.activeElement as HTMLElement | null
      isMountedRef.current = true
      panelRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      const trig = triggerRef.current
      if (trig && (trig === target || (trig instanceof Element && trig.contains(target)))) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
      if (isMountedRef.current) {
        triggerRef.current?.focus?.()
        isMountedRef.current = false
      }
    }
  }, [isOpenNow, onClose])

  if (!shouldRender) return null

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      aria-hidden={isClosing || undefined}
      ref={(el) => {
        // useShowTransition 的 ref 与焦点查询面板合一
        panelRef.current = el
        ref.current = el
      }}
      className={buildClassName(
        'glass glass-spotlight absolute right-0 top-[calc(100%+10px)] z-50 rounded-[20px] shadow-raised',
        isClosing ? 'pointer-events-none scale-95 opacity-0 transition-transform duration-150' : 'scale-100 opacity-100 transition-transform duration-150',
        panelClassName,
      )}
    >
      {children}
    </div>
  )
}
