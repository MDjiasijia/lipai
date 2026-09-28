/**
 * RangeSlider：滑杆。填充轨宽度按值比例计算，叠在原生 range 上
 * （原生 thumb 换肤见 index.css .range-slider-input）；
 * options 档位模式：value 对齐下标、下方均分刻度、点击跳档；
 * 顶行 label + 当前值（renderValue 自定义渲染）。
 */
import type { ReactElement, ReactNode } from 'react'
import { useMemo } from 'react'
import buildClassName from '../../util/buildClassName'

export function RangeSlider({
  options,
  min = 0,
  max,
  step = 1,
  label,
  value,
  disabled,
  className,
  renderValue,
  onChange,
}: {
  /** 档位模式：给定后 value = 下标，下方均分刻度。 */
  options?: string[]
  min?: number
  max?: number
  step?: number
  label?: string
  value: number
  disabled?: boolean
  className?: string
  renderValue?: (value: number) => ReactNode
  onChange: (value: number) => void
}): ReactElement {
  const resolvedMax = max ?? (options ? options.length - 1 : 100)

  const trackWidth = useMemo(() => {
    if (options) return (value / (options.length - 1)) * 100
    // 填充比例按量程（max-min），不按档数 —— 除以档数会在值大时溢出容器（横穿卡片）
    return ((value - min) / (resolvedMax - min)) * 100
  }, [options, value, resolvedMax, min])

  return (
    <div className={buildClassName('select-none', disabled && 'pointer-events-none opacity-50', className)}>
      {/* 顶行：label + 当前值 */}
      {label && (
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
          {!options && <span className="readout text-xs text-zinc-500 dark:text-zinc-400">{renderValue ? renderValue(value) : value}</span>}
        </div>
      )}
      <div className="relative">
        {/* 底轨 + 填充轨 */}
        <span aria-hidden className="pointer-events-none absolute left-0 top-1/2 h-0.5 w-full -translate-y-1/2 rounded-sm bg-line" />
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-sm bg-signal-600 dark:bg-signal-400"
          style={{ width: `${trackWidth}%` }}
        />
        <input
          type="range"
          min={min}
          max={resolvedMax}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
          className="range-slider-input relative block h-5 w-full cursor-pointer appearance-none bg-transparent"
          aria-label={label}
        />
      </div>
      {/* 档位刻度：均分网格，点击跳档 */}
      {options && (
        <div className="grid auto-cols-fr grid-flow-col">
          {options.map((option, i) => (
            <button
              key={option}
              type="button"
              onClick={() => onChange(i)}
              className={`pt-1 text-center text-[11px] transition-colors ${
                i === value ? 'font-semibold text-signal-600 dark:text-signal-300' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
