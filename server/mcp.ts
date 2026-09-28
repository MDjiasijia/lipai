/**
 * MCP(Model Context Protocol)工具集:/mcp 端点(Streamable HTTP)。
 *
 * 从上游内部版的 toolset 平移:本地工具没有宿主 —— 用户自己的 agent(Claude Code/
 * Cursor/任意 MCP 客户端)配 http://127.0.0.1:5176/mcp 即可调用。生图配合生图工具
 * (雪碧图 5×2 → save_sprite_gallery 裁 10 帧)与控制/传图/轮播/配置全套。
 *
 * 与 ext 版的差异:
 * - 工具 schema 用 JSON Schema 字面量(按协议直接给;服务端运行时再校验)。
 * - 用量/额度系工具(依赖内部 AI 平台)已剔除;usage-credit 轮播源保留成员名
 *   (轮到空池跳过,见 loop.ts)。
 * - 工具实现直接绑 server/runtime + lib/*(ext 版经 exposes 间接层,这里不需要)。
 */
import * as rt from './runtime.js';
import * as store from './lib/profile-store.js';
import * as gallery from './lib/gallery-store.js';
import {
  getWeather,
  getCachedWeather,
  listCities,
  cityToLocationId,
} from './lib/weather.js';
import {
  renderCards,
  renderWeatherCards,
  randomGalleryImages,
  listGalleryImages,
  listGalleryThemes,
  renderCanvasFrames,
  renderDigitImages,
  listDigitThemes,
  renderAnimationFrames,
  listAnimationTypes,
  renderCustomEmojiFrames,
  type CardData,
  type Template,
} from './lib/render.js';
import {
  listColorThemes,
  listCanvasTopics,
  generateCanvasTextsImpl,
  generateCanvasColorsImpl,
} from './lib/canvas-gen.js';
import {
  listLibrary,
  addToLibrary,
  getLibraryFile,
  bumpDownload,
  deleteLibraryItem,
  toggleStar,
  importLibraryItem,
} from './library.js';

/** int 便捷构造器。 */
const int = (min?: number, max?: number) => ({
  type: 'integer',
  ...(min !== undefined ? { minimum: min } : {}),
  ...(max !== undefined ? { maximum: max } : {}),
});

/** 工具定义 = {name, description, inputSchema}。 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /** 实现:args → 结果(JSON 可序列化)。 */
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const b64All = (images: Uint8Array[]) => images.map(b64);

function requireDevice() {
  const device = rt.getDevice();
  if (!device?.connected) throw new Error('设备未连接:先调 connect');
  return device;
}

/* ---------------- 工具实现(按 toolset 分组) ---------------- */

const connectionTools: McpToolDef[] = [
  {
    name: 'check_environment',
    description: '检测蓝牙二进制与桥是否就绪(控制设备前先调)',
    handler: () => rt.checkEnvironment(),
  },
  {
    name: 'list_devices',
    description:
      '扫描匹配设备名前缀的设备,返回 [{name,address}](不连接;有多个设备时先调这个再选择)',
    handler: async () => ({ devices: await rt.scanDevices() }),
  },
  {
    name: 'connect',
    description:
      '连接设备。可选 address/name(支持设备码如 31C2C6;有多个设备时先 list_devices)。autoConnect=true 时设备掉线自动重连(5/10/20/30s 退避)',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        name: { type: 'string' },
        autoConnect: { type: 'boolean' },
      },
    },
    handler: async (a) => {
      const info = await rt.connectDevice({
        address: a.address ? String(a.address) : undefined,
        name: a.name ? String(a.name) : undefined,
        autoConnect: a.autoConnect === undefined ? true : Boolean(a.autoConnect),
      });
      return info;
    },
  },
  {
    name: 'disconnect',
    description: '断开设备(默认视为用户主动,不触发自动重连)',
    handler: async (a) => {
      await rt.disconnectDevice(a.userInitiated === false ? false : true);
      return { ok: true };
    },
  },
  {
    name: 'get_connection',
    description: '查当前连接状态与设备信息(含桥运行状态)',
    handler: () => {
      const device = rt.getDevice();
      return {
        ...device?.getInfo(),
        bridge: rt.bridgeStatus(),
        autoConnect: rt.autoConnectStatus(),
      };
    },
  },
  {
    name: 'read_status',
    description: '读取设备固件/硬件/IP/MAC/存储/亮度/样式(设备回包进通信日志)',
    handler: async () => {
      const device = requireDevice();
      await device.readStatus();
      return device.getInfo();
    },
  },
  {
    name: 'set_raw_command',
    description:
      '发任意命令号的裸帧(协议探测/实验用)。command 0-255,payload 可选字节数组。响应进通信日志',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: int(0, 255),
        payload: { type: 'array', items: int(0, 255) },
      },
    },
    handler: async (a) => {
      const device = requireDevice();
      await device.sendRaw(
        Number(a.command),
        Array.isArray(a.payload) ? a.payload.map(Number) : [],
      );
      return { sent: true };
    },
  },
];

