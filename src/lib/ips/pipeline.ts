/**
 * 配方 → 帧流水线（Web 版投屏核心）—— 浏览器渲染器 + 服务端数据源。
 *
 * 渲染保持浏览器渲染器（render/ 目录：Worker 里的 canvas → JPEG）；
 * 数据获取改服务端：图组帧走 /api/galleries（~/.lipai/ 唯一真源），
 * 天气卡保留前端直连 Open-Meteo（render/weather.ts 免 Key、CORS 开放 ——
 * 简化：前端渲染全套保留，服务端只在常驻自动化里用它的渲染管线）。
 *
 * 用量/额度系（usage / credit / usage-credit）已整体剔除（无内部平台数据链路）：
 * SlotSource 联合类型保留成员名（兼容旧配方 / v2 分享文件），渲染统一走
 * renderRemovedSourceCards —— 一张「来源已移除」说明卡，不抛错（轮播不断）。
 */
import type { SlotSpec } from './profile-types'
import type { WeatherResult } from './render/weather'
import { getWeather } from './render/weather'
import { renderWeatherCards } from './render/render'
import {
  cropGalleryImage,
  listGalleryImages,
  renderCanvasFrames,
  renderCustomEmojiFrames,
  renderDigitImages,
} from './render/render'
import { getUserGalleryFrames } from './gallery-store'
import { stampFrameNumber } from './render/render'
import type { CanvasFrameSpec } from './render/render'
import { weatherCardLabel, orderWeatherCards } from './weather-cards'
// 收口转发：槽位容量的真相源在 profile-types.ts（此前两份重复定义）
export { slotCapacity } from './profile-types'
import { slotCapacity } from './profile-types'

/** 预览帧的语义元数据（与帧一一对应；天气/图库主题有，其余来源可缺省） */
export interface FrameMeta {
  id: string
  name: string
}

/** 渲染结果：帧 + 人类可读的来源标签（UI 展示 / 错误诊断） */
export interface SlotRender {
  frames: Uint8Array[]
  label: string
  /** 与 frames 一一对应的卡语义（有 ID 的来源：天气）；
   *  预览条用它显示卡名 + 支持拖拽排序（改 weatherCardOrder） */
  meta?: FrameMeta[]
  /**
   * 截断前的全部候选（天气这类「有数据才出卡」的来源给全量 —— 预览要
   * 展示所有卡、被排除/超容的置灰，用户才勾得回来）；frames 是其中的推送子集。
   * datafeed 等自身全量出卡的来源不给（frames 即全量）。
   */
  all?: { image: Uint8Array; meta: FrameMeta }[]
}

/** 说明性占位帧（数据源缺失/被删等场景，屏上直接看到原因） */
async function placeholderFrames(text: string): Promise<Uint8Array[]> {
  return renderCanvasFrames([
    { text, fg: '#9aa4b2', bgTop: '#14171c', bgBottom: '#23272f' },
  ])
}

/**
 * 「来源已移除」说明卡（三个源共用）。
 * 一张卡说明情况 + 两条出路（换个来源 / 旧配方兼容说明），不抛错 ——
 * 投屏流水线里一个槽位失败不该拖垮整份配置的应用；轮播照走。
 */
async function renderRemovedSourceCards(source: string): Promise<Uint8Array[]> {
  const label: Record<string, string> = {
    usage: '用量',
    credit: '额度',
    'usage-credit': '用量+额度',
  }
  return renderCanvasFrames([
    { text: `${label[source] ?? source}来源已移除`, fg: '#fbbf24', bgTop: '#1c1917', bgBottom: '#292524' },
    { text: '用量+额度源已退役', fg: '#a8a29e', bgTop: '#1c1917', bgBottom: '#292524' },
    { text: '换个来源（天气/图库/画布）', fg: '#9aa4b2', bgTop: '#14171c', bgBottom: '#23272f' },
  ])
}

/**
 * 按槽位配方现取内容渲染帧。
 * 失败不抛错（返回占位帧）—— 投屏流水线里一个槽位失败不该拖垮整份配置的应用；
 * 占位帧上写明原因，用户在屏幕上直接看到哪个槽位出了问题。
 */
