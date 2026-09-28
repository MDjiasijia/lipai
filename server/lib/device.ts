import { createHash } from 'node:crypto';
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
} from '../protocol.js';
import type { BleBridge } from './ble-bridge.js';
import {
  DEVICE_NAME_PREFIXES,
  isFullDeviceName,
  matchDeviceByCode,
  type DeviceInfo,
} from '../shared/index.js';

export type LogDirection = 'in' | 'out' | 'system';

/**
 * IPS 设备控制器(Node 版)。
 *
 * 复用 `protocol.ts` 帧编解码(与网页版 bluetooth.ts 同源),把 Web Bluetooth
 * 换成 BleBridge(Rust/btleplug 原生二进制子进程)。BleBridge 负责把编好的帧字节写到 BLE
 * TX 特征值、把 RX 通知字节传回;本类只管协议层收发与设备状态。
 */
export class IpsDevice {
  private info: DeviceInfo = { connected: false };
  private writeQueue = Promise.resolve();
  /**
   * 每个槽位上「最后传上去的那套图」的指纹。
   *
   * 给轮播用:内容和设备上现有的一样就别再传一遍(一套 6 张要 10-20 秒蓝牙)。
   * 记在 device 而不是轮播模块里,因为**所有**推送都得算进来 —— 用户从投屏页手动推了别的图,
   * 轮播那边就必须知道槽位内容已经变了,否则会跳过一次该做的推送、屏上停在手动推的内容上。
   */
  private readonly imageKeys = new Map<number, string>();
  private readonly bridge: BleBridge;
  private readonly onLog: (message: string, direction?: LogDirection) => void;
  private readonly onInfo: (info: DeviceInfo) => void;
  private readonly onConnection: (
    state: 'connected' | 'disconnected',
    detail: string,
    userInitiated?: boolean,
  ) => void;

  constructor(
    bridge: BleBridge,
    onLog: (message: string, direction?: LogDirection) => void,
    onInfo: (info: DeviceInfo) => void,
    onConnection: (
      state: 'connected' | 'disconnected',
      detail: string,
      userInitiated?: boolean,
    ) => void,
  ) {
    this.bridge = bridge;
    this.onLog = onLog;
    this.onInfo = onInfo;
    this.onConnection = onConnection;
    bridge.onNotify((dataHex) => this.receive(Uint8Array.from(Buffer.from(dataHex, 'hex'))));
    bridge.onDisconnect(() => {
      this.info.connected = false;
      // 桥进程报告的断开 = 设备真掉线 / 桥进程死亡,不是用户主动断的。
      this.onConnection('disconnected', '设备已断开', false);
    });
  }

  get connected(): boolean {
    return this.info.connected;
  }

  /**
   * 一套图的指纹。sha1 而不是逐字节比:调用方拿它和上次的比较,
   * 一套 6 张约 160KB,算一次不到 1ms,比在轮播里存一份图省内存也省事。
   */
  static imageKey(images: readonly Uint8Array[]): string {
    const h = createHash('sha1');
    for (const img of images) h.update(img);
    return h.digest('hex');
  }

  /** 这个槽位上最后传上去的那套图的指纹(本次连接内没传过则 undefined)。 */
  imageKeyOf(style: number): string | undefined {
    return this.imageKeys.get(style);
  }

  getInfo(): DeviceInfo {
    return { ...this.info };
  }

  /**
   * 把用户填的**设备码**解析成扫描到的完整广播名 + 地址。
   *
   * 原生层按名字连是**全等**匹配(rust scan_first_match),而屏幕上给用户看的只有设备码
   * `31C2C6`,广播名却是 `前缀_31C2C6` —— 直接拿设备码去连必然「未找到匹配设备」。
   * 这里先扫一遍,把设备码对上真名,再按地址+真名连(比让原生层反复猜前缀快且确定)。
   */
  private async resolveDeviceCode(input: string): Promise<{ name: string; address: string }> {
    this.onLog(`「${input}」看着是设备码,先扫描找出它的完整设备名…`, 'system');
    const devices = await this.listDevices();
    const hit = matchDeviceByCode(devices, input);
    if (!hit) {
      const seen = devices.length ? devices.map((d) => d.name).join('、') : '(一台都没扫到)';
      throw new Error(
        `没找到设备码「${input}」对应的设备。本次扫到:${seen}。请确认设备已开机、在附近。`,
      );
    }
    this.onLog(`设备码「${input}」→ ${hit.name}`, 'system');
    return hit;
  }

