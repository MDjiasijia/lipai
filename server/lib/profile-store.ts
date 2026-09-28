/**
 * 显示配置(DisplayProfile)持久化存储。
 *
 * 存储位置: 全局偏好 ~/.lipai/
 *   ├── config.json          # { version, currentProfileId, profileIds }
 *   ├── profiles/<id>.json   # 每个 profile 一个文件
 *   └── gallery/<name>/      # 用户图组(由 gallery-store.ts 管理)
 *
 * 规则:
 * - 全部 node:fs/promises 异步 IO,禁止 sync(会卡 EH 事件循环)
 * - 懒写: 有数据才写,按需 mkdir;onActivate 不读
 * - 绝不写扩展安装目录(只读);~/.lipai/ 是全局偏好,不跟随项目
 * - writeConfig 用模块级 Promise 链串行化(仿 device.ts writeQueue),避免并发竞态
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectGalleryDeps,
  defaultLoopConfig,
  migrateProfile,
  migrateSlotSources,
  type DisplayProfile,
  type ProfilePreviews,
  type ProfilePreviewSlots,
  type ProfileListItem,
  type ProfileStoreConfig,
  type SceneSchedule,
  type SlotSpec,
} from '../shared/profile-types.js';

/**
 * ~/.lipai/ 根目录。LIPAI_BASE_DIR 环境变量可整体改指(测试注入临时目录用):
 * 不设时跟 os.homedir() —— Windows 的 homedir() 走 USERPROFILE 不走 HOME,
 * 测试光设 HOME 在 win 上会把配置写进真实用户目录。
 */
export const BASE_DIR = process.env.LIPAI_BASE_DIR
  ? path.resolve(process.env.LIPAI_BASE_DIR, '.lipai')
  : path.join(os.homedir(), '.lipai');
const PROFILES_DIR = path.join(BASE_DIR, 'profiles');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');

/** 默认 profile id(不可删)。 */
const DEFAULT_ID = 'default';

/** 默认 config(config.json 不存在时返回)。 */
function defaultConfig(): ProfileStoreConfig {
  return { version: 1, currentProfileId: DEFAULT_ID, profileIds: [DEFAULT_ID] };
}

/**
 * 默认 profile(首次创建,default.json 不存在时用)。
 * 只给「电子立牌」槽位配一份天气卡片 —— 开箱推一次就有内容,其余槽位留空由用户填。
 */
function defaultProfile(): DisplayProfile {
  const now = Date.now();
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
    pictureDial: { transferMode: 'ble' },
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
  };
}

/** 确保 profiles 目录存在(懒创建,写时才调)。 */
async function ensureProfilesDir(): Promise<void> {
  await mkdir(PROFILES_DIR, { recursive: true });
}

// ─── config.json 读写(串行化) ─────────────────────────────────────────

/** writeConfig 串行化队列(避免并发写竞态)。 */
let writeConfigQueue: Promise<void> = Promise.resolve();

/** 读 config.json,不存在返回默认 config(不报错)。 */
export async function readConfig(): Promise<ProfileStoreConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw) as ProfileStoreConfig;
    // 兜底:确保有 version/currentProfileId/profileIds
    if (!cfg.profileIds?.length) cfg.profileIds = [DEFAULT_ID];
    if (!cfg.currentProfileId) cfg.currentProfileId = DEFAULT_ID;
    return cfg;
  } catch {
    return defaultConfig();
  }
}

/** 写 config.json(串行化,避免并发竞态)。 */
export function writeConfig(cfg: ProfileStoreConfig): Promise<void> {
  writeConfigQueue = writeConfigQueue.then(async () => {
    await mkdir(BASE_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  });
  return writeConfigQueue;
}

// ─── profile CRUD ──────────────────────────────────────────────────────

/** profile 文件路径。 */
function profilePath(id: string): string {
  return path.join(PROFILES_DIR, `${id}.json`);
}

/**
 * 列出所有 profile(轻量,不含完整内容)。
 * 同时确保 default profile 存在(首次运行 default.json 不存在时自动创建)。
 */
export async function listProfiles(): Promise<ProfileListItem[]> {
  await ensureProfilesDir();
  const cfg = await readConfig();
  const items: ProfileListItem[] = [];
  for (const id of cfg.profileIds) {
    try {
      const raw = await readFile(profilePath(id), 'utf8');
      const p = JSON.parse(raw) as DisplayProfile;
      items.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, isDefault: p.isDefault });
    } catch {
      // 文件不存在:default 自动创建,其它跳过
      if (id === DEFAULT_ID) {
        const def = defaultProfile();
        await writeProfile(def);
        items.push({ id: def.id, name: def.name, updatedAt: def.updatedAt, isDefault: true });
      }
    }
  }
  return items;
}

