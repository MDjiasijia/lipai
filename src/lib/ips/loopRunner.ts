/**
 * 轮播循环控制层 —— 服务端常驻版（API + SSE 薄层）。
 *
 * share-web 版 LoopRunner 在页面里跑定时器（关 tab 即停）；本地版轮播
 * 常驻服务端（server/lib/loop.ts，页面关掉照跑、断电重启自动恢复）：
 *  - start/stop → POST /api/loop/start | /api/loop/stop
 *  - 状态 → GET /api/loop 初始拉取 + SSE loop 事件增量更新 UI
 *
 * 类形状保留（Control.tsx 的 runnerRef.current?.start(...) 调用形状不变），
 * 内部从「本地定时器」换成「API 调用 + SSE 订阅」—— 消费方不感知。
 * start 的 slotSpecs 参数保留在签名里（对齐旧调用点），服务端按配方自带取数，
 * 前端不再渲染帧（服务端渲染管线与预览共享同一套 canvas-kit 设计语言）。
 */
import type { LoopConfig, SlotSpec } from './profile-types'
import { sanitizeLoopSteps, isSlotStep, LOOP_MIN_SEC_PUSH, LOOP_MIN_SEC_SWITCH, type LoopSource } from './loop'
import * as api from '../api-server'
import { subscribeServerEvent } from './deviceStore'
import type { LoopState } from './shared'

export type { LoopState }

/** 间隔下限（秒）：含推图步 30，纯切槽位 1 */
export function loopMinIntervalSec(steps: readonly unknown[]): number {
  const cleaned = sanitizeLoopSteps(steps)
  return cleaned.some((s) => !isSlotStep(s)) ? LOOP_MIN_SEC_PUSH : LOOP_MIN_SEC_SWITCH
}

/** LoopSource 再导出（服务端 StartLoopArgs 的 steps 类型用） */
export type { LoopSource }

export class LoopRunner {
  /** SSE 订阅退订函数（stop/重新 start 时换新） */
  private unsubscribe: (() => void) | null = null
  private lastState: LoopState | null = null

  constructor(
    /** 设备参数（旧签名的 device；服务端版用不到 —— 桥上的设备由服务端直接驱动） */
    _device: unknown,
    private readonly onState: (s: LoopState) => void,
  ) {}

  getState(): LoopState | null {
    return this.lastState
  }

  /** 订阅 SSE loop 事件（start 时挂上；server 常驻状态推过来即刷 UI） */
  private subscribe(): void {
    this.unsubscribe?.()
    this.unsubscribe = subscribeServerEvent('loop', (data) => {
      const s = data as LoopState
      if (s && typeof s === 'object' && 'status' in s) {
        this.lastState = s
        this.onState(s)
      }
    })
  }

  /**
   * 启动循环（服务端常驻）：POST /api/loop/start。
   * 间隔下限在服务端再抬一次（前端这里只传用户配的值 —— 两边同一条规则，
   *  见 loopMinIntervalSec / server runtime.startLoop）。
   *  startFrom：从第几步开始（下标，默认 0 = 第一步）—— UI 让用户挑起点。
   */
  async start(
    loop: LoopConfig,
    _slotSpecs?: (SlotSpec | null)[],
    _resumeIntervalMs?: number,
    startFrom?: number,
  ): Promise<void> {
    const steps = sanitizeLoopSteps(loop.loopSteps)
    if (steps.length === 0) {
      this.onState({ status: 'error', currentIdx: 0, rounds: 0, error: '循环步骤为空' } as LoopState)
      return
    }
    const minSec = loopMinIntervalSec(steps)
    const intervalSec = Math.max(loop.loopInterval || minSec, minSec)
    // 起点：默认第一步；超界/负数由服务端收口回 [0, steps.length)
    const rawStart = Math.floor(startFrom ?? 0)
    this.subscribe()
    try {
      const state = await api.startLoop({
        steps: steps as (number | LoopSource)[],
        intervalSec,
        startFrom: Number.isFinite(rawStart) ? rawStart : undefined,
        city: loop.loopCity,
        galleryTheme: loop.loopGalleryTheme,
        userGalleryName: loop.loopUserGalleryName,
        frames: loop.loopFrames ? [...loop.loopFrames] : undefined,
        weatherRefreshMin: loop.loopWeatherRefreshMin,
      })
      this.lastState = state
      this.onState(state)
    } catch (err) {
      this.onState({
        status: 'error',
        currentIdx: 0,
        rounds: 0,
        error: err instanceof Error ? err.message : String(err),
      } as LoopState)
    }
  }

  /** 停止循环（服务端停 timer；状态由 SSE loop 事件回推） */
  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    try {
      const state = await api.stopLoop()
      this.lastState = state
      this.onState(state)
    } catch {
      /* 服务未起/网络抖动：本地状态已停（下次 start 会重新拉） */
    }
  }

  /** 只摘 SSE 订阅、不停服务端循环（组件卸载用 —— 常驻语义：关页面 ≠ 停轮播） */
  stopDetach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** 拉一次当前状态（页面挂载时对齐 server 常驻循环 —— 页面关掉期间它照跑） */
  async refresh(): Promise<LoopState | null> {
    try {
      const state = await api.getLoopState()
      this.lastState = state
      this.onState(state)
      // 常驻循环在跑：挂上 SSE 订阅跟着刷（页面开着就能看到轮数/最近动作滚动）
      if (state.status === 'running' || state.status === 'paused') this.subscribe()
      return state
    } catch {
      return null
    }
  }

  /** 兼容旧调用点（sync 版 start）：内部异步化，调用方不 await 也不丢状态 */
  startSync(loop: LoopConfig, slotSpecs?: (SlotSpec | null)[], resumeIntervalMs?: number, startFrom?: number): void {
    void this.start(loop, slotSpecs, resumeIntervalMs, startFrom)
  }
}
