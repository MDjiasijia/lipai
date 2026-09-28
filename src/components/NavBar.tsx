/**
 * 应用外壳导航（本地管理工具双布局）：
 *  - 桌面（md+）：顶栏 —— logo / 设备徽标 / 主题
 *  - 移动端（<md）：顶栏精简（logo + 主题）+ 底部固定 Tab 栏
 *    （图标 + 文字，触控目标 ≥48px，safe-area 让出 Home Indicator）
 *
 * 与上游 Web 版的差别：登录态/UserChip 删除（本地工具无登录概念）；
 * 导航项改名对齐本地语义 —— 素材库（首页）/ 收进库（导入）/ 控制台。
 *
 * 设备连接常驻徽标：deviceStore 全局单例订阅 —— 任何页面都看得到连接状态，
 * 点击跳控制台；连着设备浏览素材库时也知道「立牌是连着的」。
 * 底部 Tab 栏的设备项即徽标本体（状态灯就在图标角上）。
 */
import type { ReactElement } from 'react'
import { useTheme } from '../lib/theme'
import { useDevice } from '../lib/ips/useDevice'
import { SLOT_STYLE_NAMES } from '../lib/ips/profile-types'
import { useHashRoute } from '../lib/api'
import { IconTabHome, IconTabUpload, IconBluetooth, StatusDot } from './icons'
import DeviceMenu, { deviceStatusLabel } from './DeviceMenu'

/** 站点 logo：玻璃罩辉光管（罩体 = 圆头拱形 + 底座，管内暖橙辉光呼吸） */
function LogoMark(): ReactElement {
  return (
    <svg viewBox="0 0 30 30" className="h-[26px] w-[26px] drop-shadow-[0_0_6px_rgba(251,146,60,0.45)]" aria-hidden>
      <defs>
        {/* 玻璃罩：顶部天光 → 底部深色收边 */}
        <linearGradient id="lg-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8f6ff" stopOpacity="0.95" />
          <stop offset="0.35" stopColor="#7dd3fc" stopOpacity="0.35" />
          <stop offset="1" stopColor="#0c4a6e" stopOpacity="0.55" />
        </linearGradient>
        {/* 辉光管体：暖橙焰心 */}
        <linearGradient id="lg-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fef3c7" />
          <stop offset="0.55" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#ea580c" />
        </linearGradient>
        <radialGradient id="lg-halo" cx="0.5" cy="0.62" r="0.55">
          <stop offset="0" stopColor="#fdba74" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fdba74" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 辉光光晕 */}
      <circle cx="15" cy="15" r="10.5" fill="url(#lg-halo)" className="logo-tube" />
      {/* 玻璃罩（圆头拱形罩 + 底沿） */}
      <path
        d="M9.5 24.5 v-11 a5.5 5.5 0 0 1 11 0 v11 z"
        fill="url(#lg-glass)"
        stroke="rgba(255,255,255,0.75)"
        strokeWidth="1"
      />
      {/* 罩内辉光管（数字灯丝简化为一根竖管 + 上下引脚） */}
      <g className="logo-tube">
        <rect x="13.4" y="9.5" width="3.2" height="12" rx="1.6" fill="url(#lg-flame)" />
        <rect x="14.35" y="6.8" width="1.3" height="3.2" rx="0.65" fill="#fbbf24" opacity="0.9" />
      </g>
      {/* 罩面镜边高光（左上弧） */}
      <path d="M11.2 11.6 a4.2 4.2 0 0 1 3-3.4" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.2" strokeLinecap="round" />
      {/* 底座 */}
      <rect x="7" y="24.5" width="16" height="2.6" rx="1.3" fill="#3f3f46" />
      <rect x="7" y="24.5" width="16" height="1" rx="0.5" fill="rgba(255,255,255,0.28)" />
    </svg>
  )
}

