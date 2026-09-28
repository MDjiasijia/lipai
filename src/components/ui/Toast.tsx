/**
 * Toast 单系统：模块级 store + <ToastHost/>（App 挂一次）。
 * 此前 Control 页里并存两套手写 toast（一套 fixed bottom-24、一套 bottom-6 ——
 * 移动端后者被 49px 底部 Tab 栏 + safe-area 完全遮住），且都没有 role=status，
 * 读屏用户对任何异步结果一无所知。这里统一。
 *
 * 位置：bottom-[calc(4.5rem+env(safe-area-inset-bottom))]（底栏上方；底栏全断点常驻）。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'

type ToastKind = 'info' | 'ok' | 'error'

interface ToastEntry {
  id: number
  msg: string
  kind: ToastKind
}

let state: { entries: ToastEntry[] } = { entries: [] }
const listeners = new Set<() => void>()
let seq = 0

function emit(): void {
  state = { ...state }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): { entries: ToastEntry[] } {
  return state
}

/** 发一条 toast；同屏最多 3 条，新的顶掉最旧的 */
export function toast(msg: string, kind: ToastKind = 'info'): void {
  const entry: ToastEntry = { id: ++seq, msg, kind }
  const entries = [...state.entries, entry].slice(-3)
  state = { entries }
  emit()
  window.setTimeout(() => {
    if (state.entries.some((e) => e.id === entry.id)) {
      state = { entries: state.entries.filter((e) => e.id !== entry.id) }
      emit()
    }
  }, 3000)
}

export function ToastHost(): ReactElement | null {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  const [, force] = useState(0)
  useEffect(() => {
    // 首条到达时确保重渲染（store 在挂载前已可能被写过）
    force((n) => n + 1)
  }, [])
  if (snap.entries.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {snap.entries.map((e) => (
        <div
          key={e.id}
          className={`glass glass-spotlight pointer-events-auto flex max-w-md items-center gap-2 rounded-[var(--radius-control)] px-4 py-2.5 text-sm shadow-raised ${
            e.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-zinc-800 dark:text-zinc-100'
          }`}
        >
          {/* 语义色用圆点表达（与 LogDock 状态灯同一语言）；info 无语义色不加点 */}
          {e.kind !== 'info' && (
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 rounded-full ${e.kind === 'ok' ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
          )}
          {e.msg}
        </div>
      ))}
    </div>
  )
}
