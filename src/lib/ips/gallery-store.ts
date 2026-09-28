/**
 * 用户图组领域 store —— API 客户端薄层。
 *
 * 旧版存 IndexedDB（galleries meta + galleryFrames 两个 object store）；
 * 本地版 ~/.lipai/gallery/（+ 内置预设 public/gallery-presets/）由服务端管，
 * 这里只是 /api/galleries 的封装 —— 函数名与返回形状对齐旧版
 * （Control.tsx「我的图组」下拉 / pipeline 渲染取帧不感知存储差异）。
 */
import type { DisplayProfile, SlotSpec } from './profile-types'
import { collectGalleryDeps } from './profile-types'
import * as api from '../api-server'

/** 用户图组元数据（与旧版 GalleryMeta 同形状；服务端另有 preset/builtin 标记） */
export interface GalleryMeta {
  name: string
  createdAt: number
  updatedAt?: number
  /** 帧数 */
  frameCount: number
  /** 来源：saveUserGallery（裁好的帧）/ saveSpriteGallery（雪碧图裁切） */
  origin?: 'user' | 'sprite'
  /** 内置预设（只读：不可删/改名）；服务端 preset ≡ builtin */
  preset?: boolean
  builtin?: boolean
}

/** 图组名去重后缀（服务端同款：重名追加 -2/-3…；导入链路前端预检用） */
export function dedupeGalleryName(name: string, existing: string[]): string {
  const names = new Set(existing)
  if (!names.has(name)) return name
  let i = 2
  while (names.has(`${name}-${i}`)) i++
  return `${name}-${i}`
}

/** 列出用户图组（轻量元数据；含内置预设 —— 服务端 listAllGalleries 同语义） */
export async function listUserGalleries(): Promise<GalleryMeta[]> {
  const { galleries } = await api.listGalleriesApi()
  return galleries.map((g) => ({
    name: g.name,
    createdAt: g.createdAt,
    updatedAt: g.createdAt,
    frameCount: g.frameCount,
    ...(g.preset ? { preset: true, builtin: true } : {}),
  }))
}

/** 取图组全部帧（base64 无前缀）；不存在回空数组（渲染链路：空槽位占位帧兜底） */
export async function getUserGalleryFrames(name: string): Promise<string[]> {
  try {
    const { frames } = await api.getGalleryFramesApi(name)
    return frames
  } catch {
    return []
  }
}

/** 保存图组（覆盖写；名字由调用方先 dedupe —— 服务端重名时加后缀落盘） */
export async function saveUserGallery(name: string, frames: string[], sourcePrompt?: string): Promise<GalleryMeta> {
  const meta = await api.saveGalleryApi(name, frames, sourcePrompt)
  return { name: meta.name, createdAt: meta.createdAt, updatedAt: meta.createdAt, frameCount: meta.frameCount }
}

/** 删除图组（内置预设服务端拒绝） */
export async function deleteUserGallery(name: string): Promise<void> {
  await api.deleteGalleryApi(name)
}

/** 重命名图组（服务端搬目录 + 改 meta） */
export async function renameUserGallery(oldName: string, newName: string): Promise<void> {
  await api.renameGalleryApi(oldName, newName)
}

/** 迁移时改写 profile 里 user-gallery 引用（重命名 / 导入合并；服务端导入链路同款语义）。
 *  覆盖三处：槽位 userGalleryName、loop.loopUserGalleryName、loop.loopPrePushGalleries ——
 *  漏任何一处，改名/导入后对应引用就悬空（槽位无内容 / 轮播推不出图）。 */
export function rewriteGalleryRefs(
  profile: DisplayProfile,
  map: (name: string) => string,
): DisplayProfile {
  const rewriteSlot = (slot: SlotSpec | null): SlotSpec | null => {
    if (!slot || slot.source !== 'user-gallery' || !slot.userGalleryName) return slot
    return { ...slot, userGalleryName: map(slot.userGalleryName) }
  }
  const loop = profile.loop
    ? {
        ...profile.loop,
        loopUserGalleryName: profile.loop.loopUserGalleryName
          ? map(profile.loop.loopUserGalleryName)
          : undefined,
        loopPrePushGalleries: profile.loop.loopPrePushGalleries?.map(map),
      }
    : undefined
  return { ...profile, slots: (profile.slots ?? []).map(rewriteSlot), ...(loop ? { loop } : {}) }
}

/** profile 引用到的图组名列表（collectGalleryDeps 直通；导出提示用） */
export function galleryDeps(profile: DisplayProfile): string[] {
  return collectGalleryDeps(profile)
}
