/**
 * Web Bluetooth 版 IPS 设备控制器。
 *
 * 移植自上游扩展版的设备层（Rust/btleplug 桥版）：
 * 协议层帧编解码（protocol.ts，与原版同源）原样复用，传输层从
 * 「spawn ble-bridge 二进制 + 行式 JSON」换成浏览器原生 Web Bluetooth API
 * （navigator.bluetooth + Nordic UART Service 直连）。
 *
 * 与原生桥版的差异（行为对齐，接缝不同）：
 * - 扫描/选择：浏览器没有自由 scan —— requestDevice 的过滤器里写死
 *   namePrefix（设备广播名前缀），用户在浏览器弹的系统面板里选设备；
 *   保存设备 id（device.id 稳定），重连时 attemptReconnect 免系统面板（但
 *   Chrome 出于安全策略仍可能重新弹一次确认，这是平台限制，不是 bug）。
 * - 写：GATT 单次 writeValue 上限 512B，我们的帧最大 504B（MTU 500 + 包头 4），
 *   不需要分帧；写队列串行化语义与原版一致（一次一帧保序、失败不污染后续）。
 * - 读：RX 特征值 startNotifications，收到的 DataView 走同一个 decodePacket。
 * - imageKey（槽位指纹，轮播去重用）从 sha1 换成 sha256（WebCrypto 是平台标准）。
 */
import {
  BLE,
  Command,
  commandName,
  decodePacket,
  hex,
  packet,
  text,
  timestampBytes,
  type DecodedPacket,
} from './protocol'
import type { DeviceInfo } from './types'

export type LogDirection = 'in' | 'out' | 'system'

export interface IpsDeviceCallbacks {
  onLog?: (message: string, direction?: LogDirection) => void
  onInfo?: (info: DeviceInfo) => void
  onConnection?: (state: 'connected' | 'disconnected', detail: string, userInitiated?: boolean) => void
}

/** Web Bluetooth 相关类型（Chrome/Edge 提供；TS lib 未内置，最小声明） */
type BluetoothServiceUUID = string
interface BluetoothRemoteGATTCharacteristic {
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  writeValue(value: BufferSource): Promise<void>
  addEventListener(
    type: 'characteristicvaluechanged',
    listener: (event: Event) => void,
  ): void
  removeEventListener(
    type: 'characteristicvaluechanged',
    listener: (event: Event) => void,
  ): void
}
interface BluetoothRemoteGATTServer {
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  connected: boolean
  getPrimaryService(service: BluetoothServiceUUID): Promise<{ getCharacteristic(uuid: BluetoothServiceUUID): Promise<BluetoothRemoteGATTCharacteristic> }>
}
interface BluetoothDeviceLike {
  id: string
  name?: string
  gatt?: BluetoothRemoteGATTServer
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void
  removeEventListener?(type: 'gattserverdisconnected', listener: () => void): void
}
type NavigatorBluetooth = Navigator & {
  bluetooth?: {
    requestDevice(options: {
      filters?: { namePrefix?: string; services?: BluetoothServiceUUID[] }[]
      optionalServices?: BluetoothServiceUUID[]
    }): Promise<BluetoothDeviceLike>
    getDevices?(): Promise<BluetoothDeviceLike[]>
    getAvailability?(): Promise<boolean>
  }
}

/** Web Bluetooth 是否可用（Chrome/Edge 桌面 + Android；iOS Safari 无此 API） */
export function webBluetoothAvailable(): boolean {
  return typeof (navigator as NavigatorBluetooth).bluetooth !== 'undefined'
}

/**
 * 没有任何免面板路径可用（无同会话绑定对象 + 浏览器没有 getDevices()）。
 * stable Chrome 把 getDevices() gating 在实验特性
 * chrome://flags/#enable-web-bluetooth-new-permissions-backend 后面 ——
 * 页面刷新后的自动重连在该配置下必然失败，deviceStore 据此立即停手，
 * 不烧完 5 轮退避给用户「正在努力重连」的假象。
 */
