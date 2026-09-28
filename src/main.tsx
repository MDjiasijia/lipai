import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { mountHyalite } from './lib/hyalite'
import { mountSpotlight } from './lib/spotlight'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// hyalite 液态玻璃：Chromium 挂真实折射（.glass/.card），其余浏览器 CSS 回落
mountHyalite()
// 跟光镜边高光：.glass-spotlight 元素的 --mx/--my 跟着指针走（全局委托一份监听）
mountSpotlight()

// 本地管理工具不做 PWA：无 registerSW/SWUpdateBar/InstallBar ——
// 应用壳与 /api 同源（npm start 单端口 5176），离线缓存由 api-cache/OPFS 分层承担。
