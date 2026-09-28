/**
 * 显示配置（profile）领域 store —— API 客户端薄层。
 *
 * share-web 版存 IndexedDB（profiles store + settings 里的 config 侧表）；
 * 本地版 ~/.lipai/（服务端 profiles/ + config.json）是唯一真源，这里只是
 * GET/POST/PUT/DELETE /api/profiles 的封装 —— 函数名与返回形状对齐 share-web 版
 * （消费方 Control.tsx / ImportButton 不感知存储差异）。
 *
 * 保留的本地纯函数：defaultProfile（POST /api/profiles 由服务端建，前端只在
 * 展示「默认配置长什么样」时用）、migrateProfile/migrateSlotSources（读旧盘
 * 兼容 —— 服务端读时也会迁，前端留一份给导入链路校验用）。
 */
import type { DisplayProfile, ProfileListItem, ProfileStoreConfig } from './profile-types'
import { migrateProfile, migrateSlotSources, collectGalleryDeps, defaultLoopConfig } from './profile-types'
import * as api from '../api-server'

/** 默认 profile id（不可删；服务端同款约定） */
export const DEFAULT_ID = 'default'

/** config 侧表（服务端 config.json 的形状；前端只读展示用） */
export type ProfileStoreConfigApi = ProfileStoreConfig

/** 读 config（服务端没有单独端点 —— currentProfileId 在 GET /api/profiles 响应里） */
export async function readConfig(): Promise<ProfileStoreConfig> {
  const { currentProfileId, profiles } = await api.listProfilesApi()
  return {
    version: 1,
    currentProfileId,
    profileIds: profiles.map((p) => p.id),
  }
}

export async function writeConfig(cfg: ProfileStoreConfig): Promise<void> {
  // config 由服务端管（写 profile/切当前配置的端点内部维护）；前端不再直写。
  // 保留签名（兼容旧调用点）；参数只用来回显要切到的配置。
  throw new Error(`本地版 config 由服务端维护（切当前配置走 POST /api/profiles/current：${cfg.currentProfileId}）`)
}

/** 默认 profile 形状（展示用；实际创建走 POST /api/profiles，服务端补全字段） */
export function defaultProfile(): DisplayProfile {
  const now = Date.now()
  return {
    id: DEFAULT_ID,
    name: '默认',
    createdAt: now,
    updatedAt: now,
    isDefault: true,
    slots: [null, null, null, { source: 'weather', city: '上海' }],
    activeSlot: 3,
    editingSlot: 3,
    slotNames: ['', '', '', ''],
    loop: defaultLoopConfig(),
    autoMode: 'loop',
    deviceControl: {
      brightness: 75,
      clockStyle: 3,
      lightMode: 0,
      lightColor: '#53c8f9',
      timeFormat: '24',
      networkTime: true,
      weatherEnabled: false,
      weatherCity: '上海',
      tempUnit: 'c',
    },
  } as DisplayProfile
}

/** 列出所有 profile（轻量；default 存在与否由服务端保证 —— 首次运行自动建） */
export async function listProfiles(): Promise<ProfileListItem[]> {
  const { profiles } = await api.listProfilesApi()
  // default 永远第一；其余按 updatedAt 降序（最新在前）
  return [...profiles].sort((a, b) => {
    if (a.isDefault) return -1
    if (b.isDefault) return 1
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

/** 读单个 profile（migrate 后返回；不存在 null）—— 旧 usage/credit 单项来源也在这一步归并 */
export async function readProfile(id: string): Promise<DisplayProfile | null> {
  try {
    const raw = await api.getProfileApi(id)
    return migrateProfile(migrateSlotSources(raw))
  } catch (err) {
    // 404 = 配置不存在（语义与 share-web 版一致：null 而不是抛错）
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}

/** 当前 profile（服务端 config.currentProfileId；读不到回落 default） */
export async function getCurrentProfile(): Promise<DisplayProfile | null> {
  const { currentProfileId } = await api.listProfilesApi()
  const p = await readProfile(currentProfileId)
  return p ?? (await readProfile(DEFAULT_ID))
}

/** 写 profile（服务端补 updatedAt；PUT /api/profiles/:id 全量保存） */
export async function writeProfile(profile: DisplayProfile): Promise<void> {
  await api.putProfileApi({ ...profile, updatedAt: Date.now() })
}

/** 新建空配置（服务端建，重名由服务端加后缀）；返回新 id */
export async function createProfile(name = '新配置'): Promise<string> {
  const p = await api.createProfileApi(name)
  return p.id
}

/** 复制一份配置（名字加「副本」重名加后缀；id 换新，isDefault 剥掉 —— 服务端同款语义） */
export async function duplicateProfile(id: string, name?: string): Promise<string> {
  const src = await readProfile(id)
  if (!src) throw new Error('源配置不存在')
  const copy = await api.duplicateProfileApi(id, name ?? `${src.name} 副本`)
  return copy.id
}

/** 删除 profile（default 不可删，服务端 400）；当前配置被删时服务端自动回落 default */
export async function deleteProfile(id: string): Promise<void> {
  await api.deleteProfileApi(id)
}

/** 切换当前 profile */
export async function setCurrentProfile(id: string): Promise<void> {
  await api.setCurrentProfileApi(id)
}

// ─── 导入 / 导出（服务端 /api/export + /api/profiles/import） ────

/** 分享站导出格式直通（类型来自分享站 src/types.ts 语义） */
export interface ExportPayload {
  type: 'lipai-profile' | 'lipai-gallery'
  version: 2
  profiles?: DisplayProfile[]
  galleries: { name: string; sourcePrompt?: string; frames: string[] }[]
  shareMeta?: { title: string; description: string; tags: string[]; author?: string }
}

/**
 * 导出 profiles + 依赖图组 —— 走服务端 POST /api/export
 * （自动带 gallery deps + previews 快照；响应即 v2 分享 JSON）。
 */
export async function exportProfiles(profileIds: string[]): Promise<ExportPayload> {
  return (await api.exportProfilesApi(profileIds)) as ExportPayload
}

/** 导入分享文件（服务端落盘：id 冲突换新、图组重名加后缀、引用改写） */
export interface ImportResult {
  profileIds: string[]
  galleryNames: string[]
}

export async function importPayload(payload: ExportPayload): Promise<ImportResult> {
  const result = await api.importProfilesApi(JSON.stringify(payload))
  return {
    profileIds: result.profiles.map((p) => p.id),
    galleryNames: result.galleries,
  }
}

/** 依赖图组收集（导出提示用；实际打包由服务端做）。迁移函数一并转发（导入链路校验用）。 */
export { migrateProfile, migrateSlotSources, collectGalleryDeps, defaultLoopConfig }
