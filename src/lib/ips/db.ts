/**
 * IndexedDB 连接与 key-value 原语（领域 store 的共享地基）。
 *
 * 三个 object store（目录结构沿用上游设计）：
 *   - profiles:  id → DisplayProfile
 *   - galleries: name → GalleryMeta
 *   - settings / galleryFrames: key → value
 *
 * 领域拆分约定（对齐 telegram-tt reducers/selectors 按领域分文件）：
 * profile-store.ts 管 profiles + config，gallery-store.ts 管 galleries，
 * datafeed-store.ts 管 datafeed 定义 —— 都经由这里的一个连接。
 */

/** IndexedDB 库名 / 版本 */
export const DB_NAME = 'lipai-web'
export const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

/** 打开（单例；升级时建 store）。 */
export function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('galleries')) db.createObjectStore('galleries', { keyPath: 'name' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings')
      if (!db.objectStoreNames.contains('galleryFrames')) db.createObjectStore('galleryFrames')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('IndexedDB 打开失败'))
    }
  })
  return dbPromise
}

/** 单条 get（settings / galleryFrames 这类 key-value store）。 */
export async function kvGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

/** 单条 put（key-value store）。 */
export async function kvPut<T>(store: string, key: string, value: T): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/**
 * 实体写入（in-line key store）：key 由 value.keyPath 字段（如 galleries.name）携带，
 * 不传 key 参数 —— in-line key store 上 put(value, key) 会抛
 * DataError（「in-line keys and the key parameter was provided」）。
 */
export async function putEntity<T>(store: string, value: T): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
