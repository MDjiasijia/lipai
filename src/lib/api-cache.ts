/**
 * 接口响应的离线缓存（IndexedDB settings store，key = `api-cache:<签名>`）。
 *
 * 策略（stale-while-revalidate 的手工版）：
 * - 每次网络成功 → 覆盖写缓存（带时间戳）；
 * - 网络失败（离线/服务器不可达）→ 回落缓存，不抛错 —— 旧数据总比白屏好；
 * - TTL 可选：易变数据（点赞态/评论）短 TTL、稳定数据（列表/详情/天气）长 TTL 或不限；
 *   超过 TTL 的缓存不回落（返回陈旧数据比报错更糟的场景由调用方用 TTL 表达）。
 *
 * 与 PWA precache 的分工：SW 管应用壳与静态资源（precache 名单不含 /api），
 * 这里管接口响应 —— 各管一层，互不干扰。
 */
import { kvGet, kvPut } from './ips/db'

const KEY_PREFIX = 'api-cache:'

interface CacheEnvelope<T> {
  /** 缓存写入时间（epoch ms）—— UI 标注「离线内容」用 */
  cachedAt: number
  data: T
}

/** 缓存读（无条目/超 TTL 回 null）。 */
export async function readApiCache<T>(key: string, ttlMs = Number.POSITIVE_INFINITY): Promise<{ cachedAt: number; data: T } | null> {
  const env = await kvGet<CacheEnvelope<T>>('settings', `${KEY_PREFIX}${key}`)
  if (!env) return null
  if (Date.now() - env.cachedAt > ttlMs) return null
  return { cachedAt: env.cachedAt, data: env.data }
}

/** 缓存写（网络成功后调用；失败静默 —— 缓存写挂了不影响主流程）。 */
export async function writeApiCache<T>(key: string, data: T): Promise<void> {
  try {
    await kvPut('settings', `${KEY_PREFIX}${key}`, { cachedAt: Date.now(), data } satisfies CacheEnvelope<T>)
  } catch {
    /* IndexedDB 满/隐私模式：缓存是增益不是依赖 */
  }
}

/** 通用「网络优先 + 缓存回落」包装（api.ts 各 GET 端点共用）。 */
export async function withOfflineCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<{ data: T; fromCache: boolean }> {
  try {
    const data = await fetcher()
    void writeApiCache(key, data)
    return { data, fromCache: false }
  } catch (err) {
    const cached = await readApiCache<T>(key, ttlMs)
    if (cached) return { data: cached.data, fromCache: true }
    throw err
  }
}
