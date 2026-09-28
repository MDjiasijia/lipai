/**
 * 设备连接全局 store（模块级单例）—— 双通道版。
 *
 * 通道（channel，默认 'server'）：
 *  - server：设备操作全部走本地服务桥（POST /api/ble/* + /api/device/* + /api/image/send，
 *    契约 docs/API.md）。掉线退避重连由服务端负责 —— 前端不跑重连循环，只把 SSE
 *    （EventSource /api/events）的 connection 事件映射进状态机；页面刷新/手机换浏览器
 *    都不影响桥上的连接与自动化（服务端常驻）。
 *  - browser：Web Bluetooth 直连（原 device.ts 逻辑原样保留）—— 桥不可用
 *    （无二进制/系统蓝牙权限/服务未起）时的后备；掉线退避照旧前端跑。
 *
 * 两通道互斥：连接任一时另一通道 UI 禁用；切换（setChannel）先断开原通道。
 * 状态机形状与上游 Web 版一致（idle/connecting/connected/disconnected），
 * Control.tsx / DeviceMenu 走 useDevice() 的订阅接口不变。
 *
 * 为什么不是 React context：三个页面（投屏/自动/设备）此前各自 useDevice()
 * 各建一个连接 —— 切 tab 即重连。提到模块顶层后实例与状态跨路由存活，
 * React 侧用 useSyncExternalStore 订阅（路由怎么切都不重置）。
 */
import type { DeviceInfo, LogEntry } from './shared'
import { IpsDevice, NoSilentReconnectError, webBluetoothAvailable } from './device'
import { readConnectSettings, writeConnectSettings, writeChannelPreference } from './store'
import * as api from '../api-server'
import { toast } from '../../components/ui/Toast'

/** 通道：服务端桥（默认）/ 浏览器 Web Bluetooth 直连（后备） */
export type DeviceChannel = 'server' | 'browser'

/** 自动重连彻底放弃时顶到用户面前的引导（错误条 + toast；重试中的暂态失败不打扰） */
const GIVE_UP_HINT = '自动重连已停止 —— 请点击「连接设备」手动连接'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected'

export interface DeviceState {
  /** 当前通道（server = 服务端桥；browser = Web Bluetooth 直连） */
  channel: DeviceChannel
  state: ConnectionState
  info: DeviceInfo
  log: LogEntry[]
  error: string
  /** browser 通道：Web Bluetooth 是否可用（server 通道恒 true —— 可用性看桥状态） */
  available: boolean
  /** 自动重连是否待命（server 通道：服务端退避重连中；browser：前端退避重连待命） */
  autoReconnect: boolean
  /** 上次连接过的设备名（恢复提示用；server 通道的存档在服务端 config.json，这里只做展示） */
  savedName: string
  /** server 通道桥状态（/api/health.ble；桥不可用时 UI 显示原因） */
  bridge: { binary: string; bridgeRunning: boolean } | null
  /** server 通道服务不可达（fetch /api/health 失败）：UI 提示「检查本地服务」+ 回落 browser */
  serverDown: boolean
}

const state: DeviceState = {
  channel: 'server',
  state: 'idle',
  info: { connected: false },
  log: [],
  error: '',
  available: webBluetoothAvailable(),
  autoReconnect: false,
  savedName: '',
  bridge: null,
  serverDown: false,
}

/**
 * getSnapshot 缓存：set() 每次换一个新对象引用。
 * useSyncExternalStore 用 Object.is 判变 —— 原地 Object.assign 的话引用不变，
 * 订阅方（header 徽标 / 菜单 / 控制台）永远不重渲染。
 */
let snapshot: DeviceState = state

const listeners = new Set<() => void>()

function set(patch: Partial<DeviceState>): void {
  Object.assign(state, patch)
  snapshot = { ...state }
  for (const l of listeners) l()
}

function appendLog(message: string, direction: LogEntry['direction']): void {
  set({ log: [...state.log.slice(-199), { message, direction, ts: Date.now() }] })
}

