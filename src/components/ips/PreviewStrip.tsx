/**
 * 预览帧条：拖拽排序 + 超容灰显 + 混合流勾选。
 *
 * 「预览即设备最终显示」——哪几张会推、哪几张被丢，都在这里看得见：
 *  - 超出槽位容量 → 灰掉 + 角标「超出 N 张」（不截断：全部渲出来，超出的灰显可拖回）
 *  - 混合流（usage-credit）：每张卡带勾选框（改 excludedMixedCards），取消勾选的灰掉标「未勾选」
 *    —— 取消勾选的卡仍然画在这里（只是灰着），否则用户就找不到那张卡、勾不回来了
 *  - 天气 / 混合流可拖拽排序：天气改 weatherCardOrder，混合流改 mixedCardOrder（存进配方）
 *  - 拖拽排序对带 meta（卡名/ID）的来源开放；无 meta 来源（图库/动画/本地图片）不排序
 *  - 键盘可达：每卡 ↑/↓ 移动（触屏无 HTML5 DnD 时的排序路径）、✕ 不需要（勾选框替代）
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { SlotSpec } from '../../lib/ips/profile-types'
import type { FrameMeta } from '../../lib/ips/pipeline'
import { slotCapacity } from '../../lib/ips/pipeline'
import { frameUrl } from '../../lib/frame'

export function PreviewStrip({
  frames,
  meta,
  all,
  editing,
  spec,
  patchSpec,
}: {
  /** base64 帧（与 meta 一一对应；meta 可空） */
  frames: string[]
  meta?: FrameMeta[]
  /** 截断前全量候选（base64，调用方转换 —— 展示所有卡，被排除/超容置灰） */
  all?: { image: string; meta: FrameMeta }[]
  editing: number
  spec: SlotSpec | null
  patchSpec: (p: Partial<SlotSpec>) => void
}): ReactElement {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const cap = slotCapacity(editing)
  const isMixed = spec?.source === 'usage-credit'
  const isWeather = spec?.source === 'weather'
  // 天气：优先用全量候选渲染（被排除/超容的卡也显示、置灰）——
  // all 不可用（旧 Worker 响应/异常兜底）回落 frames
  const isWeatherFull = isWeather && all !== undefined && all.length > 0
  const viewFrames: string[] = isWeatherFull ? all!.map((c) => c.image) : frames
  const viewMeta: FrameMeta[] | undefined = isWeatherFull ? all!.map((c) => c.meta) : meta
  const hasMeta = Boolean(viewMeta && viewMeta.length === viewFrames.length && viewFrames.length > 0)
  const orderable = hasMeta && (isMixed || isWeather)
  // 天气的排除字段已废弃（勾选框撤掉，纯「排序 + 容量截断」语义）——
  // 历史残留的 excludedWeatherCards 一律无视（存量配方里点过的勾选不再生效）
  const excluded = new Set(isMixed ? spec?.excludedMixedCards ?? [] : [])
  const order: string[] = isMixed ? spec?.mixedCardOrder ?? [] : isWeather ? spec?.weatherCardOrder ?? [] : []

  /** 实际会推送的下标集合（与 renderSlot 挑卡同语义：排序 → 排除 → 截断到容量）。
   *  纯函数显式传参 —— 不在渲染期读 store（React Compiler 踩坑记录）。 */
  const pushSet = computePushIndexes({ frames: viewFrames, meta: viewMeta, isMixed, isWeather, excluded, order, cap })

  /** 当前显示顺序（order 优先 + 未记录的按当前顺序补位）—— reorder/键盘移动共用 */
  const displayOrder = (): string[] => {
    if (!viewMeta) return []
    const ids = viewFrames.map((_, i) => viewMeta![i]?.id ?? `#${i}`)
    const current: string[] = []
    for (const id of order) if (ids.includes(id)) current.push(id)
    for (const id of ids) if (!current.includes(id)) current.push(id)
    return current
  }

  /** 写入新顺序（混合流 mixedCardOrder / 天气 weatherCardOrder，存进配方） */
  const writeOrder = (next: string[]) => {
    if (isMixed) patchSpec({ mixedCardOrder: next })
    else if (isWeather) patchSpec({ weatherCardOrder: next })
  }

  /** 拖拽/键盘移动：把 from 位的卡插到 to 位 */
  const moveCard = (from: number, to: number) => {
    if (!viewMeta || !orderable) return
    if (to < 0 || to >= viewFrames.length || from === to) return
    const current = displayOrder()
    const fromId = current[from]
    if (!fromId) return
    const next = current.filter((id) => id !== fromId)
    next.splice(to, 0, fromId)
    writeOrder(next)
  }

  /** 勾选/取消某张卡（仅混合流；全取消 = 没内容可推，拒绝最后一张的取消） */
  const toggleCard = (id: string) => {
    if (!viewMeta || !isMixed) return
    const next = excluded.has(id)
      ? [...excluded].filter((x) => x !== id)
      : [...[...excluded], id]
    // 全取消等于没内容可推：取消后至少留一张候选卡
    const wouldKeepAny = viewFrames.some((_, i) => {
      const mid = viewMeta![i]?.id
      return mid === undefined ? true : !next.includes(mid)
    })
    if (!wouldKeepAny) return
    patchSpec({ excludedMixedCards: next })
  }

  /** 勾选框显示与否：只给「勾了会真正改变推送集合」的来源（混合流可禁卡）；
   *  天气是「排序 + 容量截断」语义 —— 勾选框没有独立作用，去掉（截图反馈）。 */
  const showCheckbox = isMixed

  if (viewFrames.length === 0) {
    return (
      <p className="text-xs text-zinc-400 dark:text-zinc-500">还没有预览帧 —— 上面选个内容来源就会出图。</p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
        {viewFrames.map((b64, i) => {
          const m = hasMeta ? viewMeta![i] : undefined
          const checked = showCheckbox && (!m || !excluded.has(m.id))
          const dropped = !pushSet.has(i)
          const badge = !dropped ? null : checked ? `超出 ${cap} 张` : '未勾选'
          // title 按来源语义分：勾选来源（混合流）报勾选态；天气只报排序/容量态
          const title = m
            ? `${m.name}${showCheckbox
              ? checked
                ? dropped
                  ? ` · 排第 ${i + 1} 位超出容量，不会推送`
                  : ' · 会推送'
                : ' · 已取消勾选'
              : dropped
                ? ` · 排第 ${i + 1} 位超出容量，不会推送`
                : ' · 会推送'}（可拖拽 / ↑↓ 排序）`
            : dropped
              ? `第 ${i + 1} 帧 · 超出槽位容量（拖到前面即可保留）`
              : `第 ${i + 1} 帧`
          return (
            <div
              key={i}
              draggable={orderable}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null && dragIndex !== i) moveCard(dragIndex, i)
                setDragIndex(null)
              }}
              onDragEnd={() => setDragIndex(null)}
              className={`group relative flex flex-col gap-0.5 rounded-[calc(var(--radius-control)-0.25rem)] border p-1 transition-[border-color,opacity] duration-[var(--duration-fast)] ${
                orderable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
              } ${
                dragIndex === i
                  ? 'border-signal-500 opacity-40'
                  : dropped
                    ? 'border-dashed border-line-strong'
                    : 'border-line hover:border-signal-500/50'
              }`}
              title={title}
            >
              <div className="relative overflow-hidden rounded-[calc(var(--radius-control)-0.375rem)]">
                <img
                  src={frameUrl(b64)}
                  alt={m?.name ?? `第 ${i + 1} 帧`}
                  className={`aspect-[135/240] w-full object-cover ${dropped ? 'opacity-25 grayscale' : ''}`}
                  draggable={false}
                  style={{ imageRendering: 'pixelated' }}
                />
                {!m && (
                  <span className="readout absolute left-0 top-0 rounded-br bg-zinc-900/70 px-1 text-[9px] font-medium text-white dark:bg-white/70 dark:text-zinc-900">
                    {i}
                  </span>
                )}
                {badge && (
                  <span className="absolute inset-x-0 bottom-0 bg-zinc-900/70 text-center text-[9px] text-white dark:bg-white/70 dark:text-zinc-900">
                    {badge}
                  </span>
                )}
                {m && showCheckbox && (
                  <label
                    className="absolute right-0 top-0 flex min-h-8 min-w-8 cursor-pointer touch-manipulation items-start justify-end p-0.5"
                    title={checked ? '取消展示这张' : '展示这张'}
                  >
                    {/* 触区垫到 32px（14px 勾选框触屏点不中）；视觉 14px 小勾选框 */}
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCard(m.id)}
                      onDragStart={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      className="size-3.5 cursor-pointer rounded-sm border border-white/60 bg-white/80 accent-signal-500"
                    />
                  </label>
                )}
              </div>
              {m ? (
                <div className="flex items-center justify-center gap-0.5">
                  <span
                    className={`max-w-full truncate text-center text-[10px] leading-tight ${
                      dropped ? 'text-zinc-400/50' : 'text-zinc-500 dark:text-zinc-400'
                    }`}
                    title={m.name}
                  >
                    {m.name}
                  </span>
                  {orderable && (
                    <span className="flex shrink-0 flex-col leading-none">
                      <button
                        type="button"
                        aria-label={`上移 ${m.name}`}
                        className="text-[8px] text-zinc-400 hover:text-signal-600"
                        onClick={(e) => {
                          e.stopPropagation()
                          moveCard(i, i - 1)
                        }}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={`下移 ${m.name}`}
                        className="text-[8px] text-zinc-400 hover:text-signal-600"
                        onClick={(e) => {
                          e.stopPropagation()
                          moveCard(i, i + 1)
                        }}
                      >
                        ▼
                      </button>
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {isMixed && hasMeta && (
        <p className="text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          勾选要展示的卡、拖拽或 ↑↓ 排序 —— 这个槽位一次放 {cap} 张：手动推和「自动 → 轮播」都只推前 {cap} 张
          （灰掉的不推、轮播也不换上来）。勾选和顺序都存进这个槽位的配方。
        </p>
      )}
      {isWeather && hasMeta && (
        <p className="text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          拖拽或 ↑↓ 排序 —— 顺序存进配方，重新取数后按这份顺序排（数据是新的、顺序是你定的）。
          {viewFrames.length > cap
            ? ` 这个槽位一次放 ${cap} 张，排后面的置灰不推 —— 想展示哪张，把它拖进前 ${cap} 位。`
            : ''}
        </p>
      )}
    </div>
  )
}

/**
 * 推送下标集合：排序 → 排除 → 截断（与 renderSlot 的挑卡逻辑同语义）。
 * isWeather 与 isMixed 都按「order 优先」处理 —— 此前 isWeather 声明了没解构、
 * weather 排序走了非混合流分支（纯下标截断），与 pipeline 的 orderWeatherCards 不同语义。
 */
function computePushIndexes({
  frames,
  meta,
  isMixed,
  isWeather,
  excluded,
  order,
  cap,
}: {
  frames: string[]
  meta?: FrameMeta[]
  isMixed: boolean
  isWeather?: boolean
  excluded: Set<string>
  order: string[]
  cap: number
}): Set<number> {
  const byOrder = isMixed || isWeather
  if (!byOrder || !meta) {
    // 无卡语义（或无 meta）：全部帧按序截断到容量
    return new Set(frames.map((_, i) => i).slice(0, cap))
  }
  // 排序优先 + 定义顺序补位 → 排除 → 截断（与 renderSlot 同语义）
  const ids = frames.map((_, i) => meta[i]?.id ?? `#${i}`)
  const seq: string[] = []
  for (const id of order) if (ids.includes(id) && !seq.includes(id)) seq.push(id)
  for (const id of ids) if (!seq.includes(id)) seq.push(id)
  const picked: number[] = []
  for (const id of seq) {
    if (picked.length >= cap) break
    if (excluded.has(id)) continue
    const idx = ids.indexOf(id)
    if (idx >= 0) picked.push(idx)
  }
  return new Set(picked)
}