/**
 * 读单个 profile,顺手迁移成 slots 模型(旧文件不落盘改写,下次保存时自然写成新格式)。
 * 不存在时 default 自动创建并返回,其它返回 null。
 */
export async function readProfile(id: string): Promise<DisplayProfile | null> {
  await ensureProfilesDir();
  try {
    const raw = await readFile(profilePath(id), 'utf8');
    // migrateProfile:旧版单槽编辑器快照 → slots 模型;
    // migrateSlotSources:合并混合流后,旧 source='usage'/'credit' → 'usage-credit'。
    // 都不落盘改写,下次保存时自然写成新格式。
    return migrateSlotSources(migrateProfile(JSON.parse(raw) as DisplayProfile));
  } catch {
    if (id === DEFAULT_ID) {
      const def = defaultProfile();
      await writeProfile(def);
      return def;
    }
    return null;
  }
}


/** 数据目录描述(健康检查/启动日志用)。 */
export const DATA_DIR_DESC = BASE_DIR;

/** 当前 profile id(config.json 的 currentProfileId;不读文件内容)。 */
export async function readCurrentProfileId(): Promise<string> {
  const cfg = await readConfig();
  return cfg.currentProfileId ?? DEFAULT_ID;
}

/** 新建空白配置(只给电子立牌槽位配默认天气)。返回已落盘的完整 profile。 */
export async function createProfile(name: string): Promise<DisplayProfile> {
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const profile = defaultProfile();
  profile.id = id;
  profile.name = name.trim() || '新配置';
  profile.isDefault = false;
  profile.createdAt = Date.now();
  profile.updatedAt = Date.now();
  const cfg = await readConfig();
  cfg.profileIds.push(id);
  await writeConfig(cfg);
  await writeProfile(profile);
  return profile;
}

/** 复制配置(深拷贝 + 新 id;name 缺省「原名 副本」)。 */
export async function duplicateProfile(
  id: string,
  name?: string,
): Promise<DisplayProfile | null> {
  const source = await readProfile(id);
  if (!source) return null;
  const copy = structuredClone(source);
  copy.id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  copy.name = (name ?? `${source.name} 副本`).trim() || '副本';
  copy.isDefault = false;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  const cfg = await readConfig();
  cfg.profileIds.push(copy.id);
  await writeConfig(cfg);
  await writeProfile(copy);
  return copy;
}

/** 读当前 profile(config.json 的 currentProfileId)。 */
export async function getCurrentProfile(): Promise<DisplayProfile | null> {
  const cfg = await readConfig();
  return readProfile(cfg.currentProfileId);
}

/** 写 profile(新建或更新)。同时更新 config.profileIds。 */
export async function writeProfile(profile: DisplayProfile): Promise<void> {
  await ensureProfilesDir();
  profile.updatedAt = Date.now();
  await writeFile(profilePath(profile.id), JSON.stringify(profile, null, 2), 'utf8');
  // 更新 config.profileIds(新增 id 追加)
  const cfg = await readConfig();
  if (!cfg.profileIds.includes(profile.id)) {
    cfg.profileIds.push(profile.id);
    await writeConfig(cfg);
  }
}

/** 删除 profile。default 不可删。 */
export async function deleteProfile(id: string): Promise<void> {
  if (id === DEFAULT_ID) throw new Error('默认配置不可删除');
  await rm(profilePath(id), { force: true });
  const cfg = await readConfig();
  cfg.profileIds = cfg.profileIds.filter((p) => p !== id);
  if (cfg.currentProfileId === id) cfg.currentProfileId = DEFAULT_ID;
  await writeConfig(cfg);
}

