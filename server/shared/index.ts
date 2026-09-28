/**
 * 前后端共享常量与类型(平台无关)。
 */
import type { SceneSchedule } from './profile-types.js';

export const EVENTS = {
    CONNECTION: 'connection',
    DEVICE_INFO: 'deviceInfo',
    LOG: 'log',
    IMAGE_PROGRESS: 'imageProgress',
    LOOP: 'loop',
    SCENE_SCHEDULE: 'sceneSchedule',
    SLOT_APPLY: 'slotApply',
  } as const;
/**
 * 设备蓝牙广播名的前缀。真名形如 `前缀_31C2C6` / `IPS_xxxxxx`。
 *
 * 用户能看到的只有**设备码**(连按设备按钮三下屏幕上显示的那串,如 `31C2C6`)——
 * 前缀是广播名的一部分,不在屏幕上。所以「按名字连接」必须容得下只填设备码:
 * 拿 `31C2C6` 去和 `前缀_31C2C6` 做全等比较,永远连不上(实测报「未找到匹配设备」)。
 */
export const DEVICE_NAME_PREFIXES = ['miHoYo', 'IPS'] as const;

/** 这串是完整广播名(带前缀)还是只是设备码?大小写不敏感。 */
export function isFullDeviceName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return DEVICE_NAME_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()));
}

/** 完整广播名 → 设备码(去掉 `前缀_`);已经是设备码就原样返回。给 UI 显示用。 */
export function deviceCodeOf(name: string): string {
  const trimmed = name.trim();
  for (const p of DEVICE_NAME_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(p.toLowerCase())) {
      return trimmed.slice(p.length).replace(/^[_-]/, '');
    }
  }
  return trimmed;
}

/**
 * 扫描到的设备里,哪一台是用户要的?
 *
 * 用户填的可能是设备码(`31c2c6`)也可能是完整名(`前缀_31C2C6`),
 * 大小写还不一定对得上。按「越精确越优先」找:全等 → 设备码相等 → 名字以它结尾 → 包含。
 * 找不到给 null,调用方负责报「扫到了这些、都不匹配」。
 */
