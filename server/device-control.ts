/**
 * 配方 → 设备帧 / 设备参数下发(服务端渲染)。
 *
 * 与前端 pipeline.ts 平行的服务端版本:常驻自动化(轮播/场景日程/应用配置)
 * 不能依赖页面开着,所以渲染在服务端跑(@napi-rs/canvas,Apple Color Emoji 一步到位)。
 * 前端预览用浏览器渲染器(worker);两边共享 canvas-kit 设计系统与卡片语义,
 * 渲出来的帧「预览 ≈ 屏幕」。
 */
import type { SlotSpec, DeviceControlConfig } from './shared/profile-types.js';
import { slotCapacity } from './shared/profile-types.js';
import { orderWeatherCards } from './shared/weather-cards.js';
import type { IpsDevice } from './lib/device.js';
import {
  renderWeatherCards,
  randomGalleryImages,
  renderCanvasFrames,
  renderAnimationFrames,
  type AnimationType,
  type CanvasFrameSpec,
} from './lib/render.js';
import { getWeather } from './lib/weather.js';
import { getUserGalleryFrames } from './lib/gallery-store.js';

/** 电子立牌槽位(场景日程/轮播推的就是它)。 */
const DIAL_SLOT = 3;

/**
 * 按 SlotSpec 现取内容渲染一整套帧(服务端)。
 *
 * 时序对齐上游内部版的 renderSlotFrames(剥掉用量/额度三分支):
 * 天气(带拖拽顺序)→ 图库/我的图组 → 画布 → 内置动画 → 本地帧(files)。
 * 用量/额度系源(usage/credit/usage-credit)返回空 —— 调用方跳过该槽位;
 * 成员名保留在 SlotSource 里兼容旧配方(读了不崩,推不了内容)。
 */
export async function renderSlotForDevice(
  spec: SlotSpec,
  opts: { weatherRefreshMin?: number } = {},
): Promise<Uint8Array[]> {
  const cap = slotCapacity(DIAL_SLOT);
  switch (spec.source) {
    case 'weather': {
      const weather = await getWeather((spec.city ?? '上海').trim() || '上海', {
        maxAgeMs: (opts.weatherRefreshMin ?? 60) * 60 * 1000,
      });
      // 认用户拖的卡片顺序(存进 spec.weatherCardOrder),没拖过 = 渲染定义顺序
      const cards = orderWeatherCards(renderWeatherCards(weather), spec.weatherCardOrder);
      return cards.slice(0, cap).map((x) => x.image);
    }
    case 'gallery':
      return randomGalleryImages(cap, spec.galleryTheme ?? 'anime');
    case 'user-gallery': {
      if (!spec.userGalleryName) return [];
      const frames = await getUserGalleryFrames(spec.userGalleryName).catch(() => []);
      return frames.slice(0, cap).map((b) => Uint8Array.from(Buffer.from(b, 'base64')));
    }
    case 'canvas': {
      const c = spec.canvas;
      if (!c) return [];
      const bgImage = c.bgBase64 ? Uint8Array.from(Buffer.from(c.bgBase64, 'base64')) : undefined;
      const specs: CanvasFrameSpec[] = Array.from({ length: cap }, (_, i) => {
        const color = c.frameColors[i] ?? { fg: '#ffffff', bgTop: '#0a0a0a', bgBottom: '#1a1a1a' };
        return {
          text: c.frameTexts[i] ?? '',
          fg: color.fg,
          bgTop: color.bgTop,
          bgBottom: color.bgBottom,
          bgImage,
        };
      });
      return renderCanvasFrames(specs);
    }
    case 'animation':
      return renderAnimationFrames(
        (spec.animType ?? 'moon') as AnimationType,
        spec.animTheme ?? '霓虹蓝',
      ).slice(0, cap);
    case 'files':
      // 本地图片无法按配方复现,帧直接存配方里(base64 已裁 135×240)。
      return (spec.frames ?? [])
        .slice(0, cap)
        .map((b) => Uint8Array.from(Buffer.from(b, 'base64')));
    case 'usage':
    case 'credit':
    case 'usage-credit':
      // 用量/额度链已移除:返回空,调用方跳过(成员名保留兼容旧配方)。
      return [];
    default:
      return [];
  }
}

/** 按配置下发设备参数(有值才发;停在 activeSlot)。 */
export async function applyDeviceControl(
  device: IpsDevice | null,
  control: DeviceControlConfig,
  activeSlot?: number,
): Promise<void> {
  if (!device?.connected) return;
  if (typeof control.brightness === 'number') {
    await device.setBrightness(control.brightness);
  }
  if (typeof control.lightMode === 'number') {
    await device.setLightMode(control.lightMode);
  }
  if (control.lightColor) {
    const m = /^#?([0-9a-f]{6})$/i.exec(control.lightColor.trim());
    if (m) {
      const hex = m[1]!;
      await device.setLightColor(
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      );
    }
  }
  if (typeof control.timeFormat !== 'undefined' || control.networkTime !== undefined) {
    await device.setTime({
      timezoneQuarterHours: control.timezoneQuarterHours ?? 32,
      use24Hour: control.timeFormat !== '12',
      useNetworkTime: control.networkTime ?? true,
    });
  }
  if (typeof activeSlot === 'number') {
    await device.setClockStyle(activeSlot);
  }
}
