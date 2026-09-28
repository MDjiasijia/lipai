/**
 * 轮播循环的共享类型与清洗（移植自上游扩展版 shared/index.ts）。
 *
 * 本地版轮播常驻服务端（POST /api/loop/*，页面关掉照跑）—— 前端这份只做
 * 步骤编辑与清洗（UI 写进 profile.loop，启动时整包发给服务端）。
 * 用量/额度系（usage / credit / usage-credit）已整体剔除：LOOP_SOURCES 保留成员名
 * 兼容旧配方（清洗不剔 —— 存量配置读了不崩），服务端轮到它返回空池跳到下一步。
 * 清洗规则不变：不在 LOOP_SOURCES 里的源名静默剔掉（历史遗留字段防脏数据）。
 */

/** 内容来源（完整联合，与分享文件 SlotSource 对齐；服务端常驻版取数见 server/lib/loop.ts） */
export type LoopSource =
  | 'weather'
  | 'gallery'
  | 'user-gallery'
  | 'frames'
  | 'usage'
  | 'credit'
  | 'usage-credit'
  | 'datafeed'

/** 循环能实际取数的内容源（用量/额度系保留成员名兼容旧配方；服务端轮到它返回空池跳过）。
 *  datafeed = 自定义接口：推哪个槽位走该槽位配方里引用的数据源定义。 */
export const LOOP_SOURCES: readonly LoopSource[] = [
  'weather',
  'usage-credit',
  'usage',
  'credit',
  'gallery',
  'user-gallery',
  'frames',
  'datafeed',
] as const

/**
 * 循环里的一步 —— 两类，代价差三个数量级：
 * - 数字 0-3：切到该槽位显示现有内容（毫秒级）
 * - 内容源名：现取数据渲一套图推到槽位（蓝牙 10-20 秒）
 */
export type LoopStep = number | LoopSource

/** 这一步是切槽位（而不是推内容）吗 */
export function isSlotStep(step: LoopStep): step is number {
  return typeof step === 'number'
}

/** 这一步要走蓝牙推图吗（= 慢步骤，决定间隔下限） */
export function loopStepPushesImages(step: LoopStep): boolean {
  return !isSlotStep(step)
}

/**
 * 清洗步骤列表：剔非法值（槽位 0-3、源名须在 LOOP_SOURCES）、去重、保持给定顺序。
 * 顺序不归一化 —— 循环顺序是用户意图。用量/额度源已剔除，旧配置残留的
 * usage/credit 步骤在这里静默剔掉。
 */
export function sanitizeLoopSteps(steps: readonly unknown[] | null | undefined): LoopStep[] {
  const seen = new Set<string>()
  const out: LoopStep[] = []
  for (const raw of steps ?? []) {
    const step: LoopStep | null =
      typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3
        ? raw
        : typeof raw === 'string' && (LOOP_SOURCES as readonly string[]).includes(raw)
          ? (raw as LoopSource)
          : null
    if (step === null) continue
    if (seen.has(String(step))) continue // 同一步出现两次没意义（它自己就是循环的）
    seen.add(String(step))
    out.push(step)
  }
  return out
}

/**
 * 间隔下限（秒）：含推图步骤的循环，间隔不能比蓝牙传输本身还短（一套 6 张 10-20 秒）；
 * 纯切槽位毫秒级，下限 1 秒（可当逐帧动画用）。
 */
export const LOOP_MIN_SEC_PUSH = 30
export const LOOP_MIN_SEC_SWITCH = 1
