/**
 * 本地服务入口:Hono API + SSE + 静态托管。
 *
 * 单进程承载:BLE 桥(常驻) + 数据(~/.lipai/) + 渲染(@napi-rs/canvas) + 自动化。
 * `npm start`:同端口(5176)托管 dist/ 静态文件 + /api —— 一个命令起完整本地工具,
 * 手机/局域网任意浏览器打开即用(设备操作经服务端桥,不吃 Web Bluetooth 的
 * HTTPS/手势限制)。
 *
 * 开发模式(dev.ts):vite(5173) 代理 /api 到这里,只跑 API。
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { subscribe, sseFrame, logBuffer } from './events.js';
import * as rt from './runtime.js';
import * as store from './lib/profile-store.js';
import type { DisplayProfile } from './shared/profile-types.js';
import * as gallery from './lib/gallery-store.js';
import {
  listLibrary,
  addToLibrary,
  getLibraryFile,
  bumpDownload,
  deleteLibraryItem,
  toggleStar,
  importLibraryItem,
  validateShareFile,
} from './library.js';
import { getWeather, listCities } from './lib/weather.js';
import { renderWeatherCards } from './lib/render.js';
import { renderSlotForDevice } from './device-control.js';
import { readDataFeeds, writeDataFeeds } from './datafeeds.js';
import { MCP_TOOLS, findTool } from './mcp.js';

const PORT = Number(process.env.PORT ?? 5176);
const DIST = path.join(process.cwd(), 'dist');

const app = new Hono();

/** JSON body 解析(空 body 容错)。 */
async function body<T>(c: { req: { json(): Promise<unknown> } }, fallback: T): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return fallback;
  }
}

/* ---------------- 健康 ---------------- */
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    version: '1.0.0',
    ble: rt.bridgeStatus(),
    dataDir: store.DATA_DIR_DESC,
  }),
);

/* ---------------- SSE 事件流 ---------------- */
app.get('/api/events', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(sseFrame(event, data)));
      // 初始快照:连接状态/设备信息/轮播/场景 + 日志尾部(?since=<ts> 增量)。
      send('hello', { ts: Date.now() });
      const since = Number(c.req.query('since') ?? 0);
      for (const entry of logBuffer) {
        if (entry.ts > since) send('log', entry);
      }
      const device = rt.getDevice();
      if (device) send('deviceInfo', device.getInfo());
      send('loop', rt.getLoopState());
      send('sceneSchedule', rt.sceneState());
      const unsubscribe = subscribe((event, data) => {
        try {
          send(event, data);
        } catch {
          unsubscribe();
        }
      });
      // 心跳:30s 一次,防中间层掐空闲连接。
      const beat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'));
        } catch {
          clearInterval(beat);
        }
      }, 30_000);
      return () => {
        clearInterval(beat);
        unsubscribe();
      };
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});

/* ---------------- BLE ---------------- */
app.get('/api/ble/status', (c) => {
  const device = rt.getDevice();
  return c.json({ ...device?.getInfo(), bridge: rt.bridgeStatus() });
});
app.post('/api/ble/scan', async (c) => {
  try {
    return c.json({ devices: await rt.scanDevices() });
  } catch (e) {
    return c.json({ error: msg(e) }, 503);
  }
});
app.post('/api/ble/connect', async (c) => {
  const req = await body<{ address?: string; name?: string; autoConnect?: boolean }>(c, {});
  try {
    const info = await rt.connectDevice(req);
    return c.json(info);
  } catch (e) {
    return c.json({ error: msg(e) }, 502);
  }
});
app.post('/api/ble/disconnect', async (c) => {
  const req = await body<{ userInitiated?: boolean }>(c, {});
  await rt.disconnectDevice(req.userInitiated !== false);
  return c.json({ ok: true });
});
app.post('/api/ble/reset', async (c) => {
  await rt.resetBluetooth();
  return c.json({ ok: true });
});
app.post('/api/ble/auto-connect', async (c) => {
  const req = await body<{ enabled: boolean }>(c, { enabled: false });
  await rt.setAutoConnectEnabled(req.enabled);
  return c.json({ ok: true });
});

