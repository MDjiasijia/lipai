/**
 * 自定义接口数据源（datafeed）：取数 + 缓存 + 模板渲染。
 *
 * 本质与天气同构：打一次接口拿 JSON → 按卡片模板各自取值 → 渲成 135×240 帧列表。
 * 渲染走 canvas-kit 的声明式 stack()（与天气卡同一套布局原语），配色由模板 theme 定。
 *
 * 取值语法（存盘字符串，见 profile-types.dataFeedValueAt）：{path} 点分路径，
 * 数字段 = 数组下标；路径不存在渲染成空串，不脏屏。
 */
import type {
  DataFeedDef,
  DataFeedCardTemplate,
  DataFeedBlock,
} from '../profile-types'
import { DATAFEED_DEFAULT_TTL_MS, dataFeedInterpolate } from '../profile-types'
import type { RenderedCard, Palette } from './canvas-kit'
import { frame, backdrop, stack, alpha } from './canvas-kit'

/* ── 取数 + 缓存 ─────────────────────────────────────────────────────────── */

interface FetchEntry {
  data: unknown
  at: number
}

/** 取数缓存（defId → 结果 + 时间戳）。缩略图/多槽引用同一数据源时只打一次接口。 */
const feedCache = new Map<string, FetchEntry>()

/** 取数错误缓存：失败也在 TTL 内不再重试（轮播每 30 秒一步，不缓存会把死接口打穿）。 */
const errCache = new Map<string, { err: string; at: number }>()

function ttlOf(def: DataFeedDef): number {
  return typeof def.cacheTtlMs === 'number' && def.cacheTtlMs >= 0 ? def.cacheTtlMs : DATAFEED_DEFAULT_TTL_MS
}

export interface FeedData {
  /** 接口 JSON（或原始文本）。 */
  data: unknown
  /** 取数时间戳（epoch ms）。 */
  fetchedAt: number
}

/** 缓存是否仍新鲜（外部预览只读缓存不 fetch 时用）。 */
export function feedCacheFresh(def: DataFeedDef, now = Date.now()): boolean {
  const e = feedCache.get(def.id)
  return e !== undefined && now - e.at < ttlOf(def)
}

/**
 * 拉数据（带缓存）。ttl=0 直通不缓存。
 * 失败抛错（调用方 pipeline 有占位帧兜底）；错误也在 TTL 内记忆，避免轮播打穿死接口。
 */
export async function fetchDataFeed(def: DataFeedDef): Promise<FeedData> {
  const ttl = ttlOf(def)
  const now = Date.now()
  const hit = feedCache.get(def.id)
  if (ttl > 0 && hit && now - hit.at < ttl) return { data: hit.data, fetchedAt: hit.at }
  const errHit = errCache.get(def.id)
  if (ttl > 0 && errHit && now - errHit.at < ttl) {
    throw new Error(errHit.err)
  }
  try {
    const data = await fetchFeedRaw(def)
    feedCache.set(def.id, { data, at: now })
    errCache.delete(def.id)
    return { data, fetchedAt: now }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errCache.set(def.id, { err: msg, at: now })
    throw new Error(msg)
  }
}

/** 只读缓存不发请求（配置列表缩略图同天气的省流语义）；无缓存回 null。 */
export function peekFeedCache(def: DataFeedDef): FeedData | null {
  const e = feedCache.get(def.id)
  return e ? { data: e.data, fetchedAt: e.at } : null
}

/** 清掉某数据源的缓存（编辑器「测试」后强制下次重取）。 */
export function invalidateFeedCache(defId: string): void {
  feedCache.delete(defId)
  errCache.delete(defId)
}

async function fetchFeedRaw(def: DataFeedDef): Promise<unknown> {
  const method = def.method ?? 'GET'
  const headers: Record<string, string> = { ...(def.headers ?? {}) }
  let body: string | undefined
  if (method === 'POST') {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    body = def.body ?? undefined
  }
  let resp: Response
  try {
    resp = await fetch(def.url, { method, headers, body })
  } catch (e) {
    // fetch 网络层失败（CORS 拒绝 / 断网 / DNS）——报错里给最可能的提示
    throw new Error(`请求失败（CORS 或网络）：${e instanceof Error ? e.message : String(e)}`)
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim())
  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch {
    // 非 JSON：原样给字符串（模板当文本渲染，不炸）
    return text
  }
}

/* ── 渲染 ────────────────────────────────────────────────────────────────── */

/** 模板缺省配色（深蓝夜色，对齐 render.ts 画布缺省）。 */
function paletteOf(t: DataFeedCardTemplate): Palette {
  const th = t.theme ?? {}
  return {
    bgA: th.bgA ?? '#0d1b2a',
    bgB: th.bgB ?? '#16273d',
    fg: th.fg ?? '#e8f2ff',
    sub: th.sub ?? '#8fb3d9',
    accent: th.accent ?? '#37c3ff',
  }
}

/** 块 → stack Block（文本插值 + emoji 缺省字号 + 每块颜色/对齐覆盖）。 */
function toStackBlocks(blocks: DataFeedBlock[], data: unknown) {
  return blocks.map((b) => {
    switch (b.kind) {
      case 'label':
        return { kind: 'label' as const, text: dataFeedInterpolate(b.text, data), color: b.color, align: b.align }
      case 'hero':
        return { kind: 'hero' as const, text: dataFeedInterpolate(b.text, data), max: b.max, color: b.color, align: b.align }
      case 'body':
        return { kind: 'body' as const, text: dataFeedInterpolate(b.text, data), max: b.max, color: b.color, align: b.align }
      case 'caption':
        return { kind: 'caption' as const, text: dataFeedInterpolate(b.text, data), color: b.color, align: b.align }
      case 'emoji':
        return {
          kind: 'emoji' as const,
          text: dataFeedInterpolate(b.text, data) || '·',
          size: b.size ?? 56,
          align: b.align,
          font: 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif',
        }
      case 'gap':
        return { kind: 'gap' as const, h: b.h }
    }
  })
}

/**
 * 按定义渲染一套卡片（每张模板一帧，带稳定 ID）。
 * 空模板列表回空数组（pipeline 兜底占位）。
 */
export async function renderDataFeedCards(def: DataFeedDef, data: unknown): Promise<RenderedCard[]> {
  const cards: RenderedCard[] = []
  for (const t of def.cards) {
    const p = paletteOf(t)
    const image = await frame((ctx) => {
      backdrop(ctx, p)
      // 顶沿 accent 微光（对齐天气卡的光源语言）
      const glow = ctx.createLinearGradient(0, 0, 0, 90)
      glow.addColorStop(0, alpha(p.accent, 0.16))
      glow.addColorStop(1, alpha(p.accent, 0))
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, 135, 90)
      stack(
        ctx,
        toStackBlocks(t.blocks, data),
        p,
        { gap: 8 },
      )
    })
    cards.push({ id: t.id, image })
  }
  return cards
}