const deviceControlTools: McpToolDef[] = [
  {
    name: 'set_brightness',
    description: '设置亮度(0-100)',
    inputSchema: { type: 'object', required: ['value'], properties: { value: int(0, 100) } },
    handler: async (a) => {
      await requireDevice().setBrightness(Number(a.value));
      return { ok: true };
    },
  },
  {
    name: 'set_clock_style',
    description: '设置当前显示槽位(0=默认时钟 1=数字时钟一 2=数字时钟二 3=电子立牌)',
    inputSchema: { type: 'object', required: ['style'], properties: { style: int(0, 3) } },
    handler: async (a) => {
      await requireDevice().setClockStyle(Number(a.style));
      return { ok: true };
    },
  },
  {
    name: 'set_light_mode',
    description: '设置灯效(0=关 1=静态 2=追逐 3=彩虹)',
    inputSchema: { type: 'object', required: ['mode'], properties: { mode: int(0, 3) } },
    handler: async (a) => {
      await requireDevice().setLightMode(Number(a.mode));
      return { ok: true };
    },
  },
  {
    name: 'set_light_color',
    description: '设置 RGB 灯色(0-255 × 3)',
    inputSchema: {
      type: 'object',
      required: ['r', 'g', 'b'],
      properties: { r: int(0, 255), g: int(0, 255), b: int(0, 255) },
    },
    handler: async (a) => {
      await requireDevice().setLightColor(Number(a.r), Number(a.g), Number(a.b));
      return { ok: true };
    },
  },
  {
    name: 'set_time',
    description: '同步时区/时间格式/时间戳到设备',
    inputSchema: {
      type: 'object',
      required: ['timezoneQuarterHours', 'use24Hour', 'useNetworkTime'],
      properties: {
        timezoneQuarterHours: int(),
        use24Hour: { type: 'boolean' },
        useNetworkTime: { type: 'boolean' },
        timestamp: int(),
      },
    },
    handler: async (a) => {
      await requireDevice().setTime({
        timezoneQuarterHours: Number(a.timezoneQuarterHours ?? 32),
        use24Hour: a.use24Hour !== false,
        useNetworkTime: a.useNetworkTime !== false,
        timestamp: a.timestamp ? Number(a.timestamp) : undefined,
      });
      return { ok: true };
    },
  },
  {
    name: 'set_weather',
    description: '设置设备原生天气显示(QWeather Location ID;设备天气服务异常时用 display_weather 替代)',
    inputSchema: {
      type: 'object',
      required: ['enabled', 'locationId', 'fahrenheit'],
      properties: {
        enabled: { type: 'boolean' },
        locationId: { type: 'string' },
        fahrenheit: { type: 'boolean' },
      },
    },
    handler: async (a) => {
      await requireDevice().setWeather({
        enabled: Boolean(a.enabled),
        locationId: String(a.locationId ?? ''),
        fahrenheit: Boolean(a.fahrenheit),
      });
      return { ok: true };
    },
  },
  {
    name: 'set_weather_by_city',
    description: '按城市名下发设备原生天气配置(城市名→QWeather Location ID 映射)',
    inputSchema: {
      type: 'object',
      required: ['city'],
      properties: {
        city: { type: 'string' },
        enabled: { type: 'boolean' },
        fahrenheit: { type: 'boolean' },
      },
    },
    handler: async (a) => {
      const city = String(a.city ?? '').trim();
      const locationId = cityToLocationId(city);
      if (!locationId) {
        throw new Error(`城市「${city}」没有对应的 Location ID;可用城市调 list_cities`);
      }
      await requireDevice().setWeather({
        enabled: a.enabled === undefined ? true : Boolean(a.enabled),
        locationId,
        fahrenheit: Boolean(a.fahrenheit),
      });
      return { city, locationId };
    },
  },
  {
    name: 'configure_wifi',
    description: '下发 Wi-Fi 凭据(SSID 仅支持 ASCII;密码不落盘)',
    inputSchema: {
      type: 'object',
      required: ['ssid', 'password'],
      properties: { ssid: { type: 'string' }, password: { type: 'string' } },
    },
    handler: async (a) => {
      await requireDevice().configureWifi(String(a.ssid ?? ''), String(a.password ?? ''));
      return { ok: true };
    },
  },
  {
    name: 'set_firmware_address',
    description: '下发固件升级地址(必须 HTTPS;设备自行 OTA)',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    handler: async (a) => {
      await requireDevice().setFirmwareAddress(String(a.url ?? ''));
      return { ok: true };
    },
  },
  {
    name: 'reboot',
    description: '重启设备',
    handler: async () => {
      await requireDevice().reboot();
      return { ok: true };
    },
  },
  {
    name: 'factory_reset',
    description: '恢复出厂设置(会清除设备 Wi-Fi 与显示配置)',
    handler: async () => {
      await requireDevice().factoryReset();
      return { ok: true };
    },
  },
];

