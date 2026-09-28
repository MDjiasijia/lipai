/**
 * Select：下拉选择。label 浮动（有值时缩到上边框）、error 优先显示并替换 label、
 * 原生 select 保键盘/读屏原生行为；样式走 .input 体系。
 */
import type { ReactElement, ReactNode } from 'react'
import buildClassName from '../../util/buildClassName'

export function Select({
  value,
  onChange,
  children,
  label,
  error,
  id,
  className,
}: {
  value: string
  onChange?: (value: string) => void
  children: ReactNode
  /** 浮动标签（error 存在时被错误文案取代）。 */
  label?: string
  error?: string
  id?: string
  className?: string
}): ReactElement {
  const labelText = error || label
  return (
    <div className={buildClassName('relative', className)}>
      <select
        id={id}
        className="input pr-8"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
      >
        {children}
      </select>
      {/* 浮动标签：有值时缩到上边框（legend 效果）；error 优先并染红 */}
      {labelText && id && (
        <label
          htmlFor={id}
          className={buildClassName(
            'absolute -top-2 left-2 max-w-[calc(100%-1rem)] truncate bg-surface-0 px-1 text-[11px] leading-none',
            error ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400',
          )}
        >
          {labelText}
        </label>
      )}
      {error && (
        <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-red-500">
          <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 6v4.5M10 13.2v.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </div>
  )
}
