import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 渲染 Worker 打包用 ES 格式（渲染走 module Worker；默认 iife 与代码分割冲突）
/// <reference types="vitest/config" />
export default defineConfig({
  worker: { format: 'es' },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:5176', changeOrigin: false },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  preview: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://127.0.0.1:5176', changeOrigin: false },
    },
  },
})