/** 重连链路日志（system 方向）—— 用户查「为什么没连上」时唯一线索 */
function logReconnect(message: string): void {
  appendLog(`[重连] ${message}`, 'system')
}

/* ── browser 通道：全局唯一的设备实例（attach 回调写进 state） ── */
export const device = new IpsDevice({
  onLog: (message, direction = 'system') => {
    if (state.channel === 'browser') appendLog(message, direction)
  },
  onInfo: (info) => {
    if (state.channel === 'browser') set({ info })
  },
  onConnection: (s, detail, userInitiated) => {
    if (state.channel !== 'browser') return
    if (s === 'connected') {
      logReconnect(`已连接 ${detail} —— 重连待命解除`)
      set({ state: 'connected', error: '', autoReconnect: false })
      void persistDevice()
    } else if (userInitiated) {
      logReconnect('用户主动断开 —— 不再自动重连')
      set({ state: 'idle', autoReconnect: false })
    } else {
      logReconnect(`掉线：${detail || '连接丢失'} —— 进入退避重连`)
      set({ state: 'disconnected', error: detail, autoReconnect: true })
      scheduleReconnect()
    }
  },
})

/* ── SSE 订阅（server 通道）：connection/deviceInfo/log/imageProgress → store 形状 ── */

let eventSource: EventSource | null = null
/** imageProgress 的订阅方（sendImage 进度回调；server 通道 sendImage 里挂上/摘除） */
type ProgressListener = (p: { taskId: string; status: string; done: number; total: number; error?: string }) => void
let progressListener: ProgressListener | null = null

/** SSE 事件 → store 映射（server 通道专用；hello = 初始快照，循环/场景由各自模块订阅） */
function handleServerEvent(event: string, data: unknown): void {
  if (state.channel !== 'server') return
  switch (event) {
    case 'connection': {
      const p = data as { state: 'connected' | 'disconnected'; detail: string; name?: string; userInitiated?: boolean }
      if (p.state === 'connected') {
        logReconnect(`已连接 ${p.name ?? p.detail} —— 服务端桥连接成功`)
        set({ state: 'connected', error: '', autoReconnect: false, savedName: p.name ?? state.savedName })
      } else if (p.userInitiated) {
        set({ state: 'idle', autoReconnect: false })
      } else {
        // 掉线：服务端已开启退避重连（前端不跑重连循环，只反映状态）
        logReconnect(`桥掉线：${p.detail || '连接丢失'} —— 服务端退避重连中`)
        set({ state: 'disconnected', error: p.detail, autoReconnect: true })
      }
      break
    }
    case 'deviceInfo':
      set({ info: data as DeviceInfo })
      break
    case 'log': {
      const e = data as LogEntry
      appendLog(e.message, e.direction)
      break
    }
    case 'imageProgress':
      progressListener?.(data as Parameters<ProgressListener>[0])
      break
    default:
      break
  }
}

/** 建立 SSE 订阅（幂等：已连着直接复用）。server 通道专属。 */
function ensureEventSource(): void {
  if (eventSource) return
  const es = new EventSource('/api/events')
  eventSource = es
  es.onmessage = () => {
    /* 兼容不带 event 名的消息（心跳注释不进这里）；事件按名分发 */
  }
  for (const name of ['connection', 'deviceInfo', 'log', 'imageProgress', 'loop', 'scene', 'slotApply', 'library', 'hello']) {
    es.addEventListener(name, (ev) => {
      try {
        handleServerEvent(name, JSON.parse((ev as MessageEvent<string>).data))
      } catch {
        /* 非 JSON 载荷忽略 */
      }
    })
  }
  es.onerror = () => {
    // SSE 断开（服务重启/网络抖动）：EventSource 自动重连；这里只标记 serverDown
    // （连接状态以重连成功后的 connection/deviceInfo 快照为准，不误报掉线）
    if (state.channel === 'server') set({ serverDown: true })
  }
  es.onopen = () => {
    if (state.channel === 'server' && state.serverDown) set({ serverDown: false })
  }
}

