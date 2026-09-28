import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync } from 'node:fs';
/** 极简日志接口(服务端用 console 实现)。 */
export interface LoggerLike {
  info(data: Record<string, unknown>, msg?: string): void;
  warn(data: Record<string, unknown>, msg?: string): void;
  error?(data: Record<string, unknown>, msg?: string): void;
}

/** Python 子进程的 JSON 请求(Node → Python)。 */
interface BleRequest {
  id: number;
  method: string;
  [k: string]: unknown;
}

/** Python 子进程的 JSON 响应/通知(Python → Node)。 */
interface BleMessage {
  id?: number;
  event?: 'notify' | 'disconnected' | 'log';
  ok?: boolean;
  error?: string;
  data?: string;
  reason?: string;
  level?: string;
  msg?: string;
  [k: string]: unknown;
}

interface Pending {
  resolve: (v: BleMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 管理 ble-bridge 原生二进制(Rust/btleplug)子进程的生命周期与 JSON 行协议。
 *
 * - `start()` spawn ble-bridge-<triple>(.exe),跑 handshake 验证 BLE 可用。
 * - `request(method, args)` 发一行 JSON 请求,Promise 化等对应 id 的响应。
 * - notify/disconnected 事件通过回调转发给 IpsDevice。
 * - `stop()` 优雅断开设备 + SIGTERM + 超时 SIGKILL,reject 所有 pending。
 *
 * 协议与原 python/ble_controller.py 完全一致 —— 二进制只是一个更省事的传输层
 * (无需用户装 Python/bleak),帧编解码仍在 Node 侧。
 */
export class BleBridge {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private notifyHandler: ((dataHex: string) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private logHandler: ((level: string, msg: string) => void) | null = null;
  private exitHandler: (() => void) | null = null;

  private readonly binaryPath: string;
  private readonly logger: LoggerLike;
  /** 是否在 stop+start 自愈中(防重入)。 */
  private recovering = false;

  constructor(binaryPath: string, logger: LoggerLike) {
    this.binaryPath = binaryPath;
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    // 兜底可执行位:扩展经 zip 发布到市场后,解压出的 ble-bridge 二进制可能丢失
    // 可执行权限(publish 打包未保留权限位,实测解压后为 0o0 不可执行)→ spawn EACCES
    // → 二进制没跑起来 → handshake 永远无响应 → Node 干等 15s 超时。spawn 前 chmod +x
    // 兜底(Windows 不需要,exe 不靠权限位)。chmod 失败不阻断:Windows 下 chmod 是 noop,
    // 真 EACCES 会在 spawn 时暴露给自愈逻辑。
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.binaryPath, 0o755);
      } catch {
        /* 文件不存在 / 无权改:交给 spawn 报错 */
      }
    }
    this.logger.info({ binary: this.binaryPath }, 'starting ble-bridge');
    this.proc = spawn(this.binaryPath, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', this.onStdout);
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk: string) => {
      // 二进制未捕获的 panic/异常走 stderr,记下来排查
      this.logger.warn({ stderr: chunk.trim() }, 'ble-bridge stderr');
    });
    this.proc.on('exit', this.onExit);

