/**
 * 打包脚本:build 一份免安装可直接跑的产物包。
 *
 * 结构(release/lipai-local-<ver>-<platform>.tar.gz,解压出 lipai-local/):
 *   lipai-local/
 *   ├── server.mjs            ← esbuild 打包 server/index.ts(全部 TS → 单文件 ESM)
 *   ├── dist/                 ← 前端构建产物(vite build)
 *   ├── bin/                  ← ble-bridge 当前平台二进制 + sha256sums.txt(spawn 路径 bin/ble-bridge-<triple> 不变)
 *   ├── public/               ← 图标 + hyalite + gallery-presets/(预设图组;运行时读 process.cwd()/public/gallery-presets)
 *   ├── src/assets/gallery/   ← 服务端渲染读的内置图库(路径硬编码 src/assets/gallery)
 *   ├── node_modules/         ← esbuild external 依赖子集(hono/@hono/node-server/qrcode/@napi-rs/canvas + 平台二进制包)
 *   ├── package.json          ← {type:module, scripts:{start:"node server.mjs"}}
 *   └── README.md
 *
 * 产物验证:stage 树里直接 `node server.mjs` 冒烟(health / galleries 预设图组 / dist 托管 / mcp tools/list),
 * 全过才压 tar.gz。ble-bridge 二进制与 @napi-rs/canvas 平台二进制都是平台专属 → 只打当前平台包。
 */
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';

const ROOT = process.cwd();
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PLATFORM = `${process.platform}-${process.arch}`;
const OUT_ROOT = path.join(ROOT, 'release');
const STAGE = path.join(OUT_ROOT, 'lipai-local');
const ARCHIVE = path.join(OUT_ROOT, `lipai-local-${VERSION}-${PLATFORM}.tar.gz`);

/* ---------------- 1) esbuild 打 server(单文件 ESM,外部依赖 external) ---------------- */
// esbuild 打不进去的:平台二进制(.node 原生模块)。能打进去的(hono/qrcode 纯 JS)也标记 external
// 随包带 node_modules 子集 —— 保持运行时与开发时同一份代码路径,避免 bundle 内嵌副本与随包副本行为漂移。
const EXTERNAL = [
  '@napi-rs/canvas',
  'hono',
  '@hono/node-server',
  'qrcode',
];
// 平台二进制包:@napi-rs/canvas require('@napi-rs/canvas-darwin-arm64') 等。
for (const plat of ['darwin', 'linux', 'win32']) {
  for (const arch of ['arm64', 'x64']) {
    if (plat === 'win32' && arch === 'arm64') continue;
    EXTERNAL.push(`@napi-rs/canvas-${plat}-${arch}`);
  }
}

rmSync(OUT_ROOT, { recursive: true, force: true });
mkdirSync(OUT_ROOT, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'server/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(OUT_ROOT, 'server.mjs'),
  external: EXTERNAL,
  sourcemap: false,
  logLevel: 'warning',
});

/* ---------------- 2) 组装产物树 ---------------- */
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

cpSync(path.join(OUT_ROOT, 'server.mjs'), path.join(STAGE, 'server.mjs'));
cpSync(path.join(ROOT, 'dist'), path.join(STAGE, 'dist'), { recursive: true });

// ble-bridge:按 binary-runtime 的 triple 命名只带当前平台那份 + 全量清单(多余行不影响校验)。
const TRIPLE =
  process.platform === 'win32'
    ? 'x86_64-pc-windows-msvc'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
      : 'x86_64-unknown-linux-gnu';
const BIN_NAME = `ble-bridge-${TRIPLE}${process.platform === 'win32' ? '.exe' : ''}`;
mkdirSync(path.join(STAGE, 'bin'), { recursive: true });
cpSync(path.join(ROOT, 'bin', BIN_NAME), path.join(STAGE, 'bin', BIN_NAME));
cpSync(path.join(ROOT, 'bin', 'sha256sums.txt'), path.join(STAGE, 'bin', 'sha256sums.txt'));

// public/(icon + vendor/hyalite + gallery-presets/)
cpSync(path.join(ROOT, 'public'), path.join(STAGE, 'public'), { recursive: true });

// 服务端渲染的内置图库(路径硬编码)
mkdirSync(path.join(STAGE, 'src/assets'), { recursive: true });
cpSync(path.join(ROOT, 'src/assets/gallery'), path.join(STAGE, 'src/assets/gallery'), {
  recursive: true,
});

// external 依赖子集:精确目录复制 + 传递依赖闭包(esbuild metafile 算)。
//
// external 包运行时走真实 require —— 它自己的 dependencies(hono 的依赖、
// qrcode 的 dijkstrajs/pngjs…)也要在产物 node_modules 里,否则起不来
// (实测踩坑:qrcode 缺 dijkstrajs 直接 Cannot find module)。
// 用 esbuild 对 external 包入口跑一次 bundle(metafile: true)拿到完整 import 图,
// 把出现的所有裸包名复制走 —— 比手写依赖列表可靠(包升级不用改脚本)。
const TRANSITIVE_ROOTS = ['hono', '@hono/node-server', 'qrcode', '@napi-rs/canvas'];
const copyPkg = (name: string): void => {
  const dir = path.join(ROOT, 'node_modules', name);
  if (!existsSync(dir)) return;
  const dest = path.join(STAGE, 'node_modules', name);
  if (existsSync(dest)) return;
  cpSync(dir, dest, { recursive: true });
};