/* ---------------- 传图(设备推送) ---------------- */

/**
 * 传图走「任务」形状:sendImage 10-20 秒,MCP 工具调用可能超时 ——
 * 后台跑 + progress 事件走 SSE;工具立即返回 taskId,
 * agent 用 get_transfer_progress 轮询或订阅 /api/events 的 imageProgress。
 */
interface TransferProgress {
  status: 'running' | 'done' | 'error';
  done: number;
  total: number;
  error?: string;
}
const transfers = new Map<string, TransferProgress>();
let transferSeq = 0;

function runTransfer(slot: number, images: Uint8Array[]): string {
  const taskId = `t-${Date.now().toString(36)}-${++transferSeq}`;
  const progress: TransferProgress = { status: 'running', done: 0, total: images.length };
  transfers.set(taskId, progress);
  const device = rt.getDevice();
  void (async () => {
    try {
      if (!device?.connected) throw new Error('设备未连接');
      await device.sendImage(images, slot, (done, total) => {
        progress.done = done;
        progress.total = total;
        rt.reportImageProgress({ taskId, status: 'running', done, total });
      });
      progress.status = 'done';
      rt.reportImageProgress({ ...progress, taskId, status: 'done' });
    } catch (err) {
      progress.status = 'error';
      progress.error = err instanceof Error ? err.message : String(err);
      rt.reportImageProgress({ ...progress, taskId, status: 'error' });
    }
  })();
  return taskId;
}

const imageTools: McpToolDef[] = [
  {
    name: 'start_image_transfer',
    description:
      '蓝牙传图(后台任务,返回 taskId)。images=base64 JPG 数组(已裁剪 135×240),slot=0-3。进度走 get_transfer_progress 或 SSE /api/events 的 imageProgress',
    inputSchema: {
      type: 'object',
      required: ['images', 'slot'],
      properties: { images: { type: 'array', items: { type: 'string' } }, slot: int(0, 3) },
    },
    handler: (a) => {
      const images = (a.images as string[]).map((b) => Uint8Array.from(Buffer.from(b, 'base64')));
      return { taskId: runTransfer(Number(a.slot ?? 3), images) };
    },
  },
  {
    name: 'get_transfer_progress',
    description: '查传图进度(status=running/done/error)',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    handler: (a) => {
      const p = transfers.get(String(a.taskId));
      if (!p) throw new Error('任务不存在(可能已过期)');
      return { taskId: a.taskId, ...p };
    },
  },
];

/* ---------------- 渲染 + 推送(内容生成) ---------------- */

