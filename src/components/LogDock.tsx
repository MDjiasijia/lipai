/**
 * 全局通信日志浮窗（LogDock）：设备协议帧的全站唯一展示出口。
 *
 * 数据源 = deviceStore.log（全局单例订阅）——任何页面产生通信都进同一份日志；
 * 展示层全局：入口有两处（底栏「日志」固定位 + 右下胶囊开关），读写同一份
 * 模块级 open 状态；展开 = 右下抽屉（玻璃读数材质、自动滚底、清空）。
 *
 * 显示开关（isLogDockVisible）是模块级共享状态：DeviceMenu 的
 * 「通信日志入口」Switcher 与本组件读写同一份 —— 关掉即全站隐藏（记忆 localStorage）。
 *
 * 为什么是全局而非 Control 设备 Tab 内嵌：调试投屏/轮播时切到别的页
 * 日志就看不见了 —— 通信是全局的，日志也该是。
 *
 * TODO(下一轮 deviceStore 改造)：日志订阅改接 SSE /api/events 的 `log` 事件
 * （src/lib/ips/deviceStore.ts 会改成服务端通道 + SSE 推送），本组件消费的
 * getDeviceState/subscribeDevice/actions 接口名保持不变 —— 只换数据来源。
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import { getDeviceState, subscribeDevice, actions } from '../lib/ips/deviceStore'
import type { LogEntry } from '../lib/ips/shared'
import { toast } from './ui/Toast'
import buildClassName from '../util/buildClassName'

const HIDE_KEY = 'lipai-log-dock-hidden'

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1'
  } catch {
    return false
  }
}

/* ── 日志导出 ─────────────────────────────────────────────────────────────── */

/** 日志时间戳 → HH:MM:SS（浮窗行前缀与复制导出共用；当天内看通信序，跨天日志本就会清/滚动掉） */
function clock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 全部日志拼成纯文本（时间 + 方向箭头 + 内容），供复制出去贴给他人排查 */
function logToText(entries: LogEntry[]): string {
  return entries
    .map((entry) => {
      const arrow = entry.direction === 'out' ? '→' : entry.direction === 'in' ? '←' : '·'
      return `${clock(entry.ts)} ${arrow} ${entry.message}`
    })
    .join('\n')
}

/** 写剪贴板：clipboard API 优先（需 secure context），失败回落 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const isCopied = document.execCommand('copy')
    ta.remove()
    return isCopied
  }
}

/* ── 显示开关（模块级共享：DeviceMenu 开关 ↔ 浮窗本体）── */

let logDockHidden = readHidden()
const visibilityListeners = new Set<() => void>()

function emitVisibility(): void {
  for (const l of visibilityListeners) l()
}

/** 全站是否显示日志入口（DeviceMenu 的 Switcher 也用这份）。 */
export function useLogDockVisible(): [boolean, (visible: boolean) => void] {
  const visible = useSyncExternalStore(
    (l) => {
      visibilityListeners.add(l)
      return () => visibilityListeners.delete(l)
    },
    () => !logDockHidden,
  )
  const setVisible = (next: boolean): void => {
    logDockHidden = !next
    try {
      localStorage.setItem(HIDE_KEY, next ? '0' : '1')
    } catch {
      /* 隐私模式忽略 */
    }
    emitVisibility()
  }
  return [visible, setVisible]
}

/* ── 展开/收起（模块级共享：底栏固定位 ↔ 右下胶囊 ↔ 浮窗本体）── */

let logDockOpen = false
const openListeners = new Set<() => void>()

function emitOpen(): void {
  for (const l of openListeners) l()
}

function setLogDockOpen(next: boolean): void {
  if (logDockOpen === next) return
  logDockOpen = next
  emitOpen()
}

/** 日志浮窗是否展开（底栏固定位与胶囊开关读写同一份；跨页保持开合态）。 */
export function useLogDockOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (l) => {
      openListeners.add(l)
      return () => openListeners.delete(l)
    },
    () => logDockOpen,
  )
  return [open, setLogDockOpen]
}

/** 日志条数（底栏徽标与浮窗头部共用一份读数）。 */
export function useLogCount(): number {
  return useSyncExternalStore(subscribeDevice, getDeviceState).log.length
}

