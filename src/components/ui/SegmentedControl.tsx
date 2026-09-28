/**
 * SegmentedControl：role=radiogroup 的分档选择（真 radio input，可键盘可达）。
 * 用于 Home 排序（最新/人气）、灯效 5 档、亮度快捷档等短档位场景。
 *
 * 材质 = 液态玻璃分段控件（glass-track 轨道 + glass-thumb 浮起镜片）：
 * 选中片「浮起来」（顶镜边受光 + 双层落影），未选片平躺槽里；
 * 按压形变（active:scale）承担物理确认。kube.io 位移折射在 ≤12px 半径
 * 控件上被 bevel 钳住 —— 厚度感由三层物理暗示表达（见 index.css 注释）。
 */
import type { ReactElement } from 'react'

export interface SegmentDef<T extends string | number> {
  value: T
  label: string
  /** aria-label 补充（如「人气排序」） */
  hint?: string
}

export function SegmentedControl<T extends string | number>({
  segments,
  value,
  onChange,
  ariaLabel,
  size = 'sm',
  className = '',
}: {
  segments: SegmentDef<T>[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
  size?: 'sm' | 'md'
  className?: string
}): ReactElement {
  const name = `seg-${ariaLabel ?? Math.random().toString(36).slice(2)}`
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`glass-track inline-flex items-center gap-0.5 rounded-[var(--radius-control)] p-0.5 ${className}`}
    >
      {segments.map((s) => {
        const checked = s.value === value
        const id = `${name}-${String(s.value)}`
        return (
          <span key={String(s.value)} className="contents">
            <input
              type="radio"
              id={id}
              name={name}
              checked={checked}
              onChange={() => onChange(s.value)}
              className="peer sr-only"
            />
            <label
              htmlFor={id}
              title={s.hint}
              className={`peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-signal-600 dark:peer-focus-visible:outline-signal-300 flex cursor-pointer select-none items-center justify-center rounded-[calc(var(--radius-control)-0.25rem)] text-center font-medium transition-[color,background-color,box-shadow,transform] duration-[var(--duration-fast)] active:scale-[0.97] ${
                size === 'sm' ? 'min-h-8 px-3.5 text-xs' : 'min-h-9 px-4 text-sm'
              } ${
                checked
                  ? 'glass-thumb text-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              {s.label}
            </label>
          </span>
        )
      })}
    </div>
  )
}
