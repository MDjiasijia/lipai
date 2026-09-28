/**
 * 显示配置(DisplayProfile)类型定义 —— 前后端共享。
 *
 * ── 一份配置 = 一套槽位展示 ──
 * 设备有 4 个槽位,一份 profile 描述**每个槽位分别放什么**(slots[4] 内容配方)
 * + 设备设置(亮度/灯光/时间)+ 自动模式设置。切换配置会按配方重推各槽位。
 *
 * 为什么存"配方"而不是存图:天气/图库这类来源每次重推都该取最新内容
 * (切到「早安模式」拿的是今天的天气,不是存下来那天的)。
 * 例外是「本地图片」——本地文件路径不可靠,只能把裁好的帧直接存进配方。
 *
 * 持久化: 全局偏好 ~/.lipai/{config.json, profiles/<id>.json, gallery/<name>/}
 * 运行时: localStorage 缓存当前 profile + profile 列表(JSON 文件做持久化/分享)。
 */

import { sanitizeLoopSteps, type LoopStep } from './loop';

/** 单帧配色:前景文字色 + 背景渐变(顶→底)。 */
export interface FrameColor {
  fg: string;
  bgTop: string;
  bgBottom: string;
}

/** 内容来源。 */
export type SlotSource =
  | 'weather'
  | 'gallery'
  | 'canvas'
  | 'user-gallery'
  | 'animation'
  | 'files'
  | 'usage'
  | 'credit'
  | 'usage-credit'
  | 'datafeed';

/** 自由画布的内容(文字 + 配色 + 背景图)。 */
export interface CanvasContent {
  /** 10 帧文字(按 canvasSplit 分帧)。 */
  frameTexts: string[];
  /** 10 帧配色。 */
  frameColors: FrameColor[];
  /** 输入框原文(与 frameTexts 不双向同步)。 */
  canvasInputText: string;
  /** 分帧方式:按空格切段 / 逐字(含 emoji)切帧。 */
  canvasSplit: 'space' | 'char';
  /** 全帧统一背景图 base64(无 data: 前缀),null=用配色渐变。 */
  bgBase64: string | null;
}

/**
 * 一个槽位的内容配方。推送时按 source 现取内容渲染成帧。
 * 只带对应来源用得到的字段,其余省略。
 */
export interface SlotSpec {
  source: SlotSource;
  /** 非电子立牌槽位可给每帧加 0-9 角标(当秒数看)。 */
  stampNumbers?: boolean;
  /** source='weather' 的城市。 */
  city?: string;
  /**
   * source='weather':天气卡片展示顺序(用户拖拽排出来的语义 ID 列表)。
   * 天气卡是有数据才出(UV/降水/日照/预报天),所以存 ID 而非下标 ——
   * 重启后重新取数,按这份顺序排(数据是新的、顺序是你定的)。空/省略 = 渲染定义顺序。
   * 归一化见 `sanitizeWeatherCardOrder`(shared/weather-cards.ts)。
   */
  weatherCardOrder?: string[];
  /**
   * @deprecated 已废弃(勾选框撤掉,天气是纯「排序 + 容量截断」语义)。
   * 渲染与预览一律无视此字段;保留只为存量配方反序列化不炸。
   */
  excludedWeatherCards?: string[];
  /** source='gallery' 的内置图库主题。 */
  galleryTheme?: 'anime' | 'animals';
  /** source='user-gallery' 的图组名。 */
  userGalleryName?: string;
  /** source='canvas' 的画布内容。 */
  canvas?: CanvasContent;
  /** source='animation' 的动画类型与配色。 */
  animType?: string;
  animTheme?: string;
  /** source='usage' 的统计区间(today / 7 / 30 / month)。 */
  usagePreset?: 'today' | '7' | '30' | 'month';
  /** source='usage':隐藏金额(分享 / 给人看屏幕时用),改显示请求数、占比等非金额指标。 */
  usageHideMoney?: boolean;
  /** source='credit':隐藏额度绝对值(分享 / 给人看屏幕时用),改显示占比 %。 */
  creditHideMoney?: boolean;
  /** source='usage-credit':用量+额度混合流用的统计区间(对用量卡生效,额度是固定本月口径)。 */
  usagePresetMixed?: 'today' | '7' | '30' | 'month';
  /** source='usage-credit':隐藏金额(用量花费 + 额度绝对值都换占比/请求数)。 */
  mixedHideMoney?: boolean;
  /**
   * source='usage-credit':排除(隐藏)的卡片 ID 列表,空/省略 = 全显示。
   * 为什么存「排除」而不是「选中」见 shared/mixed-cards.ts。
   */
  excludedMixedCards?: string[];
  /**
   * source='usage-credit':卡片展示顺序(用户拖拽排出来的)。
   * 与 `excludedMixedCards`(选不选)正交:excluded 决定哪些卡出现,这个决定先后。
   * 只存用户拖过的那一段(没拖过的卡按定义顺序补位),空/省略 = 全用定义顺序。
   * 归一化见 `sanitizeMixedCardOrder`。
   */
  mixedCardOrder?: string[];
  /**
   * source='files' 的帧数据(base64 JPG,已裁成 135×240)。
   * 本地图片无法按配方复现,只能把帧本身存下来。
   */
  frames?: string[];
  /**
   * source='datafeed' 的配方:引用一个自定义数据源定义 + 本槽位出哪些卡。
   * 数据源定义存 store(全站复用),配方只存引用与挑选 —— 同一数据源可被
   * 多个槽位/多份配置引用,改定义即全局生效。
   */
  datafeed?: {
    /** 引用的数据源定义 id(store 里的 DataFeedDef.id)。 */
    defId: string;
    /** 本槽位出哪些卡(模板 ID 列表);空/省略 = 按定义顺序全出(截断到槽位容量)。 */
    cardIds?: string[];
    /** 卡顺序(用户拖拽);省略 = 按定义顺序。 */
    cardOrder?: string[];
  };
  /** 上次编辑时间(ms)。 */
  updatedAt?: number;
}

