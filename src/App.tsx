import { useEffect } from 'react'
import type { ReactElement } from 'react'
/**
 * App 外壳：hash 路由分发（本地管理工具版）
 * #/           素材库首页（可带 ?q=&type=&tag=&sort= 查询；无二级详情页，内容直接内联展示）
 * #/upload     收进本地库页（原上传页）
 * #/control    设备控制台（单页 Tab：投屏/自动/设备）
 *
 * 与上游 Web 版的差别：登录态/SWUpdateBar/InstallBar 全部删除
 * （本地工具无登录、无用量额度、不做 PWA）；ThemeProvider/NavBar/LiveRail/LogDock/
 * ToastHost 保留。initDeviceStore/warmRenderWorker 的 import 路径保持
 * src/lib/ips/deviceStore 与 src/lib/ips/render/worker-client —— 下一轮接服务端通道时改实现不动路径。
 */
import { useHashRoute } from './lib/api'
import { ThemeProvider } from './lib/theme'
import NavBar from './components/NavBar'
import LiveRail from './components/LiveRail'
import { ToastHost } from './components/ui/Toast'
import Home from './pages/Home'
import Upload from './pages/Upload'
import Control from './pages/Control'
import { initDeviceStore } from './lib/ips/deviceStore'
import { warmRenderWorker } from './lib/ips/render/worker-client'
import { LogDock } from './components/LogDock'

export default function App(): ReactElement {
  const { parts } = useHashRoute()

  // 设备连接全局单例：App 挂载时恢复上次设备 + 自动连接（只此一次，
  // 切页面/tab 不再重连 —— 修复此前每页各建 IpsDevice 的问题）
  useEffect(() => {
    void initDeviceStore()
    warmRenderWorker()
  }, [])

  const page: ReactElement =
    parts[0] === 'upload' ? (
      <Upload />
    ) : parts[0] === 'control' ? (
      <Control />
    ) : (
      <Home />
    )

  return (
    <ThemeProvider>
      <div className="relative flex min-h-dvh flex-col">
        {/* 展厅氛围层：顶部辉光（暗调但不死黑） */}
        <div aria-hidden className="ambient-glow" />
        <div className="relative z-10 flex min-h-dvh flex-1 flex-col">
          <NavBar />
          {/* 全局实时立牌展台：只在收进库/控制台常驻（这两页的展台内容是用户正在
              编辑的东西， sticky 跟随有价值）；素材库不挂 —— 列表每行自带实时走时，
              顶部再来一条会不断变的展台只会抢视觉、把内容往下顶。
              白名单式判断（parts 滤掉空串后首页是 []，首元素为 undefined） */}
          {(parts[0] === 'upload' || parts[0] === 'control') && <LiveRail />}
          {/* 底部 Tab 栏全断点常驻（fixed）：main 让位 = 栏高 54px + 内容余量，
              滚动到底不被遮；footer 收进让位区内 */}
          <main className="flex-1 pb-20">{page}</main>
          <footer className="border-t border-line py-4 pb-[5.5rem] text-center text-xs text-zinc-400 md:pb-[5.5rem] dark:text-zinc-500">
            电子立牌 · 本地管理（数据与设备都在本机，~/.lipai/）
          </footer>
        </div>
        {/* 全局 toast（role=status，位置在移动底栏上方） */}
        <ToastHost />
        {/* 全局通信日志浮窗（底栏上方胶囊开关，任意页面可开） */}
        <LogDock />
      </div>
    </ThemeProvider>
  )
}