export function matchDeviceByCode<T extends { name: string }>(
  devices: readonly T[],
  input: string,
): T | null {
  const want = input.trim().toLowerCase();
  if (!want) return null;
  const code = deviceCodeOf(want);
  const rules: ((n: string) => boolean)[] = [
    (n) => n === want,
    (n) => deviceCodeOf(n) === code,
    (n) => n.endsWith(want),
    (n) => n.includes(want),
  ];
  for (const rule of rules) {
    const hit = devices.find((d) => rule(d.name.trim().toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/** 设备信息(连接状态 + 读取到的设备元数据)。 */
export interface DeviceInfo {
  connected: boolean;
  name?: string;
  firmware?: string;
  hardware?: string;
  ip?: string;
  storage?: string;
  mac?: string;
  /** 设备实报的当前激活槽位(0-3)。来源:getClockStyle 响应解析 / setClockStyle·sendImage 后本地记录。 */
  clockStyle?: number;
}

/** 通信日志条目(后端 → webview 推送)。 */
export interface LogEntry {
  message: string;
  direction: 'in' | 'out' | 'system';
  ts: number;
}

/** 蓝牙传图长任务状态。 */
export type TransferStatus = 'running' | 'done' | 'error' | 'canceled';

export interface TransferProgress {
  taskId: string;
  status: TransferStatus;
  done: number;
  total: number;
  error?: string;
}

/**
 * 轮播循环的运行状态。`preparing` = 启动前正在给槽位预推图组;
 * `paused` = 设备断开时暂停(配置保留),重连后自动 resume。
 */
export type LoopStatus = 'running' | 'preparing' | 'paused' | 'stopped' | 'error';

/**
 * 循环里「现取数据推一套新图」能用的内容源。
 * 每个源每次轮到都重新取数(天气按新鲜度窗口、用量+额度按 5 分钟缓存),屏上是当下的数。
 */
export type LoopSource = 'frames' | 'weather' | 'gallery' | 'user-gallery' | 'usage-credit';

export const LOOP_SOURCES: readonly LoopSource[] = [
  'weather',
  'usage-credit',
  'gallery',
  'user-gallery',
  'frames',
];

/**
 * 循环里的一步 —— 只有两类,代价差三个数量级,所以在类型上就分开:
 *
 * - **数字 0-3**:切到该槽位,显示它**现有**的内容。一帧命令,毫秒级,不动槽位里的图
 *   (原「槽位轮换」= 全是数字步的循环)。
 * - **内容源名**:现取数据渲一整套图推到电子立牌槽位,走蓝牙 10-20 秒
 *   (原「定时推送」= 全是源步的循环)。
 *
 * 用「数字 or 源名」这个朴素形状而不是 `{kind,...}` 对象:存盘直接是
 * `["weather", 1, "usage-credit"]`,人打开 profile 文件就能看懂,前后端也不需要
 * 一层 parse/serialize —— 少一层就少一处两边对不齐的地方。
 *
 * 两类能混在同一个循环里,这正是把两个功能合成一个的意义:
 * 「天气 → 数字时钟 → 用量 → 电子立牌」是一条时间线,不该是两个互斥模式。
 */
export type LoopStep = number | LoopSource;

/** 这一步是切槽位(而不是推内容)吗。 */
export function isSlotStep(step: LoopStep): step is number {
  return typeof step === 'number';
}

/** 这一步要走蓝牙推图吗(= 慢步骤,决定间隔下限)。 */
export function loopStepPushesImages(step: LoopStep): boolean {
  return !isSlotStep(step);
}

/**
 * 清洗步骤列表:剔掉非法值(槽位只能 0-3、源名必须认得)、去重、保持给定顺序。
 * 顺序**不归一化** —— 循环顺序是用户的意图(先天气还是先时钟),不能替他排。
 * 前后端共用:后端不能相信 webview / AI 传来的数组。
 */
export function sanitizeLoopSteps(steps: readonly unknown[] | null | undefined): LoopStep[] {
  const seen = new Set<string>();
  const out: LoopStep[] = [];
  for (const raw of steps ?? []) {
    const step: LoopStep | null =
      typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3
        ? raw
        : typeof raw === 'string' && (LOOP_SOURCES as readonly string[]).includes(raw)
          ? (raw as LoopSource)
          : null;
    if (step === null) continue;
    // 数字与源名的字符串形态不会撞,String() 直接当 key 用
    if (seen.has(String(step))) continue; // 同一步出现两次没意义(它自己就是循环的)
    seen.add(String(step));
    out.push(step);
  }
  return out;
}

/**
 * 一套 6 张图走蓝牙要 10-20 秒,间隔不能比传输本身还短(否则下一轮追上上一轮)。
 * 纯切槽位是毫秒级,所以没有推图步骤时下限放到 1 秒(拿来当逐帧动画用)。
 */
const LOOP_MIN_SEC_PUSH = 30;
const LOOP_MIN_SEC_SWITCH = 1;

/**
 * 循环间隔下限(秒)。前后端共用一条规则,免得 UI 允许的值被后端偷偷抬高。
 *
 * 只跟「有没有推图的步骤」有关,**不再因为选了用量+额度就抬到 5 分钟** ——
 * 取数频率由取数层的缓存窗口管(用量 5 分钟、天气 60 秒),那是两件事:
 * 屏幕多久换一次 ≠ 多久打一次网络。绑在一起的后果是「想 30 秒换一次就得放弃用量卡」。
 */
export function loopMinIntervalSec(steps: readonly LoopStep[]): number {
  return steps.some(loopStepPushesImages) ? LOOP_MIN_SEC_PUSH : LOOP_MIN_SEC_SWITCH;
}

/** 轮播循环状态(webview 挂载时拉一次,之后走 EVENTS.LOOP 推)。 */
export interface LoopState {
  status: LoopStatus;
  /** 参与循环的步骤,按这个顺序轮。 */
  steps: LoopStep[];
  /** 下一轮轮到第几步(指向 steps)。 */
  currentIdx: number;
  /** 间隔(秒)。 */
  intervalSec: number;
  /** 已完成的轮数(推图和切槽位都算一轮)。 */
  rounds: number;
  /** 上一轮的时间戳(ms),0 = 还没跑过。 */
  lastRoundAt: number;
  /** 上一轮实际做了什么(运行状态里显示「刚才:切到数字时钟一」)。 */
  lastAction?: string;
  /** 上次错误(仅 status=error 时)。 */
  error?: string;
}

/**
 * 「应用一份配置」的进度:按序推多个槽位,一个槽位 1-2 分钟。
 * 单槽位内部的分包进度仍走 IMAGE_PROGRESS。
 */
export interface SlotApplyState {
  status: 'running' | 'done' | 'error';
  profileId: string;
  /** 要推的槽位总数。 */
  total: number;
  /** 已推完的槽位数。 */
  done: number;
  /** 当前正在推的槽位(done/error 时为最终激活槽位或 null)。 */
  currentSlot: number | null;
  error?: string;
}

export type Events = {
  [EVENTS.CONNECTION]: (p: {
    state: 'connected' | 'disconnected';
    detail: string;
    name?: string;
    /** 这次断开是否用户主动发起(手动断开 / 重置 / 停桥换新):前端别再显示「重连中」。 */
    userInitiated?: boolean;
  }) => void;
  [EVENTS.DEVICE_INFO]: (p: DeviceInfo) => void;
  [EVENTS.LOG]: (p: LogEntry) => void;
  [EVENTS.IMAGE_PROGRESS]: (p: TransferProgress) => void;
  [EVENTS.LOOP]: (p: LoopState) => void;
  [EVENTS.SCENE_SCHEDULE]: (p: SceneSchedule | null) => void;
  [EVENTS.SLOT_APPLY]: (p: SlotApplyState) => void;
};