/** 旧版「编辑器快照」式画布配置。只被 migrateProfile 读,用来把老 profile 迁移成 slots。 */
export interface LegacyCanvasConfig {
  /** 10 帧文字(按 canvasSplit 分帧)。 */
  frameTexts: string[];
  /** 10 帧配色(每组渐变)。 */
  frameColors: FrameColor[];
  /** @deprecated 字号改为按字数自动分级(后端渲染),仅为读旧 profile 保留。 */
  canvasFontSize?: number;
  /** input 原始文本(独立于 frameTexts,不双向同步)。 */
  canvasInputText: string;
  /** 分帧方式:按空格切段 / 逐字(含 emoji)切帧。旧 profile 无此字段,回落 'char'。 */
  canvasSplit?: 'space' | 'char';
  /** 背景图 base64(无 data: 前缀),null=用渐变。替代运行时 HTMLImageElement。 */
  bgBase64: string | null;
  /** 内容来源(投屏流水线的第一步)。user-gallery 为用户图组,animation 为动画,files 为本地图片。 */
  screenSource: 'weather' | 'gallery' | 'canvas' | 'user-gallery' | 'animation' | 'files';
  /** 推送目标槽位 0/1/2/3(全部来源共用)。槽位 3 只用前 6 张。 */
  screenStyle: 0 | 1 | 2 | 3;
  /** 非电子立牌给每帧加 0-9 角标。 */
  stampNumbers: boolean;
  /** 天气来源城市。 */
  screenCity: string;
  /** 内置图库主题。 */
  galleryTheme: 'anime' | 'animals';
  /** AI 生成文案主题。 */
  aiTopic: string;
  /** AI 生成配色主题。 */
  aiColorTheme: string;
  /** 用户图组名(screenSource='user-gallery' 时)。 */
  userGalleryName?: string;
  /** 4 个样式槽的自定义名称(对应 style 0/1/2/3),空串回落默认名。 */
  styleNames?: [string, string, string, string];
}

/** 旧版动画配置。只被 migrateProfile 读。 */
export interface LegacyAnimationConfig {
  /** 内置动画类型(moon/rocket/cat/heart/star/ball/progress/countdown)。 */
  animType: string;
  /** 配色主题。 */
  animTheme: string;
  /** @deprecated 自定义序列已合并进自由画布的「逐字分帧」,仅为读旧 profile 保留。 */
  animMode?: 'preset' | 'custom';
  /** @deprecated 同上。 */
  animInputText?: string;
  /** @deprecated 目标槽位已统一到 CanvasConfig.screenStyle,仅为读旧 profile 保留。 */
  animStyle?: 0 | 1 | 2;
}

/**
 * 轮播循环配置(原「定时推送」+「槽位轮换」合成一个)。
 *
 * 存的是**一条步骤列表**(`["weather", 1, "usage-credit"]`,见 shared/index.ts 的 LoopStep),
 * 而不是两份互斥的配置 —— 用户看到的是一条时间线,存盘也就该是一条。
 */