/** server 通道 sendImage：进度走 SSE imageProgress（订阅期间挂上，结束摘除）。
 *  running 事件透传给 onProgress（进度条跟着走）；终态（done/error/canceled）结算 Promise。 */
function withProgress(cb: () => Promise<void>, onProgress?: (done: number, total: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    progressListener = (p) => {
      if (p.status === 'running') {
        onProgress?.(p.done, p.total)
        return
      }
      if (p.status === 'done' || p.status === 'error' || p.status === 'canceled') {
        if (!settled) {
          settled = true
          progressListener = null
          if (p.status === 'error') reject(new Error(p.error ?? '传图失败'))
          else resolve()
        }
      }
    }
    cb().then(
      () => {
        if (!settled) {
          settled = true
          progressListener = null
          resolve()
        }
      },
      (err) => {
        if (!settled) {
          settled = true
          progressListener = null
          reject(err)
        }
      },
    )
  })
}

/* ── browser 通道：原退避重连逻辑（保留不动） ── */

let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
const savedIdRef: { id: string | null } = { id: null }

/** 掉线/首连失败后退避重连（免面板路径；连续失败 5 次停手等用户手动） */
function scheduleReconnect(): void {
  if (reconnectTimer) return
  if (reconnectAttempts >= 5) {
    logReconnect(`连续 ${reconnectAttempts} 次未成 —— 停手等手动连接（目标：${state.savedName || savedIdRef.id || '未知'}）`)
    set({ autoReconnect: false, state: 'disconnected', error: GIVE_UP_HINT })
    toast(GIVE_UP_HINT, 'error')
    return
  }
  // 等待期亮黄灯（connecting 的 ping 动画）—— 掉线红灯只在停手后常亮
  set({ state: 'connecting' })
  const delay = Math.min(30_000, 2000 * 2 ** reconnectAttempts)
  logReconnect(`第 ${reconnectAttempts + 1}/5 次尝试：${delay / 1000}s 后免面板重连（目标：${state.savedName || savedIdRef.id || '未知'}）`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // 先放回 disconnected：doConnect 开头有「已在 connecting」守卫，
    // 不放开的话这次尝试被守卫直接挡回 false —— 永远空转不真连。
    set({ state: 'disconnected' })
    // 定时重连没有用户手势 —— 只走免面板路径，失败静默等下一轮退避
    logReconnect('开始免面板连接…')
    void doConnect({ allowPanel: false }).then((ok) => {
      if (ok) {
        reconnectAttempts = 0
        logReconnect('重连成功 —— 退避计数清零')
      } else {
        reconnectAttempts++
        logReconnect(`失败（第 ${reconnectAttempts}/5 次）：${state.error || '设备未广播/蓝牙未就绪'}`)
        if (state.autoReconnect) scheduleReconnect()
      }
    })
  }, delay)
}

/* ── 连接实现（按通道分派） ── */

/**
 * server 通道连接：POST /api/ble/connect。name 支持设备码（31C2C6）；
 * autoConnect 交给服务端（存档 + 退避重连都在服务端）。
 * SSE 的 connection 事件会补上 connected 状态；这里成功返回 true。
 */
async function doConnectServer(): Promise<boolean> {
  set({ state: 'connecting', error: '' })
  try {
    ensureEventSource()
    const info = await api.bleConnect({ autoConnect: true })
    // 成功即整份 info 刷进 store（连接事件可能先/后到，谁后到谁覆盖，形状一致）
    set({ state: 'connected', info, error: '', autoReconnect: false, savedName: info.name ?? state.savedName })
    appendLog(`已连接 ${info.name ?? 'IPS 设备'}（服务端桥）`, 'system')
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    set({ state: 'idle', error: msg })
    appendLog(`服务端桥连接失败：${msg}`, 'system')
    return false
  }
}

/**
 * browser 通道连接（savedId 优先走免面板路径）。resolve 是否成功。
 * allowPanel=false 时绝不弹系统选择面板 —— 页面加载/掉线重连等自动路径
 * 没有用户手势，Chrome 的 requestDevice 会直接拒绝。
 */
