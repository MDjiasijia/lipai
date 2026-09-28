/**
 * 轮播循环(原「定时推送」+「槽位轮换」合成一个)。
 *
 * ── 为什么是一个而不是两个 ──
 * 两边本来就是同一件事:固定间隔 + tick + 状态机 + 设备断连自停,区别只在「一轮做什么」。
 * 拆成两个互斥模式的后果是用户得先回答一个他不该关心的问题(「我这需求算轮换还是算推送?」),
 * 而且想要「天气 → 数字时钟 → 用量」这种混着来的时间线时,两个模式都做不到。
 *
 * ── 一轮做什么 ──
 * - `slot` 步:切到某个槽位,显示它**现有**的内容。一帧命令,毫秒级,不动槽位里的图。
 * - `source` 步:现取数据 → 渲一整套 6 张 → 推到电子立牌槽位(style 3),走蓝牙 10-20 秒。
 *   6 张是那个槽位的容量,推满后固件固定展示(不逐帧切换)。
 *
 * ── 内容没变就不重推 ──
 * source 步渲出来的图和设备上那套逐字节相同时(比如用量数据还在 5 分钟缓存窗口里),
 * 跳过传输、只切回电子立牌槽位。否则「间隔 30 秒 + 数据 5 分钟才变」= 每 30 秒白传 15 秒蓝牙,
 * 屏幕毫无变化。这也让「实时性不高的内容」自动退化成纯切样式,不需要用户去理解和选择。
 *
 * 依赖注入拿 device / emit,避免和 index.ts 循环依赖。
 */

import {
  isSlotStep,
  loopMinIntervalSec,
  sanitizeLoopSteps,
  type LoopSource,
  type LoopState,
  type LoopStep,
} from '../shared/index.js';
import { clampWeatherRefreshMin, slotCapacity, SLOT_STYLE_NAMES } from '../shared/profile-types.js';
import { IpsDevice } from './device.js';
import { renderCustomEmojiFrames, renderWeatherCards, randomGalleryImages } from './render.js';
import { padCards } from './canvas-kit.js';
import { getWeather, WEATHER_FRESH_MS } from './weather.js';
import { getUserGalleryFrames } from './gallery-store.js';
import { orderWeatherCards } from '../shared/weather-cards.js';

/** 电子立牌槽位:source 步推的就是它。 */
const SLOT = 3;
const SLOT_FRAMES = slotCapacity(SLOT);

/** 设备访问器(返回当前 device,可能 null)。 */
export interface DeviceAccessor {
  get(): IpsDevice | null;
}

