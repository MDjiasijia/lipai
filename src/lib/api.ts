/**
 * 本地服务 API 客户端 + hash 路由工具。
 *
 * 与上游 Web 版的差别：分享站社交全部退役（登录/whoami/点赞/评论/中继），
 * 数据源收敛为本地服务（契约 docs/API.md）：
 *  - 素材库 /api/library：v2 分享文件格式完整兼容 —— 别人从分享站下载的文件
 *    拖进来即收；导出的文件也能原样发回去 / 再导入；
 *  - 「点赞」→「收藏星标」（starred，幂等切换）；「人气」排序 →「收藏」筛选；
 *  - 导入不再走浏览器 IndexedDB（原 importPayload），统一
 *    POST /api/library/:id/import 由服务端落盘 ~/.lipai/（id 冲突换新、
 *    图组重名加 -2、引用改写）。
 *
 * 离线缓存沿用两层：api-cache（IndexedDB，接口响应）+ OPFS（文件字节副本，
 * 下载/详情拉过的文件离线可整份读回；目录沿用 share-files）。key 前缀 library:。
 */
import { useEffect, useState } from 'react'
import type { ShareFile, ShareRecord } from '../types'
import { withOfflineCache } from './api-cache'
import { writeShareFile, readShareFile } from './opfs-cache'
import { parseShareRecord } from './share-parse'

/**
 * hash 路由（query 与 path 分离）。
 * path 段只含路径（`#/control` → parts=['control']），query 单独返回 ——
 * 此前 `#/?type=all` 的 parts[0] 是字面量 `'?type=all'`，底栏 active 判断、
 * Control `?tab=` 深链、Home 重筛选全部被它绊倒，一处拆开三处修好。
 */
export function useHashRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const raw = hash.replace(/^#/, '') || '/'
  const [pathOnly, queryString = ''] = raw.split('?')
  return {
    path: pathOnly || '/',
    parts: pathOnly.split('/').filter(Boolean),
    query: new URLSearchParams(queryString),
  }
}

export function navigate(to: string): void {
  window.location.hash = to
}

/**
 * Tab 状态写进 URL query（`#/control?tab=auto`）。
 * 返回 [当前值, 设定函数]；设定时保留其余 query 参数。可用值外的输入回落 undefined。
 */
export function useTabParam(key: string, valid: readonly string[]): [string | undefined, (next: string) => void] {
  const { path, query } = useHashRoute()
  const current = valid.find((v) => v === query.get(key))
  const set = (next: string): void => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
    if (valid.includes(next)) q.set(key, next)
    else q.delete(key)
    const qs = q.toString()
    navigate(`${path}${qs ? `?${qs}` : ''}`)
  }
  return [current, set]
}

/* ── 素材库类型 ─────────────────────────────────────────── */

/** 帧组（展台切换的最小单位）：槽位号 + 帧 + 可选语义名（图组名 / 槽位配方名） */
export interface LibraryPreviewGroup {
  slot: number
  frames: string[]
  label?: string
}

/** 列表条目（GET /api/library）。
 *  previews 是列表瘦身协议：只带第 0 组帧（其余组 frames:[] 占位），
 *  服务端未带时整段缺失 —— 两种情况都由前端按需拉详情补全。 */
export interface LibraryItem {
  id: string
  type: 'lipai-profile' | 'lipai-gallery'
  title: string
  description: string
  tags: string[]
  /** 署名（录入时的自由文本；本地库无登录概念） */
  author: string
  /** 文件字节数 */
  size: number
  /** 上传文件原文 sha256（hex） */
  sha256: string
  /** 收录时间（epoch 毫秒） */
  createdAt: number
  /** 下载次数（自用无意义，展示用） */
  downloads: number
  /** 收藏星标 */
  starred: boolean
  /** 列表瘦身：第 0 组帧；缺失 = 服务端未带 → 拉详情补全 */
  previews?: LibraryPreviewGroup[]
}

/** 详情（GET /api/library/:id 返回原始文件字节，客户端解析出 previews/thumb/summary）。
 *  列表接口的侧表字段（title 等）可能被上传者改过 —— 展示以列表为准，这里以文件本体为准。 */
