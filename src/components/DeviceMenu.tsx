/**
 * 全局设备连接菜单（header 徽标 / 移动端底栏设备项共用的弹出层）。
 *
 * 设备连接的操作与状态从 Control 页 hero 提升到全局：
 *  - 任何页面点开即可连接/断开，错误与自动重连状态就地展示
 *  - Control 页不再自带连接条（一处状态、一处操作，全站一致）
 *  - 点击外部 / Esc / 路由切换自动收起
 */
import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useDevice } from '../lib/ips/useDevice'
import { useHashRoute } from '../lib/api'
import { SLOT_STYLE_NAMES } from '../lib/ips/profile-types'
import { StatusDot, IconBluetooth, IconLoader } from './icons'
import { Menu } from './ui/Menu'
import { Switcher } from './ui/Switcher'
import { useLogDockVisible } from './LogDock'

/** 状态的一句话描述（徽标 title / 面板副文共用语义） */
export function deviceStatusLabel(
  state: 'idle' | 'connecting' | 'connected' | 'disconnected',
  autoReconnect: boolean,
): string {
  if (state === 'connected') return '已连接'
  if (state === 'connecting') return autoReconnect ? '重连中…' : '连接中…'
  if (state === 'disconnected') return autoReconnect ? '已断开 · 自动重连中' : '已断开'
  return '未连接'
}

/**
 * 弹出层 + 触发器：children 即触发器（桌面徽标 / 移动端 Tab 项），
 * 面板统一向下弹出，样式与玻璃卡片同源。
 */