const renderTools: McpToolDef[] = [
  {
    name: 'display_cards',
    description:
      '按模板生成 6 张卡并推送到设备电子立牌槽位(固定展示)。template: text=大字/countdown=倒计时/clock=时钟/qrcode=二维码/list=6 条轮播/heartbeat=心跳动画。data 按模板填(text/countdown/clock 用 text+color;qrcode 用 qrcode;list 用 items+color;见 description 示例)',
    inputSchema: {
      type: 'object',
      required: ['template'],
      properties: {
        template: {
          type: 'string',
          enum: ['text', 'countdown', 'clock', 'qrcode', 'list', 'heartbeat'],
        },
        data: { type: 'object' },
        mode: { type: 'string', enum: ['animation', 'carousel'] },
      },
    },
    handler: async (a) => {
      requireDevice();
      const frames = await renderCards(
        a.template as Template,
        (a.data ?? {}) as CardData,
        a.mode as 'animation' | 'carousel' | undefined,
      );
      return { taskId: runTransfer(3, frames), count: frames.length };
    },
  },
  {
    name: 'get_weather_info',
    description: '查真实天气(Open-Meteo 免 Key),返回完整数据(不渲染不推送)',
    inputSchema: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } },
    handler: (a) => getWeather(String(a.city ?? '上海')),
  },
  {
    name: 'get_weather_cards',
    description:
      '查真实天气并渲染卡片(主卡/气温/湿度/风 + 紫外线/降水/日照;明天/后天排最后),返回 base64 数组。refresh=true 跳过缓存。只渲染不推送;确认效果后 start_image_transfer 推送',
    inputSchema: {
      type: 'object',
      required: ['city'],
      properties: { city: { type: 'string' }, refresh: { type: 'boolean' } },
    },
    handler: async (a) => {
      const city = String(a.city ?? '上海');
      const weather = a.refresh
        ? await getWeather(city)
        : (getCachedWeather(city) ?? await getWeather(city));
      return { cards: b64All(renderWeatherCards(weather).map((c) => c.image)) };
    },
  },
  {
    name: 'display_weather',
    description:
      '查真实天气并推送到设备电子立牌(6 张:城市天气/温度体感/湿度/风,有数据时还有紫外线/降水/日照,明天/后天排最后)。AI 说「显示北京天气」→ display_weather({city:"北京"})',
    inputSchema: { type: 'object', required: ['city'], properties: { city: { type: 'string' } } },
    handler: async (a) => {
      requireDevice();
      const weather = await getWeather(String(a.city ?? '上海'));
      const images = renderWeatherCards(weather)
        .slice(0, 6)
        .map((c) => c.image);
      return { taskId: runTransfer(3, images), city: a.city, count: images.length };
    },
  },
  {
    name: 'list_cities',
    description: '列出支持的城市名(天气/设备原生天气用)',
    handler: () => ({ cities: listCities() }),
  },
  {
    name: 'push_random_gallery',
    description:
      '推送精美图库 6 张(anime=动画人物/animals=可爱动物)到电子立牌固定展示。按文件名排序固定顺序。AI 说「显示动画人物」→ push_random_gallery({theme:"anime"})',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['anime', 'animals'] },
        count: int(),
      },
    },
    handler: async (a) => {
      requireDevice();
      const images = await randomGalleryImages(
        Math.min(Number(a.count ?? 6), 6),
        (a.theme as 'anime' | 'animals') ?? 'anime',
      );
      return { taskId: runTransfer(3, images), count: images.length };
    },
  },
  {
    name: 'get_random_gallery',
    description: '取精美图库图渲染(不推送)。theme=anime/animals,count 默认 6',
    inputSchema: {
      type: 'object',
      properties: { theme: { type: 'string', enum: ['anime', 'animals'] }, count: int() },
    },
    handler: async (a) => ({
      images: b64All(
        await randomGalleryImages(
          Math.min(Number(a.count ?? 6), 6),
          (a.theme as 'anime' | 'animals') ?? 'anime',
        ),
      ),
    }),
  },
  {
    name: 'list_gallery',
    description: '列出内置图库的主题与图片名',
    inputSchema: { type: 'object', properties: { theme: { type: 'string' } } },
    handler: (a) => {
      const themes = listGalleryThemes();
      if (a.theme) {
        return { themes, images: listGalleryImages(String(a.theme)) };
      }
      return { themes, images: themes.map((t) => ({ theme: t, images: listGalleryImages(t) })) };
    },
  },
  {
    name: 'generate_canvas_texts',
    description:
      '生成 6 句趣味文案(自由画布 6 帧用)。topic 给主题(打工人日常/疯狂星期四/猫猫语录/早安问候…,省略随机)。返回 {lines:[6]}',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    handler: (a) => generateCanvasTextsImpl(String(a.topic ?? '')),
  },
  {
    name: 'generate_canvas_colors',
    description:
      '生成画布配色建议(6 组渐变)。theme 给主题(暗夜/暖阳/极简白/赛博朋克/薄荷/樱花/海洋/日落…,省略随机)。返回 {palettes:[{fg,bgTop,bgBottom}×6]}',
    inputSchema: { type: 'object', properties: { theme: { type: 'string' } } },
    handler: (a) => generateCanvasColorsImpl(String(a.theme ?? '')),
  },
  {
    name: 'list_canvas_topics',
    description: '列出画布文案主题库',
    handler: () => ({ topics: listCanvasTopics() }),
  },
  {
    name: 'list_color_themes',
    description: '列出配色主题名(画布/动画/数字钟通用)',
    handler: () => ({ themes: listColorThemes() }),
  },
  {
    name: 'render_canvas_and_push',
    description:
      'AI 一键渲染+推送自由画布到电子立牌:text_topic 文案主题 + color_theme 配色主题(均省略随机),bg_theme(anime/animals)时从图库随机选一张作 6 帧统一背景。「配个暗夜风打工人日常」→ render_canvas_and_push({text_topic:"打工人日常",color_theme:"暗夜"})',
    inputSchema: {
      type: 'object',
      properties: {
        text_topic: { type: 'string' },
        color_theme: { type: 'string' },
        bg_theme: { type: 'string', enum: ['anime', 'animals'] },
      },
    },
    handler: async (a) => {
      requireDevice();
      const texts = generateCanvasTextsImpl(String(a.text_topic ?? ''));
      const colors = generateCanvasColorsImpl(String(a.color_theme ?? ''));
      let bgImage: Uint8Array | undefined;
      if (a.bg_theme) {
        const [first] = await randomGalleryImages(1, a.bg_theme as 'anime' | 'animals');
        bgImage = first;
      }
      const specs = texts.lines.slice(0, 6).map((text, i) => {
        const palette = colors.palettes[i] ?? colors.palettes[0]!;
        return {
          text,
          fg: palette.fg,
          bgTop: palette.bgTop,
          bgBottom: palette.bgBottom,
          bgImage,
        };
      });
      const frames = await renderCanvasFrames(specs);
      return {
        taskId: runTransfer(3, frames),
        count: frames.length,
        lines: texts.lines,
        topic: texts.topic,
      };
    },
  },
  {
    name: 'push_digit_clock',
    description:
      '推送数字时钟:渲染 0-9 十帧推到 style 1/2。theme 配色(霓虹蓝/暖橙/赛博紫/薄荷绿/极简白/樱粉),style 默认 1。推送后自动切到该 style',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string' },
        style: { type: 'integer', enum: [1, 2] },
      },
    },
    handler: async (a) => {
      requireDevice();
      const style = a.style === 2 ? 2 : 1;
      const frames = renderDigitImages(String(a.theme ?? '霓虹蓝'));
      return { taskId: runTransfer(style, frames), style, count: frames.length };
    },
  },
  {
    name: 'list_digit_themes',
    description: '列出数字时钟配色主题名',
    handler: () => ({ themes: listDigitThemes() }),
  },
  {
    name: 'push_animation',
    description:
      '推送 10 帧动画到 style 0/1/2(设备每秒切一帧,10 秒循环)。type: moon/rocket/cat/heart/star/ball/progress/countdown。theme 配色(霓虹蓝/暖橙/赛博紫/薄荷绿/极简白/樱粉)。推送后自动切换',
    inputSchema: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['moon', 'rocket', 'cat', 'heart', 'star', 'ball', 'progress', 'countdown'],
        },
        theme: { type: 'string' },
        style: { type: 'integer', enum: [0, 1, 2] },
      },
    },
    handler: async (a) => {
      requireDevice();
      const style = [0, 1, 2].includes(Number(a.style)) ? Number(a.style) : 1;
      const frames = renderAnimationFrames(
        a.type as Parameters<typeof renderAnimationFrames>[0],
        String(a.theme ?? '霓虹蓝'),
      );
      return { taskId: runTransfer(style, frames), style, count: frames.length };
    },
  },
  {
    name: 'list_animation_types',
    description: '列出动画类型',
    handler: () => ({ types: listAnimationTypes() }),
  },
  {
    name: 'get_animation_preview',
    description: '渲染动画 10 帧返回 base64(不推送,不需连接)。type/theme 同 push_animation',
    inputSchema: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['moon', 'rocket', 'cat', 'heart', 'star', 'ball', 'progress', 'countdown'],
        },
        theme: { type: 'string' },
      },
    },
    handler: (a) => ({
      images: b64All(
        renderAnimationFrames(
          a.type as Parameters<typeof renderAnimationFrames>[0],
          String(a.theme ?? '霓虹蓝'),
        ),
      ),
    }),
  },
  {
    name: 'get_custom_animation_preview',
    description:
      '渲染自定义序列动画(每帧一个 emoji/文字)返回 base64(不推送)。emojis 内容数组(不足 10 补齐、超过截断),theme 配色',
    inputSchema: {
      type: 'object',
      required: ['emojis'],
      properties: { emojis: { type: 'array', items: { type: 'string' } }, theme: { type: 'string' } },
    },
    handler: (a) => ({
      images: b64All(
        renderCustomEmojiFrames(a.emojis as string[], String(a.theme ?? '霓虹蓝')),
      ),
    }),
  },
  {
    name: 'push_custom_animation',
    description:
      '推送自定义序列动画到 style 0/1/2:每帧一个 emoji/文字,设备每秒切一帧。可拼表情包序列或逐字动画(如「加」「油」「打」「工」「人」)。推送后自动切换',
    inputSchema: {
      type: 'object',
      required: ['emojis'],
      properties: {
        emojis: { type: 'array', items: { type: 'string' } },
        theme: { type: 'string' },
        style: { type: 'integer', enum: [0, 1, 2] },
      },
    },
    handler: async (a) => {
      requireDevice();
      const style = [0, 1, 2].includes(Number(a.style)) ? Number(a.style) : 1;
      const frames = renderCustomEmojiFrames(a.emojis as string[], String(a.theme ?? '霓虹蓝'));
      return { taskId: runTransfer(style, frames), style, count: frames.length };
    },
  },
];