async function doConnectBrowser(opts: { allowPanel?: boolean } = {}): Promise<boolean> {
  if (state.state === 'connecting' || state.state === 'connected') return state.state === 'connected'
  if (!state.available) {
    set({
      error: '当前浏览器不支持 Web Bluetooth（需要桌面 Chrome/Edge 或 Android Chrome；iOS Safari 不支持）',
    })
    return false
  }
  const allowPanel = opts.allowPanel !== false
  // 自动路径且没有已保存设备：根本没有免面板可走，提前退出不进 connecting
  if (!allowPanel && !savedIdRef.id) {
    set({ state: 'idle' })
    return false
  }
  set({ state: 'connecting', error: '' })
  if (!allowPanel) logReconnect(`免面板连接尝试（getDevices → id ${savedIdRef.id}）`)
  try {
    await device.connect(savedIdRef.id ?? undefined, { allowPanel })
    reconnectAttempts = 0
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 自动路径失败是常态（设备离线/蓝牙关了）：静默回 disconnected，不把错误顶到连接条
    // （连接条显示的是「上一次手动连接」的错误；自动重连另有徽标/状态灯表达）。
    // 但日志必须留痕 —— 这是查「为什么没连上」的第一线索。
    if (!allowPanel) {
      logReconnect(`免面板连接抛错：${msg}`)
      // 免面板路径在当前浏览器压根不存在：重试不会有转机 —— 立即停手
      if (err instanceof NoSilentReconnectError) {
        logReconnect('该浏览器不支持免面板重连 —— 停止退避，点「连接设备」走面板')
        set({ state: 'disconnected', autoReconnect: false, error: GIVE_UP_HINT })
        toast(GIVE_UP_HINT, 'error')
        return false
      }
      set({ state: 'disconnected' })
      return false
    }
    set({ state: 'idle', error: msg })
    return false
  }
}

async function doConnect(opts: { allowPanel?: boolean } = {}): Promise<boolean> {
  if (state.channel === 'server') return doConnectServer()
  return doConnectBrowser(opts)
}

/** 连接成功后把设备 id 存 IndexedDB（browser 通道：下次打开页面免面板直连） */
async function persistDevice(): Promise<void> {
  if (state.channel !== 'browser') return
  const id = device.savedDeviceId()
  if (!id) return
  savedIdRef.id = id
  const name = device.getInfo().name ?? null
  if (name) set({ savedName: name })
  await writeConnectSettings({
    autoConnect: true,
    lastDeviceId: id,
    lastDeviceName: name,
  }).catch(() => {})
}

/* ── 通道切换 ── */

/** 切换通道（互斥：先断开原通道再切）。connected 时调用方应先确认。 */
export async function setChannel(next: DeviceChannel): Promise<void> {
  if (state.channel === next) return
  // 在连着就先断开（两通道互斥；UI 侧切换按钮在 connected 时本来就该禁用，这里兜底）
  if (state.state === 'connected' || state.state === 'connecting') {
    await actions.disconnect()
  }
  // 摘掉旧通道的 SSE（server → browser：不再消费桥事件）
  if (next === 'browser' && eventSource) {
    eventSource.close()
    eventSource = null
  }
  set({
    channel: next,
    state: 'idle',
    info: { connected: false },
    error: '',
    autoReconnect: false,
  })
  // 通道偏好落 IndexedDB（下次打开页面沿用；前端-only 状态，不进服务端 config.json）
  void writeChannelPreference(next).catch(() => undefined)
  if (next === 'server') {
    ensureEventSource()
    void refreshBridgeStatus()
  }
}

/** 拉一次桥状态（/api/health）：server 通道 UI 的「桥不可用原因」数据源 */
export async function refreshBridgeStatus(): Promise<void> {
  try {
    const health = await api.getHealth()
    set({ bridge: health.ble, serverDown: false })
  } catch {
    set({ serverDown: true, bridge: null })
  }
}

/** 页面加载时调用一次（App 挂载）：
 *  - server 通道（默认）：拉桥状态 + SSE 快照对齐（连接/设备信息由服务端告知）。
 *  - browser 通道：恢复上次设备 + 自动连接（免面板，无手势不能弹选择器）。 */