/* ---------------- 设备命令 ---------------- */
function deviceRoute(
  path: string,
  fn: (device: NonNullable<ReturnType<typeof rt.getDevice>>, body: Record<string, unknown>) => Promise<unknown>,
) {
  app.post(path, async (c) => {
    const device = rt.getDevice();
    if (!device?.connected) return c.json({ error: '设备未连接' }, 409);
    try {
      const req = await body<Record<string, unknown>>(c, {});
      return c.json({ ok: true, result: await fn(device, req) ?? null });
    } catch (e) {
      return c.json({ error: msg(e) }, 502);
    }
  });
}

deviceRoute('/api/device/read-status', (d) => d.readStatus());
deviceRoute('/api/device/command', (d, b) =>
  d.sendRaw(Number(b.command), Array.isArray(b.payload) ? b.payload.map(Number) : []),
);
deviceRoute('/api/device/clock-style', (d, b) => d.setClockStyle(Number(b.style)));
deviceRoute('/api/device/brightness', (d, b) => d.setBrightness(Number(b.value)));
deviceRoute('/api/device/light-mode', (d, b) => d.setLightMode(Number(b.mode)));
deviceRoute('/api/device/light-color', (d, b) =>
  d.setLightColor(Number(b.r), Number(b.g), Number(b.b)),
);
deviceRoute('/api/device/wifi', (d, b) => d.configureWifi(String(b.ssid ?? ''), String(b.password ?? '')));
deviceRoute('/api/device/time', (d, b) =>
  d.setTime({
    timezoneQuarterHours: Number(b.timezoneQuarterHours ?? 32),
    use24Hour: b.use24Hour !== false,
    useNetworkTime: b.useNetworkTime !== false,
    timestamp: b.timestamp ? Number(b.timestamp) : undefined,
  }),
);
deviceRoute('/api/device/weather', (d, b) =>
  d.setWeather({
    enabled: Boolean(b.enabled),
    locationId: String(b.locationId ?? ''),
    fahrenheit: Boolean(b.fahrenheit),
  }),
);
deviceRoute('/api/device/firmware-address', (d, b) => d.setFirmwareAddress(String(b.url ?? '')));
deviceRoute('/api/device/reboot', (d) => d.reboot());
deviceRoute('/api/device/factory-reset', (d) => d.factoryReset());

app.post('/api/image/send', async (c) => {
  const device = rt.getDevice();
  if (!device?.connected) return c.json({ error: '设备未连接' }, 409);
  const req = await body<{ slot: number; frames: string[] }>(c, { slot: 3, frames: [] });
  const images = req.frames.map((b) => Uint8Array.from(Buffer.from(b, 'base64')));
  try {
    await device.sendImage(images, Number(req.slot));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: msg(e) }, 502);
  }
});

/* ---------------- 自动化 ---------------- */
app.get('/api/loop', (c) => c.json(rt.getLoopState()));
app.post('/api/loop/start', async (c) => {
  const req = await body<Parameters<typeof rt.startLoop>[0]>(c, {
    steps: ['weather'],
    intervalSec: 60,
  });
  return c.json(rt.startLoop(req));
});
app.post('/api/loop/stop', (c) => c.json(rt.stopLoop()));

app.get('/api/scene', (c) => c.json(rt.sceneState()));
app.put('/api/scene', async (c) => {
  const req = await body<{ schedule: Parameters<typeof rt.updateSceneSchedule>[0] }>(c, {
    schedule: { enabled: false, slots: [] },
  });
  await rt.updateSceneSchedule(req.schedule);
  return c.json(rt.sceneState());
});

