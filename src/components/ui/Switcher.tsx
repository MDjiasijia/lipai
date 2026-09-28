/**
 * Switcher：开关。轨道 + 浮钮两段结构（checked → 浮钮位移），即时生效的设置项开关。
 * 与 Checkbox 分工：Switcher = 开/关；Checkbox = 列表多选。
 * 整行 label 布局（文字左、开关右），44px 触控地板。
 */
import type { ReactElement } from 'react'
import buildClassName from '../../util/buildClassName'

export function Switcher({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked?: boolean
  onChange?: (next: boolean) => void
  /** 开关文案（label 内）。 */
  label: string
  /** 可选副说明（title 提示）。 */
  hint?: string
  disabled?: boolean
  className?: string
}): ReactElement {
  return (
    <label
      title={hint ?? label}
      className={buildClassName(
        'group flex min-h-11 cursor-pointer select-none items-center justify-between gap-3',
        disabled && 'cursor-default opacity-50',
        className,
      )}
    >
      <span className="text-sm">{label}</span>
      <span className="relative inline-flex">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
          className="peer sr-only"
        />
        {/* 轨道：选中染 signal（全站唯一选中语言） */}
        <span
          aria-hidden
          className="block h-3.5 w-[2.125rem] rounded-full bg-zinc-300 transition-colors duration-[var(--duration-fast)] peer-checked:bg-signal-600 dark:bg-zinc-600 dark:peer-checked:bg-signal-400"
        />
        {/* 浮钮：surface-2 镜片 + 发丝边（glass-chip 同源物理），checked 右移一倍轨宽 */}
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 left-0 block h-[1.125rem] w-[1.125rem] rounded-full border border-line-strong bg-surface-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.75)] transition-transform duration-[var(--duration-fast)] peer-checked:translate-x-[0.875rem] peer-checked:border-signal-600 dark:bg-zinc-800 dark:peer-checked:border-signal-400"
        />
        <span className="pointer-events-none absolute -inset-1 rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-signal-600 dark:peer-focus-visible:outline-signal-300" />
      </span>
    </label>
  )
}