/** 设备连接状态（徽标 / 底部 Tab / hero 共用一份语义） */
function useDeviceStatus(): {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected'
  info: ReturnType<typeof useDevice>['info']
  label: string
} {
  const { state, info, autoReconnect } = useDevice()
  // 槽位名收口：此前这里硬编码第二份数组（且与 SLOT_STYLE_NAMES 不一致：「数字钟一」）
  const slot =
    info.clockStyle !== undefined
      ? ` · 屏:${SLOT_STYLE_NAMES[info.clockStyle] ?? info.clockStyle}`
      : ''
  const label =
    state === 'connecting'
      ? autoReconnect
        ? '重连中…'
        : '连接中…'
      : state === 'connected'
        ? info.name
          ? `${info.name}${slot}`
          : `已连接${slot}`
        : state === 'disconnected'
          ? autoReconnect
            ? '已断开 · 重连中'
            : '已断开'
          : '连接设备'
  return { state, info, label }
}

/** 设备连接徽标（桌面顶栏）：全状态常驻 + 点击弹出全局连接菜单。
 *  已连接显示设备名（前缀_XXXX）—— 屏槽映射在徽标与面板里都可见。
 *  设备是唯一独立硬件 —— 任何页面都能看到状态、就地连接/断开（不必先跳控制台）。 */
function DeviceBadge(): ReactElement {
  const { state, label } = useDeviceStatus()
  return (
    <DeviceMenu
      trigger={
        <span
          title={label}
          className="glass-chip ml-1 hidden h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-white/90 md:flex dark:text-zinc-300 dark:hover:bg-white/[0.16]"
        >
          <StatusDot state={state} />
          <span className="max-w-32 truncate">{label}</span>
        </span>
      }
    />
  )
}

/** 设备状态图标按钮（移动端顶栏）：状态灯 + 蓝牙图标，点开全局连接菜单
 *  （桌面用带文字的徽标；移动端顶栏空间紧，只放图标，状态灯常驻在图标上）。 */
function DeviceIconButton(): ReactElement {
  const { state, info } = useDeviceStatus()
  return (
    <DeviceMenu
      trigger={
        <span
          title={info.name ?? deviceStatusLabel(state, false)}
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] transition-[color,background-color,box-shadow] duration-[var(--duration-fast)] hover:bg-zinc-100 hover:text-zinc-900 md:hidden dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          <IconBluetooth className="h-[18px] w-[18px]" />
          <span className="absolute right-1.5 top-1.5">
            <StatusDot state={state} className="h-2 w-2 ring-2 ring-white dark:ring-zinc-950" />
          </span>
        </span>
      }
    />
  )
}

/** 主题切换按钮（顶栏右端，两种布局共用）：三态循环 auto（跟随设备）→ 浅色 → 深色。
 *  auto 态 = 图标染 signal + 右上「A」角标 —— 当前显示的是设备配置，随时点回。 */
