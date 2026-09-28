/**
 * 内置图库索引（Web 版）。
 *
 * napi 版用 readdirSync 枚举运行时目录；
 * Vite 构建没有文件系统 —— 用 import.meta.glob 静态收集 src/assets/gallery 下的
 * 图片资源（构建期解析成 URL），枚举/取字节按这份索引走。
 *
 * 目录结构与原版一致：gallery/{anime,animals}/*.jpg + 根目录散装图。
 */

/** 构建期收集：路径 → 资源 URL（懒加载 import） */
const galleryFiles = import.meta.glob('../../../assets/gallery/**/*.{jpg,jpeg,png,webp}', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>

/** 解析相对路径 → { theme, name }；theme = 子目录名，根目录散装图为 null */
function parseEntry(key: string): { theme: string | null; name: string; url: string } | null {
  // key 形如 '../../../assets/gallery/anime/xxx.jpg'
  const m = key.match(/assets\/gallery\/(?:([^/]+)\/)?([^/]+)$/)
  if (!m) return null
  return { theme: m[1] ?? null, name: m[2], url: key }
}

/** 索引表：theme → name → URL 加载器 */
const index = new Map<string | null, Map<string, () => Promise<string>>>()
for (const [key, load] of Object.entries(galleryFiles)) {
  const entry = parseEntry(key)
  if (!entry) continue
  let bucket = index.get(entry.theme)
  if (!bucket) {
    bucket = new Map()
    index.set(entry.theme, bucket)
  }
  bucket.set(entry.name, load)
}

/** 列出主题名（排序稳定；null 根目录散装图不算主题） */
export function listGalleryThemes(): string[] {
  return [...index.keys()].filter((t): t is string => t !== null).sort()
}

/** 列出某主题（或根目录散装图）的图片文件名，排序稳定 */
export function listGalleryImages(theme?: string): string[] {
  const bucket = index.get(theme ?? null)
  return bucket ? [...bucket.keys()].sort() : []
}

/** 取图库图片原始字节（fetch 资源 URL；裁剪需要字节走 loadImage） */
export async function galleryImageBytes(name: string, theme?: string): Promise<Uint8Array> {
  const load = index.get(theme ?? null)?.get(name)
  if (!load) throw new Error(`图库没有图片 ${theme ? `${theme}/` : ''}${name}`)
  const url = await load()
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`图库图片读取失败：HTTP ${resp.status}`)
  return new Uint8Array(await resp.arrayBuffer())
}
