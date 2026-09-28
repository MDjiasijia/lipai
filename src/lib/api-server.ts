/**
 * 本地服务 API 客户端 —— src/lib/api.ts（素材库/路由）的补充模块。
 *
 * 覆盖 docs/API.md 里素材库之外的全部端点：
 *  - BLE / 设备命令（服务端桥通道：POST /api/ble/* + /api/device/* + /api/image/send）
 *  - 自动化（轮播 / 场景日程，服务端常驻 —— 页面关掉照跑）
 *  - profiles / galleries / datafeeds / weather-cities（~/.lipai/ 唯一真源）
 *
 * base ''（同源 /api 前缀）：开发模式 vite 代理到 127.0.0.1:5176，生产 npm start 单端口。
 * 放独立模块而不并进 api.ts：deviceStore / profile-store / gallery-store / datafeed-store
 * 都要引它 —— 独立出来避免「领域 store → api.ts（带离线缓存层）」的纠缠与循环依赖。
 * SSE（/api/events）不走这里：EventSource 由 deviceStore 原生订阅。
 */
import type { DataFeedDef, DisplayProfile, ProfileListItem, SceneSchedule } from './ips/profile-types'
import type { DeviceInfo, LoopState, SlotApplyState } from './ips/shared'

/* ── 通用请求封装 ─────────────────────────────────────────── */

/** JSON 请求（错误统一 `{ error }` + 4xx/5xx → Error（带 status，调用方区分 404））。 */
async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string }
  if (!resp.ok) {
    throw Object.assign(new Error(data.error ?? `请求失败（${resp.status}）`), { status: resp.status })
  }
  return data
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const put = <T>(path: string, body?: unknown): Promise<T> =>
  req<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })
const del = <T>(path: string): Promise<T> => req<T>(path, { method: 'DELETE' })

/** 路径参数编码（图组名可能是中文/空格） */
const enc = (v: string): string => encodeURIComponent(v)

/* ── 健康 / BLE（服务端桥通道） ─────────────────────────────── */

export interface HealthInfo {
  ok: boolean
  version: string
  ble: { binary: string; bridgeRunning: boolean }
  dataDir: string
}

export async function getHealth(): Promise<HealthInfo> {
  return req<HealthInfo>('/api/health')
}

export interface ScannedDevice {
  name: string
  address: string
}

/** GET /api/ble/status —— 服务端桥当前连接状态（页面加载时同步用，别只等 SSE） */
export function bleStatus(): Promise<Partial<DeviceInfo> & { bridge?: { binary: string; bridgeRunning: boolean } }> {
  return req('/api/ble/status')
}

/** POST /api/ble/scan —— 扫描匹配设备名前缀的设备（不连接） */
export function bleScan(): Promise<{ devices: ScannedDevice[] }> {
  return post('/api/ble/scan')
}

/** POST /api/ble/connect —— name 支持设备码（31C2C6）；autoConnect=true 存档并开启服务端退避重连 */
export function bleConnect(opts: { address?: string; name?: string; autoConnect?: boolean } = {}): Promise<DeviceInfo> {
  return post('/api/ble/connect', opts)
}

/** POST /api/ble/disconnect —— userInitiated=true（默认）清服务端重连绑定 */
export function bleDisconnect(userInitiated = true): Promise<{ ok: boolean }> {
  return post('/api/ble/disconnect', { userInitiated })
}

/** POST /api/ble/auto-connect —— 开/关服务端自动重连 */
export function bleAutoConnect(enabled: boolean): Promise<{ ok: boolean }> {
  return post('/api/ble/auto-connect', { enabled })
}

/* ── 设备命令（服务端桥通道；body 即参数，见 docs/API.md） ─────────── */