export interface LibraryItemDetail {
  id: string
  type: 'lipai-profile' | 'lipai-gallery'
  title: string
  description: string
  tags: string[]
  author: string
  size: number
  sha256: string
  createdAt: number
  downloads: number
  starred: boolean
  /** 全量帧组（文件本体解析；文件无预览时为空数组） */
  previews: LibraryPreviewGroup[]
  hasPreviews: boolean
  /** 首帧缩略图（base64 JPEG，无 data: 前缀）；无帧时 null */
  thumb: string | null
  /** 槽位配方 / 循环设置 / 随包图组摘要（纯展示数据，源自文件解析） */
  summary: ShareRecord['summary']
}

/** 列表接口返回 */
export interface LibraryListResp {
  items: LibraryItem[]
  nextCursor?: string
}

/* ── 请求基础件 ─────────────────────────────────────────── */

/** 错误响应（`{ error, details? }`）→ 可读消息；body 不是 JSON 时回落状态码 */
async function errorText(resp: Response, fallback: string): Promise<string> {
  const data = (await resp.json().catch(() => ({}))) as { error?: string; details?: string[] }
  return [data.error ?? fallback, ...(data.details ?? [])].join('\n')
}

async function handle<T>(resp: Response, fallback: string): Promise<T> {
  if (!resp.ok) throw new Error(await errorText(resp, fallback))
  return (await resp.json()) as T
}

/**
 * 通用 fetch 封装（JSON 优先、非 JSON 原样给字符串）。
 * 天气/城市等已收敛到服务端渲染，前端不再直连；这个裸封装留给
 * datafeed（用户自定义接口）等直连外部源的场景复用。
 */
export async function fetchApi<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim())
  const text = await resp.text()
  try {
    return JSON.parse(text) as T
  } catch {
    // 非 JSON：原样给字符串（模板当文本渲染，不炸）
    return text as unknown as T
  }
}

/* ── 素材库端点 ─────────────────────────────────────────── */

/** GET /api/library —— 分页列表（离线缓存回落；fromCache = 本次来自缓存，调用方标注「离线内容」） */
export async function listLibrary(params: {
  cursor?: string
  type?: string
  tag?: string
  q?: string
  sort?: 'new' | 'starred'
}): Promise<LibraryListResp & { fromCache?: boolean }> {
  const sp = new URLSearchParams()
  if (params.cursor) sp.set('cursor', params.cursor)
  if (params.type) sp.set('type', params.type)
  if (params.tag) sp.set('tag', params.tag)
  if (params.q) sp.set('q', params.q)
  if (params.sort) sp.set('sort', params.sort)
  const { data, fromCache } = await withOfflineCache<LibraryListResp>(`library:list?${sp.toString()}`, Number.POSITIVE_INFINITY, async () => {
    const resp = await fetch(`/api/library?${sp.toString()}`)
    return handle<LibraryListResp>(resp, `请求失败（${resp.status}）`)
  })
  return { ...data, fromCache }
}

/** 文件字节 → 详情（previews/thumb/summary 解析自文件本体；解析失败抛错） */
function detailFromBytes(id: string, bytes: Uint8Array, sha256 = ''): LibraryItemDetail {
  const parsed = parseShareRecord(new TextDecoder().decode(bytes))
  if (!parsed) throw new Error('库文件解析失败（不是合法的 v2 分享文件）')
  return {
    id,
    type: parsed.type,
    title: parsed.meta.title,
    description: parsed.meta.description,
    tags: parsed.meta.tags,
    author: parsed.meta.author ?? '',
    size: bytes.length,
    sha256,
    createdAt: 0,
    downloads: 0,
    starred: false,
    previews: parsed.previews,
    hasPreviews: parsed.hasPreviews,
    thumb: parsed.thumb,
    summary: parsed.summary,
  }
}

/** GET /api/library/:id —— 详情（离线两级回落：api-cache 缓存的响应 → OPFS 文件副本解析；
 *  后者解决离线切组 —— 列表瘦身只带第 0 组帧，其余组靠详情补全，
 *  而详情若从未拉过，下载/导入落在 OPFS 里的文件副本就是唯一出路）。
 *  响应是原始文件字节（不计数），成功即写 OPFS 副本。 */
export async function getLibraryItem(id: string): Promise<LibraryItemDetail> {
  try {
    const { data } = await withOfflineCache<LibraryItemDetail>(`library:item:${id}`, Number.POSITIVE_INFINITY, async () => {
      const resp = await fetch(`/api/library/${encodeURIComponent(id)}`)
      if (!resp.ok) throw new Error(await errorText(resp, `请求失败（${resp.status}）`))
      const blob = await resp.blob()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      void writeShareFile(id, bytes)
      return detailFromBytes(id, bytes, resp.headers.get('x-content-sha256') ?? '')
    })
    return data
  } catch (err) {
    const fromOpfs = await libraryItemFromOpfs(id)
    if (fromOpfs) return fromOpfs
    throw err
  }
}

