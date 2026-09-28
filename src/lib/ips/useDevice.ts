/**
 * 设备连接 React hook：deviceStore（模块级单例）的订阅层。
 *
 * 此前三页各建一个连接 —— 切 tab 即重连。现在实例与状态全在
 * deviceStore.ts 模块顶层，本 hook 只做 useSyncExternalStore 订阅：
 * 任何页面挂载/卸载都不影响连接，路由怎么切都共用同一台设备。
 *
 * 本地版双通道：`device` 字段不再直接是 browser 通道的 IpsDevice 实例，
 * 而是 DeviceFacade —— 按当前通道分派（server 发 /api/device/*，browser
 * 直调 device.ts）。调用形状与 share-web 版完全一致（setBrightness/…/
 * sendImage(slot 参数顺序调整为「frames, slot」对齐旧签名））。
 */
import { useSyncExternalStore } from 'react'
import { IpsDevice } from './device'
import {
  actions,
  device,
  deviceCommands,
  getDeviceState,
  subscribeDevice,
  type DeviceChannel,
  type DeviceState,
} from './deviceStore'

export type { ConnectionState, DeviceChannel, DeviceState } from './deviceStore'

/**
 * 统一设备门面：Control.tsx 的 device.setBrightness(...) 调用形状不变。
 * browser 通道语义与 share-web 版 IpsDevice 一致（含 imageKey/slotConfirmedAt
 * 这类本地指纹记录）；server 通道这些只读方法返回本地缓存（指纹去重在服务端）。
 */
export interface DeviceFacade {
  /** 是否已连接（server：桥上连接；browser：GATT 连接） */
  readonly connected: boolean
  /** 当前绑定的设备信息快照（store.info 的转发） */
  getInfo(): ReturnType<typeof device.getInfo>
  /** 静态指纹工具（browser 通道本地算；server 通道同样本地算 —— 纯函数与通道无关） */
  imageKey(images: readonly Uint8Array[]): Promise<string>
  /** 该槽位最后上传的图组指纹（server：服务端管，前端拿不到 —— 恒 undefined） */
  imageKeyOf(slot: number): string | undefined
  /** 该槽位的确认时刻（server：推送完成即确认，前端不做账） */
  slotConfirmedAtOf(slot: number): number | undefined
  /** 用户点「确认」（server：无对应端点 —— 本地记账即可） */
  confirmSlot(slot: number): void
  /** 通道（读当前 deviceStore 的通道） */
  channel(): DeviceChannel
  /* ── 命令层（deviceCommands 分派） ── */
  readStatus(): Promise<void>
  setBrightness(value: number): Promise<void>
  setLightMode(mode: number): Promise<void>
  setLightColor(r: number, g: number, b: number): Promise<void>
  setTime(opts: { timezoneQuarterHours: number; use24Hour: boolean; useNetworkTime: boolean; timestamp?: number }): Promise<void>
  setWeather(opts: { enabled: boolean; locationId: string; fahrenheit: boolean }): Promise<void>
  configureWifi(ssid: string, password: string): Promise<void>
  setFirmwareAddress(url: string): Promise<void>
  reboot(): Promise<void>
  factoryReset(): Promise<void>
  setClockStyle(style: number): Promise<void>
  sendImage(frames: Uint8Array[], slot: number, onProgress?: (done: number, total: number) => void): Promise<void>
}

/** 门面实现：读通道走 deviceStore 快照（每次调用时取，不缓存陈旧通道） */
function makeFacade(): DeviceFacade {
  return {
    get connected() {
      return getDeviceState().state === 'connected'
    },
    getInfo: () => getDeviceState().info,
    imageKey: (images) => IpsDevice.imageKey(images),
    imageKeyOf: (slot) => device.imageKeyOf(slot),
    slotConfirmedAtOf: (slot) => device.slotConfirmedAtOf(slot),
    confirmSlot: (slot) => device.confirmSlot(slot),
    channel: () => getDeviceState().channel,
    readStatus: () => deviceCommands.readStatus(),
    setBrightness: (value) => deviceCommands.setBrightness(value),
    setLightMode: (mode) => deviceCommands.setLightMode(mode),
    setLightColor: (r, g, b) => deviceCommands.setLightColor(r, g, b),
    setTime: (opts) => deviceCommands.setTime(opts),
    setWeather: (opts) => deviceCommands.setWeather(opts),
    configureWifi: (ssid, password) => deviceCommands.configureWifi(ssid, password),
    setFirmwareAddress: (url) => deviceCommands.setFirmwareAddress(url),
    reboot: () => deviceCommands.reboot(),
    factoryReset: () => deviceCommands.factoryReset(),
    setClockStyle: (style) => deviceCommands.setClockStyle(style),
    sendImage: (frames, slot, onProgress) => deviceCommands.sendImage(frames, slot, onProgress),
  }
}

/** 全局唯一门面（与 deviceStore 单例同生命周期；模块级创建避免每次渲染新建） */
const facade: DeviceFacade = makeFacade()

export function useDevice(): DeviceState & {
  /** 统一设备门面（server/browser 按通道分派；调用形状与 share-web 版一致） */
  device: DeviceFacade
  connect: () => Promise<boolean>
  disconnect: () => Promise<void>
  stopReconnect: () => void
  clearError: () => void
  clearLog: () => void
  /** 切换通道（服务端桥 ↔ 浏览器直连；互斥 —— 切换先断开原通道） */
  setChannel: (channel: DeviceChannel) => Promise<void>
  /** 手动刷一次桥状态（/api/health.ble —— 连接条「桥不可用原因」） */
  refreshBridgeStatus: () => Promise<void>
} {
  const snap = useSyncExternalStore(subscribeDevice, getDeviceState)
  return {
    ...snap,
    device: facade,
    connect: actions.connect,
    disconnect: actions.disconnect,
    stopReconnect: actions.stopReconnect,
    clearError: actions.clearError,
    clearLog: actions.clearLog,
    setChannel: actions.setChannel,
    refreshBridgeStatus: actions.refreshBridgeStatus,
  }
}