export interface LoopConfig {
  /** 参与循环的步骤(数字 0-3 = 切到该槽位;字符串 = 内容源),按这个顺序轮。 */
  loopSteps: LoopStep[];
  /** 间隔(秒)。下限见 loopMinIntervalSec:有推图步骤 30,纯切槽位 1。 */
  loopInterval: number;
  /** 启动前先给参与循环的槽位各推一组图(把槽位当动画帧)。 */
  loopPrePush?: boolean;
  /** loopPrePush 时各槽位(下标 0-3)用哪个图组,空串 = 不推。 */
  loopPrePushGalleries?: string[];
  /** 选了 weather 时的城市。 */
  loopCity?: string;
  /** 选了 gallery 时的内置图库主题。 */
  loopGalleryTheme?: 'anime' | 'animals';
  /** 选了 user-gallery 时的图组名。 */
  loopUserGalleryName?: string;
  /** 选了 frames 时的序列输入文本(按 grapheme 分帧)。 */
  loopFrames?: string;
  /** 选了 usage-credit 时的统计区间(对用量卡生效,额度是固定本月口径)。 */
  loopUsagePreset?: 'today' | '7' | '30' | 'month';
  /** 选了 usage-credit 时隐藏金额(用量花费 + 额度绝对值都换占比/请求数)。 */
  loopMixedHideMoney?: boolean;
  /**
   * 选了 weather 时多久打一次 wttr.in(分钟)。默认 60,范围 30–240。
   * 和 loopInterval(屏幕换一次)解耦:间隔 30 秒换卡也不该每 30 秒打一次天气。
   */
  loopWeatherRefreshMin?: number;
  /**
   * 选了 usage-credit 时推哪几张卡:**这里没有这个字段** —— 勾选只有一份,存在槽位配方的
   * `excludedMixedCards` 里(投屏页预览区勾的那份),循环直接读它。两处各存一份的话,
   * 预览里勾完、启动却推出另一套。
   */
}

/** @deprecated 旧版「定时推送」配置。只被 loopConfigOf 读,用来迁移成 LoopConfig。 */
export interface SchedulerConfig {
  /** 参与轮换的内容源(1 个 = 每轮都推它,多个 = 每轮换下一个)。 */
  schedSources?: string[];
  /** @deprecated 更旧的单选内容源。 */
  schedSource?: string;
  /** @deprecated 更旧的「混搭」源列表。 */
  schedMultiSources?: string[];
  schedInterval?: number;
  schedCity?: string;
  schedGalleryTheme?: 'anime' | 'animals';
  schedUserGalleryName?: string;
  schedFrames?: string;
  schedUsagePreset?: 'today' | '7' | '30' | 'month';
  schedMixedHideMoney?: boolean;
  /** @deprecated 「时钟模式」源的样式池;迁移成 slot 步骤。 */
  schedClockStyles?: number[];
}

/** @deprecated 旧版「槽位轮换」配置。只被 loopConfigOf 读,用来迁移成 LoopConfig。 */
export interface StyleRotationConfig {
  /** 参与轮换的槽位序号(0/1/2/3)。 */
  rotStyles?: number[];
  /** 切换间隔秒。 */
  rotInterval?: number;
  /** 启动前先给各参与槽位预推一组图。 */
  rotPrePush?: boolean;
  /** rotPrePush 时各槽位(0-3)对应的图组名,空串=不推。 */
  rotGalleries?: string[];
}

/** 传输配置(推送走蓝牙还是局域网 HTTP)。 */
export interface PictureDialConfig {
  transferMode: 'lan' | 'ble';
  /** @deprecated 目标槽位已统一到 CanvasConfig.screenStyle,仅为读旧 profile 保留。 */
  pictureStyle?: 0 | 1 | 2 | 3;
}

/** 设备控制配置(应用时下发设备固件,用于一键恢复)。 */
export interface DeviceControlConfig {
  brightness: number;
  clockStyle: number;
  lightMode: number;
  lightColor: string;
  timeFormat: string;
  networkTime: boolean;
  weatherEnabled: boolean;
  weatherCity: string;
  tempUnit: string;
  /**
   * 时区(四分之一小时数,32 = UTC+8)。设备 Tab 双向绑定后落在这里,
   * 应用配置时随其余设置一并下发 —— 此前 Control 里硬编码 32,设备页选的时区永远落不了盘。
   */
  timezoneQuarterHours?: number;
}

/**
 * 场景日程时段(时段表:声明开始时刻,持续到下一个时段开始)。
 * 可配多个(早 / 中 / 晚),互不干扰。
 *
 * 与轮播的「source 步」是同一件事 —— 到点把 `spec` 渲成一整套 6 张推到电子立牌槽位。
 * 所以没存「整套配置」(那是推 4 槽位、几分钟的事),只存这一个槽位的配方,
 * 到点现取内容(天气今天的、用量此刻的)推上去。
 */
