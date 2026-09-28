/**
 * StateViews：空 / 载入 / 错误三态统一原语。
 * 此前四种载入习语并存（ThinkingOrb / IconLoader / 旋转 IconRefresh / 按钮文字），
 * 空态与错误各页各写一份。这里一次收口；ThinkingOrb 只保留在 Home 首屏。
 */
import type { ReactElement, ReactNode } from 'react'
import { IconLoader } from '../icons'

/** 内联载入：统一旋转图标 + readout 文案 */
export function LoadingInline({ label = '载入中…' }: { label?: string }): ReactElement {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-sm text-zinc-500 dark:text-zinc-400">
      <IconLoader className="h-4 w-4 animate-spin" />
      <span className="readout">{label}</span>
    </div>
  )
}

/** 空态：图标 + 标题 + 可选说明 + 可选行动 */
export function EmptyState({
  title,
  hint,
  action,
  icon,
  className = '',
}: {
  title: string
  hint?: string
  action?: ReactNode
  icon?: ReactElement
  className?: string
}): ReactElement {
  return (
    <div className={`card-flat flex flex-col items-center gap-3 px-6 py-12 text-center ${className}`}>
      {icon ? <div className="text-zinc-300 dark:text-zinc-600">{icon}</div> : null}
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{title}</p>
      {hint ? <p className="max-w-sm text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** 错误盒：红边框 + 消息 + 可选重试；role=alert 让读屏立即播报 */
export function ErrorBox({
  message,
  retry,
  onRetry,
  className = '',
}: {
  message: string
  retry?: string
  onRetry?: () => void
  className?: string
}): ReactElement {
  return (
    <div
      role="alert"
      className={`rounded-[var(--radius-control)] border border-red-500/40 bg-red-500/8 px-4 py-3 text-sm text-red-600 dark:text-red-400 ${className}`}
    >
      <p className="leading-relaxed">{message}</p>
      {retry && onRetry ? (
        <button type="button" className="btn-ghost btn-sm mt-3" onClick={onRetry}>
          {retry}
        </button>
      ) : null}
    </div>
  )
}