/** 事件通道(emit 用)。 */
export interface EmitFns {
  emitLoop: (s: LoopState) => void;
  log: (message: string) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

export const loop: LoopState = {
  status: 'stopped',
  steps: ['weather'],
  currentIdx: 0,
  intervalSec: 30,
  rounds: 0,
  lastRoundAt: 0,
};

/**
 * 每个内容源「取到第几张了」的游标。
 *
 * 一轮要凑 6 张,一个源可能有 30 帧(图组)——游标让**下次轮到它时**接着往后取,
 * 于是同一个源每次轮到都出新内容。按源分开存:各源轮到的次数不同,共用一个下标会让每个源都跳着走。
 *
 * 只对**帧池型**的源有意义(字符序列 / 精美图库 / 我的图组:一堆等价的图,轮着放才有意思)。
 * **卡片型**的源(天气 / 用量+额度)在 `framesOf` 里就已经截到 6 张 —— 勾选和拖拽就是用户的
 * 选择,屏上是哪几张不该随时间变。于是那两个源的池子恰好 6 张,游标转一圈还是原来的顺序。
 */
const cursors = new Map<LoopSource, number>();

let cfgFrames: string[] = [];
let cfgCity = '上海';
let cfgGalleryTheme: 'anime' | 'animals' = 'anime';
let cfgUserGalleryName = '';
/** 天气卡片顺序(投屏页预览区拖拽排的语义 ID),省略 = 渲染定义顺序。 */
let cfgWeatherCardOrder: string[] = [];
/** 天气新鲜度窗口(毫秒),默认 1 小时。 */
let cfgWeatherRefreshMs = WEATHER_FRESH_MS;

export interface LoopConfigArgs {
  frames?: string[];
  city?: string;
  galleryTheme?: 'anime' | 'animals';
  userGalleryName?: string;
  // 用量/额度系参数(usagePreset/mixedHideMoney/mixed*)已随数据链移除。
  /** 天气卡片拖拽顺序(语义 ID 列表);空/省略 = 渲染定义顺序。 */
  weatherCardOrder?: string[];
  /** 天气数据刷新间隔(分钟,30–240,默认 60)。 */
  weatherRefreshMin?: number;
}

/** 设置内容源配置(startLoop 调用)。 */
export function setLoopConfig(cfg: LoopConfigArgs): void {
  if (cfg.frames !== undefined) {
    cfgFrames = cfg.frames;
    cursors.delete('frames');
  }
  if (cfg.city !== undefined) cfgCity = cfg.city;
  if (cfg.galleryTheme !== undefined) cfgGalleryTheme = cfg.galleryTheme;
  if (cfg.userGalleryName !== undefined) cfgUserGalleryName = cfg.userGalleryName;
  if (cfg.weatherCardOrder !== undefined) cfgWeatherCardOrder = [...cfg.weatherCardOrder];
  if (cfg.weatherRefreshMin !== undefined) {
    cfgWeatherRefreshMs = clampWeatherRefreshMin(cfg.weatherRefreshMin) * 60 * 1000;
  }
}

/** 从某源的帧池里取下一张,并推进该源的游标(池子短就循环取)。 */
function takeNext(src: LoopSource, pool: Uint8Array[]): Uint8Array | undefined {
  if (!pool.length) return undefined;
  const i = cursors.get(src) ?? 0;
  cursors.set(src, i + 1);
  return pool[i % pool.length];
}

/**
 * 某个内容源当前能提供的**全部**帧(本轮的取帧池)。
 *
 * 取数走各自的**新鲜度窗口**而不是每轮强制重取:天气默认 1 小时(可配 30–240 分钟)。
 * 窗口内复用缓存,窗口外才打网络 —— 于是「屏幕多久换一次」和「多久打一次网络」解耦。
 *
 * 取不到就给空池子,调用方会跳到下一步(用量/额度系源已移除,永远空池)。
 */
async function framesOf(src: LoopSource): Promise<Uint8Array[]> {
  if (src === 'frames') {
    return renderCustomEmojiFrames(cfgFrames.length ? cfgFrames : ['⭐'], '霓虹蓝');
  }
  if (src === 'weather') {
    try {
      const result = await getWeather(cfgCity, { maxAgeMs: cfgWeatherRefreshMs });
      // 和预览(getWeatherCards)对齐:同一份带语义 ID 的卡,同一份拖拽顺序,同样取前 6 张
      // —— 屏上就是预览里没灰掉的那 6 张,每一轮都是。
      //
      // 天气**不轮换**(和图组那种「30 帧分几轮放完」不同):用户拖出来的顺序就是他的选择,
      // 想看降水/日照把它拖进前 6 就行。让第 7、8 张轮到下一轮换上来只会让「屏上现在是哪几张」
      // 变成时间的函数 —— 拖拽的确定性没了,预览也不再等于屏幕。
      //
      // **不去重**:去重会丢掉补位概览卡,让下标错位、第 6 位和预览第 6 位不是同一张。
      const cards = orderWeatherCards(renderWeatherCards(result), cfgWeatherCardOrder);
      return cards.slice(0, SLOT_FRAMES).map((c) => c.image);
    } catch {
      return []; // 天气查不到(网络抖动)就这轮少它一步,下轮自然重试
    }
  }
  if (src === 'user-gallery') {
    if (!cfgUserGalleryName) return [];
    const b64s = await getUserGalleryFrames(cfgUserGalleryName).catch(() => []);
    return b64s.map((b) => Uint8Array.from(Buffer.from(b, 'base64')));
  }
  if (src === 'usage-credit') {
    // 用量/额度链(内部 AI 平台)已整体移除。成员名保留在 LoopSource 里
    // 兼容旧配方:轮到它就返回空池,nextRound 顺延到下一步。
    return [];
  }
  // 精美图库:每轮现随机一批
  return randomGalleryImages(SLOT_FRAMES, cfgGalleryTheme);
}

/** 槽位可读名(日志 / lastAction 用)。 */
const slotName = (slot: number): string => SLOT_STYLE_NAMES[slot] ?? `槽位 ${slot}`;

/** 本轮要做的事。 */
type Round =
  | { kind: 'slot'; slot: number }
  | { kind: 'push'; images: Uint8Array[]; source: LoopSource };

/**
 * 决定本轮做什么,并推进「轮到第几步」。
 *
 * 某一步没内容(图组没选 / 天气查失败)就顺延到下一步,最多试一圈;
 * 全都没内容时给一张说明卡,别推空。
 */
async function nextRound(): Promise<Round> {
  const steps: LoopStep[] = loop.steps.length ? loop.steps : ['gallery'];
  const start = loop.currentIdx % steps.length;
  // 只前进一格(不管这轮实际用了哪一步),所以下一轮稳定落到下一步
  loop.currentIdx = (start + 1) % steps.length;
  const order = steps.map((_, i) => steps[(start + i) % steps.length]!);
  for (const step of order) {
    if (isSlotStep(step)) return { kind: 'slot', slot: step };
    // oxlint-disable-next-line no-await-in-loop -- 顺延:只有上一步空了才会再取一次
    const pool = await framesOf(step);
    if (!pool.length) continue;
    const out: Uint8Array[] = [];
    for (let i = 0; i < SLOT_FRAMES; i++) {
      const img = takeNext(step, pool);
      if (img) out.push(img);
    }
    // 一定凑满 6 张:少推的帧位会**留着上一套的旧图**,固件照样展示它,
    // 屏上就成了「新内容和几分钟前的旧内容交替出现」。
    return { kind: 'push', images: padCards(out, SLOT_FRAMES), source: step };
  }
  // 全都没内容时给一张说明卡,别推空(错误卡渲染器已随用量/额度链移除)。
  return {
    kind: 'push',
    images: await renderCustomEmojiFrames(['⚠️ 所选内容都没有可推的东西'], '霓虹蓝'),
    source: 'gallery',
  };
}

/** 上一轮还在传就跳过这一轮:6 张走蓝牙要 10-20 秒,重入会把写队列搅乱。 */
let busy = false;

/**
 * 暂停(不断连自停):设备断开时停 timer 但保住 steps/interval/游标等全部运行配置,
 * 重连后 resumeLoop 按**原样**续播。
 *
 * 旧版断连即 `stopLoop()` + status='error' 永久停止,自动重连成功后没人把循环拉回来
 * —— 用户看到的就是「跨天之后断连了,轮播也停了,得手动再点一次启动」(日志实锤:
 * 重连成功 846 次,轮播一次都没自己回来)。pause/resume 让「设备在」和「循环在」解耦。
 */
export function pauseLoop(reason = '设备未连接'): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // 只从运行态暂停;已经停了就别把 stopped 覆盖掉(用户手点停止 ≠ 断连暂停)
  if (loop.status === 'running' || loop.status === 'preparing') {
    loop.status = 'paused';
    loop.error = reason;
  }
}