/* ---------------- 轮播 ---------------- */

const loopTools: McpToolDef[] = [
  {
    name: 'start_loop',
    description:
      '启动轮播循环(常驻,页面关掉照跑)。steps 两类:①数字 0-3=切到该槽位(毫秒级)②源名=现取内容推一套 6 张到电子立牌(蓝牙 10-20 秒):weather 天气卡/gallery 精美图库/user-gallery 我的图组/frames 字符序列(usage-credit 已移除,轮到跳过)。可混排: [\'weather\',1,3]=天气卡→默认时钟→电子立牌。intervalSec 间隔(有推图步下限 30,纯切槽位下限 1)。city/weatherRefreshMin(天气源,30-240 分钟)、galleryTheme、userGalleryName、frames 同理。内容没变时自动跳过重传(指纹去重)。设备断连自动暂停、重连续播',
    inputSchema: {
      type: 'object',
      required: ['steps', 'intervalSec'],
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              { type: 'integer', minimum: 0, maximum: 3 },
              {
                type: 'string',
                enum: ['weather', 'gallery', 'user-gallery', 'frames', 'usage-credit'],
              },
            ],
          },
        },
        intervalSec: int(1),
        city: { type: 'string' },
        galleryTheme: { type: 'string', enum: ['anime', 'animals'] },
        userGalleryName: { type: 'string' },
        frames: { type: 'array', items: { type: 'string' } },
        weatherRefreshMin: int(30, 240),
      },
    },
    handler: (a) =>
      rt.startLoop({
        steps: ((a.steps as (number | string)[]) ?? ['weather']) as never,
        intervalSec: Number(a.intervalSec ?? 60),
        city: a.city ? String(a.city) : undefined,
        galleryTheme: a.galleryTheme as 'anime' | 'animals' | undefined,
        userGalleryName: a.userGalleryName ? String(a.userGalleryName) : undefined,
        frames: a.frames ? (a.frames as string[]) : undefined,
        weatherRefreshMin: a.weatherRefreshMin ? Number(a.weatherRefreshMin) : undefined,
      }),
  },
  { name: 'stop_loop', description: '停止轮播循环', handler: () => rt.stopLoop() },
  {
    name: 'get_loop_state',
    description:
      '查轮播状态(status=running/preparing/paused/stopped/error、steps、currentIdx、intervalSec、rounds、lastAction)',
    handler: () => rt.getLoopState(),
  },
];

