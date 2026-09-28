/**
 * 立牌分享文件类型定义（只读消费 + 透传存储，网站绝不改写文件内容）
 *
 * 两种分享文件，均为 UTF-8 JSON：
 * 1. 配置分享文件：{ type: 'lipai-profile', version: 2, profiles: DisplayProfile[],
 *                    galleries: [{ name, frames }], previews?: ProfilePreviews[] }
 * 2. 图组分享文件：{ type: 'lipai-gallery', version: 2,
 *                    galleries: [{ name, sourcePrompt?, frames }] }
 *
 * 【容错说明】扩展端新增字段（顶层 shareMeta、顶层 previews）可能缺失
 * （旧文件 / 导出时关了「含预览」），所有消费方必须容错缺省；
 * 缺 previews 只影响详情页预览展示，不阻塞上传下载。
 */

/* ── 领域类型收口（2026-09 UI 重设计）──
   此前 SlotSource/SlotSpec/DisplayProfile 在这里与 lib/ips/profile-types.ts 双份定义且不一致
   （这里 loopSteps 是 number[]，那里是 LoopStep[] —— 与真实导出文件冲突；这里的 SlotSpec 是
   扁平 galleryName/frameTexts 形状，真实线上数据走嵌套 canvas/userGalleryName 形状）。
   收口规则：profile-types.ts 是唯一真相源（纯 TS、含迁移函数、server 可安全引用），
   这里只做转发；本文件保留线上形状（ShareFile/ShareRecord/CommentItem）。
   SOURCE_LABELS 也已入驻 profile-types.ts（此前 5 份、互不一致）。 */

export type {
  SlotSource,
  SlotSpec,
  DisplayProfile,
  LoopConfig,
  FrameColor,
  DeviceControlConfig,
  ProfilePreviews,
  DataFeedDef,
  DataFeedCardTemplate,
  DataFeedBlock,
} from './lib/ips/profile-types'
export {
  SOURCE_LABELS,
  SLOT_STYLE_NAMES,
  GALLERY_THEME_LABELS,
  slotCapacity,
  slotSpecLabel,
  dataFeedValueAt,
  dataFeedInterpolate,
  DATAFEED_DEFAULT_TTL_MS,
} from './lib/ips/profile-types'
// 本文件内部引用（ShareFile.profiles 等）走同名转发，与外部消费方同一份真相
import type { DisplayProfile, ProfilePreviews } from './lib/ips/profile-types'

/** 快照类来源：天气/用量等导出后不再更新，详情页需标注「非实时」 */
export const SNAPSHOT_SOURCES = ['weather', 'canvas', 'animation', 'files', 'usage-credit']

/** 随包图组 */
export interface Gallery {
  name: string
  /** 仅图组分享文件有：生成时的提示词 */
  sourcePrompt?: string
  /** 135×240 JPEG 的 base64（无 data: 前缀），每帧约 15KB；通常 10 帧 */
  frames: string[]
}

/**
 * 预览快照（扩展 0.14.3+ 导出时嵌在顶层，按 profileId 关联 profiles[i].id）。
 * frames 已按槽位容量切好：槽位 3 → 6 帧，槽位 0/1/2 → 10 帧；角标已画进帧里。
 * 可缺失：旧文件 / 导出时关了「含预览」/ 全渲不出 —— 缺失时显示占位，不阻塞上传下载。
 * 结构与 profile-types.ts 的 ProfilePreviews 等价，转发共用（见顶部收口注释）。
 */

/** 顶层分享文件（两种 type 的并集） */
export interface ShareFile {
  type: 'lipai-profile' | 'lipai-gallery'
  version: number
  profiles?: DisplayProfile[]
  galleries: Gallery[]
  /** 【0.14.3+ 顶层字段，可缺失】预览快照，按 profileId 关联 profiles[i].id */
  previews?: ProfilePreviews[]
  /** 【计划中的新增字段，容错缺省】 */
  shareMeta?: {
    title: string
    description: string
    tags: string[]
    author?: string
  }
}

/**
 * 评论条目（server / 前端共用的唯一定义）。
 * 此前在 server/repo.ts 与 src/lib/api.ts 各定义一份，字段易漂移 ——
 * 收敛到这里，其余位置一律 import。
 */
export interface CommentItem {
  /** 评论 id（时间戳+随机） */
  id: string
  /** 正文 */
  body: string
  /** 展示昵称（登录用户=IAM 昵称，匿名=自填或「路人」） */
  name: string
  /** 头像 URL（登录用户有，匿名无） */
  avatar: string | null
  /** 是否登录身份（前端用于头像渐变色，不显示徽标） */
  identified: boolean
  /** 删除归属键（user.id/email 或 ip:xxx）；服务端内部字段，旧数据可能缺，不下发前端 */
  actor?: string
  /** 回复对象（引用一条历史评论） */
  replyTo?: { id: string; name: string; body: string }
  /** 图片评论（base64 JPEG/PNG，≤120KB 原始） */
  image?: string
  /** 毫秒时间戳 */
  at: number
  /** 服务端判定「请求者可删除」时为 true（列表下发时补，不暴露 actor 原文） */
  canDelete?: boolean
}

/** 侧表展示元数据（与文件本体分离存储，不写回文件） */
export interface ShareMetaRecord {
  title: string
  description: string
  tags: string[]
  author?: string
  /** 署名人头像 URL（上传时取 IAM 身份头；管理 PATCH 可补） */
  authorAvatar?: string
}

/** 服务端存的分享记录（文件本体与元数据同表，逐字节保真） */
export interface ShareRecord {
  id: string
  /** 上传文件原文的 sha256（hex），下载时校验逐字节一致 */
  sha256: string
  /** 上传文件字节数 */
  size: number
  type: 'lipai-profile' | 'lipai-gallery'
  version: number
  meta: ShareMetaRecord
  /** 上传时间（epoch 毫秒） */
  createdAt: number
  /** 上传者平台用户 id（登录识别；匿名/旧数据为 null） */
  uploader: string | null
  /** 上传者平台昵称（展示用；匿名/旧数据为 null） */
  uploaderName: string | null
  /** 下载次数 */
  downloads: number
  /** 评论数（列表接口聚合返回，可选） */
  commentCount?: number
  /** 点赞数（列表接口聚合返回，可选；详情接口不带） */
  likeCount?: number
  /** 当前请求身份是否已赞（列表接口随行返回，可选） */
  liked?: boolean
  /** 是否已下架 */
  removed: boolean
  /** 首帧缩略图（base64 JPEG，无 data: 前缀）；无帧时为 null */
  thumb: string | null
  /** 详情页用：previews 汇总（来自各 profile.previews）+ 无 previews 标记。
   *  label 是服务端解析时算好的分组语义名（图组名 / 槽位配方名），旧记录可缺失 →
   *  前端回落「槽位 N / 图组 N」。 */
  previews: { slot: number; frames: string[]; label?: string }[]
  hasPreviews: boolean
  /** 详情页摘要：槽位配方 / 循环设置 / 随包图组（纯展示数据，源自文件解析） */
  summary: {
    profiles: {
      name: string
      activeSlot: number
      slotNames: string[]
      slots: { source: string; label: string }[]
      loopSteps: number[]
      loopInterval: number
    }[]
    galleries: { name: string; sourcePrompt?: string; frameCount: number }[]
    hasWeatherOrUsage: boolean
  }
}
