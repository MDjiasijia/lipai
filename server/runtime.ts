/**
 * 服务端设备运行时:持有 BleBridge + IpsDevice + 自动重连 + 常驻自动化。
 *
 * 事件走「事件总线 + SSE」—— emitXxx 既进 logBuffer,也广播给所有 SSE 订阅者
 * (见 events.ts)。
 *
 * 与扩展版的差异:
 * - deactivated 语义 → 服务进程生命周期(测试/优雅停机用)。
 * - 自动重连开关 + 上次设备名持久化在 ~/.lipai/config.json(profile-store)。
 * - 页面关掉不再有「事件丢失」问题:SSE 断了重连后从头拉 logBuffer 尾部。
 */
import {
  EVENTS,
  sanitizeLoopSteps,
  type DeviceInfo,
  type LoopSource,
  type SlotApplyState,
  type LoopState,
} from './shared/index.js';
import {
  type DisplayProfile,
  type SceneSchedule,
  type SceneSlot,
} from './shared/profile-types.js';
import { BleBridge } from './lib/ble-bridge.js';
import { IpsDevice, type LogDirection } from './lib/device.js';
import {
  assertBleBridgePathAllowed,
  bleBridgeBinaryPath,
  killOrphanBleBridges,
  verifyBinarySha256,
} from './lib/binary-runtime.js';
import {
  readConnectSettings,
  setAutoConnect as persistAutoConnect,
  setLastDeviceName,
  getCurrentProfile,
  readSceneSchedule,
  setSceneSchedule as persistSceneSchedule,
} from './lib/profile-store.js';
import { sceneScheduler } from './lib/scene-scheduler.js';
import {
  startLoop as startLoopImpl,
  stopLoop as stopLoopImpl,
  resumeLoop as resumeLoopImpl,
  getLoopState as getLoopStateImpl,
  type DeviceAccessor,
  type EmitFns,
} from './lib/loop.js';
import { emit, logBuffer, LOG_BUFFER_MAX } from './events.js';
import { renderSlotForDevice, applyDeviceControl } from './device-control.js';

let bridge: BleBridge | null = null;
let device: IpsDevice | null = null;
let shuttingDown = false;