    // handshake 验证 BLE 可用(radio 未开等会返回 ok:false)。
    const resp = await this.request('handshake', {}, 15_000);
    if (!resp.ok) {
      await this.stop();
      throw new Error(resp.error ?? 'BLE 不可用');
    }
    this.logger.info({ version: resp.bleak_version }, 'ble-bridge ready');
  }

  async request(
    method: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<BleMessage> {
    if (!this.proc?.stdin) throw new Error('ble-bridge 未启动');
    try {
      return await this.requestOnce(method, args, timeoutMs);
    } catch (err) {
      // POWERED_OFF 自愈:BLE manager 在子进程启动时绑定 radio 状态,
      // 启动时 radio 关着 → 之后即使开了系统蓝牙,这个进程仍持续报 POWERED_OFF。
      // 重建子进程(stop+start)= 重新探测 radio,新进程出生在「蓝牙已开」时代即可恢复。
      // 只对会触碰 radio 的方法(scan/connect)触发,且只重试一次,防无限循环。
      const msg = err instanceof Error ? err.message : String(err);
      const isPoweredOff =
        msg.includes('POWERED_OFF') ||
        msg.includes('radio is not powered') ||
        msg.includes('Bluetooth radio');
      if (!isPoweredOff || this.recovering) throw err;
      if (method !== 'scan' && method !== 'connect') throw err;
      this.logger.warn({ method, msg }, 'ble-bridge POWERED_OFF, recovering (stop+start)');
      await this.recover();
      return this.requestOnce(method, args, timeoutMs);
    }
  }

  /** 单次发请求(不做自愈),request 的内部实现。 */
  private requestOnce(
    method: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<BleMessage> {
    if (!this.proc?.stdin) throw new Error('ble-bridge 未启动');
    const id = ++this.seq,
      line = `${JSON.stringify({ id, method, ...args } satisfies BleRequest)}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ble 请求 ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(line);
    });
  }

  /** stop + start 重建子进程(POWERED_OFF 自愈用)。 */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.stop();
      await this.start();
    } finally {
      this.recovering = false;
    }
  }

  onNotify(fn: (dataHex: string) => void): void {
    this.notifyHandler = fn;
  }

  onDisconnect(fn: () => void): void {
    this.disconnectHandler = fn;
  }

  onLog(fn: (level: string, msg: string) => void): void {
    this.logHandler = fn;
  }

  onExitEvent(fn: () => void): void {
    this.exitHandler = fn;
  }

  get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /** 当前子进程 pid(未启动时为 null)。孤儿清扫时用来排除正在管理的进程。 */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    // 1. 尝试优雅断开设备(给 Python 机会清理 BLE 连接)
    try {
      await this.request('disconnect', {}, 3_000).catch(() => null);
    } catch {
      // 忽略,继续 kill
    }
    // 2. reject 所有 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('ble_controller 已停止'));
    }
    this.pending.clear();
    // 3. SIGTERM,超时 SIGKILL。
    // 注意:child.killed 在 kill('SIGTERM') 成功后立即置 true,不等进程真的退出,
    // 旧代码 `setTimeout(() => { if (!proc.killed) ... }, 2s)` 永远进不去 → 进程没死透就成了孤儿。
    // 改用 exitCode/signalCode 判活(进程真退出前一直是 null),确保 2s 后还会补一记 SIGKILL。
    const { proc } = this;
    this.proc = null;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      let sigkilled = false;
      const forceKill = setTimeout(() => {
        sigkilled = true;
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, 2_000);
      proc.once('exit', () => {
        if (!sigkilled) clearTimeout(forceKill);
      });
    }
  }

  private readonly onStdout = (chunk: string): void => {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      this.handleMessage(line);
    }
  };

  private handleMessage(raw: string): void {
    let msg: BleMessage;
    try {
      msg = JSON.parse(raw) as BleMessage;
    } catch {
      this.logger.warn({ line: raw }, 'ble_controller 输出非 JSON 行');
      return;
    }

    // 通知(无 id,异步)
    if (msg.event === 'notify') {
      if (msg.data) this.notifyHandler?.(msg.data);
      return;
    }
    if (msg.event === 'disconnected') {
      this.logger.info({ reason: msg.reason }, 'device disconnected');
      this.disconnectHandler?.();
      return;
    }
    if (msg.event === 'log') {
      this.logHandler?.(msg.level ?? 'info', msg.msg ?? '');
      return;
    }

    // 响应(有 id)
    if (msg.id != null) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg);
        else pending.reject(new Error(msg.error ?? `ble 请求失败(id=${msg.id})`));
      }
    }
  }

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.logger.warn({ code, signal }, 'ble_controller exited');
    this.proc = null;
    // reject 所有 pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`ble_controller 进程退出(code=${code}, signal=${signal})`));
    }
    this.pending.clear();
    this.exitHandler?.();
  };
}
