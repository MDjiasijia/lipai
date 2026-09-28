/**
 * 全局实时立牌横栏（App 外壳挂载：header 下方，全页面共享）。
 *
 * 内容来自全局 liveRailStore —— 各页面写入「现在展台上放什么」：
 *  - Home：用户点选某条分享的帧组（切组 = 切展台）
 *  - Control：当前编辑槽位的实时渲染帧（切槽位 = 切展台）
 *  - Upload：解析文件的预览帧
 *  - 空内容 = 收起（不占版面）
 *
 * 固定（图钉）可选（记 localStorage）：默认不固定（随页面滚走），
 * 点图钉钉在 header 下 sticky 跟随 —— 强制 sticky 的体验问题由用户自己权衡。
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import NixieTube from './NixieTube'
import { IconPin } from './icons'
import { useLiveRail } from '../lib/liveRailStore'

const PIN_KEY = 'lipai-live-rail-pinned'

function readPinned(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === '1'
  } catch {
    return false
  }
}

export default function LiveRail(): ReactElement | null {
  const { frames, label } = useLiveRail()
  const [pinned, setPinned] = useState(readPinned)

  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, pinned ? '1' : '0')
    } catch {
      /* 隐私模式忽略 */
    }
  }, [pinned])

  // 无内容：整条收起（页面没写展台内容时不占任何版面）
  if (frames.length === 0) return null

  return (
    // pinned（图钉）才 sticky 跟随；否则随页面滚走（z-30 高于内容低于弹层；
    // sticky 自带层叠上下文 —— 展台内部 z 层不外溢压到 header 的连接面板）。
    // top = 顶栏高（约 4rem）+ 状态栏 inset：inset 合法为 0（非刘海/iOS 26.1），
    // 黑.translucent 下 header 含 padding-top，展台必须按同一基准让位
    <div
      className={`z-30 mx-auto mb-6 w-full max-w-3xl px-4 pt-2 ${
        pinned ? 'sticky top-[calc(4rem+env(safe-area-inset-top))]' : 'relative'
      }`}
    >
      <div className="stage stage-frame relative rounded-2xl px-4 pb-8 pt-3.5">
        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium text-zinc-300">
            {label || '实时立牌'}
            <span className="ml-2 shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-zinc-400">走时中</span>
          </span>
          {/* 选中态语言 = chip-on（只取配色，不取 chip 基类几何 —— chip 的
              min-height/px 会把 20px 圆钮撑成扁药丸）；IconPin 的 pinned 对应固定态 */}
          <button
            type="button"
            onClick={() => setPinned((v) => !v)}
            aria-pressed={pinned}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
              pinned ? 'chip-on' : 'bg-white/10 text-zinc-400 hover:bg-white/20 hover:text-zinc-200'
            }`}
            title={pinned ? '取消固定（滚动时展台随页面滚走）' : '固定展台（滚动时钉在顶栏下方跟随）'}
          >
            <IconPin pinned={pinned} className="h-3 w-3" />
          </button>
        </div>
        <NixieTube frames={frames} theme="dark" />
      </div>
    </div>
  )
}
