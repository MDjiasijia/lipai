/**
 * Progress：role=progressbar 进度条（此前 4 处进度全是无语义 div）。
 * 读数走 readout（等宽数字），不确定进度（total 未知）显示条纹动画。
 */
import type { ReactElement } from 'react'

export function Progress({
  value,
  total,
  label,
  className = '',
}: {
  /** 已完成数；total 未知（value 同 total）时走不确定样式 */
  value: number
  total?: number
  label?: string
  className?: string
}): ReactElement {
  const pct = total && total > 0 ? Math.min(100, Math.round((value / total) * 100)) : undefined
  return (
    <div className={`w-full ${className}`}>
      {label ? (
        <div className="micro-label mb-1.5">
          {label}
          {total ? <span className="readout ml-1.5 normal-case tracking-normal text-zinc-500">{` ${value}/${total}`}</span> : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-2 overflow-hidden rounded-full bg-surface-1 shadow-[inset_0_1px_2px_rgba(15,23,42,0.12)]"
      >
        <div
          className={`h-full rounded-full bg-gradient-to-r from-signal-600 to-signal-400 transition-[width] duration-[var(--duration-slow)] ${
            pct === undefined ? 'w-1/3 animate-pulse' : ''
          }`}
          style={pct === undefined ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