/** OPFS 文件副本 → 详情（网络与 api-cache 都 miss 时的最后回落）。
 *  侧表运行时字段（starred/downloads）不在文件里：回落值留空，解析失败回 null。 */
async function libraryItemFromOpfs(id: string): Promise<LibraryItemDetail | null> {
  const bytes = await readShareFile(id)
  if (!bytes) return null
  try {
    return detailFromBytes(id, bytes)
  } catch {
    return null
  }
}

/** POST /api/library —— 收进本地库（multipart；可选 onProgress —— XHR upload.onprogress，
 *  8MB JSON 慢链路不再像卡死） */
export function uploadToLibrary(
  file: File,
  meta: { title: string; description: string; tags: string; author: string },
  onProgress?: (sent: number, total: number) => void,
): Promise<{ id: string }> {
  const fd = new FormData()
  fd.set('file', file)
  fd.set('title', meta.title)
  fd.set('description', meta.description)
  fd.set('tags', meta.tags)
  fd.set('author', meta.author)
  if (!onProgress) {
    return fetch('/api/library', { method: 'POST', body: fd }).then((resp) => handle<{ id: string }>(resp, `上传失败（${resp.status}）`))
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/library')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { id?: string; error?: string; details?: string[] }
        if (xhr.status >= 200 && xhr.status < 300 && data.id) resolve({ id: data.id })
        else reject(new Error([data.error ?? `上传失败（${xhr.status}）`, ...(data.details ?? [])].join('\n')))
      } catch {
        reject(new Error(`上传失败（${xhr.status}）`))
      }
    }
    xhr.onerror = () => reject(new Error('上传失败（网络错误）'))
    xhr.send(fd)
  })
}

/** 下载（返回原始字节，前端触发保存） */
export async function downloadLibraryItem(id: string, title: string): Promise<void> {
  const blob = await downloadLibraryItemBytes(id)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[\\/:*?"<>|\s]+/g, '_')}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 拿库文件原始字节（不落盘、不触发保存；系统分享链路用，走 download 接口计数）。
 *  成功即写 OPFS 副本 —— 下载/分享过的文件离线可整份读回（getLibraryItem 最后回落）。 */
export async function downloadLibraryItemBytes(id: string): Promise<Blob> {
  const resp = await fetch(`/api/library/${encodeURIComponent(id)}/download`, { method: 'POST' })
  if (!resp.ok) {
    throw new Error(await errorText(resp, `下载失败（${resp.status}）`))
  }
  const blob = await resp.blob()
  void writeShareFile(id, new Uint8Array(await blob.arrayBuffer()))
  return blob
}

/** DELETE /api/library/:id —— 从本地库移除（本地库无归属判断，全部可删） */
export async function deleteLibraryItem(id: string): Promise<void> {
  const resp = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!resp.ok) {
    throw new Error(await errorText(resp, `删除失败（${resp.status}）`))
  }
}

/** POST /api/library/:id/star —— 收藏 / 取消收藏（幂等切换；调用方做乐观更新+失败回滚） */
export async function toggleStar(id: string): Promise<{ starred: boolean }> {
  const resp = await fetch(`/api/library/${encodeURIComponent(id)}/star`, { method: 'POST' })
  return handle<{ starred: boolean }>(resp, `操作失败（${resp.status}）`)
}

/** POST /api/library/:id/import —— 导入到本地配置/图组（服务端落盘 ~/.lipai/：
 *  id 冲突换新、图组重名加 -2、引用改写），返回落盘的名字清单。 */
export async function importToLibrary(id: string): Promise<{ profiles: string[]; galleries: string[] }> {
  const resp = await fetch(`/api/library/${encodeURIComponent(id)}/import`, { method: 'POST' })
  return handle<{ profiles: string[]; galleries: string[] }>(resp, `导入失败（${resp.status}）`)
}

/** POST /api/export —— 本地配置/图组 → v2 分享 JSON（带图组依赖 + previews 快照），
 *  可直接再导入本地库，或发给别人 / 传回分享站。 */
export async function exportPayload(profileIds?: string[]): Promise<ShareFile> {
  const resp = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profileIds?.length ? { profileIds } : {}),
  })
  if (!resp.ok) {
    throw new Error(await errorText(resp, `导出失败（${resp.status}）`))
  }
  return (await resp.json()) as ShareFile
}
