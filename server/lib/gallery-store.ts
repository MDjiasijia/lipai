/**
 * 用户图库管理(~/.lipai/gallery/<name>/)。
 *
 * 每个图组是一个目录:
 *   ~/.lipai/gallery/<name>/
 *   ├── meta.json   # { name, frameCount, createdAt, sourcePrompt? }
 *   └── frame_0.jpg ... frame_9.jpg  # 135×240 JPG 帧
 *
 * 来源:
 * - 雪碧图裁切(saveSpriteGallery,功能1):AI 生成 5×2 大图 → 裁 10 帧
 * - 手动上传(saveUserGallery,功能4):用户选多图 → 逐帧存储
 *
 * 规则: fs.promises 异步,懒创建,绝不写扩展安装目录。
 */

import { mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { GALLERY_DIR } from './profile-store.js';

import type { DisplayProfile } from '../shared/profile-types.js';

/** 图组元数据。 */
export interface GalleryMeta {
  name: string;
  frameCount: number;
  createdAt: number;
  /** 雪碧图来源 prompt(功能1,可选)。 */
  sourcePrompt?: string;
  /** 是否为随包内置预设图组(只读,不可删/改)。 */
  builtin?: boolean;
}

/** 内置预设图组目录(随包分发,只读)。 */
const BUILTIN_PRESETS_DIR = path.join(process.cwd(), 'public', 'gallery-presets');

/** 图组分享文件的 type 标记(导入时据此拒掉配置文件 / 随便一个 json)。 */
export const GALLERY_FILE_TYPE = 'lipai-gallery';

/** 图组名去重:已存在则加 `-2`、`-3`…(导入别人的图组不覆盖自己的同名图组)。 */
export function dedupeGalleryName(name: string): string {
  if (!existsSync(galleryPath(name)) && !existsSync(builtinPath(name))) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name}-${i}`;
    if (!existsSync(galleryPath(candidate)) && !existsSync(builtinPath(candidate)))
      return candidate;
  }
  return `${name}-${Date.now()}`;
}

/** 图组目录路径(用户)。 */
function galleryPath(name: string): string {
  return path.join(GALLERY_DIR, name);
}

/** 内置预设图组目录路径(name 与 meta.json 的 name 一致)。 */
function builtinPath(name: string): string {
  return path.join(BUILTIN_PRESETS_DIR, name);
}

/** meta.json 路径(用户图组)。 */
function metaPath(name: string): string {
  return path.join(galleryPath(name), 'meta.json');
}

/** 帧文件路径(用户图组)。 */
function framePath(name: string, index: number): string {
  return path.join(galleryPath(name), `frame_${index}.jpg`);
}

/** 确保图组根目录存在。 */
async function ensureGalleryRoot(): Promise<void> {
  await mkdir(GALLERY_DIR, { recursive: true });
}

/** 解析某图组目录的 meta.json(不存在则返回兜底对象)。 */
async function readMetaOf(dir: string, name: string): Promise<GalleryMeta> {
  try {
    const raw = await readFile(path.join(dir, 'meta.json'), 'utf8');
    return JSON.parse(raw) as GalleryMeta;
  } catch {
    return { name, frameCount: 0, createdAt: 0 };
  }
}

/** 列出某根目录下的所有图组(每个子目录一个,跳过散装文件)。 */
async function listGalleriesIn(root: string, builtin: boolean): Promise<GalleryMeta[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const metas: GalleryMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // 散装文件(.DS_Store 等)
    const dir = path.join(root, e.name);
    const meta = await readMetaOf(dir, e.name);
    metas.push(builtin ? { ...meta, builtin: true } : meta);
  }
  return metas;
}

/** 从目录按 frameCount 读所有帧 → base64 数组。 */
async function readFramesFrom(dir: string, count: number): Promise<string[]> {
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- 串行读避免内存峰值
      const buf = await readFile(path.join(dir, `frame_${i}.jpg`));
      frames.push(buf.toString('base64'));
    } catch {
      break;
    }
  }
  return frames;
}

/** 列出所有图组(内置预设 + 用户),按名称排序。 */

/** 全部图组(用户 + 内置预设),给 GET /api/galleries。
 * 预设 preset:true 只读 —— 删除/改名路由对预设要拒绝。 */
export async function listAllGalleries(): Promise<
  (GalleryMeta & { preset?: boolean; builtin?: boolean })[]
> {
  // listUserGalleries 本身已含内置预设(listGalleriesIn builtin:true)——
  // 这里只做一层语义标注:preset ≡ builtin,去重后返回。
  const all = await listUserGalleries();
  const seen = new Set<string>();
  const out: (GalleryMeta & { preset?: boolean; builtin?: boolean })[] = [];
  for (const g of all) {
    if (seen.has(g.name)) continue;
    seen.add(g.name);
    out.push('builtin' in g ? { ...g, preset: true } : g);
  }
  return out;
}

/** 内置预设图组名? */
export function isPresetGallery(name: string): boolean {
  return existsSync(path.join(BUILTIN_PRESETS_DIR, name));
}

export async function listUserGalleries(): Promise<GalleryMeta[]> {
  const builtin = await listGalleriesIn(BUILTIN_PRESETS_DIR, true);
  const user = await listGalleriesIn(GALLERY_DIR, false);
  return [...builtin, ...user].sort((a, b) => a.name.localeCompare(b.name));
}

/** 读图组所有帧 → base64 数组(不含 data: 前缀)。用户图组优先,未命中则 fallback 内置预设。 */
export async function getUserGalleryFrames(name: string): Promise<string[]> {
  const dir = existsSync(galleryPath(name)) ? galleryPath(name) : builtinPath(name);
  if (!existsSync(dir)) throw new Error(`图组 ${name} 不存在`);
  // 先读 meta 拿 frameCount,兜底遍历目录
  const meta = await readMetaOf(dir, name);
  let count = meta.frameCount;
  if (count === 0) {
    const files = await readdir(dir);
    count = files.filter((f) => f.startsWith('frame_') && f.endsWith('.jpg')).length;
  }
  return readFramesFrom(dir, count);
}

/** 读图组单帧 → base64(轮播用,按索引取)。 */
export async function getUserGalleryFrame(name: string, index: number): Promise<string | null> {
  const dir = existsSync(galleryPath(name)) ? galleryPath(name) : builtinPath(name);
  try {
    const buf = await readFile(path.join(dir, `frame_${index}.jpg`));
    return buf.toString('base64');
  } catch {
    return null;
  }
}

/**
 * 从 base64 帧数组创建图组(手动上传,功能4)。
 * frames 为 base64 数组(不含 data: 前缀)。
 */
export async function saveUserGallery(
  name: string,
  frames: string[],
  sourcePrompt?: string,
): Promise<GalleryMeta> {
  if (!frames.length) throw new Error('至少需要一帧');
  await ensureGalleryRoot();
  const dir = galleryPath(name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < frames.length; i++) {
    // oxlint-disable-next-line no-await-in-loop -- 串行写避免内存峰值
    await writeFile(framePath(name, i), Buffer.from(frames[i]!, 'base64'));
  }
  const meta: GalleryMeta = {
    name,
    frameCount: frames.length,
    createdAt: Date.now(),
    ...(sourcePrompt ? { sourcePrompt } : {}),
  };
  await writeFile(metaPath(name), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * 从雪碧图大图创建图组(功能1)。
 * spriteBase64 为大图 base64(不含 data: 前缀),裁成 cols×rows 网格(默认 5×2=10 帧)。
 */
export async function saveSpriteGallery(
  name: string,
  spriteBase64: string,
  cols = 5,
  rows = 2,
  sourcePrompt?: string,
): Promise<GalleryMeta> {
  // 延迟导入裁切函数(避免循环依赖)
  const { cropSpriteToFrames } = await import('./sprite.js');
  const frames = await cropSpriteToFrames(spriteBase64, cols, rows);
  await ensureGalleryRoot();
  const dir = galleryPath(name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < frames.length; i++) {
    // oxlint-disable-next-line no-await-in-loop -- 串行写避免内存峰值
    await writeFile(framePath(name, i), frames[i]!);
  }
  const meta: GalleryMeta = {
    name,
    frameCount: frames.length,
    createdAt: Date.now(),
    sourcePrompt,
  };
  await writeFile(metaPath(name), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * 导出一个或多个图组为可分享的单文件 JSON 字符串(帧内嵌 base64)。
 *
 * 为什么内嵌帧而不是存路径:分享的对方机器上没有你的 ~/.lipai/,
 * 路径过去就是空图组。10 帧 135×240 JPEG 约 150KB,内嵌完全可接受。
 * 内置预设也允许导出 —— 对方可能装的是旧版扩展、没有这个预设。
 *
 * 一份文件装多个图组(`galleries` 数组):分享「我这套时钟图」通常不止一组,
 * 一组导一个文件、发十次不现实。单组导出也走这个数组(长度 1),读端只有一条路径。
 */
export async function exportUserGalleries(names: string[]): Promise<string> {
  const picked = names.map((n) => n.trim()).filter(Boolean);
  if (!picked.length) throw new Error('请至少选择一个图组');
  const galleries: { name: string; sourcePrompt?: string; frames: string[] }[] = [];
  const failed: string[] = [];
  for (const name of picked) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- 串行读,避免多组 base64 同时驻留
      const frames = await getUserGalleryFrames(name);
      if (!frames.length) {
        failed.push(name);
        continue;
      }
      const dir = existsSync(galleryPath(name)) ? galleryPath(name) : builtinPath(name);
      // oxlint-disable-next-line no-await-in-loop -- 同上
      const meta = await readMetaOf(dir, name);
      galleries.push({ name: meta.name || name, sourcePrompt: meta.sourcePrompt, frames });
    } catch {
      failed.push(name);
    }
  }
  if (!galleries.length) {
    throw new Error(`选中的图组都读不出帧:${failed.join('、')}`);
  }
  return JSON.stringify({ type: GALLERY_FILE_TYPE, version: 2, galleries }, null, 2);
}

/** 图组导入结果:落盘的图组 + 重名改过的名字。 */
export interface GalleryImportResult {
  imported: GalleryMeta[];
  /** 因本地已有同名而改名落盘的:`{ from, to }`。 */
  renamed: { from: string; to: string }[];
}

/**
 * 导入图组分享文件(单组 v1 / 多组 v2 都吃)。
 * 重名时自动加后缀,不覆盖本地已有的同名图组。
 */
export async function importUserGalleries(data: string): Promise<GalleryImportResult> {
  let parsed: {
    type?: string;
    /** v2:多组。 */
    galleries?: { name?: string; frames?: string[]; sourcePrompt?: string }[];
    /** v1:单组(旧版导出的文件,继续支持读)。 */
    gallery?: { name?: string; frames?: string[]; sourcePrompt?: string };
  };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (parsed.type !== GALLERY_FILE_TYPE) {
    throw new Error('这不是图组分享文件(应为「导出图组」生成的 .json)');
  }
  // v1 单组归一成数组,下面只有一条处理路径
  const list = parsed.galleries ?? (parsed.gallery ? [parsed.gallery] : []);
  const usable = list.filter((g) => g?.frames?.length);
  if (!usable.length) throw new Error('无效的图组文件:缺少帧数据');

  const imported: GalleryMeta[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const g of usable) {
    const wanted = (g.name || '导入图组').trim() || '导入图组';
    const finalName = dedupeGalleryName(wanted);
    if (finalName !== wanted) renamed.push({ from: wanted, to: finalName });
    // oxlint-disable-next-line no-await-in-loop -- 串行写,避免多组帧同时驻留
    const meta = await saveUserGallery(finalName, g.frames!);
    if (g.sourcePrompt) {
      meta.sourcePrompt = g.sourcePrompt;
      // oxlint-disable-next-line no-await-in-loop -- 同上
      await writeFile(metaPath(meta.name), JSON.stringify(meta, null, 2), 'utf8');
    }
    imported.push(meta);
  }
  return { imported, renamed };
}

/**
 * 按「导入重命名映射」重写一份配置里全部图组引用(纯函数)。
 *
 * 为什么导入端要做这件事:配置分享文件里的 `userGalleryName` 是**名字引用**,
 * 导入端对同名图组「保留本地那份、不覆盖」—— 但不重写引用的话,导入的配置
 * 指向的还是**本地那份同名图组**(内容是这台机器上已有的另一组图),
 * 「别的机器导入后展示不符预期」就是这么来的。改名落盘 + 引用跟着改,
 * 配置指向的才是**它自己带来的那份图组**,快照语义这才成立。
 *
 * 引用散在三处,与 collectGalleryDeps 对齐:槽位配方 / 轮播单选 / 轮播预推 4 槽。
 * 不在映射里的名字原样保留(图组没改名 / 引用了配置自带池之外的图组)。
 */
export function rewriteGalleryRefsInProfile(
  profile: DisplayProfile,
  renames: Map<string, string>,
): DisplayProfile {
  if (!renames.size) return profile;
  const map = (n: string | undefined | null): string | undefined => {
    const t = n?.trim();
    return t ? (renames.get(t) ?? t) : (n ?? undefined);
  };
  const slots = (profile.slots ?? []).map((spec) =>
    spec?.source === 'user-gallery' && spec.userGalleryName
      ? { ...spec, userGalleryName: map(spec.userGalleryName) }
      : spec,
  );
  const loop = profile.loop
    ? {
        ...profile.loop,
        loopUserGalleryName: map(profile.loop.loopUserGalleryName),
        loopPrePushGalleries: (profile.loop.loopPrePushGalleries ?? []).map((g) =>
          g ? (renames.get(g) ?? g) : g,
        ),
      }
    : profile.loop;
  return { ...profile, slots, loop };
}

/** 删除图组(内置预设只读,拒绝删除)。 */
export async function deleteUserGallery(name: string): Promise<void> {
  if (isPresetGallery(name) && !existsSync(galleryPath(name))) {
    throw new Error('内置预设只读,不能删除');
  }
  if (!existsSync(galleryPath(name)) && existsSync(builtinPath(name))) {
    throw new Error(`内置图组 ${name} 不可删除`);
  }
  await rm(galleryPath(name), { recursive: true, force: true });
}

/** 重命名图组(内置预设只读,拒绝重命名)。 */
export async function renameUserGallery(oldName: string, newName: string): Promise<void> {
  if (isPresetGallery(oldName) && !existsSync(galleryPath(oldName))) {
    throw new Error('内置预设只读,不能改名');
  }
  if (!existsSync(galleryPath(oldName)) && existsSync(builtinPath(oldName))) {
    throw new Error(`内置图组 ${oldName} 不可重命名`);
  }
  await rename(galleryPath(oldName), galleryPath(newName));
  // 更新 meta.name
  try {
    const meta = JSON.parse(await readFile(metaPath(newName), 'utf8')) as GalleryMeta;
    meta.name = newName;
    await writeFile(metaPath(newName), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    /* 无 meta,忽略 */
  }
}