/**
 * 恢复此前暂停的循环(自动重连成功后调)。
 *
 * 只认 paused:用户手动停过(stopped)就不擅自拉起,新启动走 startLoop。
 * 暂停时配置原封没动,直接用留下的 timer 配置重启 —— 游标也留着,
 * 恢复后从暂停前轮到的那一步接着走。
 */
export function resumeLoop(dev: DeviceAccessor, emit: EmitFns): boolean {
  if (loop.status !== 'paused') return false;
  loop.status = 'running';
  loop.error = undefined;
  emit.emitLoop({ ...loop });
  tick(dev, emit);
  timer = setInterval(() => tick(dev, emit), loop.intervalSec * 1000);
  emit.log('轮播:设备已重连,从暂停处继续。');
  return true;
}

/** 一轮:切槽位,或推一套图(内容没变则退化成切回电子立牌)。 */
function tick(dev: DeviceAccessor, emit: EmitFns): void {
  const device = dev.get();
  if (!device?.connected) {
    pauseLoop('设备未连接');
    emit.emitLoop({ ...loop });
    emit.log('轮播:设备未连接,已暂停(重连后自动继续)。');
    return;
  }
  if (busy) {
    emit.log('轮播:上一轮还在传,跳过这一轮(把间隔调大一点)。');
    return;
  }
  busy = true;
  nextRound()
    .then(async (round) => {
      if (round.kind === 'slot') {
        await device.setClockStyle(round.slot);
        return `切到「${slotName(round.slot)}」`;
      }
      // 和设备上现有那套逐字节相同 → 只切回电子立牌,省掉 10-20 秒白传
      if (device.imageKeyOf(SLOT) === IpsDevice.imageKey(round.images)) {
        await device.setClockStyle(SLOT);
        return `内容没变,只切回「${slotName(SLOT)}」(跳过重传)`;
      }
      await device.sendImage(round.images, SLOT, () => {
        /* 轮播不占用前台传输进度条 */
      });
      return `推了一套 ${round.images.length} 张到「${slotName(SLOT)}」`;
    })
    .then((action) => {
      loop.rounds += 1;
      loop.lastRoundAt = Date.now();
      loop.lastAction = action;
      loop.error = undefined;
      emit.emitLoop({ ...loop });
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      loop.error = msg;
      emit.emitLoop({ ...loop });
      emit.log(`轮播失败:${msg}`);
    })
    .finally(() => {
      busy = false;
    });
}

