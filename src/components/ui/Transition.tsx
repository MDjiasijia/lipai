/**
 * Transition：activeKey 驱动的切换动画状态机。
 *
 * 解决「切 Tab 内容闪一下」：旧内容在退出动画期间保持挂载（绝对定位垫底），
 * 新内容同时入场 —— 交叉淡入淡出，无空窗帧。
 *
 * 形态（两件套）：
 *   <Transition activeKey={tab} name="fade">
 *     {(isActive) => <TabContent isActive={isActive} />}
 *   </Transition>
 *
 * children 是 render-prop：拿 isActive 决定是否做重活（非激活期间可暂停轮询/时钟）。
 * 动画用 CSS class（name 枚举），时长由 CSS 定义；退出时长用常量兜底卸载。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

/** 动画名（CSS 类在 index.css 的 .transition-fade / .transition-slide）。 */
export type TransitionName = 'fade' | 'slide'

/** 退出动画兜底时长（ms）——transitionend 丢失时的卸载上限。 */
const EXIT_FALLBACK_MS = 200

interface KeptEntry {
  key: number
  node: ReactNode
}

export function Transition({
  activeKey,
  name = 'fade',
  children,
}: {
  /** 当前激活项的 key（变化触发切换动画）。 */
  activeKey: number | string
  name?: TransitionName
  /** render-prop：isActive=true 的那份是当前内容。 */
  children: (isActive: boolean) => ReactNode
}): ReactElement {
  const [current, setCurrent] = useState(activeKey)
  /** 退出中的旧内容（key → 节点），动画结束清掉。 */
  const [leaving, setLeaving] = useState<KeptEntry[]>([])
  /** 入场双态：挂载帧无 is-entered，rAF 后补类触发过渡。 */
  const [isEntered, setIsEntered] = useState(true)
  /** 每个进入过的 key 的 children 快照（退出动画期间要渲染旧内容）。 */
  const nodeCacheRef = useRef(new Map<string | number, ReactNode>())

  // 渲染期缓存当前 children（退出时取用）
  nodeCacheRef.current.set(activeKey, children(true))
  for (const [k] of nodeCacheRef.current) {
    if (k !== activeKey) nodeCacheRef.current.set(k, children(false))
  }

  useEffect(() => {
    if (activeKey === current) return
    const prev = current
    setCurrent(activeKey)
    setIsEntered(false)
    // 旧内容进退出序列
    setLeaving((list) => [...list, { key: -1, node: nodeCacheRef.current.get(prev) }])
    const timer = window.setTimeout(() => {
      setLeaving((list) => list.slice(1))
    }, EXIT_FALLBACK_MS)
    return () => window.clearTimeout(timer)
    // current 只在这里写
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeKey 是唯一驱动
  }, [activeKey])

  // 入场第二帧：补 is-entered 触发浮入过渡
  useEffect(() => {
    if (isEntered) return
    const raf = requestAnimationFrame(() => setIsEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [isEntered])

  return (
    <div className="relative">
      {/* 退出层：绝对定位垫底，交叉淡出 */}
      {leaving.map((entry, i) => (
        <div key={`leave-${i}`} aria-hidden className={`transition-item transition-item--leaving transition-${name}`}>
          {entry.node}
        </div>
      ))}
      <div key={current} className={`transition-item transition-${name} ${isEntered ? 'is-entered' : ''}`}>
        {children(true)}
      </div>
    </div>
  )
}