/** 设置当前 profile id。 */
export async function setCurrentProfile(id: string): Promise<void> {
  const cfg = await readConfig();
  cfg.currentProfileId = id;
  await writeConfig(cfg);
}

/** 读自动重连设置 + 上次连的设备名(后端用,webview 重载后仍记得)。 */
export async function readConnectSettings(): Promise<{
  autoConnect: boolean;
  lastDeviceName: string | null;
}> {
  const cfg = await readConfig();
  return { autoConnect: cfg.autoConnect !== false, lastDeviceName: cfg.lastDeviceName ?? null };
}

/** 写自动重连开关。 */
export async function setAutoConnect(enabled: boolean): Promise<void> {
  const cfg = await readConfig();
  cfg.autoConnect = enabled;
  await writeConfig(cfg);
}

/** 记住上次成功连的设备名(自动重连带它连)。 */
export async function setLastDeviceName(name: string | null): Promise<void> {
  const cfg = await readConfig();
  cfg.lastDeviceName = name;
  await writeConfig(cfg);
}

/**
 * 读场景日程存档(启动/重连时自动拉起用)。
 * 没存过(旧版 webview localStorage 时代)= null,不自动启动,等 webview 显式启动。
 */
export async function readSceneSchedule(): Promise<SceneSchedule | null> {
  const cfg = await readConfig();
  return cfg.sceneSchedule ?? null;
}

/** 存/清场景日程存档(null = 用户手停,不再自动拉起)。 */
export async function setSceneSchedule(schedule: SceneSchedule | null): Promise<void> {
  const cfg = await readConfig();
  cfg.sceneSchedule = schedule;
  await writeConfig(cfg);
}

/**
 * 导出一份或多份配置为 JSON 字符串(含完整内容,可下载分享)。
 *
 * 连它们引用的用户图组一起打包(`galleries`):只发 profile 的话,对方导入后
 * 槽位指向的图组在他机器上不存在,那个槽位就是空的 —— 换设备迁移同理。
 * 图组帧内嵌 base64,一份配置带 1-2 个图组约 150-300KB。
 *
 * 多份配置**共享一份图组池**并去重:两份配置都用「月相时钟」时只装一次,
 * 否则选 5 份配置就把同一组图打包 5 遍。
 *
 * withPreview:顶层附 `previews[]` —— 走推送同一条管线给每个已配槽位现渲染一整套帧,
 * 分享网站拿帧直接轮播,不用复刻渲染管线。预览是导出那一刻的快照(天气/用量是当时的数),
 * 放顶层不嵌进配置:导入端(importProfiles 整体落盘)天然不读顶层未知字段,
 * 零代码防住「陈旧快照跟配置落盘」;渲染失败/取不到内容该槽位不出现在 previews 里,
 * 不阻断导出(网站显示「无预览」占位即可)。
 *
 * renderSlot 回调由 index.ts 注入(profile-store 保持纯 fs 模块,可单测):
 * 同 renderSlotSpec(spec, slot) 签名,便于实现侧走投屏同源渲染器。
 */
