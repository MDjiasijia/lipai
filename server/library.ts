/**
 * 本地分享库:v2 分享文件格式的完整本地实现。
 *
 * 从上游分享站服务端移植,剥掉 MySQL/SQLite/身份/点赞评论多用户部分:
 * - 存储:~/.lipai/library/<id>.json(逐字节保真原文)+ index.json(侧表元数据)。
 * - 兼容:v2 JSON(type/version===2/JPEG 帧/位图校验)原样收发 —— 别人从分享站
 *   下载的文件拖进来即用;导出的文件也能传回分享站。
 * - 本地化:点赞 → 收藏星标(starred);评论删除;下载计数保留(自用无意义,显示用)。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BASE_DIR, importProfiles } from './lib/profile-store.js';
import { importUserGalleries } from './lib/gallery-store.js';

const LIB_DIR = path.join(BASE_DIR, 'library');
const INDEX_PATH = path.join(LIB_DIR, 'index.json');
const PAGE_SIZE = 12;

/** 侧表元数据(index.json 一行)。 */
export interface LibraryMeta {
  id: string;
  type: 'lipai-profile' | 'lipai-gallery';
  title: string;
  description: string;
  tags: string[];
  author: string;
  size: number;
  sha256: string;
  createdAt: number;
  downloads: number;
  starred: boolean;
}

async function ensureLib(): Promise<void> {
  await mkdir(LIB_DIR, { recursive: true });
}

async function readIndex(): Promise<LibraryMeta[]> {
  await ensureLib();
  try {
    return JSON.parse(await readFile(INDEX_PATH, 'utf8')) as LibraryMeta[];
  } catch {
    return [];
  }
}

let writeIndexQueue: Promise<void> = Promise.resolve();
function writeIndex(items: LibraryMeta[]): Promise<void> {
  writeIndexQueue = writeIndexQueue.then(async () => {
    await ensureLib();
    await writeFile(INDEX_PATH, JSON.stringify(items, null, 2), 'utf8');
  });
  return writeIndexQueue;
}

function filePath(id: string): string {
  // id 只含 [a-z0-9-](生成时保证);防目录穿越再验一道。
  if (!/^[a-z0-9-]{4,64}$/.test(id)) throw new Error('非法 id');
  return path.join(LIB_DIR, `${id}.json`);
}

function newId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------- 校验(与上传页同一套规则,服务端版) ---------------- */
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ITEMS = 20;
const MAX_FRAMES_PER_SLOT = 10;

/** 校验 v2 分享文件字节;失败抛错(消息可给用户看)。通过返回解析结果。 */
export function validateShareFile(bytes: Uint8Array): {
  type: 'lipai-profile' | 'lipai-gallery';
  title?: string;
  description?: string;
  tags?: string[];
  author?: string;
} {
  if (bytes.length > MAX_BODY) throw new Error('文件超过 8MB 上限');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('不是有效的 JSON');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'lipai-profile' && obj.type !== 'lipai-gallery') {
    throw new Error('type 必须是 lipai-profile 或 lipai-gallery');
  }
  if (obj.version !== 2) throw new Error('version 必须是 2');
  const galleries = (obj.galleries ?? []) as { frames?: unknown[] }[];
  if (!Array.isArray(galleries)) throw new Error('galleries 必须是数组');
  if (galleries.length > MAX_ITEMS) throw new Error(`图组最多 ${MAX_ITEMS} 个`);
  let totalBytes = 0;
  for (const g of galleries) {
    if (!Array.isArray(g.frames)) throw new Error('gallery.frames 必须是数组');
    if (g.frames.length > MAX_FRAMES_PER_SLOT) {
      throw new Error(`每个图组最多 ${MAX_FRAMES_PER_SLOT} 帧`);
    }
    totalBytes += validateFrames(g.frames, '图组帧');
  }
  const profiles = (obj.profiles ?? []) as {
    slots?: ({ frames?: unknown[] } | null)[];
  }[];
  if (!Array.isArray(profiles)) throw new Error('profiles 必须是数组');
  if (profiles.length > MAX_ITEMS) throw new Error(`配置最多 ${MAX_ITEMS} 份`);
  const previews = (obj.previews ?? []) as { slots?: ({ frames?: unknown[] } | null)[] }[];
  if (!Array.isArray(previews)) throw new Error('previews 必须是数组');
  if (previews.length > profiles.length) throw new Error('previews 不能比 profiles 多');
  for (const p of profiles) {
    if (!Array.isArray(p.slots)) continue;
    if (p.slots.length > 4) throw new Error('slots 最多 4 个');
    for (const slot of p.slots) {
      if (!slot || !Array.isArray(slot.frames)) continue;
      if (slot.frames.length > MAX_FRAMES_PER_SLOT) {
        throw new Error(`每个槽位最多 ${MAX_FRAMES_PER_SLOT} 帧`);
      }
      totalBytes += validateFrames(slot.frames, '槽位帧');
    }
  }
  for (const pv of previews) {
    if (!Array.isArray(pv.slots)) continue;
    for (const slot of pv.slots) {
      if (!slot || !Array.isArray(slot.frames)) continue;
      totalBytes += validateFrames(slot.frames, '预览帧', true);
    }
  }
  if (totalBytes > MAX_BODY) throw new Error('解码后帧总量超过 8MB');
  const meta = (obj.shareMeta ?? {}) as Record<string, unknown>;
  return {
    type: obj.type,
    title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : undefined,
    description: typeof meta.description === 'string' ? meta.description.slice(0, 200) : undefined,
    tags: Array.isArray(meta.tags)
      ? meta.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : undefined,
    author: typeof meta.author === 'string' ? meta.author.slice(0, 200) : undefined,
  };
}

