/**
 * Tabs 原语：role=tablist/tab/tabpanel 语义 + roving tabindex 键盘遍历。
 * 此前 Control 的 Tab 导航是普通按钮（无 aria-selected / 无方向键 / 不进 URL）——
 * 返回键、深链、读屏全部不可用。这里一次补齐。
 *
 * 用法：
 *   <TabList tabs={[{key:'content', label:'内容'}, …]} active={tab} onChange={setTab} />
 *   <TabPanel id="content">…</TabPanel>
 *
 * 激活态样式 = chip-on（全站唯一选中语言，见 index.css）。
 */
import type { ReactElement, KeyboardEvent } from 'react'
import { useRef } from 'react'

export interface TabDef {
  key: string
  label: string
  /** 可选徽标（如设备状态灯） */
  badge?: ReactElement
}

export function TabList({
  tabs,
  active,
  onChange,
  ariaLabel,
  className = '',
}: {
  tabs: TabDef[]
  active: string
  onChange: (key: string) => void
  ariaLabel?: string
  className?: string
}): ReactElement {
  const listRef = useRef<HTMLDivElement>(null)

  // roving tabindex：方向键在 tab 间移动焦点（不切换），Home/End 跳首尾
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const keys = tabs.map((t) => t.key)
    const idx = keys.indexOf(active)
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next === null) return
    e.preventDefault()
    onChange(tabs[next]!.key)
    // 焦点跟着激活 tab 走（激活即聚焦，方向键手感与原生 tab 一致）
    const el = listRef.current?.querySelector<HTMLElement>(`[data-tab-key="${tabs[next]!.key}"]`)
    el?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`glass-track flex min-h-10 w-full items-center gap-1 rounded-[var(--radius-control)] p-1 ${className}`}
    >
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            data-tab-key={t.key}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-0.25rem)] px-3 text-sm font-medium transition-[color,background-color,box-shadow,transform] duration-[var(--duration-fast)] active:scale-[0.97] ${
              isActive
                ? 'glass-thumb text-zinc-800 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
            }`}
          >
            {t.badge}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ id, children }: { id: string; children: React.ReactNode }): ReactElement {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="outline-none">
      {children}
    </div>
  )
}
