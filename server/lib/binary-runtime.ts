import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';


const execFileAsync = promisify(execFile);

/**
 * Rust ble-bridge 二进制定位 + 环境检查(替代 python-runtime.ts)。
 *
 * 二进制随扩展打包,按平台放在 <extRoot>/bin/ 下:
 * - Windows: bin/ble-bridge-x86_64-pc-windows-msvc.exe
 * - macOS:   bin/ble-bridge-aarch64-apple-darwin
 *            bin/ble-bridge-x86_64-apple-darwin
 * - Linux:   bin/ble-bridge-x86_64-unknown-linux-gnu
 *
 * 三平台预编译产物随包发布,用户侧零依赖(Python/bleak 不再需要)。
 * 来源:本仓库 `rust/ble-bridge/` crate(btleplug),Windows 上用
 * `rust/ble-bridge/build.bat` 编出三平台产物放进 bin/;
 * 完整性:bin/sha256sums.txt 清单随包发布,spawn 前核对(见 verifyBinarySha256)。
 */

/** 目标三元组 → 二进制文件名(无扩展名,Windows 再补 .exe)。 */
function targetTriple(): string {
  const platform = process.platform,
    arch = process.arch;
  if (platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (platform === 'darwin')
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux') return 'x86_64-unknown-linux-gnu';
  // 兜底:用 arch-platform 拼一个,大概率找不到 → checkEnvironment 返回 ok:false 引导。
  return `${arch}-${platform}`;
}

/** ble-bridge 文件名白名单:`ble-bridge-` + 平台三元组字样 + 可选 .exe,再无别的字符。 */
const BLE_BRIDGE_NAME_RE = /^ble-bridge-[a-z0-9_-]+(?:\.exe)?$/;

/** bin 目录(随包发布的原生二进制都在这;spawn 只认这个目录下的白名单文件名)。 */
export function bleBridgeBinDir(): string {
  // 本地服务从项目根启动;bin/ 与服务代码同级随项目分发。
  return path.join(process.cwd(), 'bin');
}

/**
 * 断言路径是一个合法的 ble-bridge 二进制路径:<extRoot>/bin/ 下、文件名匹配白名单。
 * 安全审查要求「限定可执行文件白名单路径」:ensureBridge spawn 前强制过这道闸,
 * 路径不是白名单形状(被篡改 / 拼进了用户输入)就当场抛错,不 spawn。
 *
 * `binDir` 只给单测注入假扩展根用,生产调用不传(默认真实 <extRoot>/bin)。
 */
export function assertBleBridgePathAllowed(binaryPath: string, binDir = bleBridgeBinDir()): void {
  const dir = path.dirname(path.resolve(binaryPath));
  const name = path.basename(binaryPath);
  if (dir !== path.resolve(binDir) || !BLE_BRIDGE_NAME_RE.test(name)) {
    throw new Error(
      `拒绝执行非白名单路径的二进制:${binaryPath}(只允许 ${binDir} 下 ble-bridge-<triple> 命名)`,
    );
  }
}

/**
 * spawn 前按 bin/sha256sums.txt 核对二进制完整性(安全审查要求)。
 *
 * - 清单里有它且哈希对上 → 通过(返回 null);
 * - 清单里有它但哈希对不上 → **拒绝执行**(返回错误信息:二进制可能被篡改/损坏);
 * - 清单缺失 / 清单里没有这一项 → 宽松通过(旧版升级上来 / 手动换二进制的场景不能全堵死,
 *   fail-closed 会把「清单没跟上」变成用户完全连不上)。宽松路径记日志,由调用方决定。
 *
 * 清单由 `bun scripts/bin-sums.ts` 生成,与二进制一起随包发布。
 * `binDir` 同上,只给单测注入用。
 */
export function verifyBinarySha256(binaryPath: string, binDir = bleBridgeBinDir()): string | null {
  const manifestPath = path.join(binDir, 'sha256sums.txt');
  let manifest: string;
  try {
    manifest = readFileSync(manifestPath, 'utf8');
  } catch {
    return null; // 没有清单:宽松通过(见上)
  }
  const name = path.basename(binaryPath);
  const m = new RegExp(
    String.raw`^([0-9a-f]{64})  ${name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}$`,
    'm',
  ).exec(manifest);
  if (!m) return null; // 清单里没有这一项:同上,宽松通过
  const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
  return actual === m[1]
    ? null
    : `sha256 不匹配:${name} 清单=${m[1]!.slice(0, 12)}… 实际=${actual.slice(0, 12)}…`;
}

/** Rust ble-bridge 二进制的绝对路径(随扩展打包)。 */
export function bleBridgeBinaryPath(): string {
  const triple = targetTriple(),
    name = process.platform === 'win32' ? `ble-bridge-${triple}.exe` : `ble-bridge-${triple}`,
    candidate = path.join(bleBridgeBinDir(), name);
  return candidate;
}

/**
 * 环境检查:ble-bridge 二进制是否就绪(连接设备前先调)。
 *
 * 与旧 python-runtime.checkEnvironment 对齐返回结构(python/pythonSource 字段
 * 保留为 null,兼容旧 webview;新增 nativeBinary 字段)。
 */
export function checkEnvironment(): {
  ok: boolean;
  python: string | null;
  pythonSource: 'venv' | 'system' | null;
  bleakInstalled: boolean;
  bleakVersion?: string;
  nativeBinary: string;
  scriptPath: string;
} {
  const nativeBinary = bleBridgeBinaryPath(),
    exists = existsSync(nativeBinary);
  return {
    // 二进制存在即就绪(BLE radio 通电状态由 BleBridge 启动时探测,不在此检查)。
    ok: exists,
    python: null,
    pythonSource: null,
    bleakInstalled: exists,
    bleakVersion: exists ? 'rust-btleplug' : undefined,
    nativeBinary,
    // scriptPath 保留(旧 webview/调用方可能引用),指向二进制路径。
    scriptPath: nativeBinary,
  };
}

/**
 * 清理残留的 ble-bridge 孤儿进程,返回被杀掉的 pid 列表。
 *
 * stop() 的历史 bug、热重载、进程异常退出都可能在磁盘上留下孤儿 ble-bridge:
 * 它们霸占系统蓝牙资源,导致搜不到/连不上设备,且其 BleBridge 引用早已丢失,
 * 应用内拿不到、只能靠 OS 层回收。在每次连接/扫描/重连前扫一遍,等于兜底。
 *
 * ⚠️ 这里出过一次「两个版本互杀」的事故(0.11.0 自动更新时):
 * 原来是「杀掉所有 bin/ble-bridge-* 进程」,而扩展更新期间**新旧两个后端实例同在一个 EH 进程里**
 * (各自 import 各自版本的模块)。于是 A 要 spawn 前把 B 的**活桥**当孤儿杀了,B 收到进程退出
 * → 断连 → 重连 → 它 spawn 前又把 A 的活桥杀了……日志里就是两个版本的 binary 路径来回跳、
 * 每十几秒一次「连上→被杀→重连」,用户侧表现为「按设备码连接失败: signal=SIGTERM」。
 *
 * 所以现在只杀**能证明是孤儿**的两类:
 *   1. 命令行是**我自己这个版本**的二进制 —— 那必然是我上一轮留下的(同版本只该有一个活桥,
 *      而调用方只在自己没有活桥时才调这里)。
 *   2. 父进程已经死了(ppid = 1,被 launchd/init 收养)—— 真正没人管的孤儿,与版本无关。
 * 别的版本、且父进程还活着的桥 = 另一个活实例正在用,不许碰。
 *
 * @param opts.ownBinaryPath 自己这个版本的二进制路径(不传则只按「父进程已死」判定)
 * @param opts.excludePids 要跳过的 pid(当前 bridge 正管的进程等)
 */
export async function killOrphanBleBridges(
  opts: { ownBinaryPath?: string | null; excludePids?: number[] } = {},
): Promise<number[]> {
  try {
    // 一次 ps 拿到 pid / ppid / 命令行:pgrep 只给 pid,判不了「父进程是谁、是哪个版本」。
    // Windows 上没有 ps,execFile 直接失败 → catch 返回 [](与改动前行为一致)。
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,command='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const victims = pickOrphanPids(stdout, {
      ownBinaryPath: opts.ownBinaryPath ?? null,
      excludePids: opts.excludePids ?? [],
      selfPid: process.pid,
    });
    if (victims.length === 0) return [];
    return await killPids(victims);
  } catch {
    return []; // ps 不可用 / 没匹配到:没事可做
  }
}