/* ---------------- 场景日程 ---------------- */

const sceneTools: McpToolDef[] = [
  {
    name: 'get_scene_schedule',
    description: '查场景日程(时刻表:每天到点推一套内容到电子立牌,时段结束切回默认时钟)',
    handler: () => rt.sceneState(),
  },
  {
    name: 'put_scene_schedule',
    description:
      '设置场景日程并立即生效。schedule: {enabled, slots:[{id, time:"HH:MM", daysOfWeek?:[0-6], durationMin?, label?, spec?:{source,city?,...}, enabled?}]}。slots 按 time 升序对齐;spec.source: weather/gallery/user-gallery/canvas/files。常驻(服务重启自动拉起)',
    inputSchema: {
      type: 'object',
      required: ['schedule'],
      properties: { schedule: { type: 'object' } },
    },
    handler: async (a) => {
      await rt.updateSceneSchedule(a.schedule as never);
      return rt.sceneState();
    },
  },
];

/* ---------------- 配置 / 图组 ---------------- */

const profileTools: McpToolDef[] = [
  { name: 'list_profiles', description: '列出所有显示配置(轻量)', handler: () => store.listProfiles() },
  {
    name: 'read_profile',
    description: '读单个配置完整内容',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: (a) => store.readProfile(String(a.id ?? '')),
  },
  { name: 'get_current_profile', description: '读当前配置', handler: () => store.getCurrentProfile() },
  {
    name: 'save_profile',
    description: '保存配置(新建或更新;新建用 create_profile 更顺手)',
    inputSchema: { type: 'object', required: ['profile'], properties: { profile: { type: 'object' } } },
    handler: async (a) => {
      const profile = a.profile as Parameters<typeof store.writeProfile>[0];
      await store.writeProfile(profile);
      return { id: profile.id };
    },
  },
  {
    name: 'create_profile',
    description: '新建空白配置(名字必填),返回完整配置',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    handler: (a) => store.createProfile(String(a.name ?? '新配置')),
  },
  {
    name: 'delete_profile',
    description: '删除配置(默认配置不可删)',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: async (a) => {
      await store.deleteProfile(String(a.id ?? ''));
      return { ok: true };
    },
  },
  {
    name: 'apply_profile',
    description: '按配置逐槽渲染+推送到设备(先 connect)。进度走 SSE slotApply',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: async (a) => {
      const profile = await store.readProfile(String(a.id ?? ''));
      if (!profile) throw new Error('配置不存在');
      return rt.applyProfileToDevice(profile);
    },
  },
  {
    name: 'export_profile',
    description: '导出配置为 v2 分享 JSON(带依赖图组;可发给别人的本地库/分享站)',
    inputSchema: {
      type: 'object',
      properties: { profileIds: { type: 'array', items: { type: 'string' } } },
    },
    handler: async (a) => {
      const ids = (a.profileIds as string[] | undefined) ?? null;
      const picked = ids?.length ? ids : [await store.readCurrentProfileId()];
      const result = await store.exportProfiles(picked, { withPreview: false });
      return { json: JSON.parse(result.json) };
    },
  },
  {
    name: 'import_profile',
    description: '导入 v2 分享 JSON(生成新 id;带图组依赖自动落盘)',
    inputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'string' } } },
    handler: (a) => store.importProfiles(String(a.data ?? '')),
  },
];

