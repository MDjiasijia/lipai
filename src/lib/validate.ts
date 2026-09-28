/**
 * 上传校验：API 侧必做；前端在上传页用同一套规则先做一遍，给即时反馈。
 * 规则来自 PRD「上传校验」（0.14.3 契约）：
 *  - JSON.parse 失败 → 拒绝；type ∈ {lipai-profile, lipai-gallery}；version 为数字
 *  - 请求体 ≤ 8MB（previews 嵌入后单份配置 0.7–1MB、合集数 MB，2MB 会误杀合法文件）
 *  - 每份 frames[]：非空数组；每项 base64 可解码；解码后前两字节 FF D8（JPEG magic）
 *  - 位图校验（同步字节解析）：JPEG SOF 段取宽高，宽高比 9:16 ±15%、
 *    尺寸 ≤ 300×600（防 base64 炸弹；Workers 无 createImageBitmap，用字节解析实现）
 *  - 单文件解码后总字节 ≤ 8MB
 *  - profiles/galleries 数组长度 ≤ 20；所有字符串字段长度上限 200
 *  - previews ≤ profiles 数量、每份 slots ≤ 4、每槽 frames ≤ 10
 */

import type { ShareFile } from '../types'

export const MAX_BODY_BYTES = 8 * 1024 * 1024
export const MAX_DECODED_BYTES = 8 * 1024 * 1024
export const MAX_ARRAY_LEN = 20
export const MAX_STR_LEN = 200
export const MAX_PREVIEW_SLOTS = 4
export const MAX_FRAMES_PER_SLOT = 10
/** 位图尺寸上限（防 base64 炸弹），9:16 竖屏放 大 */
export const MAX_FRAME_W = 300
export const MAX_FRAME_H = 600
/** 宽高比容差：9:16 = 0.5625，±15% */
export const ASPECT_TARGET = 9 / 16
export const ASPECT_TOLERANCE = 0.15
export const VALID_TYPES = ['lipai-profile', 'lipai-gallery'] as const

/** 校验通过后的解析结果（profiles 恒为数组，方便消费方直接 map） */
export type ParsedShare = ShareFile & { profiles: NonNullable<ShareFile['profiles']> }

export interface ValidateOutcome {
  ok: boolean
  /** 可读中文错误（最多收集 10 条） */
  errors: string[]
  data?: ParsedShare
}

/** base64 → 字节（严格解码，失败返回 null） */
export function decodeBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** JPEG magic：前两字节 FF D8 */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

const ERR_CAP = 10

/**
 * 校验分享文件文本。收集错误而不是遇错即停，前端能一次看到所有问题。
 */