export default function DeviceMenu({ trigger }: { trigger: ReactNode }): ReactElement {
  const {
    state,
    info,
    error,
    available,
    autoReconnect,
    savedName,
    channel,
    serverDown,
    bridge,
    connect,
    disconnect,
    stopReconnect,
    clearError,
  } = useDevice()
  const { parts } = useHashRoute()
  const [open, setOpen] = useState(false)
  const connected = state === 'connected'
  const autoConnecting = state === 'connecting' && autoReconnect
  const [isLogDockVisible, setLogDockVisible] = useLogDockVisible()
  /** server 通道恒可用（可用性看桥状态）；browser 通道看 Web Bluetooth */
  const canConnect = channel === 'server' || available

  // 路由变化收起（面板跟着页面走没意义）
  const routeKey = parts.join('/')
  useEffect(() => {
    setOpen(false)
  }, [routeKey])

  return (
    // 小屏根节点 static：面板改锚 sticky 顶栏（全宽定位元素）——
    // 锚按钮时按钮贴近视口右缘，面板 288px 宽会向左撑出屏幕（322px 视口实测溢出 58px）。
    // md+ 恢复 relative：桌面徽标在导航中部，面板锚按钮右缘。
    <div className="md:relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`设备连接：${deviceStatusLabel(state, autoReconnect)}`}
      >
        {trigger}
      </button>
      <Menu
        isOpen={open}
        onClose={() => setOpen(false)}
        ariaLabel="设备连接"
        panelClassName="w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-4 text-left text-sm right-2 md:right-0"
      >
        <div>
          {/* 状态行：状态灯 + 设备名 + 屏槽徽标 */}
          <div className="flex items-center gap-2.5">
            <StatusDot state={state} className="h-2.5 w-2.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight">
                {connected ? (info.name ?? 'IPS 设备') : deviceStatusLabel(state, autoReconnect)}
              </p>
              <p className="mt-0.5 truncate text-xs leading-tight text-zinc-500 dark:text-zinc-400">
                {connected
                  ? `屏幕停在「${SLOT_STYLE_NAMES[info.clockStyle ?? 0] ?? '未知'}」`
                  : state === 'connecting'
                    ? channel === 'server'
                      ? '正在经服务端桥连接…'
                      : '正在建立 GATT 连接…'
                    : state === 'disconnected'
                      ? autoReconnect
                        ? savedName
                          ? `自动重连「${savedName}」中（${
                              channel === 'server' ? '服务端退避重试' : '免面板直连，退避重试'
                            }）`
                          : '掉线后自动重连'
                        : '自动重连已停手，点下方重连'
                      : canConnect
                        ? savedName
                          ? `会自动重连「${savedName}」；也可点下方手动连接`
                          : channel === 'server'
                            ? '服务端桥就绪，点下方连接'
                            : 'Web Bluetooth 就绪，点下方连接'
                        : '当前浏览器不支持 Web Bluetooth（可切服务端桥通道）'}
              </p>
            </div>
            {connected && info.clockStyle !== undefined && (
              <span className="chip-xs chip shrink-0 border border-glow-500/40 text-glow-600 dark:text-glow-400" title={`屏幕停在「${SLOT_STYLE_NAMES[info.clockStyle ?? 0] ?? '未知'}」`}>
                屏·{SLOT_STYLE_NAMES[info.clockStyle ?? 0] ?? '未知'}
              </span>
            )}
          </div>

          {/* 已连接：设备详情映射（固件 / 硬件 / IP / 存储 —— 有什么显示什么） */}
          {connected && (
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-[var(--radius-control)] bg-zinc-100/80 px-3 py-2.5 text-xs dark:bg-white/[0.05]">
              {[
                ['固件', info.firmware],
                ['硬件', info.hardware],
                ['IP', info.ip],
                ['存储', info.storage],
                ['MAC', info.mac],
              ]
                .filter(([, v]) => Boolean(v))
                .map(([k, v]) => (
                  <div key={k} className="flex min-w-0 items-baseline gap-1.5">
                    <dt className="shrink-0 text-zinc-400 dark:text-zinc-500">{k}</dt>
                    <dd className="truncate font-medium text-zinc-700 dark:text-zinc-200">{v}</dd>
                  </div>
                ))}
            </dl>
          )}

          {/* 状态映射图例（四态各什么颜色/含义 —— 第一次用的人不用猜） */}
          {!connected && canConnect && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-[var(--radius-control)] bg-zinc-100/80 px-3 py-2 text-[10px] text-zinc-500 dark:bg-white/[0.05] dark:text-zinc-400">
              {(
                [
                  ['connected', '已连接'],
                  ['connecting', '连接中'],
                  ['disconnected', '断开重连'],
                  ['idle', '未连接'],
                ] as const
              ).map(([s, label]) => (
                <span key={s} className="flex items-center gap-1">
                  <StatusDot state={s} className="h-1.5 w-1.5" />
                  {label}
                </span>
              ))}
            </div>
          )}

          {/* 当前通道读数（server：桥状态；browser：Web Bluetooth 可用性） */}
          <div className="mt-3 flex items-center justify-between gap-2 rounded-[var(--radius-control)] bg-zinc-100/80 px-3 py-2 text-[10px] text-zinc-500 dark:bg-white/[0.05] dark:text-zinc-400">
            <span>
              通道：{channel === 'server' ? '服务端桥' : '浏览器直连'}
            </span>
            {channel === 'server'
              ? serverDown
                ? <span className="text-glow-600 dark:text-glow-400">本地服务未响应</span>
                : bridge?.bridgeRunning
                  ? <span className="text-emerald-600 dark:text-emerald-400">桥运行中</span>
                  : <span className="text-glow-600 dark:text-glow-400">桥未运行（控制台可切直连）</span>
              : available
                ? <span className="text-emerald-600 dark:text-emerald-400">Web Bluetooth 就绪</span>
                : <span className="text-glow-600 dark:text-glow-400">此浏览器不支持</span>}
          </div>

          {/* 错误（就地展开，不再散落各页） */}
          {error && (
            <div className="mt-3 rounded-[var(--radius-control)] border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
              <button type="button" className="ml-2 underline opacity-70" onClick={clearError}>
                关闭
              </button>
            </div>
          )}
          {channel === 'browser' && !available && (
            <div className="mt-3 rounded-[var(--radius-control)] border border-glow-500/40 bg-glow-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              需要桌面 Chrome / Edge 或 Android Chrome（iOS Safari 不支持 Web Bluetooth）。控制台可切「服务端桥」通道。
            </div>
          )}

          {/* 操作 */}
          <div className="mt-3 flex items-center gap-2">
            {connected ? (
              <button type="button" className="btn-ghost !py-1.5 flex-1 text-sm" onClick={() => void disconnect()}>
                断开连接
              </button>
            ) : autoConnecting ? (
              <button type="button" className="btn-ghost !py-1.5 flex-1 text-sm" onClick={stopReconnect}>
                <IconLoader className="h-4 w-4 animate-spin" />
                停止自动重连
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary !py-1.5 flex-1 text-sm"
                disabled={!canConnect || state === 'connecting'}
                onClick={() => void connect()}
              >
                {state === 'connecting' ? (
                  <>
                    <IconLoader className="h-4 w-4 animate-spin" />
                    连接中…
                  </>
                ) : (
                  <>
                    <IconBluetooth className="h-4 w-4" />
                    连接设备
                  </>
                )}
              </button>
            )}
            <a href="#/control" className="btn-ghost !py-1.5 text-sm" onClick={() => setOpen(false)}>
              控制台
            </a>
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
            {connected
              ? channel === 'server'
                ? '连接由服务端桥持有 —— 刷新/关页面连接还在，自动化照跑。'
                : '连接全局常驻 —— 切页面不断开；此通道关页面自动化会停。'
              : autoConnecting
                ? channel === 'server'
                  ? `服务端退避重连中${savedName ? ` · 目标：${savedName}` : ''}。`
                  : `免面板退避重连中（2s 起指数退避，5 次停手）${savedName ? ` · 目标：${savedName}` : ''}。`
                : channel === 'server'
                  ? '服务端桥通道：掉线重连/自动化由服务端常驻负责（控制台可切浏览器直连后备）。'
                  : '浏览器直连通道：连接全局常驻（切页面不断开），控制台可切回服务端桥。'}
          </p>

          {/* 通信日志浮窗的显示开关（全局日志入口在底栏胶囊；这里管它是否常驻） */}
          <div className="mt-2 border-t border-line pt-2">
            <Switcher
              checked={isLogDockVisible}
              onChange={setLogDockVisible}
              label="通信日志入口"
              hint="底栏右侧的「日志」固定位；关掉即全站隐藏"
            />
          </div>
        </div>
      </Menu>
    </div>
  )
}
