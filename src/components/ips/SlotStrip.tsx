/**
 * 槽位条 —— 投屏页主心骨（拖拽/勾选/超容灰显交互）。
 *
 * 一张槽位卡（横排）：左侧 9:16 预览屏 + 右侧信息/操作列。
 *  - 预览：当前编辑槽 = 实时预览帧，其他槽 = 上次快照；135×240 原大展示
 *    （不放大超分辨率，质感优先）；暗屏底模拟设备屏
 *  - 未配内容：预览区给「＋ 未配内容」空态（暗屏底一致，空/满一眼可辨）
 *  - 右列：槽位名（点名字就地改名）+ 来源标签 + 「显示」钮
 *  - 屏幕正在放谁：边框染 glow（琥珀辉光）+ 名字染琥珀；编辑中 = signal
 *
 * 前 3 个是时钟表盘槽位（各 10 帧），第 4 个「电子立牌」是轮播推图画布（6 帧）。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { SlotSpec } from '../../lib/ips/profile-types'
import { SLOT_STYLE_NAMES, SOURCE_LABELS } from '../../lib/ips/profile-types'
import { frameUrl } from '../../lib/frame'

/** 槽位条（thumbs = 每槽首帧 base64，null = 空槽/还没渲过） */
export function SlotStrip({
  slots,
  editing,
  setEditing,
  thumbs,
  slotNames,
  setSlotName,
  onScreen,
  connected,
  showDevice,
  confirmedSlots,
  confirmSlot,
}: {
  slots: (SlotSpec | null)[]
  editing: number
  setEditing: (i: number) => void
  thumbs: (string | null)[]
  slotNames?: [string, string, string, string]
  setSlotName?: (i: number, name: string) => void
  onScreen: number
  connected: boolean
  /** 「显示」按钮：切设备屏幕到该槽位（setClockStyle） */
  showDevice: (i: number) => void
  /** 每槽「屏上就是这套内容」的确认时刻（undefined = 未确认）；推送完成自动确认、重推开始作废 */
  confirmedSlots?: (number | undefined)[]
  /** 用户点「确认」：把回显刷成当前配置（不重推） */
  confirmSlot?: (i: number) => void
}): ReactElement {
  /** 就地改名中的槽位（null = 无）；点名字进编辑，Enter/失焦提交 */
  const [editingName, setEditingName] = useState<number | null>(null)
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5">
        <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          槽位 <span className="font-normal text-zinc-400 dark:text-zinc-500">点卡片编辑 · 点名字改名 · 「显示」切画面</span>
        </h3>
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500">前 3 个是表盘 · 第 4 个是立牌画布</span>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {slots.map((s, i) => {
          const selected = editing === i
          const screen = onScreen === i
          const name = slotNames?.[i]?.trim() || SLOT_STYLE_NAMES[i]
          const specLabel = s ? SOURCE_LABELS[s.source] ?? s.source : null
          const hasFrame = Boolean(thumbs[i])
          // 该槽位「屏上就是这套内容」的用户确认（纯回显；推送完成自动确认、重推开始作废）
          const confirmed = Boolean(confirmedSlots?.[i])
          return (
            <div
              key={i}
              // 状态语言全在边框：屏上 = glow 辉光 + 外晕；编辑中 = signal；闲常 = line。
              // 横排卡：左预览（9:16 定高）右信息列 —— 高度由预览决定，无竖版大片空白
              className={`flex overflow-hidden rounded-[var(--radius-control)] border-2 bg-surface-1 transition-[border-color,box-shadow] duration-[var(--duration-fast)] ${
                screen
                  ? 'border-glow-500 shadow-[0_0_14px_-4px_rgba(245,158,11,0.55)]'
                  : selected
                    ? 'border-signal-500/70'
                    : 'border-line hover:border-signal-500/40'
              }`}
            >
              {/* 左：预览屏（点 = 编辑）。135×240 原大；卡列宽不足 135 时按高收缩 */}
              <button
                type="button"
                title={`编辑「${name}」`}
                onClick={() => setEditing(i)}
                aria-pressed={selected}
                className={`relative flex w-[44%] shrink-0 items-center justify-center ${
                  hasFrame ? 'bg-zinc-950' : 'bg-zinc-950/60'
                }`}
              >
                {hasFrame ? (
                  <img
                    src={frameUrl(thumbs[i]!)}
                    alt={`槽位 ${i + 1} 预览`}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="flex flex-col items-center gap-1">
                    <span className="text-xl opacity-25">＋</span>
                    <span className="text-[10px] leading-none opacity-60">未配</span>
                  </span>
                )}
              </button>
              {/* 右：信息 + 操作（自上而下：名 / 来源 / 显示钮钉底） */}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-1 px-2 py-2">
                  {editingName === i ? (
                    <input
                      autoFocus
                      className="input !rounded-lg !px-1.5 !py-1 text-[11px]"
                      defaultValue={slotNames?.[i] ?? ''}
                      placeholder={SLOT_STYLE_NAMES[i]}
                      maxLength={8}
                      onBlur={(e) => {
                        setSlotName?.(i, e.target.value.trim())
                        setEditingName(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      title={`改名「${name}」`}
                      onClick={() => setEditingName(i)}
                      className={`max-w-full truncate rounded-lg px-1 py-0.5 text-[11px] font-semibold leading-tight transition-colors hover:bg-surface-2 ${
                        screen ? 'text-glow-600 dark:text-glow-400' : ''
                      }`}
                    >
                      {name}
                    </button>
                  )}
                  <span className="micro-label max-w-full truncate normal-case tracking-normal opacity-60">
                    {specLabel ?? '未配内容'}
                  </span>
                </div>
                {/* 显示钮：钉右列底部，通栏（屏上时禁用 + 琥珀字）。
                    屏上未确认时旁边给「确认」：点它 = 屏上就是当前配置，不重推 */}
                <div className="flex items-stretch border-t border-line">
                  <button
                    type="button"
                    disabled={!connected || screen}
                    title={screen ? '屏幕正放着它（边框辉光即屏上标记）' : `让屏幕切到「${name}」`}
                    onClick={() => showDevice(i)}
                    className={`min-w-0 flex-1 py-1.5 text-[10px] transition-[color,background-color,box-shadow] duration-[var(--duration-fast)] active:scale-[0.97] disabled:cursor-default ${
                      screen
                        ? 'text-glow-600 dark:text-glow-400'
                        : 'text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] hover:bg-surface-2 hover:text-zinc-900 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:text-zinc-100'
                    }`}
                  >
                    {screen ? (confirmed ? '✓ 显示中 · 已确认' : '显示中') : '显示'}
                  </button>
                  {screen && !confirmed && confirmSlot ? (
                    <button
                      type="button"
                      title="屏上已经是它 —— 点确认把回显刷成当前配置（不重推）"
                      onClick={() => confirmSlot(i)}
                      className="shrink-0 border-l border-line px-2 text-[10px] text-zinc-500 transition-colors hover:bg-surface-2 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    >
                      确认
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
        前 3 个各放一套静态帧当「表盘」（10 帧）；「电子立牌」是轮播 / 场景日程推图的画布（6 帧）。
        点卡片 = 选中编辑，右下「显示」才动屏幕。
      </p>
    </div>
  )
}