export async function renderSlot(
  slot: number,
  spec: SlotSpec | null,
  opts: { weatherMaxAgeMs?: number } = {},
): Promise<SlotRender> {
  const cap = slotCapacity(slot)
  if (!spec) {
    return { frames: [], label: '空槽位' }
  }
  try {
    switch (spec.source) {
      case 'weather': {
        const city = spec.city || '上海'
        const weather: WeatherResult = await getWeather(city, {
          maxAgeMs: opts.weatherMaxAgeMs,
        })
        const cards = await renderWeatherCards(weather)
        // weatherCardOrder：用户拖拽的语义 ID 顺序（数据是新的、顺序是你定的）
        // 收口：排序只走 weather-cards.ts 的 orderWeatherCards
        const sorted = orderWeatherCards(cards, spec.weatherCardOrder)
        // 排除字段已废弃（勾选框撤掉，纯「排序 + 容量截断」语义）——
        // 历史残留的 excludedWeatherCards 一律无视，全部卡参与排序与截断
        let picked = sorted.slice(0, cap)
        if (picked.length === 0) picked = [{ id: 'main', image: (await renderDigitImages())[0]! }]
        if (spec.stampNumbers) {
          picked = await Promise.all(
            picked.map(async (c, i) => ({ ...c, image: await stampFrameNumber(c.image, i % 10) })),
          )
        }
        return {
          frames: picked.map((c) => c.image),
          label: `天气 · ${city}`,
          meta: picked.map((c) => ({ id: c.id, name: weatherCardLabel(c.id) })),
          all: sorted.map((c) => ({ image: c.image, meta: { id: c.id, name: weatherCardLabel(c.id) } })),
        }
      }
      case 'gallery': {
        const theme = (spec.galleryTheme as 'anime' | 'animals') ?? 'anime'
        const names = listGalleryImages(theme)
        if (names.length === 0) throw new Error(`图库主题「${theme}」为空`)
        const frames: Uint8Array[] = []
        for (let i = 0; i < cap; i++) {
          const name = names[i % names.length]!
          frames.push(await cropGalleryImage(name, theme))
        }
        return { frames, label: `图库 · ${theme}` }
      }
      case 'user-gallery': {
        // 图组帧改服务端取（~/.lipai/gallery/ 唯一真源）；空/不存在由占位帧说明
        const name = spec.userGalleryName ?? ''
        const b64s = await getUserGalleryFrames(name)
        if (b64s.length === 0) throw new Error(`图组「${name}」不存在或为空`)
        const { loadImageFromBytes } = await import('./render/canvas-adapter')
        const { createCanvas } = await import('./render/canvas-adapter')
        const frames: Uint8Array[] = []
        for (let i = 0; i < cap; i++) {
          const b64 = b64s[i % b64s.length]!
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const img = await loadImageFromBytes(bytes)
          const canvas = createCanvas(135, 240)
          const ctx = canvas.getContext('2d')
          // cover 裁剪（与 cropGalleryImage 同规则）
          const targetRatio = 135 / 240
          const srcRatio = img.width / img.height
          let sx = 0
          let sy = 0
          let cropW = img.width
          let cropH = img.height
          if (srcRatio > targetRatio) {
            cropW = img.height * targetRatio
            sx = (img.width - cropW) / 2
          } else {
            cropH = img.width / targetRatio
            sy = (img.height - cropH) / 2
          }
          ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, 135, 240)
          frames.push(await canvas.toJpegBytes())
        }
        return { frames, label: `图组 · ${name}` }
      }
      case 'datafeed': {
        // 自定义接口：拉数据（带 TTL 缓存）→ 按槽位挑选的卡模板渲染。
        // 定义不存在 = 引用了被删除的数据源 —— 占位帧说明原因（不抛错，轮播不断）。
        const ref = spec.datafeed
        if (!ref?.defId) return { frames: [], label: '自定义接口（未选择数据源）' }
        const { readDataFeedDef } = await import('./datafeed-store')
        const def = await readDataFeedDef(ref.defId)
        if (!def) {
          return {
            frames: await placeholderFrames('数据源已被删除'),
            label: '自定义接口（定义缺失）',
          }
        }
        const { fetchDataFeed, renderDataFeedCards } = await import('./render/render-datafeed')
        const { data } = await fetchDataFeed(def)
        // 全部候选 → 按槽位 cardIds 挑选（空 = 全出）→ cardOrder 重排 → 截断到容量
        let cards = await renderDataFeedCards(def, data)
        const idSet = new Set(ref.cardIds ?? [])
        if (idSet.size > 0) cards = cards.filter((c) => idSet.has(c.id))
        if (ref.cardOrder?.length) {
          const pos = new Map<string, number>()
          ref.cardOrder.forEach((id, i) => pos.set(id, i))
          cards = [...cards].sort(
            (a, b) => (pos.get(a.id) ?? pos.size) - (pos.get(b.id) ?? pos.size),
          )
        }
        const picked = cards.slice(0, cap)
        if (picked.length === 0) {
          return { frames: await placeholderFrames('没有可出的卡（模板为空或全被排除）'), label: `接口 · ${def.name}` }
        }
        let frames = picked.map((c) => c.image)
        if (spec.stampNumbers) {
          frames = await Promise.all(
            frames.map(async (img, i) => await stampFrameNumber(img, i % 10)),
          )
        }
        const labelById = new Map(def.cards.map((t) => [t.id, t.label]))
        return {
          frames,
          label: `接口 · ${def.name}`,
          meta: picked.map((c) => ({ id: c.id, name: labelById.get(c.id) ?? c.id })),
        }
      }
      case 'canvas': {
        // 对齐上游扩展版 backend/index.ts：canvas 缺配置返回 []（空 = 无可推），
        // 绝不抛「画布配置缺失」；frameTexts/frameColors 逐帧缺省。
        // canvasInputText / canvasSplit 是纯 UI 字段（重新分帧用），渲染器不读。
        const c = spec.canvas
        if (!c) return { frames: [], label: '自由画布（未配置）' }
        const specs: CanvasFrameSpec[] = Array.from({ length: cap }, (_, i) => {
          const color = c.frameColors?.[i] ?? { fg: '#ffffff', bgTop: '#0a0a0a', bgBottom: '#1a1a1a' }
          return {
            text: c.frameTexts?.[i] ?? '',
            fg: color.fg,
            bgTop: color.bgTop,
            bgBottom: color.bgBottom,
          }
        })
        if (c.bgBase64) {
          // 背景图铺在每帧下面（renderCanvasFrames 的 bgImage 语义）
          const bytes = Uint8Array.from(atob(c.bgBase64), (ch) => ch.charCodeAt(0))
          for (const s of specs) (s as CanvasFrameSpec & { bgImage?: Uint8Array }).bgImage = bytes
        }
        let frames = await renderCanvasFrames(specs.slice(0, cap))
        if (frames.length === 0) frames = await placeholderFrames('画布为空')
        return { frames, label: '自由画布' }
      }
      case 'animation':
      case 'files': {
        // 来源已停用（share-web 删线）：选择器不再提供入口；SlotSource 类型成员保留
        // （存量配方 / 分享文件兼容），渲染统一走「来源已停用」说明帧——不抛错。
        return {
          frames: await placeholderFrames('此来源已停用（本地图片 / 内置动画）'),
          label: '来源已停用',
        }
      }
      case 'usage':
      case 'credit':
      case 'usage-credit': {
        // 用量/额度链已整体移除：成员名保留兼容旧配方 ——
        // 渲染「来源已移除」说明卡，不抛错（轮播不断；服务端常驻版返回空池跳到下一步）。
        return {
          frames: await renderRemovedSourceCards(spec.source),
          label: '来源已移除',
        }
      }
      default: {
        return {
          frames: await placeholderFrames(`未知来源 ${String(spec.source)}`),
          label: `未知来源 ${String(spec.source)}`,
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      frames: await placeholderFrames(`槽位渲染失败：${msg.slice(0, 40)}`),
      label: `渲染失败：${msg.slice(0, 60)}`,
    }
  }
}

/** emoji 序列帧（renderCustomEmojiFrames 直通；UI 的「表情序列」内容源） */
export async function renderEmojiSequence(
  cells: string[],
  theme = '霓虹蓝',
): Promise<Uint8Array[]> {
  return renderCustomEmojiFrames(cells, theme)
}

/** 数字时钟帧（自定义数字时钟槽位；renderDigitImages 直通） */
export async function renderDigits(theme = '霓虹蓝'): Promise<Uint8Array[]> {
  return renderDigitImages(theme)
}
