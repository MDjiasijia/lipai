/**
 * Checkbox：勾选项。底板 + 勾的两段标记（checked → 底板染色、勾浮现）。
 * 布局：label 左、标记右。
 * 与 Switcher 分工：Switcher = 开关一个设置项；Checkbox = 列表里多选。
 * 消费方：PreviewStrip 混合流勾选。
 */
import type { ReactElement, ReactNode } from 'react'
import buildClassName from '../../util/buildClassName'

export function Checkbox({
  checked,
  onChange,
  label,
  subLabel,
  disabled,
  className,
}: {
  checked?: boolean
  onChange?: (next: boolean) => void
  label: ReactNode
  /** 副说明（灰字第二行）。 */
  subLabel?: ReactNode
  disabled?: boolean
  className?: string
}): ReactElement {
  return (
    <label
      className={buildClassName(
        'group flex min-h-11 cursor-pointer select-none items-center justify-between gap-3 py-1',
        disabled && 'cursor-default opacity-50',
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block break-words text-sm leading-5">{label}</span>
        {subLabel != null && <span className="mt-0.5 block text-xs leading-4 text-zinc-500 dark:text-zinc-400">{subLabel}</span>}
      </span>
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
          className="peer sr-only"
        />
        {/* 底板 */}
        <span
          aria-hidden
          className="block h-5 w-5 rounded-[0.375rem] border-2 border-line-strong bg-surface-2 transition-colors duration-100 peer-checked:border-signal-600 peer-checked:bg-signal-600 dark:peer-checked:border-signal-400 dark:peer-checked:bg-signal-400"
        />
        {/* 勾（SVG，checked 浮现） */}
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="pointer-events-none absolute left-0 top-0 h-5 w-5 -scale-x-100 text-white opacity-0 transition-opacity duration-100 peer-checked:opacity-100 dark:text-zinc-950"
        >
          <path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="pointer-events-none absolute -inset-1 rounded-[var(--radius-control)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-signal-600 dark:peer-focus-visible:outline-signal-300" />
      </span>
    </label>
  )
}