export function validateShareFile(raw: string, bytes?: number): ValidateOutcome {
  const errors: string[] = []
  const push = (msg: string) => {
    if (errors.length < ERR_CAP) errors.push(msg)
  }
  let decodedTotal = 0
  let tooLong = false // 错误条数截断后避免继续大量解码

  if (bytes !== undefined && bytes > MAX_BODY_BYTES) {
    push(`文件 ${(bytes / 1024 / 1024).toFixed(2)}MB 超过 8MB 上限`)
    return { ok: false, errors }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, errors: ['不是合法的 JSON 文件（JSON.parse 失败）'] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['文件顶层必须是 JSON 对象'] }
  }
  const obj = parsed as Record<string, unknown>

  const type = obj.type
  if (typeof type !== 'string' || !VALID_TYPES.includes(type as never)) {
    push(`type 必须是 ${VALID_TYPES.join(' 或 ')}，实际为「${String(type)}」`)
  }
  // 类型与内容必须一致：图组分享不应夹带 profiles —— 否则记录被归到图组下、
  // 导入时却会带出配置，列表分类与可应用内容对不上
  if (type === 'lipai-gallery' && Array.isArray(obj.profiles) && obj.profiles.length > 0) {
    push('图组分享文件不应包含 profiles（分享配置请用 lipai-profile 类型）')
  }
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version)) {
    push('version 必须是数字')
  } else if (obj.version !== 2) {
    push(`当前仅支持 version 2，实际为 ${obj.version}`)
  }

  // —— 所有字符串字段 ≤ 200 字符（frames / previews 帧 / bgBase64 这类 base64 除外）——
  const longStrings = collectLongStrings(obj)
  for (const path of longStrings.slice(0, 3)) push(`字段 ${path} 超过 ${MAX_STR_LEN} 字符上限`)
  if (longStrings.length > 3) push(`另有 ${longStrings.length - 3} 个字段超长`)

  // —— galleries ——
  const galleries = obj.galleries
  if (!Array.isArray(galleries)) {
    push('galleries 必须是数组')
  } else {
    if (galleries.length > MAX_ARRAY_LEN) push(`galleries 数量 ${galleries.length} 超过上限 ${MAX_ARRAY_LEN}`)
    galleries.forEach((g, gi) => {
      if (!g || typeof g !== 'object' || Array.isArray(g)) {
        push(`galleries[${gi}] 必须是对象`)
        return
      }
      const gal = g as Record<string, unknown>
      if (typeof gal.name !== 'string' || !gal.name.trim()) push(`galleries[${gi}].name 必须是非空字符串`)
      const frames = gal.frames
      if (!Array.isArray(frames) || frames.length === 0) {
        push(`galleries[${gi}].frames 必须是非空数组`)
        return
      }
      frames.forEach((f, fi) => {
        if (tooLong) return
        const bad = checkFrame(f)
        if (bad === 'format') push(`galleries[${gi}].frames[${fi}] 不是合法 base64`)
        else if (bad === 'magic') push(`galleries[${gi}].frames[${fi}] 不是 JPEG（前两字节非 FF D8）`)
        else if (bad === 'bomb') {
          push('解码后帧总长超过 3MB（疑似 base64 炸弹）')
          tooLong = true
        }
      })
    })
  }

  // —— 顶层 previews（0.14.3+，可缺失）：{ profileId, slots: [{ slot, frames }] }[] ——
  // 限额：previews ≤ profiles 数量、每份 slots ≤ 4、每槽 frames ≤ 10
  if (obj.previews !== undefined) {
    const topPreviews = obj.previews
    if (!Array.isArray(topPreviews)) {
      push('previews 必须是数组')
    } else {
      const profileCount = Array.isArray(obj.profiles) ? obj.profiles.length : 0
      if (topPreviews.length > Math.max(profileCount, 1))
        push(`previews 数量 ${topPreviews.length} 超过 profiles 数量 ${profileCount}`)
      topPreviews.forEach((entry, ei) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          push(`previews[${ei}] 必须是对象`)
          return
        }
        const e = entry as Record<string, unknown>
        if (typeof e.profileId !== 'string' || !e.profileId.trim()) {
          push(`previews[${ei}].profileId 必须是非空字符串`)
        }
        if (!Array.isArray(e.slots)) {
          push(`previews[${ei}].slots 必须是数组`)
          return
        }
        if (e.slots.length > MAX_PREVIEW_SLOTS)
          push(`previews[${ei}].slots 数量 ${e.slots.length} 超过上限 ${MAX_PREVIEW_SLOTS}`)
        e.slots.forEach((pv, si) => {
          if (!pv || typeof pv !== 'object' || Array.isArray(pv)) {
            push(`previews[${ei}].slots[${si}] 必须是对象`)
            return
          }
          const item = pv as Record<string, unknown>
          if (typeof item.slot !== 'number') push(`previews[${ei}].slots[${si}].slot 必须是数字`)
          if (!Array.isArray(item.frames) || item.frames.length === 0) {
            push(`previews[${ei}].slots[${si}].frames 必须是非空数组`)
            return
          }
          if (item.frames.length > MAX_FRAMES_PER_SLOT)
            push(`previews[${ei}].slots[${si}].frames 数量 ${item.frames.length} 超过上限 ${MAX_FRAMES_PER_SLOT}`)
          item.frames.forEach((f, fi) => {
            if (tooLong) return
            const bad = checkFrame(f)
            if (bad === 'format') push(`previews[${ei}].slots[${si}].frames[${fi}] 不是合法 base64`)
            else if (bad === 'magic') push(`previews[${ei}].slots[${si}].frames[${fi}] 不是 JPEG（前两字节非 FF D8）`)
            else if (bad === 'bomb') {
              push('解码后帧总长超过 8MB（疑似 base64 炸弹）')
              tooLong = true
            }
          })
        })
      })
    }
  }

  // —— profiles（仅 lipai-profile）——
  if (type === 'lipai-profile') {
    const profiles = obj.profiles
    if (!Array.isArray(profiles)) {
      push('配置分享文件必须包含 profiles 数组')
    } else {
      if (profiles.length > MAX_ARRAY_LEN) push(`profiles 数量 ${profiles.length} 超过上限 ${MAX_ARRAY_LEN}`)
      profiles.forEach((p, pi) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          push(`profiles[${pi}] 必须是对象`)
          return
        }
        const prof = p as Record<string, unknown>
        // slots：(SlotSpec|null)[4]
        if (!Array.isArray(prof.slots) || prof.slots.length !== 4) {
          push(`profiles[${pi}].slots 必须是长度为 4 的数组`)
        }
        // previews（旧导出的内嵌格式，存在则按帧校验；新导出走顶层 previews）
        const previews = prof.previews
        if (previews !== undefined) {
          if (!Array.isArray(previews)) {
            push(`profiles[${pi}].previews 必须是数组`)
            return
          }
          previews.forEach((pv, vi) => {
            if (!pv || typeof pv !== 'object' || Array.isArray(pv)) {
              push(`profiles[${pi}].previews[${vi}] 必须是对象`)
              return
            }
            const item = pv as Record<string, unknown>
            if (typeof item.slot !== 'number') push(`profiles[${pi}].previews[${vi}].slot 必须是数字`)
            if (!Array.isArray(item.frames) || item.frames.length === 0) {
              push(`profiles[${pi}].previews[${vi}].frames 必须是非空数组`)
              return
            }
            if (item.frames.length > MAX_FRAMES_PER_SLOT)
              push(`profiles[${pi}].previews[${vi}].frames 数量 ${item.frames.length} 超过上限 ${MAX_FRAMES_PER_SLOT}`)
            item.frames.forEach((f, fi) => {
              if (tooLong) return
              const bad = checkFrame(f)
              if (bad === 'format') push(`profiles[${pi}].previews[${vi}].frames[${fi}] 不是合法 base64`)
              else if (bad === 'magic') push(`profiles[${pi}].previews[${vi}].frames[${fi}] 不是 JPEG（前两字节非 FF D8）`)
              else if (bad === 'bomb') {
                push('解码后帧总长超过 8MB（疑似 base64 炸弹）')
                tooLong = true
              }
            })
          })
        }
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const data = parsed as ParsedShare
  if (!Array.isArray(data.profiles)) (data as { profiles: unknown[] }).profiles = []
  if (!Array.isArray(data.galleries)) (data as { galleries: unknown[] }).galleries = []
  return { ok: true, errors, data }

  /** 单帧检查：返回 null（通过）/ 'format' / 'magic' / 'bomb' */
  function checkFrame(f: unknown): 'format' | 'magic' | 'bomb' | null {
    if (typeof f !== 'string' || f.length === 0) return 'format'
    const bytes = decodeBase64(f)
    if (!bytes) return 'format'
    if (!isJpeg(bytes)) return 'magic'
    decodedTotal += bytes.length
    if (decodedTotal > MAX_DECODED_BYTES) return 'bomb'
    return null
  }
}

/** 递归收集超过 200 字符的字符串字段路径（跳过 base64 帧类字段） */
function collectLongStrings(v: unknown, path = ''): string[] {
  const out: string[] = []
  const walk = (val: unknown, p: string) => {
    if (typeof val === 'string') {
      // frames 项 / previews 帧 / bgBase64 属于 base64 大字段，走解码字节校验，不受 200 字符限制
      const isBase64Field =
        /\.frames\[\d+\]$/.test(p) || p === 'bgBase64' || /\.bgBase64$/.test(p) || p.endsWith('shareMeta')
      if (!isBase64Field && val.length > MAX_STR_LEN) out.push(p || '(顶层)')
      return
    }
    if (Array.isArray(val)) {
      val.forEach((item, i) => walk(item, `${p}[${i}]`))
      return
    }
    if (val && typeof val === 'object') {
      for (const [k, v2] of Object.entries(val)) walk(v2, p ? `${p}.${k}` : k)
    }
  }
  walk(v, path)
  return out
}

/** 首帧缩略图：顶层 previews 首帧 → profile 内嵌 previews 首帧 → 首个图组首帧 → null */
export function extractThumb(parsed: ParsedShare): string | null {
  for (const entry of (parsed as { previews?: { slots?: { frames?: unknown[] }[] }[] }).previews ?? []) {
    for (const s of entry?.slots ?? []) {
      const f = (s?.frames ?? []).find((x) => typeof x === 'string' && (x as string).length > 0) as
        | string
        | undefined
      if (f) return f
    }
  }
  for (const p of parsed.profiles ?? []) {
    // 旧导出的内嵌 previews：新形状 DisplayProfile 没有这个字段，经 unknown 读容错
    for (const pv of ((p as unknown as { previews?: { slot: number; frames: string[] }[] }).previews ??
      []) as { slot: number; frames: string[] }[]) {
      const f = (pv?.frames ?? []).find((x) => typeof x === 'string' && x.length > 0)
      if (f) return f
    }
  }
  for (const g of parsed.galleries ?? []) {
    const f = (g?.frames ?? []).find((x) => typeof x === 'string' && x.length > 0)
    if (f) return f
  }
  return null
}

/**
 * 从 JPEG 字节流解析 SOF0/1/2 段取宽高（纯字节解析，不完整解码）。
 * Workers 运行时没有 createImageBitmap（浏览器 API），位图校验用本函数实现同等效果。
 * @returns null = 没有 SOF 段（损坏/非 JPEG）
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 都带宽高（0xC0–0xCF，剔除 DHT/C4 与 DAC/CC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6]
      const width = (bytes[i + 7] << 8) | bytes[i + 8]
      return { width, height }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2 // 无长度段的标记
      continue
    }
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3]
    if (segLen < 2) return null
    i += 2 + segLen
  }
  return null
}

/**
 * 位图校验：解析每帧 JPEG 宽高，确认宽高比 9:16 ±15%、尺寸 ≤ 300×600。
 * 浏览器端（上传页）与 API 侧（Workers）同规则；任一帧失败即拒绝。
 * @param frames 所有待校验的 base64 JPEG（galleries + previews 的帧原样传入即可）
 * @returns 错误列表（空 = 全部通过）
 */
export function validateFrameBitmaps(frames: string[], label = '帧'): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  let n = 0
  for (const f of frames) {
    if (typeof f !== 'string' || f.length === 0 || seen.has(f)) continue
    seen.add(f)
    const bytes = decodeBase64(f)
    if (!bytes || !isJpeg(bytes)) continue // 同步校验已报过，这里跳过
    const size = jpegSize(bytes)
    const idx = n++
    if (!size) {
      errors.push(`${label}${idx} 找不到 JPEG 尺寸段（SOF），文件可能损坏`)
    } else if (size.width > MAX_FRAME_W || size.height > MAX_FRAME_H) {
      errors.push(`${label}${idx} 尺寸 ${size.width}×${size.height} 超过 ${MAX_FRAME_W}×${MAX_FRAME_H} 上限`)
    } else {
      const aspect = size.width / size.height
      if (Math.abs(aspect - ASPECT_TARGET) > ASPECT_TARGET * ASPECT_TOLERANCE) {
        errors.push(`${label}${idx} 宽高比 ${aspect.toFixed(3)} 偏离 9:16 ±15%（应为竖屏 135×240 比例）`)
      }
    }
    if (errors.length >= 10) break
  }
  return errors
}