/* ---------------- 配置 / 图组 ---------------- */
app.get('/api/profiles', async (c) => {
  const profiles = await store.listProfiles();
  const current = await store.readCurrentProfileId();
  return c.json({ currentProfileId: current, profiles });
});
app.post('/api/profiles', async (c) => {
  const req = await body<{ name: string }>(c, { name: '新配置' });
  const profile = await store.createProfile(req.name);
  return c.json(profile, 201);
});
app.get('/api/profiles/:id', async (c) => {
  const profile = await store.readProfile(c.req.param('id'));
  return profile ? c.json(profile) : c.json({ error: '配置不存在' }, 404);
});
app.put('/api/profiles/:id', async (c) => {
  const req = await body<DisplayProfile | null>(c, null);
  if (!req?.id) return c.json({ error: '缺少配置体' }, 400);
  await store.writeProfile(req);
  return c.json({ ok: true });
});
app.delete('/api/profiles/:id', async (c) => {
  try {
    await store.deleteProfile(c.req.param('id'));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});
app.post('/api/profiles/:id/duplicate', async (c) => {
  const req = await body<{ name?: string }>(c, {});
  const copy = await store.duplicateProfile(c.req.param('id'), req.name);
  return copy ? c.json(copy, 201) : c.json({ error: '配置不存在' }, 404);
});
app.post('/api/profiles/current', async (c) => {
  const req = await body<{ id: string }>(c, { id: '' });
  await store.setCurrentProfile(req.id);
  return c.json({ ok: true });
});
app.post('/api/profiles/:id/apply', async (c) => {
  const profile = await store.readProfile(c.req.param('id'));
  if (!profile) return c.json({ error: '配置不存在' }, 404);
  if (!rt.getDevice()?.connected) return c.json({ error: '设备未连接' }, 409);
  const state = await rt.applyProfileToDevice(profile);
  return c.json(state);
});
app.get('/api/profiles/:id/thumbs', async (c) => {
  const profile = await store.readProfile(c.req.param('id'));
  if (!profile) return c.json({ error: '配置不存在' }, 404);
  const thumbs: (string | null)[] = [];
  for (const spec of profile.slots ?? []) {
    if (!spec) {
      thumbs.push(null);
      continue;
    }
    const images = await renderSlotForDevice(spec).catch(() => []);
    thumbs.push(images[0] ? Buffer.from(images[0]).toString('base64') : null);
  }
  return c.json({ slots: thumbs });
});
app.post('/api/profiles/import', async (c) => {
  const req = await body<{ data: string }>(c, { data: '' });
  const result = await store.importProfiles(req.data);
  return c.json(result);
});
app.post('/api/export', async (c) => {
  const req = await body<{ profileIds?: string[] }>(c, {});
  const current = req.profileIds?.length
    ? req.profileIds
    : [await store.readCurrentProfileId()];
  const result = await store.exportProfiles(current, {
    // withPreview:顶层附 previews 快照 —— 分享站/别的机器拿到即可轮播,不用复刻渲染管线。
    withPreview: true,
    renderSlot: async (spec) => {
      const images = await renderSlotForDevice(spec).catch(() => []);
      return images.map((img) => Buffer.from(img).toString('base64'));
    },
  });
  return new Response(result.json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="lipai-share-${Date.now()}.json"`,
    },
  });
});

app.get('/api/galleries', async (c) => c.json({ galleries: await gallery.listAllGalleries() }));
app.get('/api/galleries/:name/frames', async (c) => {
  const frames = await gallery.getUserGalleryFrames(c.req.param('name')).catch(() => {
    return null;
  });
  return frames ? c.json({ frames }) : c.json({ error: '图组不存在' }, 404);
});
app.post('/api/galleries', async (c) => {
  const req = await body<{ name: string; frames: string[]; sourcePrompt?: string }>(c, {
    name: '',
    frames: [],
  });
  if (!req.name.trim()) return c.json({ error: '图组名不能为空' }, 400);
  const meta = await gallery.saveUserGallery(req.name, req.frames, req.sourcePrompt);
  return c.json(meta, 201);
});
app.post('/api/galleries/:name/rename', async (c) => {
  const req = await body<{ name: string }>(c, { name: '' });
  await gallery.renameUserGallery(c.req.param('name'), req.name);
  return c.json({ ok: true });
});
app.delete('/api/galleries/:name', async (c) => {
  try {
    await gallery.deleteUserGallery(c.req.param('name'));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});

/* ---------------- 自定义接口(datafeed) ---------------- */
app.get('/api/settings/datafeeds', (c) => c.json({ datafeeds: readDataFeeds() }));
app.put('/api/settings/datafeeds', async (c) => {
  const req = await body<{ datafeeds: unknown[] }>(c, { datafeeds: [] });
  writeDataFeeds(req.datafeeds);
  return c.json({ ok: true });
});

/* ---------------- 天气 ---------------- */
app.get('/api/weather/cities', (c) => c.json({ cities: listCities() }));
app.get('/api/weather/preview', async (c) => {
  const city = c.req.query('city') ?? '上海';
  try {
    const weather = await getWeather(city);
    const cards = renderWeatherCards(weather);
    return c.json({
      cards: cards.map((card: { id: string; image: Uint8Array }) => ({
        id: card.id,
        image: Buffer.from(card.image).toString('base64'),
      })),
    });
  } catch (e) {
    return c.json({ error: msg(e) }, 502);
  }
});

/* ---------------- 分享库(v2 兼容) ---------------- */
app.get('/api/library', async (c) => {
  const q = c.req.query('q') ?? '';
  const type = c.req.query('type') ?? 'all';
  const tag = c.req.query('tag') ?? '';
  const sort = c.req.query('sort') ?? 'new';
  const cursor = c.req.query('cursor') ?? '';
  return c.json(await listLibrary({ q, type, tag, sort, cursor }));
});
app.post('/api/library', async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = {
      title: String(form.get('title') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
      tags: String(form.get('tags') ?? '')
        .split(/[,，\s]+/)
        .filter(Boolean),
      author: String(form.get('author') ?? '').trim(),
    };
    const id = await addToLibrary(bytes, meta);
    return c.json({ id }, 201);
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});
app.get('/api/library/:id', async (c) => {
  const item = await getLibraryFile(c.req.param('id'));
  if (!item) return c.json({ error: '条目不存在' }, 404);
  return new Response(Buffer.from(item.bytes), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-sha256': item.sha256,
    },
  });
});
app.post('/api/library/:id/download', async (c) => {
  const item = await bumpDownload(c.req.param('id'));
  if (!item) return c.json({ error: '条目不存在' }, 404);
  return new Response(Buffer.from(item.bytes), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-sha256': item.sha256,
    },
  });
});
app.delete('/api/library/:id', async (c) => {
  await deleteLibraryItem(c.req.param('id'));
  return c.json({ ok: true });
});
app.post('/api/library/:id/star', async (c) => {
  const starred = await toggleStar(c.req.param('id'));
  return c.json({ starred });
});
app.post('/api/library/:id/import', async (c) => {
  try {
    const result = await importLibraryItem(c.req.param('id'));
    return c.json(result);
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});
app.post('/api/library/validate', async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    validateShareFile(bytes); // 抛错 = 校验失败
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: msg(e) }, 400);
  }
});


/* ---------------- MCP(Streamable HTTP,JSON-RPC 2.0) ----------------
 * 用户自己的 agent 接入:http://127.0.0.1:5176/mcp
 * (Claude Code: claude mcp add --transport http lipai http://127.0.0.1:5176/mcp)
 * 无状态实现:每个 POST 一个 JSON-RPC 消息;协议版本 2025-03-26。
 * SSE 升级(服务器推送通知)暂不需要 —— 工具结果全部同步返回。
 */
let mcpInitialized = false;
app.post('/mcp', async (c) => {
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = (await c.req.json()) as typeof msg;
  } catch {
    return c.body(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 400, { 'content-type': 'application/json' });
  }
  const id = msg.id ?? null;
  const reply = (result: unknown, status: 200 | 202 = 200): Response =>
    c.body(JSON.stringify({ jsonrpc: '2.0', id, result }), status, {
      'content-type': 'application/json',
    }) as unknown as Response;
  const replyErr = (code: number, message: string, status: 200 | 400 = 200): Response =>
    c.body(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), status, {
      'content-type': 'application/json',
    }) as unknown as Response;

  switch (msg.method) {
    case 'initialize':
      mcpInitialized = true;
      return reply({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'lipai-local', version: '1.0.0' },
        instructions:
          '电子立牌本地控制:先 check_environment / list_devices,再 connect;推送内容用 display_weather / push_random_gallery / render_canvas_and_push / push_animation,传图进度走 get_transfer_progress。常驻自动化 start_loop / put_scene_schedule。生图管线:AI 生图工具出 1280x2048 雪碧图 → save_sprite_gallery 裁 10 帧 → 轮播 user-gallery 用它。',
      });
    case 'notifications/initialized':
      // 客户端完成初始化通知(无 id):按协议回 202 空体。
      return c.body(null, 202);
    case 'tools/list':
      return reply({
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        })),
      });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = findTool(name);
      if (!tool) return replyErr(-32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.handler(args);
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        // 工具执行失败按协议走 isError:true(不是 JSON-RPC error)。
        const message = e instanceof Error ? e.message : String(e);
        return reply({
          content: [{ type: 'text', text: `工具执行失败:${message}` }],
          isError: true,
        });
      }
    }
    case 'ping':
      return reply({});
    default:
      // initialize 之前到达的请求按协议拒绝;通知(无 id)静默 202。
      if (id === null) return c.body(null, 202);
      return replyErr(
        -32601,
        `Method not found: ${msg.method ?? '(空)'}${mcpInitialized ? '' : '(先 initialize)'}`,
      );
  }
});
app.get('/mcp', (c) =>
  c.json(
    {
      transport: 'streamable-http',
      endpoint: '/mcp',
      hint: 'POST JSON-RPC 2.0(initialize → tools/list → tools/call)。Claude Code: claude mcp add --transport http lipai http://127.0.0.1:5176/mcp',
    },
    405,
  ),
);

/* ---------------- 静态托管(dist/) ---------------- */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
app.get('*', (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not Found' }, 404);
  const url = new URL(c.req.url);
  // 防目录穿越:pathname 归一后必须还在 DIST 内。
  const target = path.normalize(path.join(DIST, url.pathname));
  const inside = target === DIST || target.startsWith(DIST + path.sep);
  // 目录(如 /)、不存在、越界 → SPA 回落 index.html(hash 路由,一切非文件路径都回落)。
  const isFile = inside && existsSync(target) && !target.endsWith(path.sep) && path.extname(target) !== '';
  const file = isFile ? target : path.join(DIST, 'index.html');
  if (!existsSync(file)) return c.text('dist/ 未构建:先 npm run build', 503);
  return c.body(readFileSync(file), 200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
  });
});

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ---------------- 启动 ---------------- */
async function main() {
  // 启动即拉起:数据目录 + 自动重连设置 + 常驻场景日程。
  await rt.resumePersistedAutomation();
  await rt.readAutoConnectSettings();
  // 开了自动重连且有存档设备:启动即排一次重连(设备在就秒连)。
  const device = rt.getDevice();
  if (!device?.connected) {
    void rt.tryReconnectNow().catch(() => null);
  }
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`[lipai] 本地服务已启动: http://127.0.0.1:${info.port}`);
    console.log(`[lipai] 数据目录: ${store.DATA_DIR_DESC}`);
    console.log(`[lipai] BLE 桥: ${rt.bridgeStatus().binary}`);
  });
  // 优雅停机:SIGINT/SIGTERM 停桥停轮播。
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void rt.shutdown().finally(() => process.exit(0));
    });
  }
}

void main();
