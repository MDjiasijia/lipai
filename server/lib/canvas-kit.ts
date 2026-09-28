/**
 * 135×240 小屏渲染设计系统。
 *
 * 为什么要有这一层:天气/动画/画布三个渲染器原本各写一套「两点线性渐变 + 居中文字」,
 * 于是几十张图长得一个样,而且每个渲染器的字号/行距/留白各自硬编码。
 * 这里把背景、版式、装饰件抽成共享原语,三个渲染器只负责"摆什么",不再各自发明"怎么摆"。
 *
 * 设计约束(来自设备):
 * - 135×240 竖屏、JPEG 有损、放在桌面 ~50cm 远看 → 细节会糊,靠大色块 + 高对比 + 少量元素。
 * - 细长比例(9:16 还窄)适合三段式:顶部标签 / 中部主体 / 底部注脚。
 * - 文字一律带一点暗投影:小屏上纯色文字压在渐变上边缘会发虚。
 */

import { createCanvas, GlobalFonts, type CanvasRenderingContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';

// 注册彩色 emoji 字体(macOS Apple Color Emoji / Windows Segoe UI Emoji)。
// 放在 kit 里而不是某个渲染器里:谁都可能画 emoji,注册只该发生一次。
const EMOJI_FONT_CANDIDATES =
  process.platform === 'win32'
    ? [String.raw`C:\Windows\Fonts\seguiemj.ttf`]
    : [
        '/System/Library/Fonts/Apple Color Emoji.ttc',
        '/System/Library/Fonts/Supplemental/Apple Color Emoji.ttf',
      ];
let emojiFontRegistered = false;
for (const candidate of EMOJI_FONT_CANDIDATES) {
  if (existsSync(candidate)) {
    try {
      GlobalFonts.registerFromPath(candidate, 'Emoji');
      emojiFontRegistered = true;
      break;
    } catch {
      // 注册失败继续试下一个
    }
  }
}
/** emoji 字体名(注册成功用 "Emoji",失败回落 sans-serif)。 */
export const EMOJI_FONT = emojiFontRegistered ? 'Emoji' : 'sans-serif';

// 注册中文字体。@napi-rs/canvas 在 Windows / Linux 上**不会**自动加载系统字体,
// 只认 registerFromPath 注册过的 —— 不注册中文字体,中文就渲染成豆腐块 □□□。
// macOS 走 CoreText 能直接找到 Hiragino,无需注册;这里主要给 Windows / Linux 兜底。
const CJK_FONT_CANDIDATES =
  process.platform === 'win32'
    ? [
        String.raw`C:\Windows\Fonts\msyh.ttc`, // 微软雅黑
        String.raw`C:\Windows\Fonts\simhei.ttf`, // 黑体
        String.raw`C:\Windows\Fonts\simsun.ttc`, // 宋体
      ]
    : process.platform === 'linux'
      ? [
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK.ttc',
        ]
      : []; // macOS:系统字体由 CoreText 提供,无需注册
let cjkFontRegistered = false;
for (const candidate of CJK_FONT_CANDIDATES) {
  if (existsSync(candidate)) {
    try {
      GlobalFonts.registerFromPath(candidate, 'CJK');
      cjkFontRegistered = true;
      break;
    } catch {
      // 注册失败继续试下一个
    }
  }
}

export const CARD_W = 135;
export const CARD_H = 240;

/** 安全边距:设备边框会吃掉一点,内容不要贴边。 */
export const PAD = 12;

/**
 * 中文字体族。macOS 用系统自带 Hiragino Sans GB;Windows / Linux 上把系统中文字体
 * 注册成 "CJK" 族(见上)并置于首位,否则 @napi-rs/canvas 找不到中文字形、渲染成豆腐块。
 */
export const FONT_CN = cjkFontRegistered
  ? '"CJK", "Hiragino Sans GB", "Helvetica Neue", sans-serif'
  : '"Hiragino Sans GB", "Helvetica Neue", sans-serif';

/** 一套配色:背景两端 + 三级前景。 */
export interface Palette {
  /** 背景亮端(渐变起点)。 */
  bgA: string;
  /** 背景暗端(渐变终点)。 */
  bgB: string;
  /** 主文字 / 主体元素。 */
  fg: string;
  /** 次文字(注脚、单位)。 */
  sub: string;
  /** 强调色:胶囊底、细线、图形。 */
  accent: string;
}

/**
 * 一张带身份的卡片:ID + 图。
 *
 * 混合流要按 ID 挑卡(用户勾了哪几张)、按 ID 标名字,所以渲染器不能只返回图数组 ——
 * 条件卡(没数据就不出的那些)一缺,纯数组的下标就和「第几张是什么」错位了。
 * 谁产卡谁给 ID:ID 与图在同一处产生,永不脱钩。
 */
export interface RenderedCard {
  /** 卡片稳定 ID(混合流用 MixedCardId,单独流用各自的卡名)。 */
  id: string;
  image: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* 基础:画布 / 颜色                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 把卡片列表循环补足到 count 张(卡片数不够就重复补位)。
 * 空列表原样返回空 —— 调用方自己决定兜底卡。
 */
export function padCards<T>(cards: T[], count: number): T[] {
  if (!cards.length) return [];
  return Array.from({ length: count }, (_, i) => cards[i % cards.length]!);
}

/** 渲染单帧 135×240 JPEG。 */
export function frame(draw: (ctx: CanvasRenderingContext2D) => void): Uint8Array {
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  draw(ctx);
  return canvas.toBuffer('image/jpeg', 92);
}

/** 渲染单帧(异步 draw,如需 loadImage)。 */
export async function frameAsync(
  draw: (ctx: CanvasRenderingContext2D) => Promise<void>,
): Promise<Uint8Array> {
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  await draw(ctx);
  return canvas.toBuffer('image/jpeg', 92);
}

/** #rrggbb → [r,g,b]。 */
export function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** #rrggbb + alpha → rgba() 字符串。 */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** 两色线性插值。 */
export function mix(a: string, b: string, f: number): string {
  const [r1, g1, b1] = rgb(a),
    [r2, g2, b2] = rgb(b);
  const to = (x: number, y: number) => Math.round(x * (1 - f) + y * f);
  return `#${((to(r1, r2) << 16) | (to(g1, g2) << 8) | to(b1, b2)).toString(16).padStart(6, '0')}`;
}

/** 相对亮度(0-1),用来决定压在上面的文字该深还是浅。 */
export function luma(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 确定性伪随机(同一 seed 每次渲染结果一致,避免帧间星点乱跳)。 */
export function seeded(seed: number): () => number {
  let s = (seed * 2_654_435_761) % 4_294_967_296;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

/* -------------------------------------------------------------------------- */
/* 背景                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 主背景:斜向渐变 + 左上高光 + 底部压暗。
 * 比原来的纯垂直两点渐变多了光源方向和景深,同一套色也不会显得平。
 */
export function backdrop(ctx: CanvasRenderingContext2D, p: Palette): void {
  // 斜向主渐变(左上 → 右下)
  const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  g.addColorStop(0, p.bgA);
  g.addColorStop(1, p.bgB);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 左上高光(accent 极淡,给一个光源方向)
  const hi = ctx.createRadialGradient(
    CARD_W * 0.2,
    CARD_H * 0.12,
    2,
    CARD_W * 0.2,
    CARD_H * 0.12,
    CARD_W * 1.1,
  );
  hi.addColorStop(0, alpha(p.accent, 0.28));
  hi.addColorStop(1, alpha(p.accent, 0));
  ctx.fillStyle = hi;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 底部压暗(把注脚区压下去,主体更突出)。
  // 浅色主题只压一点点:浅底上压 30% 黑会直接变成脏灰(「极简白」主题曾经就是这个毛病)。
  const depth = luma(p.bgB) > 0.62 ? 0.07 : 0.3;
  const sh = ctx.createLinearGradient(0, CARD_H * 0.55, 0, CARD_H);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(1, `rgba(0,0,0,${depth})`);
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

/** 中心光晕(给主体元素垫一层氛围,emoji 不再像贴纸)。 */
export function halo(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  a = 0.5,
): void {
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
  g.addColorStop(0, alpha(color, a));
  g.addColorStop(0.55, alpha(color, a * 0.35));
  g.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

/** 星点(夜空类背景用,seed 固定 = 帧间不闪)。 */
export function stars(
  ctx: CanvasRenderingContext2D,
  count: number,
  color = '#ffffff',
  seed = 7,
): void {
  const rand = seeded(seed);
  for (let i = 0; i < count; i++) {
    const x = rand() * CARD_W,
      y = rand() * CARD_H * 0.8,
      r = 0.4 + rand() * 1.1;
    ctx.fillStyle = alpha(color, 0.25 + rand() * 0.55);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* -------------------------------------------------------------------------- */
/* 文字                                                                        */
/* -------------------------------------------------------------------------- */

/** 临时加投影执行 draw(小屏文字压渐变会发虚,统一垫一层暗影)。 */
export function shadowed(
  ctx: CanvasRenderingContext2D,
  draw: () => void,
  blur = 6,
  a = 0.45,
  dy = 1,
): void {
  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${a})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = dy;
  draw();
  ctx.restore();
}

/** 二分找最大不超宽字号。 */
export function fitSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxSize: number,
  maxWidth: number,
  font = FONT_CN,
  weight = 'bold',
): number {
  let lo = 8,
    hi = maxSize;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    ctx.font = `${weight} ${mid}px ${font}`;
    if (ctx.measureText(text).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 按宽度截断:先缩字号到 minSize,还超宽就截字符加省略号。
 * 只缩不截会让长名字压到旁边的数字上(排行榜里出现过)。
 */
export function truncateToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize = 9,
): { text: string; size: number } {
  const size = Math.max(minSize, fitSize(ctx, text, maxSize, maxWidth));
  ctx.font = `bold ${size}px ${FONT_CN}`;
  if (ctx.measureText(text).width <= maxWidth) return { text, size };
  // oxlint-disable-next-line unicorn/prefer-spread -- 按码点截断
  const chars = Array.from(text);
  let out = '';
  for (const ch of chars) {
    if (ctx.measureText(`${out}${ch}…`).width > maxWidth) break;
    out += ch;
  }
  return { text: `${out}…`, size };
}

/** 带字距的居中文字(字距让全大写/短标签不那么局促)。 */
export function fillTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  tracking: number,
): void {
  if (!tracking) {
    ctx.textAlign = 'center';
    ctx.fillText(text, cx, y);
    return;
  }
  // oxlint-disable-next-line unicorn/prefer-spread -- 按码点拆字;spread 字符串会被 no-misused-spread 拦
  const chars = Array.from(text);
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  let x = cx - total / 2;
  for (const [i, c] of chars.entries()) {
    ctx.fillText(c, x, y);
    x += (widths[i] ?? 0) + tracking;
  }
  ctx.textAlign = prev;
}

/**
 * 按画布宽度折行(中文按字、西文按词)。
 * 单个"词"本身就超宽时(模型 id、URL 这类没空格的长串)按字符硬拆 ——
 * 否则那一行会直接溢出画布(`bedrock·claude-opus-5` 曾经就是左右都被切掉)。
 */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  // oxlint-disable-next-line unicorn/prefer-spread -- 同上
  const units = /[一-龥]/.test(text) ? Array.from(text) : text.split(/(\s+)/).filter(Boolean);
  const flush = () => {
    if (cur.trim()) lines.push(cur);
    cur = '';
  };
  for (const u of units) {
    if (ctx.measureText(u).width > maxWidth) {
      // 这个词单独就超宽:先收掉当前行,再逐字符切
      flush();
      // oxlint-disable-next-line unicorn/prefer-spread -- 按码点硬拆
      for (const ch of Array.from(u)) {
        if (ctx.measureText(cur + ch).width > maxWidth && cur) flush();
        cur += ch;
      }
      continue;
    }
    if (ctx.measureText(cur + u).width > maxWidth && cur) {
      lines.push(cur);
      cur = u.trim() ? u : '';
    } else {
      cur += u;
    }
  }
  flush();
  return lines;
}

/**
 * 取数日期(MM-DD)的共享注脚 —— 天气主卡 / 用量花费卡 / 额度今日卡各带一份,
 * 回答「这是哪天的数」。卡上只有数字时,放桌上看不出数据新旧。
 *
 * 只要日期不要时间:日期一天才变一次,时间在卡上意义不大(卡不是钟)。
 * MM-DD 短:一个 `body` 块 20px 就放得下,不像「9月16日 周三 16:08」
 * 一整行在 135px 宽的卡上 fitSize 只能收到 9-10px,桌上 50cm 外读不了。
 */
export function dateOf(at: number | Date = Date.now()): string {
  let d = at instanceof Date ? at : new Date(at);
  // 0/undefined/NaN 都是「没有取数时刻」:回落当前时刻,调用方不必再写兜底
  if (!at || Number.isNaN(d.getTime())) d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/** 单行日期+时间(MM-DD HH:mm)。今日额度卡顶栏用:日期即「今日」,时间给取数时刻。 */
export function dateTimeOf(at: number | Date = Date.now()): string {
  let d = at instanceof Date ? at : new Date(at);
  if (!at || Number.isNaN(d.getTime())) d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dateOf(d)} ${hh}:${mm}`;
}

/**
 * 日期注脚块:MM-DD 用 body 档 20px 居中,接到 `stack` 的 blocks 里用。
 * 放在卡片末尾当「这是哪天的数」的落款。sub 色:是落款,不是主角。
 */
export function dateBlock(at: number | Date, p: Palette): Block {
  return {
    kind: 'custom',
    h: 28,
    draw: (ctx, y) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = dateOf(at);
      const size = Math.min(20, fitSize(ctx, text, 20, CARD_W - PAD * 2));
      ctx.font = `bold ${size}px ${FONT_CN}`;
      ctx.fillStyle = p.sub;
      shadowed(ctx, () => fillTracked(ctx, text, CARD_W / 2, y + 14, 1), 4, 0.35, 1);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 装饰件                                                                      */
/* -------------------------------------------------------------------------- */

/** 圆角矩形路径(不依赖 ctx.roundRect 的可用性)。 */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 胶囊标签(元数据一律用它,立刻有版面感)。返回占用高度。 */
export function pill(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  top: number,
  opts: { fg: string; bg: string; size?: number; tracking?: number },
): number {
  const size = opts.size ?? 11;
  ctx.font = `bold ${size}px ${FONT_CN}`;
  const tracking = opts.tracking ?? 0.5;
  // oxlint-disable-next-line unicorn/prefer-spread -- 按码点拆字;spread 字符串会被 no-misused-spread 拦
  const chars = Array.from(text);
  const textW =
    chars.reduce((s, c) => s + ctx.measureText(c).width, 0) + tracking * (chars.length - 1);
  const w = Math.min(CARD_W - PAD * 2, textW + size * 1.6);
  const h = size + 9;
  ctx.fillStyle = opts.bg;
  roundRectPath(ctx, cx - w / 2, top, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = opts.fg;
  ctx.textBaseline = 'middle';
  fillTracked(ctx, text, cx, top + h / 2, tracking);
  return h;
}

/** 细分隔线(短、居中,用来分区)。 */
export function hairline(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  w: number,
  color: string,
): void {
  ctx.fillStyle = alpha(color, 0.55);
  ctx.fillRect(cx - w / 2, y, w, 1);
}

/** 环形进度(0-1),带底轨。 */
export function ring(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  progress: number,
  width: number,
  color: string,
  track: string,
): void {
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.strokeStyle = alpha(track, 0.25);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (progress <= 0) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, progress) * Math.PI * 2);
  ctx.stroke();
}

/** 水平数值条(渐变填充 + 底轨)。marker 给了就在该比例处画一个圆点标出当前值。 */
export function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: number,
  colorA: string,
  colorB: string,
  track: string,
  marker?: number,
): void {
  ctx.fillStyle = alpha(track, 0.22);
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fill();
  const fw = Math.max(h, w * Math.min(1, Math.max(0, fill)));
  const g = ctx.createLinearGradient(x, y, x + fw, y);
  g.addColorStop(0, colorA);
  g.addColorStop(1, colorB);
  ctx.fillStyle = g;
  roundRectPath(ctx, x, y, fw, h, h / 2);
  ctx.fill();
  if (marker !== undefined) {
    const mx = x + w * Math.min(1, Math.max(0, marker));
    shadowed(
      ctx,
      () => {
        ctx.fillStyle = colorB;
        ctx.beginPath();
        ctx.arc(mx, y + h / 2, h * 0.82, 0, Math.PI * 2);
        ctx.fill();
      },
      4,
      0.4,
      1,
    );
  }
}

/**
 * 温度尺:整条是固定的冷→暖底轨,只把 [from, to] 这段点亮。
 * 比"填满 100% 的进度条"有信息量 —— 一眼看出这天是偏冷还是偏热的一段。
 */
export function rangeBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  from: number,
  to: number,
  p: Palette,
): void {
  ctx.fillStyle = alpha(p.fg, 0.18);
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fill();
  const a = Math.min(Math.max(from, 0), 1),
    b = Math.min(Math.max(to, 0), 1);
  const sx = x + w * Math.min(a, b);
  const sw = Math.max(h * 2.6, w * Math.abs(b - a));
  const g = ctx.createLinearGradient(sx, y, sx + sw, y);
  g.addColorStop(0, alpha(p.fg, 0.7));
  g.addColorStop(1, p.fg);
  ctx.fillStyle = g;
  roundRectPath(ctx, sx, y, sw, h, h / 2);
  ctx.fill();
}

/** 方向箭头(风向用),angleDeg 0=向上,顺时针。 */
export function arrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  angleDeg: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.62, size * 0.72);
  ctx.lineTo(0, size * 0.34);
  ctx.lineTo(-size * 0.62, size * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* 版式引擎:三段式垂直堆叠                                                       */
/* -------------------------------------------------------------------------- */

/** 一个排版块。 */
export type Block =
  /** 顶部小标签(自动加字距)。 */
  | { kind: 'label'; text: string; color?: string }
  /** 主体大字(自适应字号,可折行)。 */
  | { kind: 'hero'; text: string; max?: number; color?: string; tracking?: number }
  /** 中号文字。 */
  | { kind: 'body'; text: string; max?: number; color?: string }
  /** 底部注脚小字。 */
  | { kind: 'caption'; text: string; color?: string }
  /** emoji(用 emoji 字体,固定字号)。 */
  | { kind: 'emoji'; text: string; size: number; font: string }
  /** 纯间距。 */
  | { kind: 'gap'; h: number }
  /** 自定义绘制(拿到该块顶部 y 和高度自己画)。 */
  | { kind: 'custom'; h: number; draw: (ctx: CanvasRenderingContext2D, y: number) => void };

interface Measured {
  block: Block;
  h: number;
  lines: string[];
  size: number;
}

const SPEC: Record<
  'label' | 'hero' | 'body' | 'caption',
  { max: number; tracking: number; lh: number }
> = {
  label: { max: 12, tracking: 1.5, lh: 1.2 },
  hero: { max: 62, tracking: 0, lh: 1.12 },
  body: { max: 26, tracking: 0, lh: 1.2 },
  caption: { max: 13, tracking: 0.3, lh: 1.25 },
};

/**
 * 垂直居中堆叠一组块,自动测量、折行、分配间距。
 * gap 是块间基础间距;整体在安全区内垂直居中。
 */
export function stack(
  ctx: CanvasRenderingContext2D,
  blocks: Block[],
  p: Palette,
  opts: { gap?: number; top?: number; bottom?: number } = {},
): void {
  const gap = opts.gap ?? 7;
  const maxW = CARD_W - PAD * 2;
  const measured: Measured[] = blocks.map((block) => {
    if (block.kind === 'gap' || block.kind === 'custom') {
      return { block, h: block.h, lines: [], size: 0 };
    }
    if (block.kind === 'emoji') {
      ctx.font = `${block.size}px ${block.font}`;
      return { block, h: block.size * 1.02, lines: [block.text], size: block.size };
    }
    const spec = SPEC[block.kind];
    const max = 'max' in block && block.max ? block.max : spec.max;
    // 先按不折行找字号,缩得太狠说明该折行:回到较大字号再按宽度折
    let size = fitSize(ctx, block.text, max, maxW);
    let lines = [block.text];
    if (size < max * 0.55 && block.kind !== 'label') {
      size = Math.round(max * 0.72);
      ctx.font = `bold ${size}px ${FONT_CN}`;
      lines = wrap(ctx, block.text, maxW);
      while (lines.length > 3 && size > 12) {
        size -= 3;
        ctx.font = `bold ${size}px ${FONT_CN}`;
        lines = wrap(ctx, block.text, maxW);
      }
    }
    return { block, h: lines.length * size * spec.lh, lines, size };
  });

  const totalH = measured.reduce((s, m) => s + m.h, 0) + gap * (measured.length - 1);
  const areaTop = opts.top ?? PAD;
  const areaH = CARD_H - areaTop - (opts.bottom ?? PAD);
  let y = areaTop + Math.max(0, (areaH - totalH) / 2);
  const cx = CARD_W / 2;

  for (const m of measured) {
    const { block } = m;
    const top = y;
    y += m.h + gap;
    if (block.kind === 'gap') continue;
    if (block.kind === 'custom') {
      block.draw(ctx, top);
      continue;
    }
    if (block.kind === 'emoji') {
      ctx.font = `${block.size}px ${block.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const mid = top + m.h / 2;
      shadowed(ctx, () => ctx.fillText(block.text, cx, mid), 10, 0.35, 2);
      continue;
    }
    const spec = SPEC[block.kind];
    const color =
      block.color ?? (block.kind === 'caption' || block.kind === 'label' ? p.sub : p.fg);
    const tracking =
      block.kind === 'hero' && 'tracking' in block && block.tracking !== undefined
        ? block.tracking
        : spec.tracking;
    ctx.font = `bold ${m.size}px ${FONT_CN}`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    const lineH = m.size * spec.lh;
    for (const [li, line] of m.lines.entries()) {
      const ly = top + lineH * li + lineH / 2;
      shadowed(ctx, () => fillTracked(ctx, line, cx, ly, tracking), 5, 0.4, 1);
    }
  }
}

/**
 * 大数字 + 单位(如 31℃、72%)。
 *
 * 单位单独画而不是和数字拼成一个字符串:`31℃` 直接 fillText 时 ℃ 会跟着大字号走,
 * 又高又挤、基线还偏 —— 拆开画才能各自定字号和垂直位置。
 * 裸度数 `°` 当上标抬高;`℃`/`%` 这类完整单位坐基线(它们自带的圆圈已经在字高上部)。
 */
export function bigMetric(
  ctx: CanvasRenderingContext2D,
  value: string,
  unit: string,
  cx: number,
  cy: number,
  p: Palette,
  maxSize = 76,
): void {
  const superscript = unit === '°';
  const unitSize = Math.round(maxSize * 0.34);
  const gap = superscript ? 3 : 2;
  ctx.font = `bold ${unitSize}px ${FONT_CN}`;
  const unitW = unit ? ctx.measureText(unit).width : 0;
  const size = fitSize(ctx, value, maxSize, CARD_W - PAD * 2 - unitW - gap);
  ctx.font = `bold ${size}px ${FONT_CN}`;
  const valW = ctx.measureText(value).width;
  const totalW = valW + (unit ? unitW + gap : 0);
  const left = cx - totalW / 2;
  const baseline = cy + size * 0.36;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = p.fg;
  shadowed(ctx, () => ctx.fillText(value, left, baseline), 6, 0.4, 1);
  if (unit) {
    ctx.font = `bold ${unitSize}px ${FONT_CN}`;
    ctx.fillStyle = p.sub;
    const uy = superscript ? baseline - size * 0.44 : baseline;
    shadowed(ctx, () => ctx.fillText(unit, left + valW + gap, uy), 4, 0.35, 1);
  }
  ctx.textAlign = 'center';
}

/**
 * 把图片按 cover 方式铺满画布(居中裁剪)。
 * 单独封装是因为 @napi-rs/canvas 的 context 类型缺 drawImage 声明,运行时存在。
 */
export function cover(ctx: CanvasRenderingContext2D, img: { width: number; height: number }): void {
  const targetRatio = CARD_W / CARD_H;
  const srcRatio = img.width / img.height;
  let sx = 0,
    sy = 0,
    cropW = img.width,
    cropH = img.height;
  if (srcRatio > targetRatio) {
    cropW = img.height * targetRatio;
    sx = (img.width - cropW) / 2;
  } else {
    cropH = img.width / targetRatio;
    sy = (img.height - cropH) / 2;
  }
  (
    ctx as unknown as {
      drawImage: (
        i: unknown,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        dw: number,
        dh: number,
      ) => void;
    }
  ).drawImage(img, sx, sy, cropW, cropH, 0, 0, CARD_W, CARD_H);
}