export async function initDeviceStore(): Promise<void> {
  // 幂等锁：StrictMode 下 App 挂载 effect 跑两次，二次调用直接复用首个 Promise
  initPromise ??= doInitDeviceStore()
  return initPromise
}

let initPromise: Promise<void> | null = null

async function doInitDeviceStore(): Promise<void> {
  // 通道偏好存 IndexedDB settings（前端-only 状态；与 connect 设置同库）。
  // 没存过 = 首次运行，保持默认 'server'（对齐 docs/API.md 通道语义）。
  const s = await readConnectSettings().catch(() => null)
  if (s?.lastDeviceName) set({ savedName: s.lastDeviceName })
  if (s?.lastDeviceId) savedIdRef.id = s.lastDeviceId
  if (s?.channel === 'browser') set({ channel: 'browser' })

  // server 通道：桥状态 + SSE。连接恢复交给服务端（autoConnect 存档在服务端 config.json）；
  // SSE 初始快照（hello 后的 deviceInfo/loop/scene）一到，状态自然对齐。
  if (state.channel === 'server') {
    ensureEventSource()
    await refreshBridgeStatus()
    // 桥掉线状态下的存档重连由服务端负责；这里只把「桥上是否已连」同步进 UI
    try {
      const status = await api.bleStatus()
      if (status.connected) {
        set({ state: 'connected', info: status as DeviceInfo, error: '', savedName: status.name ?? state.savedName })
      }
    } catch {
      /* 服务未起（serverDown 已标）：UI 提示检查本地服务 / 切 browser 通道 */
    }
    return
  }

  // browser 通道：原自动重连逻辑（首连失败进退避，见 scheduleReconnect）
  if (s?.lastDeviceId && s.autoConnect) {
    set({ autoReconnect: true })
    logReconnect(`页面加载：恢复上次设备「${s.lastDeviceName ?? s.lastDeviceId}」，开始首连（免面板）`)
    const ok = await doConnect({ allowPanel: false })
    // 首连失败 ≠ 永远失败：设备刚上电 / 蓝牙栈未就绪都是暂态，退避重试
    if (!ok && state.autoReconnect) {
      logReconnect('首连未成 —— 进入退避重连（设备可能刚上电/蓝牙栈未就绪）')
      scheduleReconnect()
    }
  }
}

/* ── 统一设备操作门面（Control.tsx 调用形状不变；按通道分派） ──
 * server：POST /api/device/*（SSE 事件补 info/log）
 * browser：原 device.ts 直调 */

