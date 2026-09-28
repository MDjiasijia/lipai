/**
 * 分享文件 → 详情记录字段的纯函数（前端 / server 共用）。
 *
 * collectPreviews / buildSummary 收口在这里，server/shareLogic.ts 与前端 OPFS
 * 离线回落解析（parseShareRecord）都引用同一份实现。
 */
import type { ParsedShare } from './validate'
import { extractThumb, validateFrameBitmaps } from './validate'
import { slotSpecLabel } from './ips/profile-types'
import type { ShareRecord } from '../types'

/** 槽位来源的中文标签 */
export function sourceLabel(source: unknown): string {
  const map: Record<string, string> = {
    weather: '天气', gallery: '图组', canvas: '画布', 'user-gallery': '随包图组',
    animation: '动画', files: '文件帧', 'usage-credit': '用量',
  }
  return typeof source === 'string' ? (map[source] ?? source) : '未知'
}

export function buildSummary(parsed: ParsedShare): ShareRecord['summary'] {
  // profiles 容错：图组文件没有该字段（服务端路径有 validate 兜底，直接消费文件的路径没有）
  const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : []
  const profiles = (rawProfiles as unknown as Record<string, unknown>[]).map((p) => {
    const slotsRaw = Array.isArray(p.slots) ? p.slots : []
    const slots = slotsRaw.map((s) => {
      if (s === null || typeof s !== 'object') return { source: 'null', label: '空槽位' }
      const slot = s as Record<string, unknown>
      let label = sourceLabel(slot.source)
      if (slot.source === 'weather' && typeof slot.city === 'string') label += ` · ${slot.city}`
      if (slot.source === 'user-gallery' && typeof slot.userGalleryName === 'string') label += ` · ${slot.userGalleryName}`
      if (slot.source === 'gallery' && typeof slot.galleryName === 'string') label += ` · ${slot.galleryName}`
      return { source: String(slot.source ?? ''), label }
    })
    const loop = (p.loop ?? {}) as Record<string, unknown>
    return {
      name: typeof p.name === 'string' ? p.name : '未命名配置',
      activeSlot: typeof p.activeSlot === 'number' ? p.activeSlot : 0,
      slotNames: Array.isArray(p.slotNames) ? (p.slotNames as string[]) : [],
      slots,
      loopSteps: Array.isArray(loop.loopSteps) ? (loop.loopSteps as number[]) : [],
      loopInterval: typeof loop.loopInterval === 'number' ? loop.loopInterval : 0,
    }
  })
  const hasWeatherOrUsage = profiles.some((p) =>
    p.slots.some((s) => s.source === 'weather' || s.source === 'usage-credit'),
  )
  return {
    profiles,
    galleries: parsed.galleries.map((g) => ({
      name: g.name,
      sourcePrompt: g.sourcePrompt,
      frameCount: g.frames.length,
    })),
    hasWeatherOrUsage,
  }
}

/**
 * 从解析结果提取 previews 汇总（每个槽位取前几帧进详情接口，控制记录体积）。
 * 来源优先级：顶层 previews（0.14.3+，按 profileId 关联）→ profile 内嵌 previews（旧导出）；
 * 图组文件则每个图组一条（模拟器按图组切换）。
 */