// 收集 external 包(及其递归 dependencies)用到的所有 node_modules 包名。
// @napi-rs/canvas 的平台二进制在 optionalDependencies 且体积大(27MB/平台)——
// 只把当前平台那个算进闭包,别的平台的带进 tar 里纯属浪费。
function collectTransitive(): Set<string> {
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const pkgRoot = path.join(ROOT, 'node_modules', name);
    if (!existsSync(pkgRoot)) return;
    const pkgJson = JSON.parse(
      readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    for (const dep of Object.keys(pkgJson.dependencies ?? {})) walk(dep);
    // optionalDependencies 只认 canvas 当前平台二进制(其余 optional 大多是引擎特定,按需补)
    for (const dep of Object.keys(pkgJson.optionalDependencies ?? {})) {
      if (dep.startsWith('@napi-rs/canvas-') && dep !== `@napi-rs/canvas-${process.platform}-${process.arch}`) {
        continue;
      }
      walk(dep);
    }
  };
  for (const root of TRANSITIVE_ROOTS) walk(root);
  return seen;
}
for (const name of collectTransitive()) copyPkg(name);

// package.json(最小可跑)
writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(
    { name: 'lipai-local', version: VERSION, type: 'module', private: true, scripts: { start: 'node server.mjs' } },
    null,
    2,
  ),
);

// README(精简:一行跑起来)
writeFileSync(
  path.join(STAGE, 'README.md'),
  `# lipai-local ${VERSION}(${PLATFORM})

免安装产物包。运行(需 Node ≥ 20):

\`\`\`bash
node server.mjs        # 默认端口 5176,PORT 环境变量可改
\`\`\`

浏览器打开 http://127.0.0.1:5176 即完整本地工具;手机同 WiFi 访问 http://<电脑IP>:5176。

MCP 接入(你自己的 agent,67 个工具):

\`\`\`bash
claude mcp add --transport http lipai http://127.0.0.1:5176/mcp
\`\`\`

目录:server.mjs(服务端)/ dist(前端)/ bin(蓝牙桥,当前平台二进制)/
public(图标 + 预设图组)/ src/assets/gallery(内置图库,服务端渲染读)/
node_modules(原生/外部依赖子集,已含,无需 npm install)。

数据在 \`~/.lipai/\`(不随包,首次运行自动创建)。完整文档见源仓库 README。
`,
);

/* ---------------- 3) 冒烟:stage 树里直接跑 server.mjs ---------------- */
const PORT = '5199';
const SMOKE_HOME = path.join(OUT_ROOT, 'smoke-home');
rmSync(SMOKE_HOME, { recursive: true, force: true });
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: STAGE,
  env: { ...process.env, PORT, LIPAI_BASE_DIR: path.join(OUT_ROOT, 'smoke-tmp') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d: Buffer) => (serverLog += d.toString()));
server.stderr.on('data', (d: Buffer) => (serverLog += d.toString()));

const get = (p: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: Number(PORT), path: p, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });

const post = (p: string, payload: unknown): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(PORT),
        path: p,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });

// 等服务起来(最多 10s)
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 250));
  up = await get('/api/health')
    .then((r) => r.status === 200)
    .catch(() => false);
}
if (!up) {
  server.kill('SIGKILL');
  console.error('冒烟失败:服务没起来。\n--- server log ---\n' + serverLog);
  process.exit(1);
}

const checks: string[] = [];
const expect = (name: string, ok: boolean, detail = '') => {
  checks.push(`${ok ? '✓' : '✗'} ${name}${detail ? `(${detail})` : ''}`);
  if (!ok) {
    server.kill('SIGKILL');
    console.error(`冒烟失败:${name}\n--- server log ---\n` + serverLog);
    process.exit(1);
  }
};

const health = JSON.parse((await get('/api/health')).body);
expect('health', health.ok === true && health.ble.binary.includes('bin/ble-bridge-'));

const galleries = JSON.parse((await get('/api/galleries')).body);
expect('预设图组', galleries.galleries.some((g: { name: string }) => g.name === '鲸娘数字手势'));

const galleryFrames = JSON.parse(
  (await get(`/api/galleries/${encodeURIComponent('鲸娘数字手势')}/frames`)).body,
);
expect('图组帧读取', Array.isArray(galleryFrames.frames) && galleryFrames.frames.length === 10);

const spa = await get('/');
expect('SPA 托管', spa.status === 200 && spa.body.includes('<title>电子立牌'));

const asset = await get('/icon-192.png');
expect('静态资源', asset.status === 200);

const mcpInit = JSON.parse((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' })).body);
expect('MCP initialize', mcpInit.result?.serverInfo?.name === 'lipai-local');

const mcpTools = JSON.parse((await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body);
expect('MCP 工具数', mcpTools.result?.tools?.length >= 60, `${mcpTools.result?.tools?.length} 个`);

const mcpCall = JSON.parse(
  (
    await post('/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'generate_canvas_texts', arguments: { topic: '打工人日常' } },
    })
  ).body,
);
const callText = mcpCall.result?.content?.[0]?.text ?? '';
expect(
  'MCP 渲染调用(esbuild 后 @napi-rs/canvas 正常)',
  callText.includes('lines') || callText.length > 20,
);

server.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 500));
rmSync(path.join(OUT_ROOT, 'smoke-tmp'), { recursive: true, force: true });
rmSync(SMOKE_HOME, { recursive: true, force: true });

/* ---------------- 4) 压 tar.gz ---------------- */
spawnSync('tar', ['-czf', ARCHIVE, '-C', OUT_ROOT, 'lipai-local'], { stdio: 'inherit' });

console.log('\n' + checks.map((c) => '  ' + c).join('\n'));
console.log(`\n✓ 产物包: ${ARCHIVE}`);
console.log(`  ${(statSync(ARCHIVE).size / 1024 / 1024).toFixed(1)} MB · 解压出 lipai-local/,node server.mjs 即跑`);