export async function exportProfiles(
  ids: string[],
  opts?: {
    withPreview?: boolean;
    /** 槽位配方 → 渲染帧(base64)注入 seam。 */
    renderSlot?: (spec: SlotSpec, slot: number) => Promise<string[]>;
  },
): Promise<ExportProfilesResult> {
  const picked = ids.map((i) => i.trim()).filter(Boolean);
  if (!picked.length) throw new Error('请至少选择一份配置');
  const profiles: DisplayProfile[] = [];
  for (const id of picked) {
    // oxlint-disable-next-line no-await-in-loop -- 串行读,量小且避免并发抖动
    const profile = await readProfile(id);
    if (profile) profiles.push(profile);
  }
  if (!profiles.length) throw new Error(`选中的配置都不存在:${picked.join('、')}`);

  const { getUserGalleryFrames } = await import('./gallery-store.js');
  const wanted = [...new Set(profiles.flatMap((p) => collectGalleryDeps(p)))];
  const galleries: { name: string; frames: string[] }[] = [];
  for (const name of wanted) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- 串行读,避免多组 base64 同时驻留
      const frames = await getUserGalleryFrames(name);
      if (frames.length) galleries.push({ name, frames });
    } catch {
      // 图组已被删除:跳过,不阻断导出(对方导入时会提示这个槽位缺图组)
    }
  }

  let previews: ProfilePreviews[] | undefined;
  if (opts?.withPreview && opts.renderSlot) {
    previews = [];
    for (const profile of profiles) {
      // oxlint-disable-next-line no-await-in-loop -- 串行渲染,避免多槽位帧同时驻留
      const slots = await renderProfilePreviews(profile, opts.renderSlot);
      if (slots.length) previews.push({ profileId: profile.id, slots });
    }
    // 全都渲不出来时不带字段(网站按「无预览」处理),不留空数组占位
    if (!previews.length) previews = undefined;
  }
  return {
    json: JSON.stringify(
      {
        type: 'lipai-profile',
        version: 2,
        profiles,
        galleries,
        // 顶层 shareMeta:分享站上传页直接带出标题/标签(0.14.3+ 网站类型已预留,导出端一直没写)。
        // 导入端整体落盘不读顶层未知字段,不影响本扩展导入。
        // 描述留给上传者填(这里编不出比配置名更有信息量的句子,预填空串网站当占位)。
        shareMeta: {
          title:
            profiles.length === 1
              ? (profiles[0]?.name ?? '立牌配置')
              : `立牌配置合集(${profiles.length} 份)`,
          description: '',
          tags: ['立牌配置'],
        },
        ...(previews ? { previews } : {}),
      },
      null,
      2,
    ),
    /** 有预览的配置数(调用方日志用,0 = 没带 previews 字段)。 */
    previewCount: previews?.length ?? 0,
  };
}

/** exportProfiles 返回:JSON 字符串 + 预览统计(调用方日志 / UI 提示用)。 */
export interface ExportProfilesResult {
  json: string;
  previewCount: number;
}

/**
 * 一份配置 → 已配槽位的预览帧(导出注入的渲染实现跑这里)。
 *
 * 对齐推送路径(applyProfileSlots):按 slots 配方渲染、角标走同一规则
 * (stampNumbers 且非槽位 3)、容量按 slotCapacity —— 网站轮播出来的就是
 * 「这份配置推上立牌后长什么样」,不是另一套差不多的东西。
 */
async function renderProfilePreviews(
  profile: DisplayProfile,
  renderSlot: (spec: SlotSpec, slot: number) => Promise<string[]>,
): Promise<ProfilePreviewSlots[]> {
  const out: ProfilePreviewSlots[] = [];
  for (let slot = 0; slot < (profile.slots?.length ?? 0); slot++) {
    const spec = profile.slots?.[slot];
    if (!spec) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- 串行渲染,避免多槽位帧同时驻留
      const frames = await renderSlot(spec, slot);
      if (frames.length) out.push({ slot, frames });
    } catch {
      // 单槽位渲不出来(图组被删/取数失败):跳过,不阻断整份导出
    }
  }
  return out;
}

/** 配置导入结果。 */
export interface ProfileImportResult {
  /** 落盘的配置:新 id + 名字。 */
  profiles: { id: string; name: string }[];
  /** 随包图组里实际落盘的(新名字)。 */
  galleries: string[];
  /** 因本地已有同名(且内容一致)而跳过的图组。 */
  skipped: string[];
  /** 因本地已有同名(且内容不同)而改名落盘的:`{ from, to }`。 */
  renamed: { from: string; to: string }[];
}

