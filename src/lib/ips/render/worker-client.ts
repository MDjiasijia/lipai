/**
 * 渲染 Worker 客户端：主线程侧的 renderSlot 代理。
 *
 * - 帧渲染（canvas/JPEG/取数）进 Worker，主线程零阻塞；
 * - Worker 失败（极端环境不支持模块 Worker）自动降级：直接在主线程跑同一函数
 *   —— 调用方不感知差异（返回形状一致）。
 *
 * 协议见 worker.ts 头注释。
 */
import type { SlotSpec } from '../profile-types'
import type { SlotRender } from '../pipeline'

interface DoneMsg {
  type: 'done'
  id: string
  frames: Uint8Array[]
  label: string
  meta?: { id: string; name: string }[]
}
interface ErrorMsg {
  type: 'error'
  id: string
  message: string
}
type WorkerMsg = DoneMsg | ErrorMsg

const pending = new Map<string, { resolve: (v: SlotRender) => void; reject: (e: Error) => void }>()

let worker: Worker | null = null
/** Worker 初始化失败（构造抛错/不支持）→ 永久降级主线程。 */
let isDegraded = false

function ensureWorker(): Worker | null {
  if (isDegraded) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      if (msg.type === 'done') {
        entry.resolve({ frames: msg.frames, label: msg.label, meta: msg.meta })
      } else {
        entry.reject(new Error(msg.message))
      }
    }
    worker.onerror = () => {
      // Worker 崩溃：在等请求全部降级重跑
      isDegraded = true
      const waiting = [...pending.values()]
      pending.clear()
      for (const entry of waiting) entry.reject(new Error('渲染 Worker 崩溃，已降级主线程'))
    }
    return worker
  } catch {
    isDegraded = true
    return null
  }
}

let seq = 0

/** renderSlot 的 Worker 版（同签名同结果；Worker 不可用时自动主线程直跑）。 */
export async function renderSlotAsync(
  slot: number,
  spec: SlotSpec | null,
  opts: { weatherMaxAgeMs?: number } = {},
): Promise<SlotRender> {
  const w = ensureWorker()
  if (!w) {
    const { renderSlot } = await import('../pipeline')
    return renderSlot(slot, spec, opts)
  }
  const id = `r${++seq}`
  return new Promise<SlotRender>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type: 'render', id, slot, spec, weatherMaxAgeMs: opts.weatherMaxAgeMs })
  })
}

/** 预取 Worker（App 挂载时调，隐藏首帧的 Worker 启动延迟）。 */
export function warmRenderWorker(): void {
  ensureWorker()
}