export function deviceReadStatus(): Promise<{ ok: boolean }> {
  return post('/api/device/read-status')
}
export function deviceSetClockStyle(style: number): Promise<{ ok: boolean }> {
  return post('/api/device/clock-style', { style })
}
export function deviceSetBrightness(value: number): Promise<{ ok: boolean }> {
  return post('/api/device/brightness', { value })
}
export function deviceSetLightMode(mode: number): Promise<{ ok: boolean }> {
  return post('/api/device/light-mode', { mode })
}
export function deviceSetLightColor(r: number, g: number, b: number): Promise<{ ok: boolean }> {
  return post('/api/device/light-color', { r, g, b })
}
export function deviceConfigureWifi(ssid: string, password: string): Promise<{ ok: boolean }> {
  return post('/api/device/wifi', { ssid, password })
}
export function deviceSetTime(opts: {
  timezoneQuarterHours: number
  use24Hour: boolean
  useNetworkTime: boolean
  timestamp?: number
}): Promise<{ ok: boolean }> {
  return post('/api/device/time', opts)
}
export function deviceSetWeather(opts: {
  enabled: boolean
  locationId: string
  fahrenheit: boolean
}): Promise<{ ok: boolean }> {
  return post('/api/device/weather', opts)
}
export function deviceSetFirmwareAddress(url: string): Promise<{ ok: boolean }> {
  return post('/api/device/firmware-address', { url })
}
export function deviceReboot(): Promise<{ ok: boolean }> {
  return post('/api/device/reboot')
}
export function deviceFactoryReset(): Promise<{ ok: boolean }> {
  return post('/api/device/factory-reset')
}

/** POST /api/image/send —— 蓝牙传图（base64 JPEG；imageKey 指纹去重在服务端，前端不用管）。
 *  响应在整套传完后才回来（蓝牙 10-20 秒）；进度事件 imageProgress 走 SSE（见 deviceStore）。 */
export function sendImage(slot: number, frames: string[]): Promise<{ ok: boolean }> {
  return post('/api/image/send', { slot, frames })
}

/* ── 自动化（服务端常驻） ─────────────────────────────────── */

/** GET /api/loop —— 轮播状态（SSE loop 事件之外的全量拉取口） */
export function getLoopState(): Promise<LoopState> {
  return req('/api/loop')
}

/** POST /api/loop/start 的参数（服务端 lib/loop.ts LoopConfigArgs 对齐） */
export interface StartLoopArgs {
  /** 步骤：数字 0-3 = 切槽位；字符串 = 内容源（用量/额度系保留成员名但服务端空池跳过） */
  steps: (number | string)[]
  intervalSec: number
  startFrom?: number
  city?: string
  galleryTheme?: 'anime' | 'animals'
  userGalleryName?: string
  /** frames 步骤的 emoji/文字序列（逐帧） */
  frames?: string[]
  /** 天气卡拖拽顺序（语义 ID；空/省略 = 渲染定义顺序） */
  weatherCardOrder?: string[]
  /** 天气数据刷新间隔（分钟，30–240，默认 60）—— 与屏幕换卡间隔解耦 */
  weatherRefreshMin?: number
}

export function startLoop(args: StartLoopArgs): Promise<LoopState> {
  return post('/api/loop/start', args)
}

export function stopLoop(): Promise<LoopState> {
  return post('/api/loop/stop')
}

/** 场景日程运行时状态（服务端 scene-scheduler 的 getState 形状） */
export interface SceneScheduleState {
  status: 'running' | 'stopped' | 'error'
  schedule: SceneSchedule | null
  activeSlotId: string | null
  lastTriggerAt: number
  error?: string
}

/** GET/PUT /api/scene 的响应：{ schedule, state } */
export interface SceneStateResp {
  schedule: SceneSchedule | null
  state: SceneScheduleState
}

export function getSceneSchedule(): Promise<SceneStateResp> {
  return req('/api/scene')
}

/** PUT /api/scene —— 校验后存 config.json 并立即生效（常驻运行器按新时刻表对齐） */
export function putSceneSchedule(schedule: SceneSchedule): Promise<SceneStateResp> {
  return put('/api/scene', { schedule })
}

/* ── 配置（profiles，~/.lipai/profiles/） ───────────────────── */

