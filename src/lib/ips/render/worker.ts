/**
 * 渲染 Worker 入口：把 renderSlot 全链路（取数 → canvas → JPEG）搬出主线程。
 *
 * 蓝牙规范上只在 Window 暴露（Web Bluetooth [Exposed=Window]），Worker 拿不到
 * navigator.bluetooth —— 所以分界线是：渲染（CPU 重活）在 Worker，蓝牙发送
 * （字节切片 + GATT write，轻）留主线程。主线程从此不为渲染卡顿负责。
 *
 * 协议（PostMessageConnector 同款形状）：
 *   → { type:'render', id, slot, spec, weatherMaxAgeMs }
 *   ← { type:'done', id, frames, label, meta } | { type:'error', id, message }
 *
 * 帧以 transferable 传回（零拷贝）；IndexedDB（图组/数据源定义）、fetch（天气/
 * datafeed）在 Worker 里原生可用 —— 渲染管线代码零改动直接跑。
 */
import { renderSlot } from '../pipeline'
import type { SlotSpec } from '../profile-types'

interface RenderRequest {
  type: 'render'
  id: string
  slot: number
  spec: SlotSpec | null
  weatherMaxAgeMs?: number
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const msg = e.data
  if (msg?.type !== 'render') return
  void (async () => {
    try {
      const out = await renderSlot(msg.slot, msg.spec, { weatherMaxAgeMs: msg.weatherMaxAgeMs })
      const transfer = out.frames.map((f) => f.buffer)
      self.postMessage(
        {
          type: 'done',
          id: msg.id,
          frames: out.frames,
          label: out.label,
          meta: out.meta,
        },
        { transfer },
      )
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
    }
  })()
}