/**
 * 导入配置分享文件(单份 v1 / 多份 v2 都吃)。每份生成新 id 避免冲突。
 *
 * 顶层 `previews[]`(导出时嵌的预览快照)**本函数不读也不落盘**:预览是导出那一刻
 * 按当时内容渲染的帧,落盘的话下次导出/查看就带着陈旧快照走;导入的是配方,
 * 落盘后重推时按配方现取内容。靠「只读已知的 type/profiles/profile/galleries 字段」
 * 天然实现,别把 parsed 整对象落盘。
 *
 * 随包图组按「快照语义」落盘(0.14.2 起)—— 修复「别的机器导入后展示不符预期」:
 * 配置里的 `userGalleryName` 是**名字引用**,旧逻辑对同名图组无条件跳过、引用不动,
 * 导入的配置指向的就是**本地那份同名图组**(内容是这台机器上已有的另一组图)。
 * 现在:
 * - 本地没有 → 落盘,引用不用动;
 * - 本地有、**帧内容一致** → 跳过(引用指本地,内容等价,快照成立);
 * - 本地有、**帧不同** → 改名(`-2`/`-3`)落盘,配置里的引用(槽位配方/轮播单选/轮播预推)
 *   重写指向新名字 —— 不覆盖本地那份的安全性保留,配置指向它自己带来的图组。
 */
export async function importProfiles(data: string): Promise<ProfileImportResult> {
  let parsed: {
    type?: string;
    /** v2:多份。 */
    profiles?: DisplayProfile[];
    /** v1:单份(旧版导出的文件,继续支持读)。 */
    profile?: DisplayProfile;
    galleries?: { name?: string; frames?: string[] }[];
  };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  // v1 单份归一成数组,下面只有一条处理路径
  const list = parsed.profiles ?? (parsed.profile ? [parsed.profile] : []);
  if (!list.length) throw new Error('无效的配置文件:缺少 profile 字段');

  const { saveUserGallery, dedupeGalleryName, getUserGalleryFrames, rewriteGalleryRefsInProfile } =
    await import('./gallery-store.js');

  // ── 先落盘图组(引用重写要在配置写盘之前算好映射) ──
  const imported: string[] = [];
  const skipped: string[] = [];
  const renames = new Map<string, string>();
  for (const g of parsed.galleries ?? []) {
    const name = g.name?.trim();
    if (!name || !g.frames?.length) continue;
    if (!existsSync(path.join(GALLERY_DIR, name))) {
      // 本地没有:按原名落盘
      // oxlint-disable-next-line no-await-in-loop -- 串行写,避免多组帧同时驻留
      await saveUserGallery(name, g.frames);
      imported.push(name);
      continue;
    }
    // 本地有:帧内容一致 → 跳过(引用不用动);不同 → 改名落盘,引用重写
    let same: boolean;
    try {
      // oxlint-disable-next-line no-await-in-loop -- 同上
      const local = await getUserGalleryFrames(name);
      same = local.length === g.frames.length && local.every((f, i) => f === g.frames![i]);
    } catch {
      same = false; // 本地那份读不出来:当内容不同,改名落盘最稳
    }
    if (same) {
      skipped.push(name);
      continue;
    }
    const finalName = dedupeGalleryName(name);
    // oxlint-disable-next-line no-await-in-loop -- 同上
    await saveUserGallery(finalName, g.frames);
    imported.push(finalName);
    renames.set(name, finalName);
  }

  // ── 再落盘配置(带着重写后的图组引用) ──
  const saved: { id: string; name: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const profile = rewriteGalleryRefsInProfile(list[i]!, renames);
    // 生成新 id(旧 id + 时间戳 + 序号:同一毫秒导入多份也不会撞)
    profile.id = `${profile.id}-${Date.now()}-${i}`;
    profile.isDefault = false;
    profile.createdAt = Date.now();
    profile.updatedAt = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- 串行写,writeProfile 内部还要读改写 config.json
    await writeProfile(profile);
    saved.push({ id: profile.id, name: profile.name });
  }
  return {
    profiles: saved,
    galleries: imported,
    skipped,
    renamed: [...renames].map(([from, to]) => ({ from, to })),
  };
}

// ─── 用户图组目录管理(gallery-store.ts 复用) ──────────────────────────

/** ~/.lipai/gallery/ 根目录(用户图组)。 */
export const GALLERY_DIR = path.join(BASE_DIR, 'gallery');

/** 确保用户图组目录存在。 */
export async function ensureGalleryDir(): Promise<void> {
  await mkdir(GALLERY_DIR, { recursive: true });
}

/** 列出用户图组名(meta.json 的 name,无 meta 则用目录名)。 */
export async function listGalleryDirs(): Promise<string[]> {
  if (!existsSync(GALLERY_DIR)) return [];
  const entries = await readdir(GALLERY_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