/** 帧数组校验:base64 可解码 + JPEG magic + 位图宽高比/尺寸炸弹防护。 */
function validateFrames(frames: unknown[], label: string, preview = false): number {
  let total = 0;
  for (const raw of frames) {
    if (typeof raw !== 'string') throw new Error(`${label}:必须是 base64 字符串`);
    let buf: Uint8Array;
    try {
      buf = Uint8Array.from(Buffer.from(raw, 'base64'));
    } catch {
      throw new Error(`${label}:base64 解码失败`);
    }
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
      throw new Error(`${label}:必须是 JPEG(FF D8 magic)`);
    }
    if (!preview) checkBitmap(buf, label);
    total += buf.length;
  }
  return total;
}

/** 位图校验:解析 SOF 段取宽高 —— 9:16±15%、≤300×600,防「一张巨图当帧」。 */
function checkBitmap(buf: Uint8Array, label: string): void {
  let i = 2;
  let width = 0;
  let height = 0;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    const size = (buf[i + 2]! << 8) | buf[i + 3]!;
    // SOF0-SOF15(不含 DHT/DAC):C0-CF 排除 C4/C8/CC
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (buf[i + 5]! << 8) | buf[i + 6]!;
      width = (buf[i + 7]! << 8) | buf[i + 8]!;
      break;
    }
    i += 2 + size;
  }
  if (!width || !height) throw new Error(`${label}:无法解析 JPEG 尺寸`);
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) / (9 / 16) > 0.15) {
    throw new Error(`${label}:宽高比需接近 9:16(±15%),实际 ${width}×${height}`);
  }
  if (width > 300 || height > 600) {
    throw new Error(`${label}:尺寸超限(≤300×600),实际 ${width}×${height}`);
  }
}

