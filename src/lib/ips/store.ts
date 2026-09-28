/**
 * 前端本地状态存档（IndexedDB settings KV）。
 *
 * 本地版数据源收敛到服务端（profiles/galleries/datafeeds 走 /api，~/.lipai/ 唯一真源），
 * IndexedDB 只保留**前端-only**状态：连接设置（browser 通道的 savedId/自动重连偏好）、
 * 控制台屏幕常亮开关、主题等 —— 这些是「这台浏览器的事」，不该进服务端 config.json。
 * （share-web 版这里是领域 store 门面：profile/gallery/datafeed 的 IndexedDB 实现；
 *  那条链已整体换成 API 客户端薄层，见 profile-store.ts / gallery-store.ts / datafeed-store.ts。）
 */
import { kvGet, kvPut } from './db'

/** 连接设置（browser 通道 Web Bluetooth 设备存档；server 通道的 autoConnect 存档在服务端 config.json） */
export interface ConnectSettings {
  /** 自动重连开关 */
  autoConnect?: boolean
  /** 上次成功连接的 Web Bluetooth 设备 id（免面板重连用） */
  lastDeviceId?: string | null
  /** 上次成功连接的设备名（菜单提示「会自动重连它」） */
  lastDeviceName?: string | null
  /** 前端-only：通道偏好（'server' | 'browser'；默认 server） */
  channel?: 'server' | 'browser'
}

const CONNECT_KEY = 'connect'

export async function readConnectSettings(): Promise<ConnectSettings> {
  return (await kvGet<ConnectSettings>('settings', CONNECT_KEY)) ?? {}
}

export async function writeConnectSettings(next: ConnectSettings): Promise<void> {
  await kvPut('settings', CONNECT_KEY, next)
}

/** 通道偏好读写（连接条 SegmentedControl；默认 'server'） */
export async function readChannelPreference(): Promise<'server' | 'browser'> {
  const s = await readConnectSettings().catch(() => null)
  return s?.channel === 'browser' ? 'browser' : 'server'
}

export async function writeChannelPreference(channel: 'server' | 'browser'): Promise<void> {
  const s = await readConnectSettings().catch(() => ({} as ConnectSettings))
  await writeConnectSettings({ ...s, channel })
}
