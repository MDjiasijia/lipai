/**
 * Spinner：环形加载指示（颜色参数化、纯 CSS 动画）。
 * 与 LoadingInline（图标+文案）分工：Spinner 是纯指示件，用于按钮内/局部小区域。
 */
import type { ReactElement } from 'react'
import buildClassName from '../../util/buildClassName'

export function Spinner({
  color = 'currentColor',
  className,
}: {
  /** 任意 CSS 颜色；缺省跟随文字色（currentColor）。 */
  color?: string
  className?: string
}): ReactElement {
  return (
    <span
      role="status"
      aria-label="载入中"
      className={buildClassName(
        'inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-transparent align-[-0.15em]',
        className,
      )}
      style={{ borderTopColor: color, borderRightColor: color }}
    />
  )
}

/**
 * Skeleton：内容骨架屏（形状占位，不是转圈）。
 * 列表/卡片加载时先给形状，比 spinner 的「等」感轻得多。
 */
export function Skeleton({
  className,
  variant = 'rect',
}: {
  className?: string
  /** rect = 圆角块；text = 文本行（h-3 圆头）；circle = 圆。 */
  variant?: 'rect' | 'text' | 'circle'
}): ReactElement {
  const shape = variant === 'text' ? 'h-3 rounded-full' : variant === 'circle' ? 'rounded-full' : 'rounded-[var(--radius-control)]'
  return (
    <span
      aria-hidden
      className={buildClassName('block animate-pulse bg-zinc-200/80 dark:bg-zinc-700/60', shape, className)}
    />
  )
}