export interface SceneSlot {
  id: string;
  /** "HH:MM" 24 小时制,精确到分钟。时段的**开始**时刻。 */
  time: string;
  /** 到点推什么内容(电子立牌槽位配方)。undefined = 老数据迁过来的空骨架,等用户补内容。 */
  spec?: SlotSpec;
  /** 星期几 0-6(0=周日),省略/空=每天。 */
  daysOfWeek?: number[];
  /** 可读标签,如"午饭时间"。 */
  label?: string;
  /** 持续 N 分钟后切回默认时钟;省略 = 一直到下一个时段开始。 */
  durationMin?: number;
  /** 是否启用(false=临时停用但保留配置)。省略视为启用。 */
  enabled?: boolean;
}

/**
 * 场景日程(一份全局日程,不随 profile 走)。
 * 时段表存在 webview localStorage,启动时整份传给后端 startSceneSchedule。
 */
export interface SceneSchedule {
  enabled: boolean;
  slots: SceneSlot[];
}

/** 完整显示配置 —— 一个 profile = 一套立牌显示状态。 */
export interface DisplayProfile {
  /** 唯一 id(slug)。 */
  id: string;
  /** 用户可读名,如"默认""干饭模式"。 */
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 标记默认 profile(不可删)。 */
  isDefault?: boolean;

  /** 4 个槽位分别放什么(索引 = 槽位号 0-3);null = 该槽位这份配置不管。 */
  slots?: (SlotSpec | null)[];
  /** 应用这份配置后屏幕停在哪个槽位。 */
  activeSlot?: 0 | 1 | 2 | 3;
  /** 上次在投屏页编辑的是哪个槽位(纯 UI 记忆)。 */
  editingSlot?: 0 | 1 | 2 | 3;
  /** 4 个槽位的自定义名称,空串回落默认名。 */
  slotNames?: [string, string, string, string];

  /** 轮播循环配置。老 profile 没有,由 loopConfigOf 从 scheduler / styleRotation 迁出来。 */
  loop?: LoopConfig;
  // oxlint-disable no-deprecated -- 这两个字段本身就是「已废弃、只为读旧盘保留」
  /** @deprecated 旧版「定时推送」配置,只读不写(loopConfigOf 迁移入口)。 */
  scheduler?: SchedulerConfig;
  /** @deprecated 旧版「槽位轮换」配置,只读不写(同上)。 */
  styleRotation?: StyleRotationConfig;
  // oxlint-enable no-deprecated
  deviceControl: DeviceControlConfig;
  /** 传输方式。旧 profile 必带,新 profile 可省(回落蓝牙)。 */
  pictureDial?: PictureDialConfig;
  /** 「自动」页当前选中的模式(老值 rotation / scheduler 都并成了 loop)。 */
  autoMode?: 'loop' | 'scene' | 'rotation' | 'scheduler';

  /** 旧版单目标槽位的编辑器快照(读旧文件用;migrateProfile 会转成 slots)。 */
  canvas?: LegacyCanvasConfig;
  /** 旧版动画配置(同上)。 */
  animation?: LegacyAnimationConfig;
}

/**
 * 收集一份配置引用到的所有用户图组名(去重,不含空串)。
 *
 * 分享配置时要连图组一起打包 —— 只发 profile JSON,对方导入后
 * `userGalleryName` 指向的图组在他机器上不存在,那个槽位就是空的。
 * 图组名散在三处(槽位配方 / 轮播的单选图组 / 轮播预推的 4 个槽位),
 * 这里统一收口,避免导出漏掉某一处。
 */
export function collectGalleryDeps(profile: DisplayProfile): string[] {
  const names = new Set<string>();
  const add = (n: string | undefined | null): void => {
    const name = n?.trim();
    if (name) names.add(name);
  };
  for (const slot of profile.slots ?? []) {
    if (slot?.source === 'user-gallery') add(slot.userGalleryName);
  }
  add(profile.loop?.loopUserGalleryName);
  for (const g of profile.loop?.loopPrePushGalleries ?? []) add(g);
  return [...names];
}

/** 槽位容量:槽位 3(电子立牌)固件固定展示 6 张,其余槽位 10 帧。 */
export function slotCapacity(slot: number): number {
  return slot === 3 ? 6 : 10;
}

/**
 * 4 个槽位(= 时钟样式)的默认名。用户能在 `slotNames` 里改名,这里是回落值。
 * 前端选择器、后端日志共用一份 —— 两边各写一遍就会出现「日志叫样式 1、界面叫数字时钟一」。
 */
export const SLOT_STYLE_NAMES = ['默认时钟', '数字时钟一', '数字时钟二', '电子立牌'] as const;

