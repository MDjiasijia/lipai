/**
 * Radio + RadioGroup：单选项。圆环 + 实心点两段标记（checked → 圆环染色、点浮现）。
 * 与 SegmentedControl 分工：Segmented = 短档位横排；RadioGroup = 带说明的
 * 竖排选项列表（设置页形态）。
 */
import type { ReactElement, ReactNode } from 'react'
import buildClassName from '../../util/buildClassName'

export interface RadioOption<T extends string> {
  value: T
  label: ReactNode
  subLabel?: ReactNode
  disabled?: boolean
}

export function Radio<T extends string>({
  name,
  value,
  checked,
  onChange,
  label,
  subLabel,
  disabled,
  className,
}: {
  name: string
  value: T
  checked?: boolean
  onChange?: (value: T) => void
  label: ReactNode
  subLabel?: ReactNode
  disabled?: boolean
  className?: string
}): ReactElement {
  return (
    <label
      className={buildClassName(
        'flex min-h-11 cursor-pointer select-none items-center justify-between gap-3 py-1',
        disabled && 'cursor-default opacity-50',
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block break-words text-sm leading-5">{label}</span>
        {subLabel != null && <span className="mt-0.5 block text-xs leading-4 text-zinc-500 dark:text-zinc-400">{subLabel}</span>}
      </span>
      <span className="relative inline-flex h-5 w-5 shrink-0">
        {/* 纯视觉标记（无 input.sr-only 依赖）：点击由外层 label 转发到隐藏 radio，
            圆环/点以 checked prop 驱动 —— sr-only 的 absolute 定位曾把标记飞出容器 */}
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => onChange?.(value)}
          className="peer sr-only !absolute h-5 w-5"
        />
        {/* 圆环 */}
        <span
          aria-hidden
          className="block h-5 w-5 rounded-full border-2 border-line-strong bg-surface-2 transition-colors duration-100 peer-checked:border-signal-600 dark:peer-checked:border-signal-400"
        />
        {/* 实心点 */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 m-[0.375rem] block h-2 w-2 rounded-full bg-signal-600 opacity-0 transition-opacity duration-100 peer-checked:opacity-100 dark:bg-signal-300"
        />
        <span className="pointer-events-none absolute -inset-1 rounded-full peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-signal-600 dark:peer-focus-visible:outline-signal-300" />
      </span>
    </label>
  )
}

export function RadioGroup<T extends string>({
  name,
  options,
  selected,
  onChange,
  className,
}: {
  name: string
  options: RadioOption<T>[]
  selected?: T
  onChange?: (value: T) => void
  className?: string
}): ReactElement {
  return (
    <div role="radiogroup" className={className}>
      {options.map((option) => (
        <Radio
          key={option.value}
          name={name}
          value={option.value}
          checked={option.value === selected}
          onChange={onChange}
          label={option.label}
          subLabel={option.subLabel}
          disabled={option.disabled}
        />
      ))}
    </div>
  )
}