/**
 * 从 `ps -Ao pid=,ppid=,command=` 的输出里挑出「该杀的孤儿 ble-bridge」。
 *
 * 抽成纯函数是为了能单测 —— 这条判定错一次的代价见上面那段事故注释(两个版本互杀活桥)。
 */
export function pickOrphanPids(
  psOutput: string,
  opts: { ownBinaryPath?: string | null; excludePids?: readonly number[]; selfPid?: number },
): number[] {
  const exclusions = new Set((opts.excludePids ?? []).filter((p) => Number.isInteger(p)));
  const victims: number[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    const ppid = Number.parseInt(m[2]!, 10);
    const cmd = m[3]!;
    if (!cmd.includes('bin/ble-bridge-')) continue;
    if (exclusions.has(pid) || pid === opts.selfPid) continue;
    // 我自己这个版本的二进制 = 我上一轮留下的残留;父进程已死(被 launchd/init 收养)= 真孤儿。
    // 其余(别的版本 + 父进程还活着)是另一个活实例在用,不许碰。
    const isMine = !!opts.ownBinaryPath && cmd.includes(opts.ownBinaryPath);
    if (isMine || ppid <= 1) victims.push(pid);
  }
  return victims;
}

/** 先 SIGTERM、短等后 SIGKILL,返回确认(信号已送到)的 pid 列表。 */
async function killPids(pids: number[]): Promise<number[]> {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      /* 进程在杀前已退出(ESRCH)算已清理 */
      killed.push(pid);
    }
  }
  if (killed.length > 0) {
    // 给 SIGTERM 一点时间优雅退出,再用 SIGKILL 扫尾(避免 SIGTERM 杀不掉的顽固进程)。
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    for (const pid of killed) {
      try {
        process.kill(pid, 0); // 探测是否还活着
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  return killed;
}