/**
 * 内容来源的中文标签 —— 全站唯一一份(此前散在 types/Control/SlotStrip/SourcePicker 四处,
 * 且互不一致:canvas 一处叫「手绘板」一处叫「自由画布」)。展示用富列表(icon+提示语)的
 * SourcePicker 自己维护,label 本体只从这里出。
 */
export const SOURCE_LABELS: Record<string, string> = {
  weather: '天气',
  gallery: '内置图库',
  canvas: '自由画布',
  'user-gallery': '我的图组',
  animation: '内置动画',
  files: '本地图片',
  'datafeed': '自定义接口',
  // legacy 键:migrateSlotSources 会把旧盘上的单独来源并进 usage-credit,标签兜底用
  usage: '用量',
  credit: '额度',
  'usage-credit': '用量+额度',
};

/**
 * 自定义数据源定义（「接口 + 取值 + 渲染模板」一体）。
 *
 * 与天气来源同构：拉一次 JSON → 按卡片模板各自取值 → 渲成 135×240 帧列表。
 * 存 IndexedDB（store.ts），可被任意槽位/配置引用；「自动」轮播把 datafeed
 * 步骤当推图步骤对待 —— 用户用它实现天气之外的任意自定义展示（股价/热搜/待办…）。
 */
export interface DataFeedDef {
  /** 唯一 id（slug，store 生成）。 */
  id: string;
  /** 用户可读名，如「GitHub Trending」。 */
  name: string;
  createdAt: number;
  updatedAt: number;

  /** 接口地址（须返回 JSON；浏览器直连，受目标服务 CORS 约束 —— 编辑器里可测试）。 */
  url: string;
  /** 请求方法。默认 GET。 */
  method?: 'GET' | 'POST';
  /** 请求头（浏览器允许的；Authorization 等受限头编辑器里会提示）。 */
  headers?: Record<string, string>;
  /** POST 请求体（JSON 字符串）。 */
  body?: string;

  /**
   * 取数结果缓存时长（毫秒）。0 = 不缓存（每次渲染都打接口 —— 轮播时慎用）。
   * 默认 10 分钟。与「自动」的换卡间隔解耦：间隔再密也不该把接口打挂。
   */
  cacheTtlMs?: number;

  /** 卡片模板列表：每张模板产出一帧。 */
  cards: DataFeedCardTemplate[];
}

/** 一张卡的渲染模板：声明式块布局（对齐 render.ts 天气卡的 stack() 结构）。 */
export interface DataFeedCardTemplate {
  /** 卡片稳定 ID（槽位配方 cardIds/cardOrder 引用它，不能改字面量）。 */
  id: string;
  /** 卡名（预览/排序标签）。 */
  label: string;

  /** 配色（缺省 = 深蓝夜色）。 */
  theme?: {
    /** 背景渐变亮端。 */
    bgA?: string;
    /** 背景渐变暗端。 */
    bgB?: string;
    /** 主文字/主体色。 */
    fg?: string;
    /** 次文字色。 */
    sub?: string;
    /** 强调色（胶囊底/细线/图形）。 */
    accent?: string;
  };

  /** 垂直堆叠的内容块（自上而下渲染，自动测高居中）。 */
  blocks: DataFeedBlock[];
}

/**
 * 内容块 —— canvas-kit stack() Block 的可序列化子集（存盘/跨端安全，禁函数）。
 * 文本支持取值占位 {path}：渲染时从接口 JSON 里按路径取值插进去。
 * 路径语法：a.b.0.c（点分，数字段 = 数组下标）；顶层直接写字段名。
 * 每块可覆盖颜色（color）与对齐（align；缺省随卡居中）—— 字段级个性化的粒度。
 */
export type DataFeedBlock =
  | { kind: 'label'; text: string; color?: string; align?: 'left' | 'center' | 'right' }
  | { kind: 'hero'; text: string; max?: number; color?: string; align?: 'left' | 'center' | 'right' }
  | { kind: 'body'; text: string; max?: number; color?: string; align?: 'left' | 'center' | 'right' }
  | { kind: 'caption'; text: string; color?: string; align?: 'left' | 'center' | 'right' }
  | { kind: 'emoji'; text: string; size?: number; align?: 'left' | 'center' | 'right' }
  | { kind: 'gap'; h: number };

/**
 * 从对象里按点分路径取值（'a.b.0.c'）。返回 undefined = 路径不存在（渲染成空）。
 * 纯函数、无异常：路径段遍历，遇 null/undefined 或非对象中断。
 */