const galleryTools: McpToolDef[] = [
  {
    name: 'save_sprite_gallery',
    description:
      '雪碧图图组:把 AI 生成的 5×2 网格大图裁成 10 帧存入用户图组(~/.lipai/gallery/<name>/)。解决人物一致性(同一人物 10 个姿势/数字 0-9)。用生图工具(text2img)生成 1280×2048 大图后调此方法。sprite_base64 无 data: 前缀',
    inputSchema: {
      type: 'object',
      required: ['name', 'sprite_base64'],
      properties: {
        name: { type: 'string' },
        sprite_base64: { type: 'string' },
        source_prompt: { type: 'string' },
      },
    },
    handler: (a) =>
      gallery.saveSpriteGallery(
        String(a.name ?? ''),
        String(a.sprite_base64 ?? ''),
        5,
        2,
        a.source_prompt ? String(a.source_prompt) : undefined,
      ),
  },
  { name: 'list_user_galleries', description: '列出所有用户图组(含内置预设标记)', handler: () => gallery.listAllGalleries() },
  {
    name: 'get_user_gallery_frames',
    description: '读图组所有帧返回 base64 数组',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    handler: async (a) => ({ frames: await gallery.getUserGalleryFrames(String(a.name ?? '')) }),
  },
  {
    name: 'save_user_gallery',
    description: '从 base64 帧数组创建图组(手动多图)',
    inputSchema: {
      type: 'object',
      required: ['name', 'frames'],
      properties: {
        name: { type: 'string' },
        frames: { type: 'array', items: { type: 'string' } },
        source_prompt: { type: 'string' },
      },
    },
    handler: (a) =>
      gallery.saveUserGallery(
        String(a.name ?? ''),
        a.frames as string[],
        a.source_prompt ? String(a.source_prompt) : undefined,
      ),
  },
  {
    name: 'delete_user_gallery',
    description: '删除用户图组(内置预设不可删)',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    handler: async (a) => {
      await gallery.deleteUserGallery(String(a.name ?? ''));
      return { ok: true };
    },
  },
  {
    name: 'rename_user_gallery',
    description: '重命名图组(内置预设不可改)',
    inputSchema: {
      type: 'object',
      required: ['name', 'new_name'],
      properties: { name: { type: 'string' }, new_name: { type: 'string' } },
    },
    handler: async (a) => {
      await gallery.renameUserGallery(String(a.name ?? ''), String(a.new_name ?? ''));
      return { ok: true };
    },
  },
];

