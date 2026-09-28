/**
 * 开发启动:vite(5173) + 本地 API(5176) 并行。
 * API 进程随本脚本生命周期;Ctrl-C 两个都停。
 */
import { spawn } from 'node:child_process';

const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: '5176' },
});
const web = spawn('npx', ['vite', '--port', '5173', '--host', '127.0.0.1'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const stop = () => {
  api.kill('SIGTERM');
  web.kill('SIGTERM');
};
process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  if (code !== 0) {
    web.kill('SIGTERM');
    process.exit(code ?? 1);
  }
});
