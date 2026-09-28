/**
 * 展示元数据提取：标题/标签/预览/摘要
 * 全部只读消费分享文件，结果只存侧表（ShareRecord），绝不写回文件。
 */

import type { ShareFile, DisplayProfile, SlotSpec } from '../types'
import { SOURCE_LABELS, SNAPSHOT_SOURCES } from '../types'

/** 列表筛选用常用标签 */
export const COMMON_TAGS = ['天气', '图组', 'canvas', '动画', '时钟', '随包图组', '用量']

/** 去重后取前 N 个标签 */
export function pickTags(cands: string[], limit = 6): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of cands) {
    const t = (c ?? '').trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

/** 标题缺省：用户填写 > shareMeta.title > profile.name / gallery.name > 未命名 */
export function deriveTitle(parsed: ShareFile): string {
  return parsed.shareMeta?.title?.trim() || ''
}

/** 收集配置文件里出现的槽位来源标签（weather → 「天气」等） */
export function profileTagCandidates(p: DisplayProfile): string[] {
  const out: string[] = []
  for (const s of p?.slots ?? []) {
    if (!s) continue
    const label = SOURCE_LABELS[s.source]
    if (label) out.push(label)
  }
  return out
}

/** 自动标签：图组文件 → 「图组」；配置文件 → 各槽位来源标签 */
export function deriveTags(parsed: ShareFile): string[] {
  const cands: string[] = [...(parsed.shareMeta?.tags ?? [])]
  if (parsed.type === 'lipai-gallery') {
    cands.push('图组')
  } else {
    for (const p of parsed.profiles ?? []) cands.push(...profileTagCandidates(p))
  }
  return pickTags(cands)
}

/**
 * 详情页预览：顶层 previews 里 profileId 匹配的条目（0.14.3+，可缺失 → 无）。
 * 兼容旧导出：顶层没有时回落读 profile 内嵌 previews。
 */
export function profilePreviews(
  parsed: ShareFile,
  p: DisplayProfile,
): { slot: number; frames: string[] }[] {
  const pick = (raw: unknown): { slot: number; frames: string[] }[] => {
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (v): v is { slot: number; frames: string[] } =>
          !!v &&
          typeof v === 'object' &&
          typeof (v as { slot?: unknown }).slot === 'number' &&
          Array.isArray((v as { frames?: unknown }).frames) &&
          (v as { frames: unknown[] }).frames.length > 0,
      )
      .map((v) => ({ slot: v.slot, frames: v.frames.filter((f) => typeof f === 'string' && f.length > 0) }))
      .filter((v) => v.frames.length > 0)
  }
  const top = pick(parsed.previews?.find((pv) => pv?.profileId === p.id)?.slots)
  if (top.length > 0) return top
  return pick((p as { previews?: unknown }).previews)
}

/** 槽位配方摘要（详情页只读信息区用；字段名对齐真实线上形状 profile-types.SlotSpec） */
export function slotSummary(s: SlotSpec | null): string {
  if (!s) return '空槽位'
  const parts = [SOURCE_LABELS[s.source] ?? String(s.source)]
  if (s.source === 'weather') parts.push(s.city ? `城市：${s.city}` : '城市未设置')
  if (s.source === 'gallery') parts.push(s.galleryTheme ? `图库主题：${s.galleryTheme}` : '图库主题未设置')
  if (s.source === 'user-gallery')
    parts.push(s.userGalleryName ? `我的图组：${s.userGalleryName}` : '图组未设置')
  if (s.source === 'canvas') parts.push('手绘内容（导出时快照）')
  if (s.source === 'usage-credit') parts.push('用量信息（导出时快照）')
  return parts.join(' · ')
}

/** 快照类内容（天气/用量等）→ 详情页加「导出时的快照，非实时」标注 */
export function profileHasSnapshot(p: DisplayProfile): boolean {
  return (p?.slots ?? []).some((s) => s && SNAPSHOT_SOURCES.includes(s.source))
}

/** 汇总详情 previews：顶层 previews（按 profileId 关联）；图组文件则每图组一条（详情页模拟器用） */
export function collectAllPreviews(parsed: ShareFile): { slot: number; frames: string[] }[] {
  if (parsed.type === 'lipai-gallery') {
    return (parsed.galleries ?? []).map((g, i) => ({
      slot: i,
      frames: (g?.frames ?? []).filter((f) => typeof f === 'string' && f.length > 0),
    }))
  }
  const out: { slot: number; frames: string[] }[] = []
  for (const p of parsed.profiles ?? []) out.push(...profilePreviews(parsed, p))
  return out
}
