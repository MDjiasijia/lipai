/**
 * 卡片渲染器:用 @napi-rs/canvas 生成 135×240 JPG,供 AI displayCards 推送到设备。
 *
 * 6 种模板:text / countdown / clock / qrcode / list / heartbeat。
 * 设备爱心样式(style=3)固定展示 6 张图。
 */
import { createCanvas, loadImage, type CanvasRenderingContext2D } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CARD_W,
  CARD_H,
  PAD,
  FONT_CN,
  EMOJI_FONT,
  frame,
  frameAsync,
  backdrop,
  halo,
  stars,
  stack,
  pill,
  hairline,
  ring,
  bar,
  rangeBar,
  arrow,
  bigMetric,
  alpha,
  mix,
  shadowed,
  cover,
  luma,
  dateBlock,
  type Palette,
  type Block,
} from './canvas-kit.js';
import type { WeatherResult } from './weather.js';
import { sunCardCopy, uvAt, weatherStyle } from './weather-view.js';
import type { WeatherCardId } from '../shared/weather-cards.js';

const FRAME_COUNT = 6;

export { CARD_W, CARD_H };

export type Template = 'text' | 'countdown' | 'clock' | 'qrcode' | 'list' | 'heartbeat';
export type RenderMode = 'animation' | 'carousel';

/** 各模板对应的数据。 */
export interface CardData {
  /** text: 要显示的文字(可中文) */
  text?: string;
  /** text: 文字颜色(默认青色 #00d4ff) */
  color?: string;
  /** text: 背景色(默认深蓝 #0d1b2a) */
  bg?: string;
  /** countdown: 起始数字 */
  from?: number;
  /** countdown: 结束数字 */
  to?: number;
  /** clock: 格式 'HH:MM' | 'HH:MM:SS'(默认 HH:MM) */
  format?: string;
  /** qrcode: 二维码内容 */
  qrcode?: string;
  /** list: 6 条文字(不足6条补空,超出截断) */
  items?: string[];
}

/** 画背景(纯色,默认深蓝)。 */
function drawBackground(ctx: CanvasRenderingContext2D, color = '#0d1b2a'): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

/**
 * 居中文字,二分查找适配字号(文字长就缩小,保证不超出边界)。
 * maxWidth 默认 90% 画布宽,留白边。
 */
function drawCenteredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  color = '#00d4ff',
  maxSize = 64,
  font = FONT_CN,
  maxWidth = CARD_W * 0.9,
): void {
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 二分查找最大不超宽的字号
  let lo = 8,
    hi = maxSize;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    ctx.font = `bold ${mid}px ${font}`;
    if (ctx.measureText(text).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  ctx.font = `bold ${lo}px ${font}`;
  ctx.fillText(text, CARD_W / 2, CARD_H / 2);
}

/** 画二维码居中(留白边,填满大部分屏幕)。 */
async function drawQrcode(ctx: CanvasRenderingContext2D, text: string): Promise<void> {
  drawBackground(ctx);
  const dataUrl = await QRCode.toDataURL(text, {
      margin: 0,
      width: 256,
      color: { dark: '#000000', light: '#ffffff' },
    }),
    img = await loadImage(dataUrl),
    // 居中,留 12px 白边
    size = Math.min(CARD_W, CARD_H) - 24,
    x = (CARD_W - size) / 2,
    y = (CARD_H - size) / 2;
  // 白底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - 6, y - 6, size + 12, size + 12);
  // @napi-rs/canvas 的 context 类型缺 drawImage 声明,运行时存在,断言绕过
  (
    ctx as unknown as CanvasRenderingContext2D & {
      drawImage: (img: unknown, x: number, y: number, w: number, h: number) => void;
    }
  ).drawImage(img, x, y, size, size);
}

/** 画爱心(用于 heartbeat 动画和标识)。scale 0-1 控制大小。 */
function drawHeart(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color = '#ff4d6d',
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  const s = size;
  // 爱心路径(贝塞尔)
  ctx.moveTo(cx, cy + s * 0.3);
  ctx.bezierCurveTo(cx, cy, cx - s, cy - s * 0.3, cx - s, cy - s * 0.6);
  ctx.bezierCurveTo(cx - s, cy - s, cx, cy - s, cx, cy - s * 0.3);
  ctx.bezierCurveTo(cx, cy - s, cx + s, cy - s, cx + s, cy - s * 0.6);
  ctx.bezierCurveTo(cx + s, cy - s * 0.3, cx, cy, cx, cy + s * 0.3);
  ctx.closePath();
  ctx.fill();
}

/** 按模板推断 mode(countdown/heartbeat 默认 animation,list 默认 carousel,其余任意)。 */
function inferMode(template: Template): RenderMode {
  if (template === 'countdown' || template === 'heartbeat') return 'animation';
  if (template === 'list') return 'carousel';
  return 'carousel';
}

/**
 * 按 template + data 渲染 6 张 135×240 JPG。
 * 返回 Uint8Array[](6 张)。
 */
export async function renderCards(
  template: Template,
  data: CardData,
  mode?: RenderMode,
): Promise<Uint8Array[]> {
  const m = mode ?? inferMode(template),
    frames: Uint8Array[] = [];

  switch (template) {
    case 'text': {
      // 6 张同文字(稳定显示)。或 carousel 时可传 items?text 单文字就6张相同。
      const text = data.text ?? '',
        color = data.color ?? '#00d4ff',
        bg = data.bg ?? '#0d1b2a';
      for (let i = 0; i < FRAME_COUNT; i++) {
        frames.push(
          frame((ctx) => {
            drawBackground(ctx, bg);
            drawCenteredText(ctx, text, color, 56);
          }),
        );
      }
      break;
    }
    case 'countdown': {
      // 6 帧倒计时:from → to 均分6步
      const from = data.from ?? 6,
        to = data.to ?? 1,
        step = (from - to) / (FRAME_COUNT - 1);
      for (let i = 0; i < FRAME_COUNT; i++) {
        const n = Math.round(from - step * i);
        frames.push(
          frame((ctx) => {
            drawBackground(ctx, '#1a0a14');
            drawCenteredText(ctx, String(n), '#ff4d6d', 80);
          }),
        );
      }
      break;
    }
    case 'clock': {
      // 实时时钟:6 帧,每帧隔 10 秒(显示当前时间 + 未来 10/20/30/40/50 秒)
      // 简化:6 张相同当前时间(设备固定展示,屏上就是当前时间);或显示秒数递增
      const format = data.format ?? 'HH:MM',
        now = new Date();
      for (let i = 0; i < FRAME_COUNT; i++) {
        const t = new Date(now.getTime() + i * 10000),
          hh = String(t.getHours()).padStart(2, '0'),
          mm = String(t.getMinutes()).padStart(2, '0'),
          ss = String(t.getSeconds()).padStart(2, '0'),
          text = format === 'HH:MM:SS' ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
        frames.push(
          frame((ctx) => {
            drawBackground(ctx, '#0d1b2a');
            drawCenteredText(ctx, text, '#00d4ff', 48);
          }),
        );
      }
      break;
    }
    case 'qrcode': {
      // 6 张相同二维码(稳定显示)
      const text = data.qrcode ?? data.text ?? '';
      for (let i = 0; i < FRAME_COUNT; i++) {
        frames.push(await frameAsync((ctx) => drawQrcode(ctx, text)));
      }
      break;
    }
    case 'list': {
      // 6 条不同文字轮播(每条一帧),不足补空,超出截断
      const items = (data.items ?? []).slice(0, FRAME_COUNT);
      while (items.length < FRAME_COUNT) items.push('');
      for (const item of items) {
        frames.push(
          frame((ctx) => {
            drawBackground(ctx, '#0d1b2a');
            drawCenteredText(ctx, item || '·', '#00d4ff', 40);
          }),
        );
      }
      break;
    }
    case 'heartbeat': {
      // 6 帧心跳动画:爱心大小脉动
      const sizes = [0.5, 0.7, 0.9, 1, 0.8, 0.6];
      for (const scale of sizes) {
        frames.push(
          frame((ctx) => {
            drawBackground(ctx, '#1a0a14');
            drawHeart(ctx, CARD_W / 2, CARD_H / 2, 45 * scale, '#ff4d6d');
          }),
        );
      }
      break;
    }
    default: {
      throw new Error(`未知模板: ${template}`);
    }
  }

  // mode 仅用于语义标注(countdown/heartbeat 动画,list 轮播);实际都返回6张
  void m;
  return frames;
}

/* -------------------------------------------------------------------------- */
/* 天气卡片(专用渲染:大字 + emoji + 多行 + 配色背景)                            */
/* -------------------------------------------------------------------------- */

/** 风向 → 罗盘角度(箭头指向风吹去的方向 = 来向 +180°)。 */
const WIND_DEG: Record<string, number> = {
  N: 0,
  NNE: 22,
  NE: 45,
  ENE: 67,
  E: 90,
  ESE: 112,
  SE: 135,
  SSE: 157,
  S: 180,
  SSW: 202,
  SW: 225,
  WSW: 247,
  W: 270,
  WNW: 292,
  NW: 315,
  NNW: 337,
};

/** WHO UV 指数档:弱 / 中等 / 强 / 很强 / 极强。 */
function uvLabel(uv: number): string {
  if (uv < 3) return '弱';
  if (uv < 6) return '中等';
  if (uv < 8) return '强';
  if (uv < 11) return '很强';
  return '极强';
}

/**
 * 渲染天气卡片:主卡 / 温度 / 湿度 / 风,外加有数据才出的 UV / 降水 / 日出月相 / 明天 / 后天。
 * 顺序 = 当天的事在前(降水/日照),预报(明天/后天)在最后。
 *
 * 返回全部卡(含末尾补位概览卡,凑满 6 张)。槽位容量 6 张由调用方截断;
 * 预览和轮播都取前 6 张,两边对齐 —— 补位卡只是凑数,不单独去重。
 *
 * 设计要点(针对原版"6 张一个模子"的问题):
 * - 背景由**天气状况**决定(晴天蓝 / 雨湿青 / 雷紫 / 雪冰蓝 / 雾灰褐),气温只轻推冷暖;
 *   预报卡用各自那天的状况,所以「明天会下雨」看颜色就知道。
 * - 每张各有主体:大 emoji / 超大数字 / 环形湿度 / 风向箭头 / 温区间条 —— 有图形就不再靠堆文字。
 * - 数字与单位拆开画(`31` + 独立字号的 `℃`):拼成一个字符串时 ℃ 会跟着大字号走,又高又挤。
 */
export function renderWeatherCards(
  weather: WeatherResult,
): { id: WeatherCardId; image: Uint8Array }[] {
  const c = weather.current;
  const cur = weatherStyle(c.descCn, c.tempC);
  const p = cur.palette;
  const today = weather.forecast[0];
  const astro = weather.astronomy;
  const rainChance = weather.chanceOfRain;
  // UV 按此刻从小时序列插值,不吃取数那一档。没序列才回落 current.uvIndex。
  // 取整后再画:轮播 30 秒换卡时环的连续插值不会每轮都改 JPEG(否则蓝牙白传)。
  // 0 也出卡(夜里「弱」):以前 >0 才出,日落后整张紫外线从预览和前 6 槽消失。
  const uvNow = uvAt(weather.uvHourly) ?? (Number.isFinite(c.uvIndex) ? c.uvIndex : null);
  const uv = uvNow != null && Number.isFinite(uvNow) ? Math.max(0, Math.round(uvNow)) : null;
  const windDirCn: Record<string, string> = {
    N: '北风',
    S: '南风',
    E: '东风',
    W: '西风',
    NE: '东北风',
    NW: '西北风',
    SE: '东南风',
    SW: '西南风',
    NNE: '东北风',
    ENE: '东北风',
    ESE: '东南风',
    SSE: '东南风',
    SSW: '西南风',
    WSW: '西南风',
    WNW: '西北风',
    NNW: '西北风',
  };
  const cards: { id: WeatherCardId; image: Uint8Array }[] = [];
  // add(id, draw):渲染一帧并带上稳定语义 ID。ID 让拖拽顺序能跨刷新/轮播对齐同一张卡。
  const add = (id: WeatherCardId, draw: (ctx: CanvasRenderingContext2D) => void): void => {
    cards.push({ id, image: frame(draw) });
  };

  // 1. 主卡:城市胶囊 + 大 emoji(带光晕)+ 天气描述 + 补充注脚 + 日期落款
  add('main', (ctx) => {
    backdrop(ctx, p);
    halo(ctx, CARD_W / 2, CARD_H * 0.38, CARD_W * 0.72, p.accent, 0.42);
    stack(
      ctx,
      [
        {
          kind: 'custom',
          h: 21,
          draw: (c2, y) => {
            pill(c2, c.city, CARD_W / 2, y, { fg: p.bgB, bg: alpha(p.fg, 0.9), size: 11 });
          },
        },
        { kind: 'emoji', text: cur.icon, size: 66, font: EMOJI_FONT },
        { kind: 'body', text: c.descCn, max: 27 },
        { kind: 'custom', h: 1, draw: (c2, y) => hairline(c2, CARD_W / 2, y, 34, p.sub) },
        // 补充注脚只留温度卡没有的:温度/体感都在温度卡专行,主卡不重复。
        // UV 只在 ≥5(该防的时候)才提;降水有量才提。
        (() => {
          const bits: string[] = [];
          if (uv != null && uv >= 5) bits.push(`UV ${Math.round(uv)}`);
          if (Number.isFinite(c.precipMm) && c.precipMm > 0) bits.push(`${c.precipMm}mm`);
          return bits.length
            ? { kind: 'caption' as const, text: bits.join(' · ') }
            : { kind: 'gap' as const, h: 1 };
        })(),
        // 取数日期(MM-DD)落款:桌上分不清这是哪天的数 —— 日期回答。
        // 用取数时刻而不是渲染时刻:缓存命中(默认 2h)时如实显示数据多新。
        dateBlock(weather.fetchedAt ?? 0, p),
      ],
      p,
      { gap: 8 },
    );
  });

  // 2. 温度:超大数字 + 今日温区间条(当前温度在区间里的位置)
  add('temp', (ctx) => {
    backdrop(ctx, p);
    const lo = today?.minTempC ?? c.tempC - 4;
    const hi = today?.maxTempC ?? c.tempC + 4;
    const fill = hi > lo ? (c.tempC - lo) / (hi - lo) : 0.5;
    stack(
      ctx,
      [
        { kind: 'label', text: `气温 · ${cur.tempLabel}` },
        {
          kind: 'custom',
          h: 84,
          draw: (c2, y) => bigMetric(c2, String(c.tempC), '℃', CARD_W / 2, y + 42, p, 86),
        },
        {
          kind: 'custom',
          h: 7,
          draw: (c2, y) =>
            bar(
              c2,
              PAD + 8,
              y,
              CARD_W - (PAD + 8) * 2,
              7,
              fill,
              alpha(p.fg, 0.55),
              p.fg,
              p.fg,
              fill,
            ),
        },
        { kind: 'caption', text: `今日 ${lo}–${hi}℃` },
        { kind: 'caption', text: `体感 ${c.feelsLikeC}℃` },
      ],
      p,
      { gap: 9 },
    );
  });

  // 3. 湿度:环形进度 + 环心百分比(比 💧emoji + 数字有信息量)
  add('humidity', (ctx) => {
    backdrop(ctx, p);
    stack(
      ctx,
      [
        { kind: 'label', text: '湿度' },
        {
          kind: 'custom',
          h: 104,
          draw: (c2, y) => {
            const cx = CARD_W / 2,
              cy = y + 52;
            ring(c2, cx, cy, 43, c.humidity / 100, 9, p.fg, p.bgB);
            c2.font = `bold 34px ${FONT_CN}`;
            c2.fillStyle = p.fg;
            c2.textAlign = 'center';
            c2.textBaseline = 'middle';
            shadowed(c2, () => c2.fillText(String(c.humidity), cx, cy - 2), 5, 0.4, 1);
            c2.font = `bold 13px ${FONT_CN}`;
            c2.fillStyle = p.sub;
            c2.fillText('%', cx, cy + 22);
          },
        },
        { kind: 'caption', text: c.humidity >= 80 ? '潮湿' : c.humidity >= 55 ? '舒适' : '干燥' },
      ],
      p,
      { gap: 10 },
    );
  });

  // 4. 风:风向箭头(按罗盘角度旋转)+ 风速
  add('wind', (ctx) => {
    backdrop(ctx, p);
    const deg = (WIND_DEG[c.windDir] ?? 0) + 180;
    stack(
      ctx,
      [
        { kind: 'label', text: '风' },
        {
          kind: 'custom',
          h: 62,
          draw: (c2, y) => {
            const cx = CARD_W / 2,
              cy = y + 31;
            c2.fillStyle = alpha(p.bgB, 0.42);
            c2.beginPath();
            c2.arc(cx, cy, 30, 0, Math.PI * 2);
            c2.fill();
            shadowed(c2, () => arrow(c2, cx, cy, 21, deg, p.fg), 6, 0.35, 1);
          },
        },
        {
          kind: 'custom',
          h: 52,
          draw: (c2, y) => bigMetric(c2, String(c.windKmh), '', CARD_W / 2, y + 26, p, 54),
        },
        { kind: 'caption', text: `km/h · ${windDirCn[c.windDir] ?? c.windDir}` },
      ],
      p,
      { gap: 8 },
    );
  });

  // 5. UV:紧接风后面,保证进前 6 槽。夜里 0 也出(「弱」),不是整张消失。
  // 6. 降水 / 7. 日照(有数据才出),8/9. 明天 / 后天 —— 顺序见 WEATHER_CARD_DEFS 注释。
  // 环按 0–11 归一(WHO 极强档),环心显整数。
  if (uv != null) {
    add('uv', (ctx) => {
      backdrop(ctx, p);
      stack(
        ctx,
        [
          { kind: 'label', text: '紫外线' },
          {
            kind: 'custom',
            h: 104,
            draw: (c2, y) => {
              const cx = CARD_W / 2,
                cy = y + 52;
              ring(c2, cx, cy, 43, Math.min(uv / 11, 1), 9, p.fg, p.bgB);
              c2.font = `bold 34px ${FONT_CN}`;
              c2.fillStyle = p.fg;
              c2.textAlign = 'center';
              c2.textBaseline = 'middle';
              shadowed(c2, () => c2.fillText(String(Math.round(uv)), cx, cy - 2), 5, 0.4, 1);
              c2.font = `bold 13px ${FONT_CN}`;
              c2.fillStyle = p.sub;
              c2.fillText('UV', cx, cy + 22);
            },
          },
          { kind: 'caption', text: uvLabel(uv) },
        ],
        p,
        { gap: 10 },
      );
    });
  }

  // 降水:有降雨量或降雨概率才出。一张卡一件事 —— 大数字是降雨量,概率写 caption。
  if ((Number.isFinite(c.precipMm) && c.precipMm > 0) || (rainChance != null && rainChance > 0)) {
    const mm = Number.isFinite(c.precipMm) ? c.precipMm : 0;
    add('precip', (ctx) => {
      backdrop(ctx, p);
      stack(
        ctx,
        [
          { kind: 'label', text: '降水' },
          {
            kind: 'custom',
            h: 84,
            draw: (c2, y) =>
              bigMetric(
                c2,
                mm > 0 ? String(mm) : String(rainChance ?? 0),
                mm > 0 ? 'mm' : '%',
                CARD_W / 2,
                y + 42,
                p,
                72,
              ),
          },
          {
            kind: 'caption',
            text:
              mm > 0 && rainChance != null
                ? `降雨概率 ${rainChance}%`
                : mm > 0
                  ? '今日累计'
                  : `降雨概率 ${rainChance}%`,
          },
        ],
        p,
        { gap: 9 },
      );
    });
  }

  // 日照:日落前讲今日几点落 + 月相;日落后预告下一场日出。不是把升和落并排写死。
  const sun = astro ? sunCardCopy(astro, { tomorrowSunrise: weather.tomorrowSunrise }) : null;
  if (sun) {
    add('sun', (ctx) => {
      backdrop(ctx, p);
      halo(ctx, CARD_W / 2, CARD_H * 0.38, CARD_W * 0.7, p.accent, 0.28);
      stack(
        ctx,
        [
          { kind: 'label', text: sun.label },
          { kind: 'emoji', text: sun.emoji, size: 44, font: EMOJI_FONT },
          {
            kind: 'custom',
            h: 60,
            draw: (c2, y) => bigMetric(c2, sun.time, '', CARD_W / 2, y + 30, p, 42),
          },
          { kind: 'caption', text: sun.caption },
        ],
        p,
        { gap: 7 },
      );
    });
  }

  // 明天 / 后天:各自按当天状况取色,下雨就是湿青、出太阳就是天蓝。
  // 排在当天的事(降水/日照)之后 —— 6 张挤不下时先挤掉后天,不是今天日落。
  for (const [i, f] of [weather.forecast[1], weather.forecast[2]].entries()) {
    if (!f) continue;
    const fs = weatherStyle(f.descCn, f.maxTempC);
    const fp = fs.palette;
    add(i === 0 ? 'tomorrow' : 'day-after', (ctx) => {
      backdrop(ctx, fp);
      stack(
        ctx,
        [
          {
            kind: 'custom',
            h: 21,
            draw: (c2, y) => {
              pill(c2, i === 0 ? '明天' : '后天', CARD_W / 2, y, {
                fg: fp.bgB,
                bg: alpha(fp.fg, 0.9),
                size: 11,
              });
            },
          },
          { kind: 'emoji', text: fs.icon, size: 54, font: EMOJI_FONT },
          { kind: 'body', text: f.descCn, max: 23 },
          {
            kind: 'custom',
            h: 7,
            // 温度尺:固定 -10~40℃ 刻度上点亮这天的区间,不同日子条长条位不同
            draw: (c2, y) =>
              rangeBar(
                c2,
                PAD + 8,
                y,
                CARD_W - (PAD + 8) * 2,
                7,
                (f.minTempC + 10) / 50,
                (f.maxTempC + 10) / 50,
                fp,
              ),
          },
          { kind: 'caption', text: `${f.minTempC}–${f.maxTempC}℃` },
        ],
        fp,
        { gap: 8 },
      );
    });
  }

  // 不足 6 张才补概览(预报缺天 / 没有 UV·降水·日照)。有额外真卡时通常已满,不会垫重复主卡。
  // 槽位要 6 张:少推的帧位会留着上一套旧图。轮播和预览都取前 6 张,补位卡两边一致。
  while (cards.length < FRAME_COUNT) {
    add('overview', (ctx) => {
      backdrop(ctx, p);
      halo(ctx, CARD_W / 2, CARD_H * 0.42, CARD_W * 0.7, p.accent, 0.35);
      stack(
        ctx,
        [
          { kind: 'label', text: c.city },
          { kind: 'emoji', text: cur.icon, size: 58, font: EMOJI_FONT },
          {
            kind: 'custom',
            h: 60,
            draw: (c2, y) => bigMetric(c2, String(c.tempC), '℃', CARD_W / 2, y + 30, p, 62),
          },
        ],
        p,
        { gap: 8 },
      );
    });
  }
  return cards;
}

/* -------------------------------------------------------------------------- */
/* 精美图库(public/gallery/,随机选图裁剪推送)                                    */
/* -------------------------------------------------------------------------- */

/** gallery 目录绝对路径(扩展根 public/gallery/)。theme 指定时返回主题子目录(anime/animals)。 */
function galleryDir(theme?: string): string {
  const base = path.join(process.cwd(), 'src', 'assets', 'gallery');
  return theme ? path.join(base, theme) : base;
}

/** 列出 gallery 主题子目录名(如 ['anime','nature','abstract'])。 */
export function listGalleryThemes(): string[] {
  try {
    return readdirSync(galleryDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** 列出某主题(或全部)的图片文件名。theme 省略时列根目录散装图。 */
export function listGalleryImages(theme?: string): string[] {
  try {
    return readdirSync(galleryDir(theme))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 给已渲染的帧图片底部加帧序号角标(0-9)。
 * 用于非电子立牌模式:设备每秒切一帧,角标 0-9 正好当秒数指示,兼用时钟功能。
 *
 * 为什么是「底部大数字 + 10 格进度条」而不是右上角小圆牌:
 * 屏幕 135×240 摆在桌上 ~50cm 远看,原来的 14px 数字基本认不出。改成
 * - 底部一条自下而上的渐变带打底,任何底图(浅色天空 / 花瓣)上都能压住,不糊字
 * - 左侧 34px 粗体数字,远看能直接读秒
 * - 右侧 10 格进度条亮到第 N 格,数字糊掉时靠「亮条长度」也能数出秒
 * 只占底部 ~34px(画面 14%),人物主体在中上部,不会被遮。
 */
export async function stampFrameNumber(image: Uint8Array, index: number): Promise<Uint8Array> {
  const img = await loadImage(Buffer.from(image));
  const canvas = createCanvas(CARD_W, CARD_H),
    ctx = canvas.getContext('2d');
  // 先画原图(应为 135×240,兜底缩放)
  ctx.drawImage(img, 0, 0, CARD_W, CARD_H);

  const n = ((index % 10) + 10) % 10; // 负数下标也归一到 0-9
  const bandH = 34;
  const bandY = CARD_H - bandH;

  // ① 底部渐变带:下沉到全黑,上缘透明 —— 有硬边会像贴了张卡片,渐变才像画面自带的暗角
  const g = ctx.createLinearGradient(0, bandY, 0, CARD_H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = g;
  ctx.fillRect(0, bandY, CARD_W, bandH);

  // ② 左侧大号数字(带投影:压在亮底图上时白字边缘会发虚)
  const label = String(n);
  ctx.font = `bold 34px ${FONT_CN}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const baseline = CARD_H - 7;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(label, PAD - 3 + 1.5, baseline + 1.5);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, PAD - 3, baseline);

  // ③ 右侧 10 格进度条:亮到第 n 格(n=0 时全灭 —— 归零那一帧本身就是「重新开始」)
  //    5 格一组留个宽间隙(像尺子的中线):9 格和 8 格远看长得一样,分组后一眼看出「过半没过半」
  const cellGap = 1.5;
  const groupGap = 4;
  const barX = PAD + 28;
  const barW = CARD_W - barX - PAD + 3;
  const cellW = (barW - cellGap * 8 - (groupGap - cellGap)) / 10;
  const cellH = 9;
  const cellY = CARD_H - 18;
  for (let i = 0; i < 10; i++) {
    const x = barX + i * (cellW + cellGap) + (i >= 5 ? groupGap - cellGap : 0);
    const lit = i < n;
    // 灭格描边而非纯色块:纯半透明格子压在亮底图(满月)上会被吃掉,看着像只有几格
    ctx.fillStyle = lit ? '#ffffff' : 'rgba(255,255,255,0.14)';
    roundRect(ctx, x, cellY, cellW, cellH, 1.5);
    ctx.fill();
    if (!lit) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, cellY + 0.5, cellW - 1, cellH - 1, 1.5);
      ctx.stroke();
    }
  }
  return canvas.toBuffer('image/jpeg');
}

/** 画圆角矩形路径(不填充,调用方 fill/stroke)。 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 读取 gallery 图片并裁剪为 135×240(cover 模式,居中填充)→ Uint8Array JPG。 */
export async function cropGalleryImage(name: string, theme?: string): Promise<Uint8Array> {
  const filePath = path.join(galleryDir(theme), name);
  const buf = await readFile(filePath);
  const img = await loadImage(buf);
  const sw = img.width;
  const sh = img.height;
  // cover:取最大居中裁剪区(目标比例 135:240 = 9:16)
  const targetRatio = CARD_W / CARD_H;
  const srcRatio = sw / sh;
  let sx = 0,
    sy = 0,
    cropW = sw,
    cropH = sh;
  if (srcRatio > targetRatio) {
    // 源更宽,左右裁剪
    cropW = sh * targetRatio;
    sx = (sw - cropW) / 2;
  } else {
    // 源更高,上下裁剪
    cropH = sw / targetRatio;
    sy = (sh - cropH) / 2;
  }
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, CARD_W, CARD_H);
  return canvas.toBuffer('image/jpeg');
}

/** 按顺序取 count 张某主题图片(文件名排序,不随机),裁剪为 135×240,返回 Uint8Array[]。theme 省略取 anime。 */
export async function randomGalleryImages(count: number, theme = 'anime'): Promise<Uint8Array[]> {
  const names = listGalleryImages(theme).map((name) => ({ name, theme }));
  if (names.length === 0) throw new Error('gallery 图片库为空');
  // 按文件名排序取前 count 张(稳定顺序,风格统一)
  const picked = names.slice(0, count);
  // 不足 count 时从另一主题补足(避免重复同主题图),仍不足才循环重复
  const otherTheme = theme === 'anime' ? 'animals' : 'anime';
  const extras = listGalleryImages(otherTheme).map((name) => ({ name, theme: otherTheme }));
  const fallback = [...picked, ...extras];
  const result: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const p = fallback[i] ?? picked[i % picked.length];
    if (!p) break;
    // oxlint-disable-next-line no-await-in-loop -- 串行裁剪,避免并发内存峰值
    result.push(await cropGalleryImage(p.name, p.theme));
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* 自由画布渲染(文字 + 配色 + 可选背景图,6 帧)                                    */
/* -------------------------------------------------------------------------- */

/** 自由画布帧配置:文字 + 配色(渐变背景)+ 可选背景图。 */
export interface CanvasFrameSpec {
  text: string;
  fg: string;
  bgTop: string;
  bgBottom: string;
  bgImage?: Uint8Array;
}

/** 是否单个 emoji(含图形字符且 UTF-16 长度 ≤ 2 = BMP 字符或单个 surrogate pair)。 */
function isSingleEmoji(v: string): boolean {
  return /\p{Extended_Pictographic}/u.test(v) && v.length <= 2;
}

/** 按字数分级主字号:单字要够大、长句要收得住(原来固定 36px,短字小得可怜、长句挤成三行)。 */
function heroSizeFor(text: string): number {
  const t = text.trim();
  // oxlint-disable-next-line unicorn/prefer-spread -- 按码点计数;spread 字符串会被 no-misused-spread 拦
  const n = Array.from(t).length;
  // 拉丁字母比方块字窄得多,同样字数可以给更大字号(fitSize 兜底不会超宽)
  const latin = !/[一-龥]/.test(t) ? 1.45 : 1;
  const base =
    n <= 1 ? 92 : n === 2 ? 78 : n === 3 ? 66 : n === 4 ? 54 : n <= 6 ? 46 : n <= 9 ? 38 : 31;
  return Math.round(base * latin);
}

/**
 * 文字帧的共享排版:主字 + (≥3 字时)下方一条 accent 短线。
 * 「自由画布」和「自定义序列」共用它 —— 两者本来就是同一件事(文字 → 帧),
 * 视觉必须一致,UI 上才好合并成一个来源。
 */
function textBlocks(text: string, p: Palette): Block[] {
  // oxlint-disable-next-line unicorn/prefer-spread -- 按码点计数
  const n = Array.from(text.trim()).length;
  const blocks: Block[] = [{ kind: 'hero', text, max: heroSizeFor(text), color: p.fg }];
  if (n >= 3) {
    blocks.push(
      { kind: 'gap', h: 1 },
      {
        kind: 'custom',
        h: 3,
        draw: (c2, y) => {
          c2.fillStyle = alpha(p.fg, 0.8);
          c2.fillRect(CARD_W / 2 - 11, y, 22, 3);
        },
      },
    );
  }
  return blocks;
}

/** 由用户挑的三个颜色推出完整 Palette(sub/accent 自动派生)。 */
function canvasPalette(spec: CanvasFrameSpec): Palette {
  const bgA = spec.bgTop || '#0a0a0a';
  const bgB = spec.bgBottom || '#1a1a1a';
  const fg = spec.fg || '#ffffff';
  return { bgA, bgB, fg, sub: mix(fg, bgB, 0.42), accent: fg };
}

/**
 * 渲染自由画布 N 帧(N = specs 长度,上限 10)。emojiSubject 定义在下方动画一节(函数声明提升)。
 *
 * 相比原版:字号按字数分级、行距放宽、文字带投影、加一条 accent 装饰线,
 * 背景图改用「底部渐深」蒙层(图的上半保持清晰,文字压在暗部)而不是整张压 35% 黑。
 */
export async function renderCanvasFrames(specs: CanvasFrameSpec[]): Promise<Uint8Array[]> {
  const count = Math.min(Math.max(specs.length, 1), 10);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const spec = specs[i] ?? { text: '', fg: '#ffffff', bgTop: '#0a0a0a', bgBottom: '#1a1a1a' };
    const p = canvasPalette(spec);
    const text = (spec.text ?? '').trim();
    // oxlint-disable-next-line no-await-in-loop -- 串行渲染避免并发内存峰值
    frames.push(
      await frameAsync(async (ctx) => {
        if (spec.bgImage) {
          cover(ctx, await loadImage(spec.bgImage));
          // 底部渐深蒙层:文字区域压暗保证可读,图上半留清晰
          const scrim = ctx.createLinearGradient(0, 0, 0, CARD_H);
          scrim.addColorStop(0, 'rgba(0,0,0,0.10)');
          scrim.addColorStop(0.45, 'rgba(0,0,0,0.30)');
          scrim.addColorStop(1, 'rgba(0,0,0,0.58)');
          ctx.fillStyle = scrim;
          ctx.fillRect(0, 0, CARD_W, CARD_H);
          // 文字区再压一层柔和暗斑:浅色背景图上白字光靠整体蒙层还是发飘
          if (text) {
            const seat = ctx.createRadialGradient(
              CARD_W / 2,
              CARD_H / 2,
              4,
              CARD_W / 2,
              CARD_H / 2,
              CARD_W * 0.85,
            );
            seat.addColorStop(0, 'rgba(0,0,0,0.46)');
            seat.addColorStop(0.6, 'rgba(0,0,0,0.2)');
            seat.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = seat;
            ctx.fillRect(0, 0, CARD_W, CARD_H);
          }
        } else {
          backdrop(ctx, p);
        }
        if (!text) return;
        // 单个 emoji:大字号 + 光晕(与内置动画/序列同一套处理),不是当普通文字排版
        if (isSingleEmoji(text)) {
          emojiSubject(ctx, text, CARD_W / 2, CARD_H / 2, 104, p.accent, 0.36);
          return;
        }
        stack(ctx, textBlocks(text, p), p, { gap: 8 });
      }),
    );
  }
  return frames;
}

/* -------------------------------------------------------------------------- */
/* 数字时钟图片(0-9,10 张,推到 style 1/2 自定义数字时钟)                        */
/* -------------------------------------------------------------------------- */

/**
 * 内置配色主题(数字时钟 / 动画 / 序列共用)。
 * 每个主题给完整 Palette:背景两端 + 三级前景,渲染器不再各自猜 sub/accent。
 */
const THEMES: Record<string, Palette> = {
  霓虹蓝: { bgA: '#123a63', bgB: '#070d1f', fg: '#7ee8ff', sub: '#8fb6cf', accent: '#39c6ff' },
  暖橙: { bgA: '#ffa552', bgB: '#8f2c07', fg: '#fff6ea', sub: '#ffd3a8', accent: '#ffcf7a' },
  赛博紫: { bgA: '#4a1078', bgB: '#0c0524', fg: '#ff9bf5', sub: '#b48ad6', accent: '#c04bff' },
  薄荷绿: { bgA: '#2fbfa8', bgB: '#054a42', fg: '#f2fffb', sub: '#a8e6d8', accent: '#7df0d0' },
  极简白: { bgA: '#ffffff', bgB: '#c3ced4', fg: '#16232b', sub: '#5b6b75', accent: '#8fa6b2' },
  樱粉: { bgA: '#ffa3bd', bgB: '#a33b62', fg: '#fff5f8', sub: '#ffd0de', accent: '#ff8fb4' },
};

/** 取主题 Palette(未知名回落霓虹蓝)。 */
function themePalette(theme: string): Palette {
  return THEMES[theme] ?? THEMES['霓虹蓝']!;
}

/** 渲染 10 张数字图(0-9),用于自定义数字时钟槽位。返回 Uint8Array[10]。 */
export function renderDigitImages(theme = '霓虹蓝'): Uint8Array[] {
  const p = themePalette(theme);
  const frames: Uint8Array[] = [];
  for (let n = 0; n <= 9; n++) {
    frames.push(
      frame((ctx) => {
        backdrop(ctx, p);
        halo(ctx, CARD_W / 2, CARD_H / 2, CARD_W * 0.62, p.accent, 0.3);
        ctx.fillStyle = p.fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `bold 128px ${FONT_CN}`;
        shadowed(ctx, () => ctx.fillText(String(n), CARD_W / 2, CARD_H / 2), 12, 0.45, 2);
      }),
    );
  }
  return frames;
}

/** 列出数字时钟配色主题名。 */
export function listDigitThemes(): string[] {
  return Object.keys(THEMES);
}

/* -------------------------------------------------------------------------- */
/* 10 帧动画(推到 style 1/2,设备每秒切一帧,10 秒循环)                          */
/* -------------------------------------------------------------------------- */

/** 动画类型:月亮圆缺 / 火箭发射 / 猫咪探头 / 爱心脉动 / 星星旋转 / 弹球跳跃 / 进度环 / 倒数计数。 */
export type AnimationType =
  | 'moon'
  | 'rocket'
  | 'cat'
  | 'heart'
  | 'star'
  | 'ball'
  | 'progress'
  | 'countdown';

/** 主体 emoji:先垫光晕再画,带投影 —— 不然 emoji 像贴纸浮在背景上。 */
function emojiSubject(
  ctx: CanvasRenderingContext2D,
  char: string,
  cx: number,
  cy: number,
  size: number,
  glow: string,
  glowStrength = 0.42,
): void {
  halo(ctx, cx, cy, size * 0.95, glow, glowStrength);
  ctx.font = `${size}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  shadowed(ctx, () => ctx.fillText(char, cx, cy), 12, 0.4, 3);
}

/** 地面色带(弹球/猫咪这类需要"站在什么上面"的场景)。 */
function ground(ctx: CanvasRenderingContext2D, y: number, p: Palette): void {
  // 用前景色的低透明度做地面:比原来"越往下越暗"更能和背景分开,影子也才压得出来
  const g = ctx.createLinearGradient(0, y, 0, CARD_H);
  g.addColorStop(0, alpha(p.fg, 0.06));
  g.addColorStop(1, alpha(p.fg, 0.2));
  ctx.fillStyle = g;
  ctx.fillRect(0, y, CARD_W, CARD_H - y);
  ctx.fillStyle = alpha(p.fg, 0.3);
  ctx.fillRect(0, y, CARD_W, 1);
}

/**
 * 渲染 10 帧动画(设备每秒切一帧 = 10 秒循环)。
 *
 * 相比原版:每种动画有自己的场景(星空 / 地面 / 光晕 / 环形轨道),不再是 8 种动画同一个深蓝底;
 * emoji 带光晕和投影;弹球影子改成暗色(原来在深蓝底上完全看不见);
 * 猫咪改成从底部探头(原来从右边缘探出,第 1 帧只剩半条尾巴,像渲染 bug)。
 */
export function renderAnimationFrames(type: AnimationType, theme = '霓虹蓝'): Uint8Array[] {
  const p = themePalette(theme);
  const frames: Uint8Array[] = [];
  const cx = CARD_W / 2,
    cy = CARD_H / 2;
  const dark = luma(p.bgB) < 0.5;

  for (let i = 0; i < 10; i++) {
    const t = i / 10; // 循环进度 0~0.9
    const pingpong = 0.5 - 0.5 * Math.cos(t * Math.PI * 2); // 0→1→0
    frames.push(
      frame((ctx) => {
        backdrop(ctx, p);

        switch (type) {
          case 'moon': {
            if (dark) stars(ctx, 34, p.fg, 11);
            const phases = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒'];
            // 满月最亮,朔月几乎不发光
            const lit = [0.05, 0.2, 0.4, 0.6, 0.85, 0.6, 0.4, 0.2, 0.05, 0.2][i] ?? 0.4;
            emojiSubject(ctx, phases[i] ?? '🌕', cx, cy, 106, p.accent, lit * 0.7);
            break;
          }
          case 'rocket': {
            if (dark) stars(ctx, 26, p.fg, 5);
            const y = CARD_H - 34 - t * (CARD_H - 78);
            const wobble = Math.sin(t * Math.PI * 4) * 5;
            // 发射台微光
            halo(ctx, cx, CARD_H - 6, CARD_W * 0.62, p.accent, 0.22);
            if (i < 9) {
              ctx.font = `${34 + (i % 3) * 7}px ${EMOJI_FONT}`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('🔥', cx + wobble * 1.3, y + 42);
            }
            emojiSubject(ctx, '🚀', cx + wobble, y, 68, p.accent, 0.3);
            break;
          }
          case 'cat': {
            // 从底边完整探出再缩回。不画地面带:地面线会横穿猫身,像渲染坏了。
            // 起手留 0.14 的探出量:pingpong 从 0 开始会有 1~2 帧整屏空白
            const y = CARD_H + 34 - (0.14 + 0.86 * pingpong) * 150;
            emojiSubject(ctx, '🐱', cx, y, 92, p.accent, 0.26);
            break;
          }
          case 'heart': {
            const size = Math.round(66 + 62 * pingpong);
            // 脉动扩散环
            ctx.lineWidth = 2;
            ctx.strokeStyle = alpha(p.fg, 0.3 * (1 - pingpong));
            ctx.beginPath();
            ctx.arc(cx, cy, 44 + pingpong * 44, 0, Math.PI * 2);
            ctx.stroke();
            emojiSubject(ctx, '❤️', cx, cy, size, p.accent, 0.28 + pingpong * 0.4);
            break;
          }
          case 'star': {
            if (dark) stars(ctx, 22, p.fg, 3);
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(t * Math.PI * 2);
            halo(ctx, 0, 0, 78, p.accent, 0.4);
            ctx.font = `96px ${EMOJI_FONT}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            shadowed(ctx, () => ctx.fillText('✨', 0, 0), 12, 0.35, 0);
            ctx.restore();
            break;
          }
          case 'ball': {
            const gy = CARD_H - 46;
            ground(ctx, gy, p);
            const hop = 4 * t * (1 - t); // 0→1→0 抛物线
            const R = 30;
            const y = gy - R - hop * 96; // 最低点球底正好贴地面线
            // 影子画在地面带上:用黑色 + 地面带已提亮,才真的看得见
            ctx.fillStyle = `rgba(0,0,0,${0.42 - hop * 0.26})`;
            ctx.beginPath();
            ctx.ellipse(cx, gy + 8, 25 - hop * 13, 5.5 - hop * 2.5, 0, 0, Math.PI * 2);
            ctx.fill();
            emojiSubject(ctx, '⚽', cx, y, R * 2, p.accent, 0.2);
            break;
          }
          case 'progress': {
            const prog = (i + 1) / 10;
            ring(ctx, cx, cy, 52, prog, 11, p.fg, p.fg);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `bold 34px ${FONT_CN}`;
            ctx.fillStyle = p.fg;
            shadowed(
              ctx,
              () => ctx.fillText(String(Math.round(prog * 100)), cx, cy - 3),
              6,
              0.4,
              1,
            );
            ctx.font = `bold 13px ${FONT_CN}`;
            ctx.fillStyle = p.sub;
            ctx.fillText('%', cx, cy + 24);
            break;
          }
          case 'countdown': {
            const n = 10 - i;
            ring(ctx, cx, cy, 58, n / 10, 6, alpha(p.fg, 0.8), p.fg);
            halo(ctx, cx, cy, 66, p.accent, 0.3);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `bold ${n >= 10 ? 74 : 92}px ${FONT_CN}`;
            ctx.fillStyle = p.fg;
            shadowed(ctx, () => ctx.fillText(String(n), cx, cy), 12, 0.45, 2);
            break;
          }
          default: {
            break;
          }
        }
      }),
    );
  }
  return frames;
}

/** 列出动画类型。 */
export function listAnimationTypes(): AnimationType[] {
  return ['moon', 'rocket', 'cat', 'heart', 'star', 'ball', 'progress', 'countdown'];
}

/**
 * 渲染自定义序列动画:每帧一个 emoji 或一段文字。
 * emoji 帧 = 大 emoji + 光晕;文字帧 = 与「自由画布」同一套排版(装饰线 + 分级字号),
 * 两者视觉语言一致,所以 UI 上这两个来源可以合成一个。
 * 不足 10 帧用最后一个补齐,超过截断。
 */
export function renderCustomEmojiFrames(cells: string[], theme = '霓虹蓝'): Uint8Array[] {
  const p = themePalette(theme);
  const seq: string[] = Array.from({ length: 10 }, (_, i) => {
    const e = cells[i];
    return e?.trim() ? e.trim() : (cells.at(-1) ?? '⭐');
  });
  const cx = CARD_W / 2,
    cy = CARD_H / 2;
  return seq.map((cell, i) => {
    const emojiCell = isSingleEmoji(cell);
    // 文字帧:背景在 10 帧间来回渐变,连播时有流动感(emoji 帧不动,emoji 自带颜色)
    const f = i / 9;
    const framePalette: Palette = emojiCell
      ? p
      : { ...p, bgA: mix(p.bgA, p.bgB, f * 0.65), bgB: mix(p.bgB, p.bgA, f * 0.35) };
    return frame((ctx) => {
      backdrop(ctx, framePalette);
      if (emojiCell) {
        emojiSubject(ctx, cell, cx, cy, 104, p.accent, 0.36);
        return;
      }
      stack(ctx, textBlocks(cell, framePalette), framePalette, { gap: 8 });
    });
  });
}
