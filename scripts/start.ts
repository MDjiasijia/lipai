/**
 * 生产启动:先构建(缺 dist 时),再单进程起 API + 静态托管(5176)。
 * 浏览器打开 http://127.0.0.1:5176 即完整本地工具(手机同 WiFi 用电脑 IP 访问)。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

if (!existsSync(path.join(process.cwd(), 'dist', 'index.html'))) {
  console.log('[lipai] dist/ 不存在,先构建前端…');
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
await import('../server/index.js');
