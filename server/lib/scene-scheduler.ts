/**
 * 场景日程触发器:按时刻表切换 profile(早 / 中 / 晚 多时段)。
 *
 * 与 startLoop(固定间隔的轮播)不同:本调度器按"时刻表"触发,而且换的是**一整套配置**
 * 而不是"屏上这一下显示什么" —— 所以没和轮播并成一个。
 *
 * ── 时段表模型(不是"闹钟"模型) ──
 * 每个 slot 只声明**开始时刻**;当前该激活谁 = 今天已开始的时段里最靠后的那个,
 * 一直持续到下一个时段开始(或 durationMin 用完)。每次 tick 都重新推算一遍再对齐,
 * 不依赖"恰好在那一分钟被叫醒"。
 *
 * 这样解决了旧实现的两个问题:
 * 1. 旧版只在 `slot.time === 当前 HH:MM` 那一分钟命中 —— 中途启动扩展什么都不会发生。
 * 2. 旧版用 restoreTimer 倒计时切回默认,且有 `!this.restoreTimer` 守卫:
 *    配了早/中/晚时,前一个时段的定时器会在后一个时段生效期间把设备切回默认。
 *    现在无定时器,纯推算 + 对齐,多时段互不干扰。
 *
 * 已知取舍:跨零点的时段(如 23:00 持续 120 分钟)在 00:00 结束 —— 按"当天"算,不跨日。
 */

import type { SceneSchedule, SceneSlot } from '../shared/profile-types.js';

/** 场景日程运行时状态。 */
export interface SceneScheduleState {
  status: 'running' | 'stopped' | 'error';
  schedule: SceneSchedule | null;
  /** 当前激活的时段 id,null=不在任何时段(用默认配置)。 */
  activeSlotId: string | null;
  /** 上次切换时间戳(ms)。 */
  lastTriggerAt: number;
  error?: string;
}

type Callbacks = {
  /** 进入某时段:把 slot.spec 渲成一套图推到电子立牌。 */
  onEnter: (slot: SceneSlot) => void;
  /** 离开时段(没有任何时段命中):切回默认时钟。 */
  onLeave: () => void;
};

/** "HH:MM" → 当天第几分钟;非法格式返回 -1。 */
function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return -1;
  const h = Number(m[1]),
    min = Number(m[2]);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

export class SceneScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeSlotId: string | null = null;
  private readonly state: SceneScheduleState = {
    status: 'stopped',
    schedule: null,
    activeSlotId: null,
    lastTriggerAt: 0,
  };
  private callbacks: Callbacks | null = null;

  start(schedule: SceneSchedule, callbacks: Callbacks): void {
    this.stop();
    this.state.schedule = schedule;
    this.callbacks = callbacks;
    this.state.status = 'running';
    this.state.error = undefined;
    // 30 秒对齐一次(纯推算,开销可忽略;比 60 秒切换更及时)
    this.timer = setInterval(() => this.tick(), 30_000);
    // 立即对齐:启动时若已处在某时段内,马上切过去
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.activeSlotId = null;
    this.state.status = 'stopped';
    this.state.activeSlotId = null;
  }

  getState(): SceneScheduleState {
    return { ...this.state, activeSlotId: this.activeSlotId };
  }

  /** 推算此刻应激活的时段(今天已开始的时段里最靠后的那个,未超过 durationMin)。 */
  private resolveActive(now: Date): SceneSlot | null {
    const schedule = this.state.schedule;
    if (!schedule) return null;
    const dow = now.getDay();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const slots = schedule.slots
      .filter((s) => s.enabled !== false)
      .filter((s) => !s.daysOfWeek?.length || s.daysOfWeek.includes(dow))
      .map((s) => ({ slot: s, start: toMinutes(s.time) }))
      .filter((x) => x.start >= 0)
      .sort((a, b) => a.start - b.start);

    let active: { slot: SceneSlot; start: number } | null = null;
    for (const x of slots) {
      if (x.start > nowMin) break;
      active = x;
    }
    if (!active) return null;
    // durationMin 用完就回默认,不等下一个时段
    if (active.slot.durationMin && nowMin >= active.start + active.slot.durationMin) return null;
    return active.slot;
  }

  private tick(): void {
    if (!this.state.schedule?.enabled || !this.callbacks) return;
    const desired = this.resolveActive(new Date());
    const desiredId = desired?.id ?? null;
    if (desiredId === this.activeSlotId) return;

    this.activeSlotId = desiredId;
    this.state.activeSlotId = desiredId;
    this.state.lastTriggerAt = Date.now();
    try {
      if (desired) this.callbacks.onEnter(desired);
      else this.callbacks.onLeave();
    } catch (e) {
      this.state.error = e instanceof Error ? e.message : String(e);
    }
  }
}

export const sceneScheduler = new SceneScheduler();
