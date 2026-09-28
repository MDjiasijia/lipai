/**
 * 场景日程控制层 —— API 同步版（服务端常驻）。
 *
 * share-web 版 SceneScheduler 在页面里跑 30s tick（关 tab 即停，存档走
 * IndexedDB settings）；本地版常驻服务端（server/lib/scene-scheduler.ts，
 * config.json 落盘、启动即拉起）：
 *  - 读状态：GET /api/scene（{ schedule, state }）+ SSE scene 事件增量更新
 *  - 写时刻表：PUT /api/scene（服务端校验 + 存 config.json + 立即按新表对齐）
 *
 * 类形状保留（Control.tsx 的 schedulerRef.current?.start(...) 调用形状不变），
 * 内部从「本地定时器 + IndexedDB 存档」换成「API 同步 + SSE 订阅」。
 * 时段推算（resolveActive）留在服务端 —— 前端这份只是编辑器与读数面板。
 */
import type { SceneSchedule, SceneSlot } from './profile-types'
import * as api from '../api-server'
import type { SceneScheduleState } from '../api-server'
import { subscribeServerEvent } from './deviceStore'

export type { SceneScheduleState }

/** 旧 Callbacks 形状（服务端版用不到 —— 到点推图由服务端直接驱动桥上设备） */
type Callbacks = {
  onEnter: (slot: SceneSlot) => void
  onLeave: () => void
}

export class SceneScheduler {
  private unsubscribe: (() => void) | null = null
  private lastState: SceneScheduleState | null = null
  private schedule: SceneSchedule | null = null

  /**
   * 「启动」（PUT /api/scene）：服务端存档 + 立即拉起常驻运行器。
   *  callbacks 参数保留在签名里（对齐旧调用点），服务端版不消费 ——
   *  到点推图由服务端直接驱动桥上设备。
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 旧调用点兼容（形状对齐 share-web 版）
  async start(schedule: SceneSchedule, _callbacks?: Callbacks): Promise<void> {
    this.schedule = schedule
    const resp = await api.putSceneSchedule(schedule)
    this.lastState = resp.state
    this.subscribe()
  }

  /** 停止（禁用存档：enabled=false 落盘 + 服务端停运行器） */
  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.schedule) {
      // 停 ≠ 删时刻表：enabled=false 保留骨架，用户随时再启用
      const resp = await api.putSceneSchedule({ ...this.schedule, enabled: false }).catch(() => null)
      if (resp) this.lastState = resp.state
    }
  }

  /** 订阅 SSE scene 事件（常驻运行器到点切换时推 { schedule, state }） */
  private subscribe(): void {
    this.unsubscribe?.()
    this.unsubscribe = subscribeServerEvent('scene', (data) => {
      const p = data as { schedule?: SceneSchedule | null; state?: SceneScheduleState }
      if (p?.state && typeof p.state === 'object') {
        this.lastState = p.state
        if (p.schedule) this.schedule = p.schedule
      }
    })
  }

  getState(): SceneScheduleState | null {
    return this.lastState
  }

  /** 只摘 SSE 订阅、不停服务端日程（组件卸载用 —— 常驻语义） */
  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  getSchedule(): SceneSchedule | null {
    return this.schedule
  }

  /** 拉一次当前状态 + 时刻表（页面挂载时对齐 server 常驻日程） */
  async refresh(): Promise<{ schedule: SceneSchedule | null; state: SceneScheduleState } | null> {
    try {
      const resp = await api.getSceneSchedule()
      this.schedule = resp.schedule
      this.lastState = resp.state
      if (resp.state.status === 'running') this.subscribe()
      return resp
    } catch {
      return null
    }
  }
}