export function listProfilesApi(): Promise<{ currentProfileId: string; profiles: ProfileListItem[] }> {
  return req('/api/profiles')
}

export function createProfileApi(name: string): Promise<DisplayProfile> {
  return post('/api/profiles', { name })
}

export function getProfileApi(id: string): Promise<DisplayProfile> {
  return req(`/api/profiles/${enc(id)}`)
}

export function putProfileApi(profile: DisplayProfile): Promise<{ ok: boolean }> {
  return put(`/api/profiles/${enc(profile.id)}`, profile)
}

export function deleteProfileApi(id: string): Promise<{ ok: boolean }> {
  return del(`/api/profiles/${enc(id)}`)
}

export function duplicateProfileApi(id: string, name?: string): Promise<DisplayProfile> {
  return post(`/api/profiles/${enc(id)}/duplicate`, { name })
}

export function setCurrentProfileApi(id: string): Promise<{ ok: boolean }> {
  return post('/api/profiles/current', { id })
}

/** POST /api/profiles/:id/apply —— 服务端按配方逐槽渲染+推送（进度 slotApply 走 SSE），再下发 deviceControl */
export function applyProfileApi(id: string): Promise<SlotApplyState> {
  return post(`/api/profiles/${enc(id)}/apply`)
}

/** POST /api/export —— v2 分享 JSON（带图组依赖 + previews 快照；响应即文件内容） */
export function exportProfilesApi(profileIds?: string[]): Promise<unknown> {
  return post('/api/export', profileIds?.length ? { profileIds } : {})
}

/** POST /api/profiles/import 的结果（服务端落盘的名字清单） */
export interface ProfileImportResp {
  profiles: { id: string; name: string }[]
  galleries: string[]
  skipped: string[]
  renamed: { from: string; to: string }[]
}

export function importProfilesApi(data: string): Promise<ProfileImportResp> {
  return post('/api/profiles/import', { data })
}

/* ── 图组（galleries，~/.lipai/gallery/ + 内置预设） ───────────── */

export interface GalleryMetaApi {
  name: string
  frameCount: number
  createdAt: number
  sourcePrompt?: string
  /** 内置预设（只读：不可删/改名） */
  preset?: boolean
  builtin?: boolean
}

export function listGalleriesApi(): Promise<{ galleries: GalleryMetaApi[] }> {
  return req('/api/galleries')
}

export function getGalleryFramesApi(name: string): Promise<{ frames: string[] }> {
  return req(`/api/galleries/${enc(name)}/frames`)
}

export function saveGalleryApi(name: string, frames: string[], sourcePrompt?: string): Promise<GalleryMetaApi> {
  return post('/api/galleries', { name, frames, sourcePrompt })
}

export function renameGalleryApi(name: string, next: string): Promise<{ ok: boolean }> {
  return post(`/api/galleries/${enc(name)}/rename`, { name: next })
}

export function deleteGalleryApi(name: string): Promise<{ ok: boolean }> {
  return del(`/api/galleries/${enc(name)}`)
}

/* ── 自定义接口（datafeeds，config.json KV） ─────────────────── */

export function listDataFeedsApi(): Promise<{ datafeeds: DataFeedDef[] }> {
  return req('/api/settings/datafeeds')
}

export function putDataFeedsApi(datafeeds: DataFeedDef[]): Promise<{ ok: boolean }> {
  return put('/api/settings/datafeeds', { datafeeds })
}

/* ── 天气城市 ─────────────────────────────────────────── */

/**
 * GET /api/weather/cities —— 服务端 listCities() 提供的支持城市名列表。
 * （设备原生天气要的 QWeather LocationID 仍由前端 CITY_TO_LOCATION_ID 静态映射，
 * 服务器没有单独的 id 端点 —— 返回的是城市名数组，不是 [{id,name}]。）
 */
export function listWeatherCities(): Promise<{ cities: string[] }> {
  return req('/api/weather/cities')
}