export class NoSilentReconnectError extends Error {
  constructor() {
    super(
      '浏览器没有 getDevices()（stable Chrome 默认关闭，chrome://flags/#enable-web-bluetooth-new-permissions-backend 可开）—— 页面刷新后无法免面板重连',
    )
    this.name = 'NoSilentReconnectError'
  }
}

export class IpsDevice {
  private info: DeviceInfo = { connected: false }
  private writeQueue = Promise.resolve()
  /** 每个槽位「最后传上去的那套图」的指纹（轮播去重用，语义同原版 device.ts） */
  private readonly imageKeys = new Map<number, string>()
  /**
   * 每个槽位「屏上就是这套内容」的确认时刻（对齐 ext SlotContent.confirmedAt）。
   * 设备协议读不到屏上内容 —— 这条记录是「设备上现在是什么」的唯一来源。
   * 推送完成自动确认；用户点「确认」也写这里；新一次推送开始即作废（屏上即将被换掉）。
   */
  private readonly slotConfirmedAt = new Map<number, number>()
  /** 当前绑定的 Web Bluetooth 设备（private；id 经 savedDeviceId() 暴露给 hook 存档） */
  private device: BluetoothDeviceLike | null = null
  /** gattserverdisconnected 处理器（attach 先移除旧的再挂，防重连泄漏） */
  private disconnectHandler: (() => void) | null = null
  /** characteristicvaluechanged 处理器（重绑/断开前摘除，防通知重复回调） */
  private rxHandler: ((event: Event) => void) | null = null
  private tx: BluetoothRemoteGATTCharacteristic | null = null
  private rx: BluetoothRemoteGATTCharacteristic | null = null
  private readonly cb: IpsDeviceCallbacks
  /** 用户主动断开时置位：gattserverdisconnected 事件里区分「主动/掉线」 */
  private userDisconnect = false
  /** 连接代次：disconnect/abortConnect 递增；attach 完成时若已换代则静默作废，
   *  防止「用户已断开/喊停，但在途的 gatt.connect 才兑现」把状态翻回 connected。 */
  private connectionEpoch = 0

  constructor(cb: IpsDeviceCallbacks = {}) {
    this.cb = cb
  }

  get connected(): boolean {
    return this.info.connected && Boolean(this.device?.gatt?.connected)
  }

  getInfo(): DeviceInfo {
    return { ...this.info }
  }

  /** 当前绑定设备的 Web Bluetooth id（未绑定 null）—— hook 存档免面板重连用 */
  savedDeviceId(): string | null {
    return this.device?.id ?? null
  }

