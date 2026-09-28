/**
 * Modal：弹层唯一原语。
 *
 * 能力全部来自 hooks/子原语的组装，本组件只做编排：
 * - useShowTransition：开合动画、动画播完才卸载
 * - Portal：渲到 #portals（脱离父级层叠上下文 —— 此前弹层被 header z-20 困住那类 bug 的根治）
 * - Esc 关闭 / 点背板关闭 / 焦点进面板、关闭还原触发器
 * - trapFocus：Tab 循环锁在面板内（a11y）
 *
 * 视觉 = 玻璃面板（glass glass-spotlight），尺寸由调用方 className 定（max-w-*）。
 * ConfirmDialog 等特化弹层在 Modal 之上薄封装。
 */
import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShowTransition } from '../../hooks/useShowTransition'
import buildClassName from '../../util/buildClassName'

const ANIMATION_FALLBACK_MS = 200

/** Tab 循环锁定在容器内。 */
function trapFocus(e: KeyboardEvent, container: HTMLElement): void {
  if (e.key !== 'Tab') return
  const focusables = container.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

export function Modal({
  isOpen,
  onClose,
  children,
  ariaLabel,
  className,
  contentClassName,
  noBackdrop,
  onCloseAnimationEnd,
}: {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  ariaLabel: string
  /** 背板容器附加类（宽度/布局）；面板内容附加类用 contentClassName。 */
  className?: string
  contentClassName?: string
  /** 无背板（菜单类浮层挂靠场景给 true；缺省 = 有背板）。 */
  noBackdrop?: boolean
  onCloseAnimationEnd?: NoneToVoidFunction
}): ReactElement | null {
  const { ref, shouldRender, isClosing } = useShowTransition<HTMLDivElement>({
    isOpen,
    onCloseAnimationEnd,
    fallbackDurationMs: ANIMATION_FALLBACK_MS,
  })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const isOpenNow = isOpen && shouldRender

  useEffect(() => {
    if (!isOpenNow) return
    triggerRef.current = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (panel) trapFocus(e, panel)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      triggerRef.current?.focus?.()
    }
  }, [isOpenNow, onClose])

  // 关闭动画期间内容仍挂载（isClosing），但不再响应交互
  if (!shouldRender) return null

  return createPortal(
    <div
      ref={ref}
      className={buildClassName(
        'fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 backdrop-blur-sm',
        isClosing ? 'pointer-events-none opacity-0 transition-opacity duration-200' : 'opacity-100 transition-opacity duration-200',
        className,
      )}
      onPointerDown={(e) => {
        if (!noBackdrop && e.target === e.currentTarget) onClose()
      }}
      aria-hidden={isClosing || undefined}
    >
      <div
        ref={(el) => {
          panelRef.current = el
          ref.current = el
        }}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={buildClassName(
          'glass glass-spotlight rounded-[20px] shadow-raised',
          isClosing ? 'scale-95 opacity-0 transition-transform duration-200' : 'scale-100 opacity-100 transition-transform duration-200',
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.getElementById('portals') ?? document.body,
  ) as ReactElement
}