/* ---------------- CRUD ---------------- */
export async function listLibrary(params: {
  q?: string;
  type?: string;
  tag?: string;
  sort?: string;
  cursor?: string;
}): Promise<{ items: LibraryMeta[]; nextCursor?: string }> {
  const all = await readIndex();
  let items = [...all].sort((a, b) => b.createdAt - a.createdAt);
  if (params.type === 'lipai-profile' || params.type === 'lipai-gallery') {
    items = items.filter((x) => x.type === params.type);
  }
  if (params.tag) {
    items = items.filter((x) => x.tags.includes(params.tag!));
  }
  if (params.q) {
    const q = params.q.toLowerCase();
    items = items.filter(
      (x) =>
        x.title.toLowerCase().includes(q) ||
        x.description.toLowerCase().includes(q) ||
        x.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  if (params.sort === 'starred') {
    items = items.filter((x) => x.starred).sort((a, b) => b.createdAt - a.createdAt);
  }
  // 游标 = createdAt(毫秒时间戳字符串)。
  const cursorNum = params.cursor ? Number(params.cursor) : 0;
  if (params.sort !== 'starred' && cursorNum > 0) {
    const idx = items.findIndex((x) => x.createdAt <= cursorNum);
    if (idx >= 0) items = items.slice(idx);
  }
  const page = items.slice(0, PAGE_SIZE);
  const next =
    items.length > PAGE_SIZE ? String(page.at(-1)?.createdAt ?? '') : undefined;
  return { items: page, ...(next ? { nextCursor: next } : {}) };
}

export async function addToLibrary(
  bytes: Uint8Array,
  meta: { title?: string; description?: string; tags?: string[]; author?: string },
  opts: { skipValidate?: boolean } = {},
): Promise<string> {
  if (!opts.skipValidate) validateShareFile(bytes);
  // 重新解析只为了取 type/shareMeta 兜底(校验已通过)。
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    type: 'lipai-profile' | 'lipai-gallery';
    shareMeta?: { title?: string };
  };
  const id = newId();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const item: LibraryMeta = {
    id,
    type: parsed.type,
    title: (meta.title || parsed.shareMeta?.title || '未命名分享').slice(0, 200),
    description: (meta.description ?? '').slice(0, 200),
    tags: (meta.tags ?? []).slice(0, 8).map((t) => t.slice(0, 30)),
    author: (meta.author ?? '').slice(0, 200),
    size: bytes.length,
    sha256,
    createdAt: Date.now(),
    downloads: 0,
    starred: false,
  };
  await ensureLib();
  await writeFile(filePath(id), bytes);
  const items = await readIndex();
  items.unshift(item);
  await writeIndex(items);
  return id;
}

export async function getLibraryFile(id: string): Promise<{
  bytes: Uint8Array;
  sha256: string;
} | null> {
  if (!existsSync(filePath(id))) return null;
  const bytes = new Uint8Array(await readFile(filePath(id)));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function getLibraryMeta(id: string): Promise<LibraryMeta | null> {
  const items = await readIndex();
  return items.find((x) => x.id === id) ?? null;
}

export async function bumpDownload(id: string): Promise<{
  bytes: Uint8Array;
  sha256: string;
} | null> {
  const file = await getLibraryFile(id);
  if (!file) return null;
  const items = await readIndex();
  const item = items.find((x) => x.id === id);
  if (item) {
    item.downloads += 1;
    await writeIndex(items);
  }
  return file;
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const items = await readIndex();
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) throw new Error('条目不存在');
  await writeIndex(next);
  await rm(filePath(id), { force: true });
}

export async function toggleStar(id: string): Promise<boolean> {
  const items = await readIndex();
  const item = items.find((x) => x.id === id);
  if (!item) throw new Error('条目不存在');
  item.starred = !item.starred;
  await writeIndex(items);
  return item.starred;
}

/* ---------------- 导入(库条目 → 本地配置/图组) ---------------- */
export async function importLibraryItem(
  id: string,
): Promise<{ profiles: string[]; galleries: string[] }> {
  const file = await getLibraryFile(id);
  if (!file) throw new Error('条目不存在');
  const text = new TextDecoder().decode(file.bytes);
  // profiles 与 galleries 各导各的:gallery 条目可能只有图组,profile 条目两样都有。
  // importUserGalleries 只导图组;importProfiles 连带它依赖的图组(共享池去重)。
  const galleryResult = await importUserGalleries(text).catch(() => null);
  const profileResult = await importProfiles(text).catch(() => null);
  const galleries = new Set<string>();
  for (const g of galleryResult?.imported ?? []) galleries.add(g.name);
  for (const g of profileResult?.galleries ?? []) galleries.add(g);
  const profiles = (profileResult?.profiles ?? []).map((p) => p.name);
  return { profiles, galleries: [...galleries] };
}

export { addToLibrary as addShareToLibrary, validateShareFile as validateLibraryShareFile };