  /**
   * 槽位指纹：整套图逐字节串接后 sha256（WebCrypto；原版用 node:crypto sha1，语义一致）。
   * 串接再哈希而不是逐张哈希拼接：避免「两套图互相交换某张」时指纹碰撞。
   */
  static async imageKey(images: readonly Uint8Array[]): Promise<string> {
    const total = images.reduce((n, img) => n + img.byteLength, 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const img of images) {
      joined.set(img, offset)
      offset += img.byteLength
    }
    const digest = await crypto.subtle.digest('SHA-256', joined)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** 该槽位最后上传的图组指纹（本次连接内没传过则 undefined） */
  imageKeyOf(style: number): string | undefined {
    return this.imageKeys.get(style)
  }

  /**
   * 连接设备：requestDevice 系统面板选设备 → GATT 连接 → 找 NUS 服务 →
   * 订阅 RX 通知 → 读一轮状态。
   * 已保存设备（savedId 非空）时先试免面板重连。
   *
   * allowPanel（默认 true）：是否允许回落 requestDevice 系统面板。
   * 面板必须由用户手势触发 —— 页面加载/定时重连等自动路径传 false，
   * 免面板重连失败就直接抛错（Chrome 会拒绝无手势的 requestDevice：
   * "Must be handling a user gesture to show a permission request."），
   * 把「选设备」留给用户点击「连接设备」按钮。
   */
  async connect(savedId?: string, opts: { allowPanel?: boolean } = {}): Promise<void> {
    const nav = navigator as NavigatorBluetooth
    if (!nav.bluetooth) {
      throw new Error(
        '当前浏览器不支持 Web Bluetooth（需要桌面 Chrome/Edge 或 Android Chrome；iOS Safari 不支持）',
      )
    }
    const allowPanel = opts.allowPanel !== false
    // 先试已保存设备的免面板重连（Chrome 允许对已授权设备静默重连）
    if (savedId) {
      let isSilentlyConnected = false
      try {
        isSilentlyConnected = await this.connectSaved(nav, savedId)
      } catch (cause) {
        if (!allowPanel) {
          throw new Error(
            `自动重连失败（${cause instanceof Error ? cause.message : String(cause)}）—— 请点击「连接设备」重新选择`,
          )
        }
        // 手势内静默回落系统面板（保存的设备可能已被系统遗忘/权限过期/不在范围）
      }
      // 没有任何静默路径：自动路径就此放弃（NoSilentReconnectError），手势路径落到下方 requestDevice 面板
      if (!isSilentlyConnected && !allowPanel) throw new NoSilentReconnectError()
    } else if (!allowPanel) {
      throw new Error('没有已保存的设备 —— 请点击「连接设备」选择（浏览器要求设备选择面板必须由用户点击触发）')
    }
    const device = await nav.bluetooth.requestDevice({
      filters: [{ namePrefix: 'miHoYo' }, { namePrefix: 'IPS' }],
      optionalServices: [BLE.service],
    })
    await this.attach(device)
  }

  /**
   * 免面板重连已保存设备。resolve 是否走通了静默路径；false = 浏览器没有
   * getDevices()（stable Chrome 把它 gating 在实验特性 web-bluetooth-new-permissions-backend
   * 后面），调用方自行决定回落面板还是放弃。
   *
   * 两条静默路径，按可用性择一：
   * - 同会话内（页面没刷新过）：上次绑定的 BluetoothDevice 对象还活着，
   *   直接对它 gatt.connect() —— web.dev 官方重连模式，不依赖任何实验特性；
   * - 跨刷新：getDevices() 枚举已授权设备按 id 匹配（需要上述实验特性）。
   */
  private async connectSaved(nav: NavigatorBluetooth, id: string): Promise<boolean> {
    // 同会话绑定对象还在（id 一定一致 —— 绑定即来自 savedId 路径或 persistDevice）
    if (this.device) {
      await this.attach(this.device)
      return true
    }
    const bt = nav.bluetooth
    if (!bt?.getDevices) return false
    const known = await bt.getDevices()
    const hit = known.find((d) => d.id === id)
    if (!hit) throw new Error('设备已被系统遗忘')
    await this.attach(hit)
    return true
  }

  /** 事务式摘除当前绑定的 GATT 断线 / RX 通知监听（换绑/断开时调用，防重复回调） */
  private teardownListeners(): void {
    if (this.disconnectHandler && this.device) {
      this.device.removeEventListener?.('gattserverdisconnected', this.disconnectHandler)
    }
    if (this.rxHandler && this.rx) {
      this.rx.removeEventListener?.('characteristicvaluechanged', this.rxHandler)
    }
    this.disconnectHandler = null
    this.rxHandler = null
  }

  /** 绑定设备：GATT 连接 + NUS 特征值就位 + 断线监听 + 状态读取。
   *
   * 事务式提交：GATT/特征值全部就绪、且代次仍最新后，才把本次绑定写入 this.*
   * 并挂监听。期间若用户断开/喊停/被更新的连接取代（connectionEpoch 已变），
   * 静默断开本次 GATT，不向 store 报 connected —— 否则在途的 gatt.connect 兑现
   * 会把状态翻回 connected（用户已断开/停止却显示已连接）。 */
  private async attach(device: BluetoothDeviceLike): Promise<void> {
    if (!device.gatt) throw new Error('设备无 GATT（不是 BLE 设备？）')
    const epoch = ++this.connectionEpoch
    await device.gatt.connect()
    const service = await device.gatt.getPrimaryService(BLE.service)
    const tx = await service.getCharacteristic(BLE.tx)
    const rx = await service.getCharacteristic(BLE.rx)
    if (!rx || !tx) throw new Error('设备缺少 Nordic UART 服务（可能不是立牌）')
    await rx.startNotifications()
    // 等待期间被 disconnect()/abortConnect()/更新的连接取代 → 拆除本次，不报状态。
    // 先摘旧监听再断 GATT：getDevices() 常返回同一对象，残留在上面的 disconnectHandler
    // 会收到 gattserverdisconnected → 误报 disconnected → 把自动重连重新武装起来。
    if (epoch !== this.connectionEpoch) {
      this.teardownListeners()
      try {
        device.gatt.disconnect()
      } catch {
        /* 断线中的设备再 disconnect 会抛，吞掉 */
      }
      return
    }
    // 先摘旧连接的监听再挂新的：getDevices() 每次返回同一对象，重连会累积 N 个
    // gattserverdisconnected / characteristicvaluechanged 回调（一次掉线/收包触发 N 次）。
    this.teardownListeners()
    this.device = device
    this.tx = tx
    this.rx = rx
    this.userDisconnect = false
    this.disconnectHandler = () => {
      this.info.connected = false
      const userInitiated = this.userDisconnect
      this.userDisconnect = false
      this.cb.onInfo?.({ ...this.info, connected: false })
      this.cb.onConnection?.('disconnected', userInitiated ? '已断开' : '设备已断开', userInitiated)
    }
    device.addEventListener('gattserverdisconnected', this.disconnectHandler)
    this.rxHandler = (event: Event) => {
      const target = event.target as unknown as {
        value?: DataView
      }
      if (target.value) this.receive(new Uint8Array(target.value.buffer, target.value.byteOffset, target.value.byteLength))
    }
    this.rx.addEventListener('characteristicvaluechanged', this.rxHandler)
    this.info = { connected: true, name: device.name ?? 'IPS 设备' }
    this.cb.onInfo?.({ ...this.info })
    this.cb.onConnection?.('connected', this.info.name ?? 'IPS 设备')
    this.cb.onLog?.(`已连接 ${this.info.name}`, 'system')
    await this.readStatus()
  }

  /** 使任何在途的 attach 作废（用户喊停自动重连，但 gatt.connect 还没兑现时） */
  abortConnect(): void {
    this.connectionEpoch++
  }

  async disconnect(): Promise<void> {
    // 递增代次：任何在途的 attach 即使 gatt.connect 兑现，也不会再报 connected
    this.connectionEpoch++
    this.userDisconnect = true
    try {
      this.device?.gatt?.disconnect()
    } catch {
      /* 断线中的设备再 disconnect 会抛，吞掉 */
    }
    this.teardownListeners()
    // 手动断开即解绑：同会话免面板路径不得把用户明确松开的设备又静默挂回，
    // 下次连接重走面板（可换设备）。掉线（非手动）不清绑定 —— 同会话自动重连全靠它。
    this.device = null
    this.tx = null
    this.rx = null
    // 保留已读到的固件/IP/槽位等（此前整份清空 → deviceStore 滞留陈旧快照或假连接态）
    this.info = { ...this.info, connected: false }
    this.cb.onInfo?.({ ...this.info })
    this.cb.onConnection?.('disconnected', '已断开', true)
  }

  /** 读一轮设备状态（固件/硬件/IP/存储/MAC/槽位/灯效） */
  async readStatus(): Promise<void> {
    await this.sendMany([
      packet(Command.getFirmwareVersion),
      packet(Command.getHardwareVersion),
      packet(Command.getWifiIp),
      packet(Command.getDeviceStorage),
      packet(Command.getWifiMac),
      packet(Command.getClockStyle),
      packet(Command.getLightMode),
      packet(Command.getLightBrightness),
      packet(Command.getLightColor),
    ])
  }

  async configureWifi(ssid: string, password: string): Promise<void> {
    const encoder = new TextEncoder()
    await this.sendMany([
      packet(Command.setWifiSsid, encoder.encode(ssid)),
      packet(Command.setWifiPassword, encoder.encode(password)),
      packet(Command.setWifiStatus, [8]),
    ])
    this.cb.onLog?.('已下发 Wi‑Fi 凭据；请等待设备连接网络。', 'system')
  }

  async setClockStyle(style: number): Promise<void> {
    await this.send(packet(Command.setClockStyle, [style]))
    this.info.clockStyle = style
    this.cb.onInfo?.({ ...this.info })
  }

  /** 该槽位的确认时刻（undefined = 没确认过/已被新推送作废） */
  slotConfirmedAtOf(style: number): number | undefined {
    return this.slotConfirmedAt.get(style)
  }

  /** 用户点「确认」：屏上就是这个内容，把回显刷成当前配置（不重推） */
  confirmSlot(style: number): void {
    this.slotConfirmedAt.set(style, Date.now())
    this.cb.onInfo?.({ ...this.info })
  }
  /** 发任意命令号的裸帧（协议探测用） */
  sendRaw(command: number, payload: Iterable<number> = []): Promise<void> {
    return this.send(packet(command, payload))
  }

  setBrightness(value: number): Promise<void> {
    return this.send(packet(Command.setLightBrightness, [value]))
  }

  setLightMode(mode: number): Promise<void> {
    return this.send(packet(Command.setLightMode, [mode]))
  }

  setLightColor(red: number, green: number, blue: number): Promise<void> {
    return this.send(packet(Command.setLightColor, [red, green, blue]))
  }

  async setTime(options: {
    timezoneQuarterHours: number
    use24Hour: boolean
    useNetworkTime: boolean
    timestamp?: number
  }): Promise<void> {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
    await this.sendMany([
      packet(Command.setNetworkTime, [Number(options.useNetworkTime)]),
      packet(Command.setTimeZone, [options.timezoneQuarterHours & 0xff]),
      packet(Command.setTimeFormat, [Number(!options.use24Hour)]),
      packet(Command.setTimestamp, timestampBytes(timestamp)),
    ])
  }

  async setWeather(options: { enabled: boolean; locationId: string; fahrenheit: boolean }): Promise<void> {
    const encoder = new TextEncoder()
    await this.sendMany([
      packet(Command.setWeatherLocation, encoder.encode(options.locationId.trim())),
      packet(Command.setTemperatureUnit, [Number(options.fahrenheit)]),
      packet(Command.setWeatherVisible, [Number(options.enabled)]),
    ])
  }

  setFirmwareAddress(url: string): Promise<void> {
    return this.send(packet(Command.setFirmwareAddress, new TextEncoder().encode(url.trim())))
  }

  reboot(): Promise<void> {
    return this.send(packet(Command.rebootDevice))
  }

  factoryReset(): Promise<void> {
    return this.send(packet(Command.factoryReset))
  }

  /**
   * 蓝牙传图（时序与原版 device.ts sendImage 一致）：
   * imageSum → setUpgradeMode(2) → [imageStart / imageData(500B 分包) / imageEnd]×N
   * → setUpgradeMode(0) → setWeatherVisible(0) → setClockStyle(style)（切到该槽位）。
   * 传完才记指纹：中途失败时槽位是半套，不能让轮播以为「已是这套」而跳过重传。
   */
  async sendImage(
    images: Uint8Array[],
    style: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    // 新一次推送开始 = 旧确认作废（屏上内容即将被换掉，确认只针对「现在屏上这套」）
    this.slotConfirmedAt.delete(style)
    const chunkSize = BLE.mtu // 500
    const encoder = new TextEncoder()
    const frames: Uint8Array[] = []
    let counted = 1
    let done = 1
    for (const [index, image] of images.entries()) {
      const filename = encoder.encode(`/style${style}/${index}.jpg`)
      frames.push(packet(Command.imageStart, filename))
      counted++
      for (let offset = 0; offset < image.length; offset += chunkSize) {
        frames.push(packet(Command.imageData, image.slice(offset, offset + chunkSize)))
        counted++
      }
      frames.push(packet(Command.imageEnd))
      counted++
    }
    onProgress?.(0, counted)
    await this.send(packet(Command.imageSum, [(counted >> 8) & 0xff, counted & 0xff]))
    await this.send(packet(Command.setUpgradeMode, [2]))
    onProgress?.(done, counted)
    for (const frame of frames) {
      // 写队列串行：一次一帧，保序 + 失败不污染后续（语义同原版）
      await this.send(frame)
      done++
      onProgress?.(done, counted)
    }
    await this.send(packet(Command.setUpgradeMode, [0]))
    await this.send(packet(Command.setWeatherVisible, [0]))
    await this.setClockStyle(style)
    const key = await IpsDevice.imageKey(images)
    this.imageKeys.set(style, key)
    // 推送完成 = 系统自己知道屏上就是这套内容，自动确认（不用用户再点）
    this.slotConfirmedAt.set(style, Date.now())
  }

  private async sendMany(packets: Uint8Array[]): Promise<void> {
    for (const item of packets) await this.send(item)
  }

  /** 串行写一帧（写队列语义与原版 device.ts.send 一致） */
  private send(frame: Uint8Array): Promise<void> {
    const cmd = frame[1] ?? -1
    const attempt = this.writeQueue.then(async () => {
      if (!this.info.connected || !this.tx) throw new Error('设备未连接，请重新连接')
      this.cb.onLog?.(`${commandName(cmd)} [${frame.length}B] ${hex(frame)}`, 'out')
      // GATT 写上限 512B；帧最大 504B（MTU 500 + 0xA5,cmd,checksum,0x5A 各 1）。
      // ArrayBufferView 分离问题：copy 出独立 buffer（部分 Chrome 版本 writeValue
      // 对 offset≠0 的 view 会拒绝）。
      const copy = new Uint8Array(frame.byteLength)
      copy.set(frame)
      await this.tx.writeValue(copy.buffer as ArrayBuffer)
    })
    // 队列健康：本次失败不污染后续（原版同款注释语义）
    this.writeQueue = attempt.catch(() => undefined)
    return attempt
  }

  private receive(value: Uint8Array): void {
    const packetValue = decodePacket(
      new DataView(value.buffer, value.byteOffset, value.byteLength),
    )
    const cmd = packetValue ? commandName(packetValue.command) : '?'
    this.cb.onLog?.(
      `${cmd} [${value.length}B] ${hex(value)}${packetValue?.checksumValid === false ? '  [校验失败]' : ''}`,
      'in',
    )
    if (packetValue) this.apply(packetValue)
  }

  /** 解析设备响应（A5, cmd, status(0=成功), data..., checksum, 5A）—— 逻辑与原版一致 */
  private apply(response: DecodedPacket): void {
    const [status] = response.payload
    const body = response.payload.slice(1)
    const name = commandName(response.command)
    if (status === undefined || status !== 0) {
      this.cb.onLog?.(`${name} ← 设备返回失败状态：${status ?? '缺失'}`, 'system')
      return
    }
    switch (response.command) {
      case Command.getFirmwareVersion:
        this.info.firmware = text(body)
        break
      case Command.getHardwareVersion:
        this.info.hardware = text(body)
        break
      case Command.getWifiIp:
        this.info.ip = [...body].join('.')
        break
      case Command.getDeviceStorage:
        this.info.storage = `${Math.round(
          ((((body[0] ?? 0) + ((body[1] ?? 0) << 8) + ((body[2] ?? 0) << 16) + ((body[3] ?? 0) << 24)) >>> 0) /
            1000),
        )} KB`
        break
      case Command.getWifiMac:
        this.info.mac = Array.from(body, (v) => v.toString(16).padStart(2, '0')).join(':')
        break
      case Command.getClockStyle:
        this.info.clockStyle = body[0] ?? 0
        break
      // 设备真值对账：readStatus 一直有请求这三个，但此前没有 case →
      // 落到 default 只 log「已确认」，DeviceInfo 永远不带亮度/灯效 → UI 只能造默认值。
      case Command.getLightMode:
        this.info.lightMode = body[0]
        break
      case Command.getLightBrightness:
        this.info.brightness = body[0]
        break
      case Command.getLightColor:
        this.info.lightColor = body.length >= 3 ? `#${[body[0], body[1], body[2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}` : undefined
        break
      default:
        this.cb.onLog?.(`${name} ← 设备已确认`, 'system')
        return
    }
    this.cb.onInfo?.({ ...this.info })
  }
}
