/**
 * 分享文件的 OPFS 缓存（Origin Private File System）。
 *
 * 与 api-cache（IndexedDB，存接口响应 JSON）的分工：这里存**分享文件原始字节**
 * —— 下载 / 导入动作把文件副本按记录 id 落进 OPFS；离线时读回并解析出详情
 * （previews 全量在手，切组不再受列表瘦身协议限制）。
 *
 * 为什么不进 api-cache：单文件最大 8MB、内容是 MB 级 base64 —— 过 structured
 * clone 序列化内存峰值高、隐私模式下 IndexedDB 配额收紧；OPFS 是裸字节写 +
 * 文件系统级配额（约为可用空间的 60%），Safari 16.4+ / Chromium 全支持。
 *
 * 不可用（无 API / 写失败 / 配额满）一律静默降级：缓存是增益不是依赖，
 * 调用方在 miss 时走既有的网络错误路径。
 */

/** OPFS 目录名（origin 内独立命名空间，不与其他功能混用） */
const DIR_NAME = 'share-files'
/** 缓存预算：单文件最大 8MB，文件数与总字节任一超限即淘汰最旧的，避免占满 OPFS 配额 */
const MAX_FILES = 200
const MAX_BYTES = 200 * 1024 * 1024

let dirPromise: Promise<FileSystemDirectoryHandle | null> | null = null

/** OPFS 可用性（模块级缓存一次判定；jsdom/老浏览器无 navigator.storage） */
function supported(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
  } catch {
    return false
  }
}

/** 打开（并按需创建）缓存目录；失败回 null 并清缓存 —— 下次调用重试
 *  （存储可能在页面生命周期中出现/消失：jsdom 桩、隐私模式切换） */
function openDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!dirPromise) {
    dirPromise = (async () => {
      try {
        const root = await navigator.storage.getDirectory()
        return await root.getDirectoryHandle(DIR_NAME, { create: true })
      } catch {
        dirPromise = null
        return null
      }
    })()
  }
  return dirPromise
}

/** 写入一份分享文件字节（key = 分享记录 id）。失败静默。 */
export async function writeShareFile(id: string, bytes: Uint8Array): Promise<void> {
  if (!supported()) return
  try {
    const dir = await openDir()
    if (!dir) return
    const handle = await dir.getFileHandle(id, { create: true })
    const writable = await handle.createWritable()
    // Blob 入写（FileSystemWriteChunkType 不收共享缓冲的 Uint8Array 视图）
    await writable.write(new Blob([bytes as BlobPart]))
    await writable.close()
    // 写入成功后再做预算淘汰（新文件的 mtime 最新，不会被淘汰；失败不影响写入）
    void evict(dir)
  } catch {
    /* 配额满 / 隐私模式：缓存是增益不是依赖 */
  }
}

/**
 * OPFS 目录枚举能力（lib.dom 的 FileSystemDirectoryHandle 类型尚未收录
 * entries()/keys()/values() 异步迭代器，但 Chromium/Safari 16.4+ 均已实现）。
 * 用本地接口描述并做运行时能力检测，不支持的环境直接跳过淘汰。
 */
interface OpfsDirectory extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

/**
 * 缓存预算淘汰：文件数或总字节超限时，按最后修改时间升序（最旧在前）删除，
 * 直到两项都回到预算内。运行环境不支持目录枚举（jsdom 桩 / 老实现）时直接跳过。
 * 失败一律静默 —— 缓存是增益，不能影响下载主链路。
 */
async function evict(dir: FileSystemDirectoryHandle): Promise<void> {
  const enumerable = dir as unknown as Partial<OpfsDirectory>
  if (typeof enumerable.entries !== 'function') return
  try {
    const files: { name: string; size: number; lastModified: number }[] = []
    for await (const [name, handle] of enumerable.entries()) {
      if (handle.kind !== 'file') continue
      const file = await (handle as FileSystemFileHandle).getFile()
      files.push({ name, size: file.size, lastModified: file.lastModified })
    }
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    if (files.length <= MAX_FILES && totalBytes <= MAX_BYTES) return
    files.sort((a, b) => a.lastModified - b.lastModified)
    let count = files.length
    let bytes = totalBytes
    for (const f of files) {
      if (count <= MAX_FILES && bytes <= MAX_BYTES) break
      await dir.removeEntry(f.name)
      count -= 1
      bytes -= f.size
    }
  } catch {
    /* 目录枚举/删除失败：缓存是增益不是依赖 */
  }
}

/** 读取分享文件字节；未缓存或读取失败回 null。 */
export async function readShareFile(id: string): Promise<Uint8Array | null> {
  if (!supported()) return null
  try {
    const dir = await openDir()
    if (!dir) return null
    const handle = await dir.getFileHandle(id)
    const file = await handle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  } catch {
    return null
  }
}
