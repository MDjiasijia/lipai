/**
 * 内容来源选择器 —— 单级平铺，一步直达。
 *
 * 此前两级（大类 4 格 → 组内成员行）：点大类还会静默落到第一个成员，
 * 「想选本地图片」得先猜它在「图片」大类下 —— 交互绕。
 * 收回一级：每个来源一个带图标的按钮，title 提示细节，点谁是谁。
 * 顺序按使用频率排：画布 → 我的图组 → 内置图库 → 天气 → 接口 → 本地图片 → 内置动画。
 *
 * 选中 = chip-on（浮起镜片）；未选 = 内凹槽里的玻璃片（内凹阴影半分量：
 * 不画完整 glass-track 轨道边框 —— 网格里逐格画框会碎）。
 * 按压形变 active:scale 承担物理确认。
 */
import type { ReactElement } from 'react'
import type { SlotSpec } from '../../lib/ips/profile-types'
import {
  IconStack,
  IconImage,
  IconBrush,
  IconWeather,
  IconPlug,
  IconFilm,
  IconFileImage,
} from '../icons'

type SourceKind = NonNullable<SlotSpec['source']>

/** 平铺来源清单（顺序 = 使用频率；hint 进 title 提示，不再占一行）。
 *  本地版变化（对齐本地工具架构）：
 *  - 用量/额度系（usage/credit/usage-credit）入口删除 —— 数据链已随内部平台退役，
 *    SlotSource 联合类型保留成员名（存量配方 / v2 分享文件兼容），
 *    渲染走 pipeline 的「来源已移除」占位卡；
 *  - files（本地图片）/ animation（内置动画）入口恢复 —— 渲染链都在
 *    （前端浏览器渲染器 + 服务端常驻自动化共用同一套配方语义）。 */
const SOURCES: { key: SourceKind; label: string; hint: string; icon: ReactElement }[] = [
  { key: 'canvas', label: '自由画布', hint: '文案主题 + 配色主题，一秒出一套表盘帧', icon: <IconBrush /> },
  { key: 'user-gallery', label: '我的图组', hint: '从素材库导入 / 自由画布存的图组（服务端落盘 ~/.lipai/gallery/）', icon: <IconStack /> },
  { key: 'gallery', label: '内置图库', hint: '自带精美图库（anime / animals）随机裁剪', icon: <IconImage /> },
  { key: 'weather', label: '天气卡片', hint: '真实天气卡片（Open-Meteo），按此刻 UV / 日出日落渲染', icon: <IconWeather /> },
  { key: 'datafeed', label: '自定义接口', hint: '自定义数据源：任意接口数据渲成卡片（在管理里配置）', icon: <IconPlug /> },
  { key: 'files', label: '本地图片', hint: '本地图片文件裁剪成帧（帧直接存进配方，无需服务端）', icon: <IconFileImage /> },
  { key: 'animation', label: '内置动画', hint: '月亮圆缺 / 火箭发射 / 猫咪探头等 8 种预设动画', icon: <IconFilm /> },
]

export function SourcePicker({
  source,
  onSourceChange,
}: {
  source: SourceKind | undefined
  onSourceChange: (s: SourceKind) => void
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {SOURCES.map((s) => {
          const active = s.key === source
          return (
            <button
              key={s.key}
              type="button"
              title={s.hint}
              onClick={() => onSourceChange(s.key)}
              aria-pressed={active}
              className={`flex min-h-9 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-transparent px-2 py-1.5 text-xs font-semibold transition-[color,background-color,border-color,box-shadow,transform] duration-[var(--duration-fast)] active:scale-[0.97] ${
                active
                  ? 'chip-on'
                  : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 hover:text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              {s.icon}
              {s.label}
            </button>
          )
        })}
      </div>
      {/* 存量配方里还有用量/额度系来源（usage/credit/usage-credit）：就地说明状态与出路。
          新配不再有入口（上面的清单不给）；老配方读进来仍能渲染（pipeline 占位卡）。 */}
      {(source === 'usage' || source === 'credit' || source === 'usage-credit') && (
        <p className="rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          「用量+额度」来源已退役 —— 屏上会渲染一张说明卡。请换个来源（天气 / 图库 / 画布 / 接口）。
        </p>
      )}
    </div>
  )
}