export const actions = {
  connect: (): Promise<boolean> => doConnect(),
  disconnect: async (): Promise<void> => {
    if (state.channel === 'server') {
      // 服务端断开（userInitiated=true 清服务端重连绑定）；connection 事件回 idle
      try {
        await api.bleDisconnect(true)
      } catch (err) {
        appendLog(`断开请求失败：${err instanceof Error ? err.message : String(err)}`, 'system')
      }
      set({ state: 'idle', autoReconnect: false })
      return
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempts = 0
    set({ autoReconnect: false })
    await device.disconnect()
    set({ state: 'idle' })
  },
  /** 用户喊停自动重连：server 通道调服务端开关；browser 清前端定时器 */
  stopReconnect: (): void => {
    if (state.channel === 'server') {
      void api.bleAutoConnect(false).catch(() => undefined)
      set({ autoReconnect: false, state: 'disconnected' })
      return
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempts = 0
    device.abortConnect()
    set({ autoReconnect: false, state: 'disconnected' })
  },
  clearError: (): void => set({ error: '' }),
  clearLog: (): void => set({ log: [] }),
  setChannel,
  refreshBridgeStatus,
}

export function subscribeDevice(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDeviceState(): DeviceState {
  return snapshot
}

/* ── 设备命令门面（统一接口；server 发 API、browser 直调 device.ts） ──
 *  提供给 useDevice().device 形状之外的命令层 —— Control.tsx 的
 *  device.setBrightness(...) 调用经由 useDevice.ts 的 DeviceFacade 走到这里。 */

export const deviceCommands = {
  readStatus: (): Promise<void> =>
    state.channel === 'server' ? api.deviceReadStatus().then(() => undefined) : device.readStatus(),
  setBrightness: (v: number): Promise<void> =>
    state.channel === 'server' ? api.deviceSetBrightness(v).then(() => undefined) : device.setBrightness(v),
  setLightMode: (m: number): Promise<void> =>
    state.channel === 'server' ? api.deviceSetLightMode(m).then(() => undefined) : device.setLightMode(m),
  setLightColor: (r: number, g: number, b: number): Promise<void> =>
    state.channel === 'server' ? api.deviceSetLightColor(r, g, b).then(() => undefined) : device.setLightColor(r, g, b),
  setTime: (opts: {
    timezoneQuarterHours: number
    use24Hour: boolean
    useNetworkTime: boolean
    timestamp?: number
  }): Promise<void> =>
    state.channel === 'server' ? api.deviceSetTime(opts).then(() => undefined) : device.setTime(opts),
  setWeather: (opts: { enabled: boolean; locationId: string; fahrenheit: boolean }): Promise<void> =>
    state.channel === 'server' ? api.deviceSetWeather(opts).then(() => undefined) : device.setWeather(opts),
  configureWifi: (ssid: string, password: string): Promise<void> =>
    state.channel === 'server' ? api.deviceConfigureWifi(ssid, password).then(() => undefined) : device.configureWifi(ssid, password),
  setFirmwareAddress: (url: string): Promise<void> =>
    state.channel === 'server' ? api.deviceSetFirmwareAddress(url).then(() => undefined) : device.setFirmwareAddress(url),
  reboot: (): Promise<void> =>
    state.channel === 'server' ? api.deviceReboot().then(() => undefined) : device.reboot(),
  factoryReset: (): Promise<void> =>
    state.channel === 'server' ? api.deviceFactoryReset().then(() => undefined) : device.factoryReset(),
  setClockStyle: (style: number): Promise<void> =>
    state.channel === 'server' ? api.deviceSetClockStyle(style).then(() => undefined) : device.setClockStyle(style),
  /**
   * 蓝牙传图（统一接口）：
   * - server：POST /api/image/send {slot, frames:base64[]}，进度走 SSE imageProgress
   *   （imageKey 指纹去重在服务端 —— 前端不用管「这套是否已传过」）。
   * - browser：原 device.sendImage（帧切片 + GATT 写队列 + 指纹记录全在本地）。
   */
  sendImage: (
    frames: Uint8Array[],
    slot: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> => {
    if (state.channel === 'browser') return device.sendImage(frames, slot, onProgress)
    // base64 编码（分块避免 String.fromCharCode 爆栈）
    const b64s = frames.map((f) => {
      let binary = ''
      for (let i = 0; i < f.length; i += 0x8000) binary += String.fromCharCode(...f.subarray(i, i + 0x8000))
      return btoa(binary)
    })
    onProgress?.(0, b64s.length)
    return withProgress(() => api.sendImage(slot, b64s).then(() => undefined), onProgress).then(() => {
      onProgress?.(b64s.length, b64s.length)
    })
  },
}

/** loop / scene 的 SSE 事件转发（loopStore / sceneStore 订阅用；deviceStore 只分发设备域事件） */
export function subscribeServerEvent(name: 'loop' | 'scene' | 'slotApply', handler: (data: unknown) => void): () => void {
  // 事件源在 deviceStore 持有；这里补一层注册（ensureEventSource 先行）
  ensureEventSource()
  const wrapped = (data: unknown): void => handler(data)
  const es = eventSource
  if (!es) return () => undefined
  const listener = (ev: Event): void => {
    try {
      wrapped(JSON.parse((ev as MessageEvent<string>).data))
    } catch {
      /* 非 JSON 载荷忽略 */
    }
  }
  es.addEventListener(name, listener)
  return () => es.removeEventListener(name, listener)
}