function ThemeButton(): ReactElement {
  const { pref, theme, cycle } = useTheme()
  const label =
    pref === 'auto'
      ? `跟随设备（当前${theme === 'dark' ? '深色' : '浅色'}）· 点击固定浅色`
      : pref === 'light'
        ? '已固定浅色 · 点击固定深色'
        : '已固定深色 · 点击恢复跟随设备'
  return (
    <button
      type="button"
      onClick={cycle}
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] transition-[color,background-color,box-shadow] duration-[var(--duration-fast)] hover:bg-zinc-100 hover:text-zinc-900 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-800 dark:hover:text-white ${
        pref === 'auto'
          ? 'text-signal-600 dark:text-signal-300'
          : 'text-zinc-500 dark:text-zinc-400'
      }`}
      title={label}
      aria-label={label}
    >
      {theme === 'dark' ? (
        // 太阳（当前深色 → 下一档回浅色）
        <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden>
          <circle cx="10" cy="10" r="4" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4-1.4M14.3 5.7l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        // 月亮（当前浅色 → 下一档去深色）
        <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden>
          <path
            d="M17 12.5A7 7 0 1 1 7.5 3 5.5 5.5 0 0 0 17 12.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {/* auto 态角标：A = 跟随设备中 */}
      {pref === 'auto' && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-signal-500 text-[8px] font-bold leading-none text-white"
        >
          A
        </span>
      )}
    </button>
  )
}

/** 底部 Tab 栏（全断点常驻，不再移动端专属）：
 *  - 三 Tab 重排为 素材库 | 设备(居中) | 收进库 —— 设备是核心硬件入口，占 HIG 突出中心位
 *  - 设备 Tab 常驻展示连接状态 + 设备名（连着时副行显示设备名，未连显示状态词）
 *  - 日志固定在最右（独立于 Tab 组的小位）：全站可开日志浮窗，条数徽标常显
 *  - 高度 54px + 底部安全区让出 Home Indicator；选中态 = signal 色（iOS Tab 语言）
 *  - 半透明模糊材质（内容滚过下方透出，保持上下文） */
function BottomTabBar(): ReactElement {
  const { parts } = useHashRoute()
  const active = parts[0] ?? ''
  const { state, info } = useDeviceStatus()
  const tabs: { href: string; key: string; label: string; icon: ReactElement; device?: boolean }[] = [
    { href: '#/', key: '', label: '素材库', icon: <IconTabHome className="h-6 w-6" /> },
    { href: '#/control', key: 'control', label: '设备', icon: <IconBluetooth className="h-6 w-6" />, device: true },
    { href: '#/upload', key: 'upload', label: '收进库', icon: <IconTabUpload className="h-6 w-6" /> },
  ]
  return (
    <nav
      aria-label="主导航"
      className="glass-chrome fixed inset-x-0 bottom-0 z-30 border-t border-line pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto flex h-[54px] max-w-lg items-stretch justify-around px-2">
        {tabs.map((t) => {
          const isActive = active === t.key
          return (
            <a
              key={t.href}
              href={t.href}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex min-w-16 flex-1 flex-col items-center justify-center gap-0.5 py-1 transition-colors duration-[var(--duration-fast)] ${
                isActive
                  ? 'text-signal-700 dark:text-signal-200'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
              }`}
            >
              <span className="relative">
                {t.icon}
                {/* 设备项状态灯：图标右上角（HIG badge 位），全状态常驻 */}
                {t.device && (
                  <span aria-hidden className="absolute -right-1.5 -top-1">
                    <StatusDot state={state} className="h-2 w-2 ring-2 ring-white dark:ring-zinc-950" />
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium leading-none">{t.label}</span>
              {/* 设备 Tab 副行：设备名（连着）/ 状态词（未连）—— 常驻可见 */}
              {t.device && (
                <span className="max-w-24 truncate text-[9px] leading-none text-zinc-400 dark:text-zinc-500">
                  {state === 'connected' ? (info.name ?? '已连接') : deviceStatusLabel(state, false)}
                </span>
              )}
            </a>
          )
        })}
      </div>
    </nav>
  )
}

export default function NavBar(): ReactElement {
  return (
    <>
      {/* 顶栏玻璃：glass-chrome（20px 霜 + hyalite 折射阶梯）—— 此前 blur-2xl=40px 是模糊预算上限本身，泥 */}
      {/* z-40 高于内容区（含 LiveRail 的 z-30 sticky 展台）—— 设备连接浮窗不被展台盖住。
          iOS 黑.translucent：状态栏浮在页面上 —— 顶栏玻璃必须长进状态栏区
          （pt-[env(safe-area-inset-top)]，inset 合法为 0），否则顶部被系统时钟/内容穿透。
          WebKit 上 transform 会与 backdrop-filter 互相干扰（模糊失真/整块发黑），
          折射背景的稳定性由 body::before 固定层承担（见 index.css）—— 不再上 transform */}
      <header className="glass-chrome sticky top-0 z-40 border-b border-line pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5 sm:py-3">
          <a href="#/" className="group flex shrink-0 items-center gap-2.5">
            <LogoMark />
            {/* nowrap：小屏折行会把 logo 和两行文字的对齐扯歪；手机档略缩字号换空间 */}
            <span className="text-brand-gradient whitespace-nowrap text-sm font-extrabold tracking-tight sm:text-base">
              电子立牌 · 本地管理
            </span>
          </a>

          {/* 导航统一走底部 Tab 栏（全断点常驻）；顶栏只留 品牌名 + 设备徽标 + 主题。
              设备徽标（md+）点开连接菜单 —— 移动端顶栏空间紧，只留图标按钮 */}
          <div className="ml-auto flex items-center gap-1 md:ml-2">
            <DeviceBadge />
            <DeviceIconButton />
            <ThemeButton />
          </div>
        </div>
      </header>
      {/* 移动端底部 Tab 栏（safe-area 让出 Home Indicator） */}
      <BottomTabBar />
    </>
  )
}