  async connect(options?: {
    address?: string;
    name?: string;
    scanTimeout?: number;
  }): Promise<void> {
    // 只给了设备码(没带广播名前缀)时先解析成真名 —— 否则原生层全等匹配连不上。
    // 已有 address 的走直连快路径,不必解析。
    let target = options;
    if (options?.name && !options.address && !isFullDeviceName(options.name)) {
      const hit = await this.resolveDeviceCode(options.name);
      target = { ...options, name: hit.name, address: hit.address };
    }
    const base = {
      name_prefix: [...DEVICE_NAME_PREFIXES],
      service: BLE.service,
      tx: BLE.tx,
      rx: BLE.rx,
      ...(target?.scanTimeout !== undefined ? { scan_timeout: target.scanTimeout } : {}),
    };
    const doConnect = (extra: Record<string, unknown>) =>
      this.bridge.request('connect', { ...base, ...extra });
    // 首选按给定参数连:有 address 走「跳过扫描直连」快路径(macOS 稳)。
    // Windows/btleplug 按地址直连偶发 "Not connected" / "未找到设备" —— 有设备名时
    // 回退到「扫描后按名字连」(实测稳定),丢掉 address 重试一次。
    const resp = await doConnect({
      ...(target?.address ? { address: target.address } : {}),
      ...(target?.name ? { name: target.name } : {}),
    }).catch((err: unknown) => {
      if (!target?.address || !target?.name) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.onLog(`按地址连接失败(${msg}),改用名字重试…`, 'system');
      return doConnect({ name: target.name });
    });
    if (!resp.ok) throw new Error(resp.error ?? '连接失败');
    this.info = { connected: true, name: resp.name as string };
    this.onConnection('connected', this.info.name ?? 'IPS 设备');
    this.onLog(`已连接 ${this.info.name ?? '设备'}`, 'system');
  }

  /** 扫描匹配前缀的设备,返回列表(不连接)。供用户/AI 选择要连的设备。 */
  async listDevices(): Promise<{ name: string; address: string }[]> {
    const resp = await this.bridge.request(
      'scan',
      { name_prefix: [...DEVICE_NAME_PREFIXES] },
      15_000,
    );
    if (!resp.ok) throw new Error(resp.error ?? '扫描失败');
    return (resp.devices as { name: string; address: string }[]) ?? [];
  }