/* ---------------- 日志 / 事件 ---------------- */
export function emitLog(message: string, direction: LogDirection = 'system'): void {
  const entry = { message, direction, ts: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  emit(EVENTS.LOG, entry);
}

function emitInfo(info: DeviceInfo): void {
  emit(EVENTS.DEVICE_INFO, info);
}

/* ---------------- 自动重连(从 ext index.ts 平移,代号机制完整保留) ----------------
 * 设备 GATT 断开(超出范围/断电/信号差)后自动重连到上次设备。
 * 开关 + 上次设备名存 ~/.lipai/config.json。退避 5s → 10s → 20s → 30s 封顶。
 * 手动连接优先级最高:cancelAutoReconnect 让在飞的那次安静退出。
 */
let autoConnectEnabled = true;
let lastDeviceName: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let reconnectAttempt = 0;
/** 重连代号:每次「取消重连」都 +1;在飞的重连每步比对,变了就安静退出(防僵尸循环)。 */
let connectGeneration = 0;
let userInitiatedDisconnect = false;
let connecting = false;
const RECONNECT_DELAYS = [5, 10, 20, 30];

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cancelAutoReconnect(): void {
  clearReconnect();
  connectGeneration += 1;
  reconnecting = false;
  reconnectAttempt = 0;
}

async function attemptReconnect(): Promise<void> {
  if (shuttingDown) return;
  if (reconnecting) return;
  if (!autoConnectEnabled || !lastDeviceName) return;
  if (device?.connected) {
    reconnectAttempt = 0;
    return;
  }
  reconnecting = true;
  const gen = connectGeneration;
  const cancelled = () =>
    shuttingDown || gen !== connectGeneration || !autoConnectEnabled || !lastDeviceName;
  const attempt = reconnectAttempt + 1;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 30;
  emitLog(`自动重连中(第 ${attempt} 次,${delay}s 后重试)…`);
  try {
    if (device?.connected) {
      await device.disconnect().catch(() => null);
    }
    if (bridge?.running) {
      await bridge.stop().catch(() => null);
      device = null;
    }
    if (cancelled()) return;
    const dev = await ensureBridge();
    if (cancelled()) return;
    if (device?.connected) {
      reconnectAttempt = 0;
      return;
    }
    // 重连用短扫描(5s):扫不到快点失败,别长扫描占着蓝牙。
    await dev.connect({ name: lastDeviceName, scanTimeout: 5 });
    if (cancelled()) return;
    await setLastDeviceName(lastDeviceName);
    reconnectAttempt = 0;
    emitLog(`已自动重连 ${lastDeviceName}。`);
    await dev.readStatus().catch(() => null);
    // 断电/重启正是设备丢参数的时刻:按存档恢复 + 拉回自动化。
    void restoreDeviceControlOnConnect(dev).catch(() => null);
    resumeAutomationAfterConnect();
  } catch (err) {
    if (cancelled()) return;
    const msg = err instanceof Error ? err.message : String(err);
    emitLog(`自动重连失败:${msg}`);
    reconnectAttempt += 1;
    scheduleReconnect();
  } finally {
    if (gen === connectGeneration) reconnecting = false;
  }
}

function scheduleReconnect(): void {
  if (shuttingDown) return;
  if (!autoConnectEnabled || !lastDeviceName) return;
  clearReconnect();
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 30;
  reconnectTimer = setTimeout(() => {
    void attemptReconnect();
  }, delay * 1000);
}

function onConnectionChange(state: 'connected' | 'disconnected', userInitiated = false): void {
  if (shuttingDown) return;
  if (state === 'connected') {
    clearReconnect();
    reconnectAttempt = 0;
    reconnecting = false;
    userInitiatedDisconnect = false;
    return;
  }
  if (userInitiated) {
    userInitiatedDisconnect = false;
    return;
  }
  if (userInitiatedDisconnect) {
    userInitiatedDisconnect = false;
    return;
  }
  if (reconnecting) return; // 重连自换进程产生的断开,不是真掉线
  if (autoConnectEnabled && lastDeviceName) scheduleReconnect();
}

function emitConnection(
  state: 'connected' | 'disconnected',
  detail: string,
  userInitiated = false,
): void {
  emit(EVENTS.CONNECTION, {
    state,
    detail,
    name: device?.getInfo().name,
    userInitiated,
  });
  onConnectionChange(state, userInitiated);
}

/* ---------------- 自动化恢复(重连成功后) ---------------- */
function resumeAutomationAfterConnect(): void {
  if (resumeLoopImpl(deviceAccessor, emitFns)) {
    emitLog('轮播:设备已重连,从暂停处继续。');
  }
  if (sceneScheduler.getState().status !== 'running' && persistedSchedule?.enabled) {
    startPersistedSceneSchedule('重连');
  }
}

const deviceAccessor: DeviceAccessor = { get: () => device };
const emitFns: EmitFns = {
  emitLoop: (s: LoopState) => emit(EVENTS.LOOP, s),
  log: (m: string) => emitLog(m, 'system'),
};

/* ---------------- 场景日程:到点推图的并发守卫 + 持久化 ---------------- */
let sceneBusy = false;
let pendingSlot: SceneSlot | null = null;
let persistedSchedule: SceneSchedule | null = null;

async function pushSceneSpec(slot: SceneSlot): Promise<void> {
  if (!slot.spec) {
    // 只声明时段没有内容:切回默认时钟(时段表语义)。
    await device?.setClockStyle(0).catch(() => null);
    emitLog(`场景「${slot.label ?? slot.id}」:无内容配方,切回默认时钟。`);
    return;
  }
  const images = await renderSlotForDevice(slot.spec);
  if (!images.length) {
    emitLog(`场景「${slot.label ?? slot.id}」:内容没有可推的东西,跳过。`);
    return;
  }
  await device?.sendImage(images, 3);
  emitLog(`场景「${slot.label ?? slot.id}」:已推 ${images.length} 张到电子立牌。`);
}

async function onSceneEnter(slot: SceneSlot): Promise<void> {
  if (!device?.connected) return;
  if (sceneBusy) {
    // 上一时段没推完:存进 pendingSlot,推完在 finally 里接着推(守卫语义见 ext 注释)。
    pendingSlot = slot;
    return;
  }
  sceneBusy = true;
  try {
    await pushSceneSpec(slot);
    if (pendingSlot) {
      const next = pendingSlot;
      pendingSlot = null;
      await pushSceneSpec(next);
    }
  } catch (err) {
    emitLog(`场景推图失败:${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sceneBusy = false;
  }
}

async function onSceneLeave(): Promise<void> {
  await device?.setClockStyle(0).catch(() => null);
}

function startPersistedSceneSchedule(reason: string): void {
  if (!persistedSchedule?.enabled) return;
  sceneScheduler.start(persistedSchedule, {
    onEnter: (slot) => void onSceneEnter(slot),
    onLeave: () => void onSceneLeave(),
  });
  emitLog(`场景日程已启动(${reason}),共 ${persistedSchedule.slots.length} 个时段。`);
  emit(EVENTS.SCENE_SCHEDULE, {
    schedule: persistedSchedule,
    state: sceneScheduler.getState(),
  });
}

/* ---------------- 桥生命周期 ---------------- */
async function ensureBridge(): Promise<IpsDevice> {
  if (device && bridge?.running) return device;
  if (bridge?.running) {
    // bridge 活着但 device 丢了(异常路径):重建 device 绑定。
    device = makeDevice(bridge);
    return device;
  }
  const binaryPath = bleBridgeBinaryPath();
  assertBleBridgePathAllowed(binaryPath);
  const shaErr = verifyBinarySha256(binaryPath);
  if (shaErr) throw new Error(shaErr);
  // 连接/扫描前扫一遍孤儿(只杀能证明是孤儿的,见 binary-runtime 注释)。
  await killOrphanBleBridges({
    ownBinaryPath: binaryPath,
    excludePids: bridge?.pid ? [bridge.pid] : [],
  });
  bridge = new BleBridge(binaryPath, consoleLogger);
  await bridge.start();
  device = makeDevice(bridge);
  return device;
}

function makeDevice(b: BleBridge): IpsDevice {
  return new IpsDevice(
    b,
    (message, direction) => emitLog(message, direction),
    (info) => emitInfo(info),
    (state, detail, userInitiated) => emitConnection(state, detail, userInitiated),
  );
}

/** console 版 LoggerLike(ble-bridge 构造需要;人类可读单行)。 */
const consoleLogger = {
  info: (data: Record<string, unknown>, msg?: string) =>
    console.log(`[ble-bridge] ${msg ?? ''}`, JSON.stringify(data)),
  warn: (data: Record<string, unknown>, msg?: string) =>
    console.warn(`[ble-bridge] ${msg ?? ''}`, JSON.stringify(data)),
};

export function bridgeStatus(): { binary: string; bridgeRunning: boolean } {
  return {
    binary: bleBridgeBinaryPath(),
    bridgeRunning: Boolean(bridge?.running),
  };
}

export function getDevice(): IpsDevice | null {
  return device;
}

/* ---------------- 连接 API(路由层调用) ---------------- */
export async function connectDevice(options: {
  address?: string;
  name?: string;
  autoConnect?: boolean;
}): Promise<DeviceInfo> {
  if (connecting) throw new Error('已有一次连接在进行中');
  connecting = true;
  cancelAutoReconnect();
  try {
    const dev = await ensureBridge();
    await dev.connect(options);
    await setLastDeviceName(dev.getInfo().name ?? options.name ?? null);
    lastDeviceName = dev.getInfo().name ?? null;
    if (options.autoConnect !== undefined) {
      autoConnectEnabled = options.autoConnect;
      await persistAutoConnect(options.autoConnect);
    }
    await dev.readStatus().catch(() => null);
    await restoreDeviceControlOnConnect(dev).catch(() => null);
    resumeAutomationAfterConnect();
    return dev.getInfo();
  } finally {
    connecting = false;
  }
}

export async function disconnectDevice(userInitiated = true): Promise<void> {
  if (userInitiated) {
    userInitiatedDisconnect = true;
    cancelAutoReconnect();
    clearReconnect();
  }
  if (!device) return;
  await device.disconnect(userInitiated);
  if (userInitiated) lastDeviceName = device.getInfo().name ?? lastDeviceName;
}

export async function scanDevices(): Promise<{ name: string; address: string }[]> {
  const dev = await ensureBridge();
  return dev.listDevices();
}

export async function resetBluetooth(): Promise<void> {
  cancelAutoReconnect();
  clearReconnect();
  if (bridge?.running) await bridge.stop().catch(() => null);
  bridge = null;
  device = null;
  // 杀孤儿桥 + 重建。
  await killOrphanBleBridges({ ownBinaryPath: bleBridgeBinaryPath() });
  emitLog('蓝牙栈已重置。');
}

/** 手动触发一次重连(启动时「设备在就秒连」用;不影响退避状态)。 */
export async function tryReconnectNow(): Promise<void> {
  if (device?.connected || !lastDeviceName || !autoConnectEnabled) return;
  await attemptReconnect();
}

/** 自动重连当前状态(连接工具 get_connection 用)。 */
export function autoConnectStatus(): { enabled: boolean; lastDeviceName: string | null } {
  return { enabled: autoConnectEnabled, lastDeviceName };
}

export async function setAutoConnectEnabled(enabled: boolean): Promise<void> {
  autoConnectEnabled = enabled;
  await persistAutoConnect(enabled);
  if (enabled && !device?.connected && lastDeviceName) scheduleReconnect();
  else if (!enabled) clearReconnect();
}

export async function readAutoConnectSettings(): Promise<{
  autoConnect: boolean;
  lastDeviceName: string | null;
}> {
  const cfg = await readConnectSettings();
  autoConnectEnabled = cfg.autoConnect;
  lastDeviceName = cfg.lastDeviceName;
  return cfg;
}

/* ---------------- 设备参数恢复(连上即按存档下发) ---------------- */
async function restoreDeviceControlOnConnect(dev: IpsDevice): Promise<void> {
  const profile = await getCurrentProfile();
  if (!profile?.deviceControl) return;
  await applyDeviceControl(dev, profile.deviceControl).catch((err) => {
    emitLog(`恢复设备参数失败:${err instanceof Error ? err.message : String(err)}`);
  });
}

/* ---------------- 轮播 API ---------------- */
export function startLoop(args: {
  steps: (number | LoopSource)[];
  intervalSec: number;
  startFrom?: number;
  city?: string;
  galleryTheme?: 'anime' | 'animals';
  userGalleryName?: string;
  frames?: string[];
  weatherCardOrder?: string[];
  weatherRefreshMin?: number;
}): LoopState {
  const steps = sanitizeLoopSteps(args.steps);
  return startLoopImpl(deviceAccessor, emitFns, {
    ...args,
    steps,
    intervalSec: Math.max(
      steps.some((s) => typeof s !== 'number') ? 30 : 1,
      Math.floor(args.intervalSec),
    ),
  });
}

export function stopLoop(): LoopState {
  stopLoopImpl();
  return getLoopStateImpl();
}

export function getLoopState(): LoopState {
  return getLoopStateImpl();
}

/** 服务启动时按存档拉起常驻自动化(页面没开也照跑)。 */
export async function resumePersistedAutomation(): Promise<void> {
  persistedSchedule = await readSceneSchedule();
  if (persistedSchedule?.enabled) startPersistedSceneSchedule('启动');
  // 轮播不自动拉起(它是用户显式启动的);场景日程是「配置了就该生效」的。
}

export async function updateSceneSchedule(schedule: SceneSchedule): Promise<void> {
  await persistSceneSchedule(schedule);
  persistedSchedule = schedule;
  if (schedule.enabled) startPersistedSceneSchedule('更新');
  else {
    sceneScheduler.stop();
    emit(EVENTS.SCENE_SCHEDULE, { schedule, state: sceneScheduler.getState() });
  }
}

export function sceneState(): {
  schedule: SceneSchedule | null;
  state: ReturnType<typeof sceneScheduler.getState>;
} {
  return { schedule: persistedSchedule, state: sceneScheduler.getState() };
}

/* ---------------- 传图进度事件(MCP 后台任务用) ---------------- */
export function reportImageProgress(p: {
  taskId: string;
  status: 'running' | 'done' | 'error' | 'canceled';
  done: number;
  total: number;
  error?: string;
}): void {
  emit(EVENTS.IMAGE_PROGRESS, p);
}

/* ---------------- 应用一份配置(逐槽推送) ---------------- */
export async function applyProfileToDevice(
  profile: DisplayProfile,
): Promise<SlotApplyState> {
  const total = (profile.slots ?? []).filter((s) => s).length;
  const state: SlotApplyState = {
    status: 'running',
    profileId: profile.id,
    total,
    done: 0,
    currentSlot: null,
  };
  emit(EVENTS.SLOT_APPLY, { ...state });
  let done = 0;
  let lastSlot: number | null = null;
  for (const [slot, spec] of (profile.slots ?? []).entries()) {
    if (!spec) continue;
    state.currentSlot = slot;
    emit(EVENTS.SLOT_APPLY, { ...state, currentSlot: slot });
    const images = await renderSlotForDevice(spec);
    if (images.length) {
      await device?.sendImage(images, slot);
      lastSlot = slot;
    }
    done += 1;
    state.done = done;
    emit(EVENTS.SLOT_APPLY, { ...state });
  }
  if (profile.deviceControl) {
    await applyDeviceControl(device, profile.deviceControl, lastSlot ?? undefined).catch(() => null);
  }
  state.status = 'done';
  state.currentSlot = lastSlot;
  emit(EVENTS.SLOT_APPLY, { ...state });
  return state;
}

/* ---------------- 优雅停机 ---------------- */
export async function shutdown(): Promise<void> {
  shuttingDown = true;
  cancelAutoReconnect();
  clearReconnect();
  stopLoopImpl();
  sceneScheduler.stop();
  await bridge?.stop().catch(() => null);
  bridge = null;
  device = null;
}

/* ---------------- 渲染入口(路由层用) ---------------- */
export {
  getWeather,
  listCities,
  cityToLocationId,
} from './lib/weather.js';
export {
  renderWeatherCards,
  randomGalleryImages,
  renderCanvasFrames,
  renderAnimationFrames,
  renderCustomEmojiFrames,
  stampFrameNumber,
  listAnimationTypes,
} from './lib/render.js';
export {
  listUserGalleries,
  getUserGalleryFrames,
  exportUserGalleries,
} from './lib/gallery-store.js';
export {
  slotCapacity,
  clampWeatherRefreshMin,
  SLOT_STYLE_NAMES,
} from './shared/profile-types.js';
export { describeSteps } from './lib/loop.js';
export { sanitizeLoopSteps } from './shared/index.js';
export { renderSlotForDevice, applyDeviceControl } from './device-control.js';
export { checkEnvironment } from './lib/binary-runtime.js';
export type { SlotSpec, DisplayProfile } from './shared/profile-types.js';