export function collectPreviews(
  parsed: ParsedShare,
  perSlot = 10,
): { slot: number; frames: string[]; label?: string }[] {
  const out: { slot: number; frames: string[]; label?: string }[] = []
  // 图组文件：每个图组一条（slot 用图组下标）
  if (parsed.type === 'lipai-gallery') {
    parsed.galleries.forEach((g, i) => {
      const valid = g.frames.filter((f): f is string => typeof f === 'string' && f.length > 0)
      if (valid.length > 0) out.push({ slot: i, frames: valid.slice(0, perSlot), label: g.name })
    })
    return out
  }
  const top = Array.isArray((parsed as { previews?: unknown }).previews)
    ? ((parsed as { previews: unknown }).previews as unknown[])
    : null
  const usedProfileIds = new Set<string>()
  if (top) {
    for (const entry of top) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const profileId = typeof e.profileId === 'string' ? e.profileId : null
      if (!profileId || !Array.isArray(e.slots)) continue
      // profile 级命名材料：配置名 + 槽位配方语义名（按 slot 号取）
      const prof = (parsed.profiles as unknown as Record<string, unknown>[]).find((p) => p?.id === profileId)
      const slotNames = Array.isArray(prof?.slotNames) ? (prof!.slotNames as unknown[]) : []
      const profSlots = Array.isArray(prof?.slots) ? (prof!.slots as unknown[]) : []
      for (const pv of e.slots) {
        if (pv === null || typeof pv !== 'object') continue
        const slot = (pv as Record<string, unknown>).slot
        const frames = (pv as Record<string, unknown>).frames
        if (typeof slot !== 'number' || !Array.isArray(frames)) continue
        const valid = frames.filter((f): f is string => typeof f === 'string' && f.length > 0)
        if (valid.length > 0) {
          // 名称优先级：用户自定义槽位名 > 槽位配方语义名（「天气 · 上海」）> 配置名
          const customName = typeof slotNames[slot] === 'string' ? (slotNames[slot] as string).trim() : ''
          const specLabel = slotSpecLabel(profSlots[slot] ?? null)
          const label =
            customName || (specLabel !== '空槽位' ? specLabel : '') ||
            (typeof prof?.name === 'string' && prof.name ? prof.name : '')
          out.push({ slot, frames: valid.slice(0, perSlot), ...(label ? { label } : {}) })
          usedProfileIds.add(profileId)
        }
      }
    }
  }
  // 顶层 previews 缺失或该 profile 没有条目 → 回落读 profile 内嵌 previews（旧导出）
  for (const p of parsed.profiles as unknown as Record<string, unknown>[]) {
    if (typeof p.id === 'string' && usedProfileIds.has(p.id)) continue
    const previews = p.previews
    if (!Array.isArray(previews)) continue
    const slotNames = Array.isArray(p.slotNames) ? (p.slotNames as unknown[]) : []
    const profSlots = Array.isArray(p.slots) ? (p.slots as unknown[]) : []
    for (const pv of previews) {
      if (pv === null || typeof pv !== 'object') continue
      const slot = (pv as Record<string, unknown>).slot
      const frames = (pv as Record<string, unknown>).frames
      if (typeof slot !== 'number' || !Array.isArray(frames)) continue
      const valid = frames.filter((f): f is string => typeof f === 'string' && f.length > 0)
      if (valid.length > 0) {
        const customName = typeof slotNames[slot] === 'string' ? (slotNames[slot] as string).trim() : ''
        const specLabel = slotSpecLabel(profSlots[slot] ?? null)
        const label =
          customName || (specLabel !== '空槽位' ? specLabel : '') ||
          (typeof p.name === 'string' && p.name ? p.name : '')
        out.push({ slot, frames: valid.slice(0, perSlot), ...(label ? { label } : {}) })
      }
    }
  }
  return out
}

/** 收集文件内全部帧（galleries + 顶层/内嵌 previews），交给位图校验 */
export async function collectBitmapErrors(parsed: ParsedShare): Promise<string[]> {
  const frames: string[] = []
  for (const g of parsed.galleries) frames.push(...(g?.frames ?? []))
  const top = (parsed as { previews?: { slots?: { frames?: string[] }[] }[] }).previews
  for (const entry of top ?? []) {
    for (const s of entry?.slots ?? []) frames.push(...(s?.frames ?? []))
  }
  for (const p of parsed.profiles) {
    for (const pv of ((p as { previews?: { frames?: string[] }[] }).previews ?? [])) {
      frames.push(...(pv?.frames ?? []))
    }
  }
  if (frames.length === 0) return []
  return validateFrameBitmaps(frames)
}

/** 构建一条 ShareRecord 主体（不含 id 与时间与侧表运行时字段，落库时补） */
export function buildRecord(
  parsed: ParsedShare,
  meta: { title: string; description: string; tags: string[]; author?: string; authorAvatar?: string },
): Omit<ShareRecord, 'id' | 'createdAt'> {
  const previews = collectPreviews(parsed)
  return {
    sha256: '',
    size: 0,
    type: parsed.type,
    version: parsed.version,
    meta,
    downloads: 0,
    removed: false,
    uploader: null,
    uploaderName: null,
    thumb: extractThumb(parsed),
    previews,
    hasPreviews: previews.length > 0,
    summary: buildSummary(parsed),
  }
}

/**
 * 原始分享文件文本 → 详情记录（OPFS 离线回落用）。
 * 校验不在这里做（缓存的字节来自服务端下载接口，已是校验过的文件）；
 * 解析失败回 null，调用方回落到无详情的降级态。
 * 侧表字段（downloads/removed/点赞态）不在文件里 —— 由调用方以已知记录补齐。
 */
export function parseShareRecord(raw: string): Omit<ShareRecord, 'id' | 'createdAt' | 'downloads' | 'removed' | 'uploader' | 'uploaderName'> | null {
  let parsed: ParsedShare
  try {
    parsed = JSON.parse(raw) as ParsedShare
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.galleries)) return null
  // profiles 容错归一（图组文件可缺；collectPreviews/buildSummary 按数组消费）
  if (!Array.isArray((parsed as { profiles?: unknown }).profiles)) {
    ;(parsed as { profiles: unknown[] }).profiles = []
  }
  const previews = collectPreviews(parsed)
  return {
    sha256: '',
    size: 0,
    type: parsed.type,
    version: parsed.version,
    meta: {
      title: parsed.shareMeta?.title ?? parsed.profiles?.[0]?.name ?? parsed.galleries[0]?.name ?? '未命名分享',
      description: parsed.shareMeta?.description ?? '',
      tags: parsed.shareMeta?.tags ?? [],
      ...(parsed.shareMeta?.author ? { author: parsed.shareMeta.author } : {}),
    },
    thumb: extractThumb(parsed),
    previews,
    hasPreviews: previews.length > 0,
    summary: buildSummary(parsed),
  }
}