export function stopLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  loop.status = 'stopped';
}

/**
 * 启动循环。
 *
 * @param args.steps 参与循环的步骤(至少一个)
 * @param args.intervalSec 间隔,低于 `loopMinIntervalSec(steps)` 会被抬上去
 * @param args.startFrom 从第几步开始(下标,默认 0 = 第一步)。UI 让用户挑起点
 *   (比如「先看用量再看天气」),超界/负数都会收口回合法范围 —— 后端对 UI 值保持宽容。
 * @param prepare 可选的启动前准备(给槽位预推图组)。有它时先进 `preparing` 状态,
 *   跑完才开始计时 —— 预推要 1-2 分钟,期间 UI 要能说清楚「在干什么」。
 */
export function startLoop(
  dev: DeviceAccessor,
  emit: EmitFns,
  args: { steps: LoopStep[]; intervalSec: number; startFrom?: number } & LoopConfigArgs,
  prepare?: () => Promise<void>,
): LoopState {
  setLoopConfig(args);
  stopLoop();
  // 游标归零:重新启动就该从每个源的第一张开始
  cursors.clear();
  loop.steps = sanitizeLoopSteps(args.steps);
  // 起点:默认第一步;收口到 [0, steps.length),勾选变了 / 传脏值都不能让 currentIdx 指空
  const stepsLen = Math.max(1, loop.steps.length);
  const rawStart = Math.floor(args.startFrom ?? 0);
  loop.currentIdx = (((Number.isFinite(rawStart) ? rawStart : 0) % stepsLen) + stepsLen) % stepsLen;
  loop.intervalSec = Math.max(loopMinIntervalSec(loop.steps), Math.floor(args.intervalSec));
  loop.rounds = 0;
  loop.lastRoundAt = 0;
  loop.lastAction = undefined;
  loop.error = undefined;

  const begin = (): void => {
    loop.status = 'running';
    emit.emitLoop({ ...loop });
    tick(dev, emit);
    timer = setInterval(() => tick(dev, emit), loop.intervalSec * 1000);
  };

  if (!prepare) {
    begin();
    return { ...loop };
  }
  loop.status = 'preparing';
  prepare()
    .then(() => {
      // 预推期间用户点了停止 / 设备断了 —— 别硬把循环拉起来
      if (loop.status !== 'preparing') return;
      begin();
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      loop.status = 'error';
      loop.error = msg;
      emit.emitLoop({ ...loop });
      emit.log(`轮播:预推图组失败,未启动(${msg})`);
    });
  return { ...loop };
}

export function getLoopState(): LoopState {
  return { ...loop };
}

/** 步骤列表 → 一行可读描述(日志用:「现查的天气卡 → 数字时钟一 → 现取的用量+额度卡」)。 */
export function describeSteps(steps: readonly LoopStep[]): string {
  return steps.map((s) => (isSlotStep(s) ? slotName(s) : LOOP_SOURCE_LABELS[s])).join(' → ');
}

/** 内容源的可读名(日志用,别把 'usage-credit' 这种 id 直接给用户看)。 */
export const LOOP_SOURCE_LABELS: Record<LoopSource, string> = {
  frames: '字符序列',
  weather: '现查的天气卡',
  gallery: '精美图库',
  'user-gallery': '我的图组',
  'usage-credit': '现取的用量+额度卡',
};