/* ---------------- 分享库 ---------------- */

const libraryTools: McpToolDef[] = [
  {
    name: 'list_library',
    description: '列出本地分享库(参数 q 搜索/type=all|lipai-profile|lipai-gallery/tag/sort=new|starred/cursor 分页)',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        type: { type: 'string', enum: ['all', 'lipai-profile', 'lipai-gallery'] },
        tag: { type: 'string' },
        sort: { type: 'string', enum: ['new', 'starred'] },
        cursor: { type: 'string' },
      },
    },
    handler: (a) =>
      listLibrary({
        q: a.q ? String(a.q) : undefined,
        type: a.type ? String(a.type) : undefined,
        tag: a.tag ? String(a.tag) : undefined,
        sort: a.sort ? String(a.sort) : undefined,
        cursor: a.cursor ? String(a.cursor) : undefined,
      }),
  },
  {
    name: 'add_to_library',
    description: '把 v2 分享 JSON 收进本地库(bytes_base64 或 json 文本)。校验同上传页',
    inputSchema: {
      type: 'object',
      properties: {
        bytes_base64: { type: 'string' },
        json: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        author: { type: 'string' },
      },
    },
    handler: async (a) => {
      const bytes = a.bytes_base64
        ? Uint8Array.from(Buffer.from(String(a.bytes_base64), 'base64'))
        : new TextEncoder().encode(String(a.json ?? ''));
      const id = await addToLibrary(bytes, {
        title: a.title ? String(a.title) : undefined,
        description: a.description ? String(a.description) : undefined,
        tags: a.tags ? (a.tags as string[]) : undefined,
        author: a.author ? String(a.author) : undefined,
      });
      return { id };
    },
  },
  {
    name: 'get_library_item',
    description: '读库条目原始 JSON(v2 格式,可再导入或转发)',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: async (a) => {
      const file = await getLibraryFile(String(a.id ?? ''));
      if (!file) throw new Error('条目不存在');
      return { json: JSON.parse(new TextDecoder().decode(file.bytes)) };
    },
  },
  {
    name: 'download_library_item',
    description: '下载库条目(计数 + 返回原始字节 base64)',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: async (a) => {
      const file = await bumpDownload(String(a.id ?? ''));
      if (!file) throw new Error('条目不存在');
      return { bytes_base64: b64(file.bytes), sha256: file.sha256 };
    },
  },
  {
    name: 'delete_library_item',
    description: '从本地库删除条目',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: async (a) => {
      await deleteLibraryItem(String(a.id ?? ''));
      return { ok: true };
    },
  },
  {
    name: 'toggle_star',
    description: '收藏/取消收藏(幂等切换),返回新状态',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: (a) => ({ starred: toggleStar(String(a.id ?? '')) }),
  },
  {
    name: 'import_library_item',
    description: '把库条目导入到本地配置/图组(id 冲突换新、图组重名加 -2、引用改写)',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: (a) => importLibraryItem(String(a.id ?? '')),
  },
];

/* ---------------- 汇总 ---------------- */

export const MCP_TOOLS: McpToolDef[] = [
  ...connectionTools,
  ...deviceControlTools,
  ...imageTools,
  ...renderTools,
  ...loopTools,
  ...sceneTools,
  ...profileTools,
  ...galleryTools,
  ...libraryTools,
];

export function findTool(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