export function dataFeedValueAt(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * 把文本里的 {path} 占位替换成接口数据。
 * - 路径不存在 → 空串（卡上不留 {xxx} 脏字）；
 * - 数组/对象值 → JSON 序列化（长度截 60）；
 * - 无占位的文本原样返回。
 */
export function dataFeedInterpolate(text: string, data: unknown): string {
  return text.replace(/\{([^{}]+)\}/g, (_m, path: string) => {
    const v = dataFeedValueAt(data, path.trim());
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  });
}

/** datafeed 默认缓存：10 分钟（对齐天气 CACHE_TTL_MS 量级）。 */
export const DATAFEED_DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * 图库主题的中文标签(内置图库槽位的语义名称用)。
 */
export const GALLERY_THEME_LABELS: Record<string, string> = {
  anime: '动漫图库',
  animals: '动物图库',
};

/**
 * 槽位配方的一句话语义名称:「天气 · 上海」「我的图组 · 星空」这类。
 * 服务端解析(shareLogic / functions _lib)与前端共用 —— 首页展台分组
 * 用它当 chip 名,替代无语义的「槽 N」。
 */
export function slotSpecLabel(s: unknown): string {
  if (s === null || typeof s !== 'object') return '空槽位';
  const slot = s as Record<string, unknown>;
  const base = SOURCE_LABELS[String(slot.source)] ?? String(slot.source ?? '未知');
  let detail = '';
  if (slot.source === 'weather' && typeof slot.city === 'string' && slot.city) detail = slot.city;
  if (slot.source === 'user-gallery' && typeof slot.userGalleryName === 'string' && slot.userGalleryName)
    detail = slot.userGalleryName;
  if (slot.source === 'gallery' && typeof slot.galleryTheme === 'string' && slot.galleryTheme)
    detail = GALLERY_THEME_LABELS[slot.galleryTheme] ?? slot.galleryTheme;
  return detail ? `${base} · ${detail}` : base;
}

/**
 * 把旧版 profile(单目标槽位的编辑器快照)迁移成 slots[4] 模型。
 * 旧配置的 canvas.screenSource + screenStyle → 对应槽位的一份配方,其余槽位留空。
 * 已经是新模型的原样返回(幂等)。
 */
export function migrateProfile(p: DisplayProfile): DisplayProfile {
  if (p.slots) return p;
  // 读旧字段是本函数的职责,走一个别名以免逐处触发 deprecated 告警
  const legacy = p as { canvas?: LegacyCanvasConfig; animation?: LegacyAnimationConfig };
  const c = legacy.canvas;
  const slots: (SlotSpec | null)[] = [null, null, null, null];
  if (c) {
    const spec: SlotSpec = { source: c.screenSource, stampNumbers: c.stampNumbers };
    if (c.screenSource === 'weather') spec.city = c.screenCity;
    if (c.screenSource === 'gallery') spec.galleryTheme = c.galleryTheme;
    if (c.screenSource === 'user-gallery') spec.userGalleryName = c.userGalleryName;
    if (c.screenSource === 'animation') {
      spec.animType = legacy.animation?.animType ?? 'moon';
      spec.animTheme = legacy.animation?.animTheme ?? '霓虹蓝';
    }
    if (c.screenSource === 'canvas') {
      spec.canvas = {
        frameTexts: c.frameTexts,
        frameColors: c.frameColors,
        canvasInputText: c.canvasInputText,
        canvasSplit: c.canvasSplit ?? 'char',
        bgBase64: c.bgBase64,
      };
    }
    slots[c.screenStyle] = spec;
  }
  return {
    ...p,
    slots,
    activeSlot: c?.screenStyle ?? 3,
    editingSlot: c?.screenStyle ?? 3,
    slotNames: p.slotNames ?? c?.styleNames ?? ['', '', '', ''],
  };
}

/**
 * 把旧版 slots 里的 source='usage' / 'credit' 迁移成合并后的 'usage-credit'。
 *
 * 合并混合流后只留 'usage-credit' 一个来源,但用户磁盘上可能还有旧 profile 存着
 * 单独的 'usage' 或 'credit'。读 profile 时过一遍这个:把它们的 source 改成
 * 'usage-credit',用量区间和隐藏金额开关映射到混合流对应的字段。
 * (额度单独来源没有区间,默认用 '7';隐藏金额开关映射到 mixedHideMoney。)
 *
 * 幂等:已经是 'usage-credit'(或其他来源)的原样返回。
 */
export function migrateSlotSources(p: DisplayProfile): DisplayProfile {
  if (!p.slots) return p;
  let changed = false;
  const slots = p.slots.map((spec): SlotSpec | null => {
    if (!spec) return spec;
    if (spec.source === 'usage') {
      changed = true;
      return {
        ...spec,
        source: 'usage-credit',
        usagePresetMixed: spec.usagePreset ?? '7',
        mixedHideMoney: spec.usageHideMoney === true ? true : undefined,
        usagePreset: undefined,
        usageHideMoney: undefined,
      };
    }
    if (spec.source === 'credit') {
      changed = true;
      return {
        ...spec,
        source: 'usage-credit',
        usagePresetMixed: '7',
        mixedHideMoney: spec.creditHideMoney === true ? true : undefined,
        creditHideMoney: undefined,
      };
    }
    return spec;
  });
  return changed ? { ...p, slots } : p;
}

/**
 * 把老场景日程时段(存 `profileId`)迁移成新模型(存 `spec`)。
 *
 * 老时段存的是 `profileId`(指向整套配置),但当时 onEnter 根本没推内容(只切 clockStyle+brightness),
 * 所以老时段里**没有内容可迁** —— 这里只剥掉 `profileId`,保留时段骨架(time/label/daysOfWeek/...),
 * `spec` 留 undefined,UI 上标「未配置内容」让用户补。
 *
 * 保留骨架而不整体丢弃:用户不用重配时刻表,只需给每个时段补一下内容。
 * 不把 `profileId` → 该 profile 的 slot[3] spec:迁移发生在 loadSceneSlots(localStorage 解析),
 * 那时 profile 列表还没加载,拿不到 spec;而且老 onEnter 没推内容,迁出来的 spec 也不一定是用户想要的。
 *
 * 幂等:已经没有 `profileId` 的原样返回。
 */
export function migrateSceneSlots(slots: SceneSlot[] | null | undefined): SceneSlot[] {
  if (!slots?.length) return [];
  let changed = false;
  const out = slots.map((slot) => {
    if (!('profileId' in slot)) return slot;
    changed = true;
    // 剥掉老字段：rest 收集其余属性（profileId 不落盘 —— 语义见函数头注释）
    const rest: SceneSlot = { ...(slot as Omit<SceneSlot, 'profileId'>) };
    return rest;
  });
  return changed ? out : slots;
}

/** 天气数据刷新间隔(分钟):默认 60,范围 30–240。和屏幕换卡间隔解耦。 */
export const WEATHER_REFRESH_MIN_DEFAULT = 60;
export const WEATHER_REFRESH_MIN_MIN = 30;
export const WEATHER_REFRESH_MIN_MAX = 240;

export function clampWeatherRefreshMin(n: unknown): number {
  const v =
    typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : WEATHER_REFRESH_MIN_DEFAULT;
  return Math.min(WEATHER_REFRESH_MIN_MAX, Math.max(WEATHER_REFRESH_MIN_MIN, v));
}

/** 没配过循环时的默认步骤:天气一步(能立刻看到东西,又不依赖任何已推内容)。 */
export const DEFAULT_LOOP_STEPS: LoopStep[] = ['weather'];

/** 循环配置的默认值(新建 profile / 老配置读不出来时用)。 */
export function defaultLoopConfig(): LoopConfig {
  return {
    loopSteps: [...DEFAULT_LOOP_STEPS],
    loopInterval: 30,
    loopCity: '上海',
    loopGalleryTheme: 'anime',
    loopFrames: '⭐🌙✨🔥💰',
    loopUsagePreset: '7',
    loopWeatherRefreshMin: WEATHER_REFRESH_MIN_DEFAULT,
  };
}

/**
 * 读出一份 profile 的循环配置,顺带把老配置迁过来。
 *
 * 老 profile 里「定时推送」和「槽位轮换」是两份互斥配置 + 一个 `autoMode` 说当时选了哪个。
 * 合并成一条时间线后要挑一份迁:**按 autoMode 挑用户当时在用的那个**,
 * 而不是把两份的步骤混起来 —— 混起来会凭空造出一个用户从没配过的循环
 * (比如他明明只想切槽位,启动后却开始每 30 秒推天气图)。
 *
 * 幂等:已有 `loop` 的原样返回。
 */
// oxlint-disable-next-line no-deprecated -- 迁移入口:签名必须收老配置
export function loopConfigOf(p: {
  loop?: LoopConfig;
  // oxlint-disable no-deprecated
  scheduler?: SchedulerConfig;
  styleRotation?: StyleRotationConfig;
  // oxlint-enable no-deprecated
  autoMode?: string;
}): LoopConfig {
  if (p.loop?.loopSteps?.length) return { ...defaultLoopConfig(), ...p.loop };
  const base = defaultLoopConfig();
  // oxlint-disable no-deprecated -- 迁移入口:这里就是唯一该读老字段的地方
  const sched = p.scheduler;
  const rot = p.styleRotation;
  // 老的槽位轮换:全是 slot 步。autoMode 缺省时也走它 —— 有 rotStyles 说明配过。
  if (p.autoMode === 'rotation' && rot?.rotStyles?.length) {
    return {
      ...base,
      loopSteps: sanitizeLoopSteps(rot.rotStyles),
      loopInterval: rot.rotInterval ?? 60,
      loopPrePush: rot.rotPrePush,
      loopPrePushGalleries: rot.rotGalleries,
    };
  }
  if (!sched) return base;
  // 老的定时推送:内容源 → source 步;「时钟模式」源 → 它那几个样式各成一个 slot 步
  const raw: unknown[] = [];
  for (const src of legacySchedSources(sched)) {
    // 老的「时钟模式」源带一个样式池 → 每个样式各成一个切槽位步
    if (src === 'clock') raw.push(...(sched.schedClockStyles ?? [1]));
    else raw.push(src);
  }
  const steps = sanitizeLoopSteps(raw);
  return {
    ...base,
    loopSteps: steps.length ? steps : [...DEFAULT_LOOP_STEPS],
    loopInterval: sched.schedInterval ?? base.loopInterval,
    loopCity: sched.schedCity ?? base.loopCity,
    loopGalleryTheme: sched.schedGalleryTheme ?? base.loopGalleryTheme,
    loopUserGalleryName: sched.schedUserGalleryName,
    loopFrames: sched.schedFrames ?? base.loopFrames,
    loopUsagePreset: sched.schedUsagePreset ?? base.loopUsagePreset,
    loopMixedHideMoney: sched.schedMixedHideMoney,
  };
  // oxlint-enable no-deprecated
}

/**
 * 老「定时推送」配置里的内容源列表(它自己也经历过一次「单选 → 多选」迁移:
 * schedSources 新 → schedSource='multi' + schedMultiSources → schedSource 单选)。
 */
// oxlint-disable-next-line no-deprecated -- 迁移入口
function legacySchedSources(cfg: SchedulerConfig): string[] {
  if (cfg.schedSources?.length) return [...cfg.schedSources];
  // oxlint-disable no-deprecated -- 同上,迁移入口
  if (cfg.schedSource === 'multi') return [...(cfg.schedMultiSources ?? [])];
  return cfg.schedSource ? [cfg.schedSource] : [];
  // oxlint-enable no-deprecated
}

/** ~/.lipai/config.json 结构。 */
export interface ProfileStoreConfig {
  version: number;
  /** 当前激活的 profile id。 */
  currentProfileId: string;
  /** 所有 profile id 列表。 */
  profileIds: string[];
  /** 自动重连开关:设备断开后自动尝试重连(开发热重载 / 设备断电后不用手动连)。 */
  autoConnect?: boolean;
  /** 上次成功连接的设备名(自动重连带它连,不写 localStorage —— 后端要在 webview 没起时也记得)。 */
  lastDeviceName?: string;
}

/** 轻量 profile 列表项(listProfiles 返回,不含完整内容)。 */
export interface ProfileListItem {
  id: string;
  name: string;
  updatedAt: number;
  isDefault?: boolean;
}

/**
 * 导出配置分享文件时嵌的预览快照(一个已配槽位的渲染帧)。
 *
 * 为什么导出要带预览:分享网站要展示「这份配置在立牌上长什么样」,
 * 但天气/用量这类来源的内容只有本扩展的渲染管线能现取 —— 网站复刻不了。
 * 导出时走推送同一条管线(renderSlotSpec)现渲染一整套,网站拿帧直接轮播。
 */
export interface ProfilePreviewSlots {
  /** 槽位号 0-3。 */
  slot: number;
  /** 135×240 JPEG base64(无 data: 前缀),含角标时与推送路径同规则。 */
  frames: string[];
}

/**
 * 一份配置的预览快照(顶层 `previews[]` 的元素)。
 *
 * 放**顶层**而不是嵌进 DisplayProfile:previews 是导出那一刻的快照,
 * 嵌进配置对象的话导入端(importProfiles 整体写盘)得显式剥掉,漏剥就把
 * 陈旧快照落了盘(和 0.14.2 修的「同名图组引用不重写」同一类问题)。
 * 顶层字段导入端天然不读,零代码守住快照语义;重新导出时永远现渲染新的。
 */
export interface ProfilePreviews {
  /** 对应同文件 profiles[].id(导出时的原始 id;导入端会换新 id,previews 不跟走)。 */
  profileId: string;
  slots: ProfilePreviewSlots[];
}