/* ── 浮窗本体 ────────────────────────────────────────────────────────────── */

export function LogDock(): ReactElement | null {
  const { log, state: connState } = useSyncExternalStore(subscribeDevice, getDeviceState)
  const [visible] = useLogDockVisible()
  const [open, setOpen] = useLogDockOpen()
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /** 复制全部日志（含时间戳）到剪贴板 */
  const copyLog = (): void => {
    void copyText(logToText(log)).then((isCopied) => {
      toast(isCopied ? `已复制 ${log.length} 条日志` : '复制失败（剪贴板不可用）', isCopied ? 'ok' : 'error')
    })
  }

  // 新日志自动滚底（展开时才滚 —— 收起时不做无谓工作）
  useEffect(() => {
    if (!open) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log, open])

  if (!visible) return null

  const isIdle = connState === 'idle'
  const dotClass =
    connState === 'connected'
      ? 'bg-emerald-400'
      : connState === 'connecting'
        ? 'bg-glow-400 animate-pulse'
        : connState === 'disconnected'
          ? 'bg-red-400'
          : 'bg-zinc-500'

  return (
    <div className="pointer-events-none fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] right-3 z-40 flex flex-col items-end gap-2">
      {open && (
        <div
          role="dialog"
          aria-label="通信日志"
          className="glass pointer-events-auto flex max-h-[min(24rem,50dvh)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[var(--radius-card)] shadow-raised"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span aria-hidden className={buildClassName('h-2 w-2 shrink-0 rounded-full', dotClass)} />
            <span className="micro-label flex-1">通信日志</span>
            <span className="readout text-[10px] text-zinc-400">{log.length} 条</span>
            <button
              type="button"
              className="text-[11px] text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-200 disabled:opacity-40"
              onClick={copyLog}
              disabled={log.length === 0}
              title="复制全部日志（含时间戳）"
            >
              复制
            </button>
            <button
              type="button"
              className="text-[11px] text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-200"
              onClick={actions.clearLog}
            >
              清空
            </button>
            <button
              type="button"
              className="text-[11px] text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-200"
              onClick={() => setOpen(false)}
              aria-label="收起日志"
            >
              ▾
            </button>
          </div>
          <div
            ref={bodyRef}
            className="readout min-h-0 flex-1 overflow-y-auto p-3 text-[11px] leading-relaxed"
          >
            {log.length === 0 ? (
              <p className="text-zinc-400">{isIdle ? '尚无通信 —— 连接设备后全站协议帧实时显示在这里。' : '连接中… 协议帧将实时显示。'}</p>
            ) : (
              log.map((entry, i) => (
                <p key={i} className="whitespace-pre-wrap">
                  {/* 时间戳随方向同色系（降档亮度）—— 三类行扫一眼可分，正文色不稀释 */}
                  <span
                    className={
                      entry.direction === 'out'
                        ? 'text-zinc-500 dark:text-zinc-600'
                        : entry.direction === 'in'
                          ? 'text-emerald-600 dark:text-emerald-800'
                          : 'text-zinc-400 dark:text-zinc-600'
                    }
                  >
                    {clock(entry.ts)}
                  </span>{' '}
                  <span className={entry.direction === 'out' ? 'text-signal-300' : entry.direction === 'in' ? 'text-emerald-300' : 'text-zinc-500'}>
                    {entry.direction === 'out' ? '→' : entry.direction === 'in' ? '←' : '·'}
                  </span>{' '}
                  {entry.message}
                </p>
              ))
            )}
          </div>
        </div>
      )}
      {/* 胶囊开关（常驻右下角；底栏上方，全站可开 —— 与 Toast 左右错开） */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="glass-chip-float glass-chip pointer-events-auto flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-3 text-[11px] font-medium text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
        title={open ? '收起通信日志' : '打开通信日志（全站协议帧，任何页面可看）'}
      >
        <span aria-hidden className={buildClassName('h-1.5 w-1.5 rounded-full', dotClass)} />
        日志
        {log.length > 0 && <span className="readout rounded-full bg-zinc-900/10 px-1.5 text-[10px] dark:bg-white/10">{log.length}</span>}
      </button>
    </div>
  )
}