  async disconnect(userInitiated = false): Promise<void> {
    // 3s 短超时(对齐 bridge.stop 内的 disconnect):桥侧本身有 3s 超时兜底,
    // 这里等 30s 默认值只会让「断开」按钮在死桥上白转半分钟才给反馈。
    await this.bridge.request('disconnect', {}, 3_000).catch(() => null);
    this.info.connected = false;
    this.onConnection('disconnected', '已断开', userInitiated);
  }

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
    ]);
  }

  async configureWifi(ssid: string, password: string): Promise<void> {
    const encoder = new TextEncoder();
    await this.sendMany([
      packet(Command.setWifiSsid, encoder.encode(ssid)),
      packet(Command.setWifiPassword, encoder.encode(password)),
      packet(Command.setWifiStatus, [8]),
    ]);
    this.onLog('已下发 Wi‑Fi 凭据;请等待设备连接网络。', 'system');
  }

  async setClockStyle(style: number): Promise<void> {
    await this.send(packet(Command.setClockStyle, [style]));
    // 设备已切到该槽位:记下来 + 推给 UI(● 屏 / 槽位条「显示中」用实报值,不靠猜)
    this.info.clockStyle = style;
    this.onInfo({ ...this.info });
  }

  /** 发任意命令号的裸帧(协议探测/实验用,复用写队列保证串行)。 */
  sendRaw(command: number, payload: Iterable<number> = []): Promise<void> {
    return this.send(packet(command, payload));
  }

  setBrightness(value: number): Promise<void> {
    return this.send(packet(Command.setLightBrightness, [value]));
  }

  setLightMode(mode: number): Promise<void> {
    return this.send(packet(Command.setLightMode, [mode]));
  }

  setLightColor(red: number, green: number, blue: number): Promise<void> {
    return this.send(packet(Command.setLightColor, [red, green, blue]));
  }

  async setTime(options: {
    timezoneQuarterHours: number;
    use24Hour: boolean;
    useNetworkTime: boolean;
    timestamp?: number;
  }): Promise<void> {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    await this.sendMany([
      packet(Command.setNetworkTime, [Number(options.useNetworkTime)]),
      packet(Command.setTimeZone, [options.timezoneQuarterHours & 0xff]),
      packet(Command.setTimeFormat, [Number(!options.use24Hour)]),
      packet(Command.setTimestamp, timestampBytes(timestamp)),
    ]);
  }

  async setWeather(options: {
    enabled: boolean;
    locationId: string;
    fahrenheit: boolean;
  }): Promise<void> {
    const encoder = new TextEncoder();
    await this.sendMany([
      packet(Command.setWeatherLocation, encoder.encode(options.locationId.trim())),
      packet(Command.setTemperatureUnit, [Number(options.fahrenheit)]),
      packet(Command.setWeatherVisible, [Number(options.enabled)]),
    ]);
  }

  setFirmwareAddress(url: string): Promise<void> {
    return this.send(packet(Command.setFirmwareAddress, new TextEncoder().encode(url.trim())));
  }

  reboot(): Promise<void> {
    return this.send(packet(Command.rebootDevice));
  }

  factoryReset(): Promise<void> {
    return this.send(packet(Command.factoryReset));
  }

  /**
   * 蓝牙传图(长任务用,调用方负责传 onProgress)。
   * 时序与网页版 bluetooth.ts sendImage 一致(复刻原小程序 packingImages)。
   */
  async sendImage(
    images: Uint8Array[],
    style: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const chunkSize = BLE.mtu, // 500
      encoder = new TextEncoder(),
      frames: Uint8Array[] = [];
    let counted = 1,
      done = 1;
    for (const [index, image] of images.entries()) {
      const filename = encoder.encode(`/style${style}/${index}.jpg`);
      frames.push(packet(Command.imageStart, filename));
      counted++;
      for (let offset = 0; offset < image.length; offset += chunkSize) {
        frames.push(packet(Command.imageData, image.slice(offset, offset + chunkSize)));
        counted++;
      }
      frames.push(packet(Command.imageEnd));
      counted++;
    }
    onProgress?.(0, counted);

    await this.send(packet(Command.imageSum, [(counted >> 8) & 0xff, counted & 0xff]));
    await this.send(packet(Command.setUpgradeMode, [2]));
    onProgress?.(done, counted);
    for (const frame of frames) {
      // 蓝牙写队列必须串行:一次一帧,保证顺序且一次失败不污染后续。
      // oxlint-disable-next-line no-await-in-loop
      await this.send(frame);
      done++;
      onProgress?.(done, counted);
    }
    await this.send(packet(Command.setUpgradeMode, [0]));
    await this.send(packet(Command.setWeatherVisible, [0]));
    // 走 setClockStyle 而非裸包:传完设备切到该槽位,顺手把 info.clockStyle 记上 + 推给 UI
    await this.setClockStyle(style);
    // 传完才记指纹:中途失败时槽位内容是半套,不能让轮播以为「已经是这套了」而跳过重传
    this.imageKeys.set(style, IpsDevice.imageKey(images));
  }

  private async sendMany(packets: Uint8Array[]): Promise<void> {
    for (const item of packets) {
      // 蓝牙写队列必须串行:一次一帧,保证顺序且一次失败不污染后续。
      // oxlint-disable-next-line no-await-in-loop
      await this.send(item);
    }
  }

  private send(frame: Uint8Array): Promise<void> {
    const cmd = frame[1] ?? -1;
    // 串行化写入:与网页版一致用写队列保证顺序。
    // 一次失败不能污染后续请求 —— 直接 then 链会让 writeQueue 卡在 rejected,
    // 之后每个 send 都直接 reject、连写都不写(且错误是最早那条,误报)。
    // 所以把这次的 promise 返给调用方(该报错报错),队列这边 catch 掉保持健康。
    const attempt = this.writeQueue.then(async () => {
      // 设备已掉线就别再往死掉的 GATT 连接上写了 —— 省一次跨进程往返,
      // 也把底层 BleakError 翻成人话,让调用方(AI / UI)知道该重连而不是重试。
      if (!this.info.connected) throw new Error('设备未连接,请重新连接');
      this.onLog(`${commandName(cmd)} [${frame.length}B] ${hex(frame)}`, 'out');
      try {
        await this.bridge.request('write', { data: Buffer.from(frame).toString('hex') }, 60_000);
      } catch (err) {
        // BLE 断开会有个窗口:Python 的 disconnected 回调还没清掉 client,
        // write_gatt_char 就抛 BleakError: disconnected。这里翻成可操作的消息,
        // 否则 AI 拿到原始 BleakError 会一直重试(日志里见过一秒十几发)。
        const msg = err instanceof Error ? err.message : String(err);
        const friendly = msg.includes('disconnected') ? '设备已断开,请重新连接' : msg;
        throw new Error(friendly, { cause: err });
      }
    });
    this.writeQueue = attempt.catch(() => undefined);
    return attempt;
  }

  private receive(value: Uint8Array): void {
    const packetValue = decodePacket(
        new DataView(value.buffer, value.byteOffset, value.byteLength),
      ),
      cmd = packetValue ? commandName(packetValue.command) : '?';
    this.onLog(
      `${cmd} [${value.length}B] ${hex(value)}${packetValue?.checksumValid === false ? '  [校验失败]' : ''}`,
      'in',
    );
    if (packetValue) this.apply(packetValue);
  }

  private apply(response: DecodedPacket): void {
    // 设备响应格式:A5, command, result status(0=成功), data..., checksum, 5A。
    const [status] = response.payload,
      body = response.payload.slice(1),
      name = commandName(response.command);
    if (status === undefined || status !== 0) {
      this.onLog(`${name} ← 设备返回失败状态:${status ?? '缺失'}`, 'system');
      return;
    }
    switch (response.command) {
      case Command.getFirmwareVersion: {
        this.info.firmware = text(body);
        break;
      }
      case Command.getHardwareVersion: {
        this.info.hardware = text(body);
        break;
      }
      case Command.getWifiIp: {
        this.info.ip = [...body].join('.');
        break;
      }
      case Command.getDeviceStorage: {
        this.info.storage = `${Math.round((((body[0] ?? 0) + ((body[1] ?? 0) << 8) + ((body[2] ?? 0) << 16) + ((body[3] ?? 0) << 24)) >>> 0) / 1000)} KB`;
        break;
      }
      case Command.getWifiMac: {
        this.info.mac = Array.from(body, (v) => v.toString(16).padStart(2, '0')).join(':');
        break;
      }
      case Command.getClockStyle: {
        // 当前激活槽位(0-3):「● 屏 / 槽位条显示中」用设备实报值。
        // 之前落进 default 只记「已确认」,把这条信息丢了。
        this.info.clockStyle = body[0] ?? 0;
        break;
      }
      default: {
        // set 类命令:设备已确认(status 0)
        this.onLog(`${name} ← 设备已确认`, 'system');
        return;
      }
    }
    this.onInfo({ ...this.info });
  }
}
