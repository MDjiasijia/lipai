# 本地服务 API 契约（v1）

服务端 = **唯一数据源**（`~/.lipai/`：config.json、profiles/、gallery/、library/）+ **原生 BLE 桥持有者**（bin/ble-bridge-*）+ **常驻自动化**（轮播/场景日程，页面关掉照跑）。

- 开发：vite(5173) 代理 `/api` → `127.0.0.1:5176`；生产：`npm start` 单端口 5176（host 0.0.0.0，供手机/局域网浏览器经服务端通道控设备）。
- 所有响应 JSON。错误统一 `{ error: string }` + 4xx/5xx。
- 帧数据传输一律 base64 JPEG（135×240，与设备/v2 分享文件一致）。

## SSE 事件流

`GET /api/events`（`text/event-stream`）。事件名与载荷：

| event | data |
|---|---|
| `connection` | `{state:'connected'\|'disconnected', detail, name?, userInitiated?}` |
| `deviceInfo` | `DeviceInfo`（含 clockStyle） |
| `log` | `{message, direction:'in'\|'out'\|'system', ts}` |
| `imageProgress` | `{taskId, status:'running'\|'done'\|'error'\|'canceled', done, total, error?}` |
| `loop` | `LoopState` |
| `scene` | `{schedule, state:{status,activeSlotId,lastTriggerAt,error?}}` |
| `slotApply` | `{status:'running'\|'done'\|'error', profileId, total, done, currentSlot, error?}` |
| `library` | `{kind:'changed'}`（列表变了，客户端重拉） |

## BLE / 设备（服务端通道）

| 方法 路径 | body | 说明 |
|---|---|---|
| GET `/api/health` | | `{ok, version, ble:{binary, bridgeRunning}, dataDir}` |
| GET `/api/ble/status` | | `{connected, name?, …DeviceInfo, autoConnect, lastDevice?}` |
| POST `/api/ble/scan` | | `{devices:[{name,address}]}` |
| POST `/api/ble/connect` | `{address?, name?, scanTimeout?, autoConnect?}` | name 支持设备码（31C2C6）；autoConnect=true 存档并开启掉线退避重连 |
| POST `/api/ble/disconnect` | `{userInitiated?}` | 默认 true（清重连绑定） |
| POST `/api/ble/reset` | | 杀孤儿桥 + 重置蓝牙栈 |
| POST `/api/ble/auto-connect` | `{enabled}` | 开关自动重连 |

设备命令（全部走服务端桥；body 即参数）：

```
POST /api/device/read-status
POST /api/device/command        {command:number, payload?:number[]}   # 裸帧(协议探测)
POST /api/device/clock-style    {style:0-3}
POST /api/device/brightness     {value:0-100}
POST /api/device/light-mode     {mode:0-3}
POST /api/device/light-color    {r,g,b}
POST /api/device/wifi           {ssid, password}
POST /api/device/time           {timezoneQuarterHours, use24Hour, useNetworkTime, timestamp?}
POST /api/device/weather        {enabled, locationId, fahrenheit}
POST /api/device/firmware-address {url}
POST /api/device/reboot
POST /api/device/factory-reset
POST /api/image/send            {slot:0-3, frames:string[](base64)}   # 进度走 imageProgress
```

## 自动化（常驻）

| 方法 路径 | 说明 |
|---|---|
| GET `/api/loop` | `LoopState`（status/steps/currentIdx/intervalSec/rounds/lastRoundAt/lastAction/error） |
| POST `/api/loop/start` | `{steps:(0-3\|'weather'\|'gallery'\|'user-gallery'\|'frames')[], intervalSec, startFrom?, city?, galleryTheme?, userGalleryName?, frames?, weatherCardOrder?, weatherRefreshMin?}` |
| POST `/api/loop/stop` | |
| GET `/api/scene` | `{schedule:SceneSchedule, state}` |
| PUT `/api/scene` | `{schedule:SceneSchedule}`（校验后存 config.json，立即生效） |

## 配置 / 图组（~/.lipai/）

| 方法 路径 | 说明 |
|---|---|
| GET `/api/profiles` | `{currentProfileId, profiles:DisplayProfile[]}`（按 ext profile-types 形状） |
| POST `/api/profiles` | `{name}` 新建默认配置 → `DisplayProfile` |
| GET `/api/profiles/:id` | `DisplayProfile` |
| PUT `/api/profiles/:id` | 全量保存（服务端补 updatedAt） |
| DELETE `/api/profiles/:id` | 默认配置不可删（400） |
| POST `/api/profiles/:id/duplicate` | `{name}` → 新配置 |
| POST `/api/profiles/current` | `{id}` |
| POST `/api/profiles/:id/apply` | 按配置逐槽渲染+推送（进度 slotApply），再下发 deviceControl；返回 `{ok}` |
| GET `/api/profiles/:id/thumbs` | `{slots:(string\|null)[4]}` 每槽首帧 base64 |
| GET `/api/galleries` | `[{name, frameCount, sourcePrompt?, preset?}]`（含内置预设，preset:true 只读） |
| GET `/api/galleries/:name/frames` | `{frames:string[]}` |
| POST `/api/galleries` | `{name, frames:string[], sourcePrompt?}` 新建/覆盖 |
| POST `/api/galleries/:name/rename` | `{name}` |
| DELETE `/api/galleries/:name` | 预设不可删 |
| GET/PUT `/api/settings/datafeeds` | `DataFeedDef[]`（自定义接口定义，KV 存 config.json） |

## 分享库（v2 文件完整兼容）

| 方法 路径 | 说明 |
|---|---|
| GET `/api/library?q&type&tag&sort&cursor` | `{items:[LibraryItem], nextCursor?}`；sort=new\|starred；type=all\|lipai-profile\|lipai-gallery。item=`{id,type,title,description,tags[],author?,size,sha256,createdAt,downloads,starred,previews?:[{profileId,slots:[{slot,frames[]}]}]}`（列表瘦身：previews 只带第 0 组帧） |
| POST `/api/library` | multipart：`file`(v2 JSON ≤8MB) + title/description/tags/author（≤200 字符）；同规则校验（type/version===2/帧 base64+JPEG magic/位图 9:16±15% ≤300×600/总量 ≤8MB/数组 ≤20/previews ≤ profiles/slots ≤4/每槽 ≤10）→ `{id}` |
| GET `/api/library/:id` | 原始文件字节（不计数），`X-Content-Sha256` 头 |
| POST `/api/library/:id/download` | 计数 + 返回文件 |
| DELETE `/api/library/:id` | |
| POST `/api/library/:id/star` | `{starred}` 幂等切换 |
| POST `/api/library/:id/import` | 导入到本地配置/图组（id 冲突换新、图组重名加 `-2`、引用改写）→ `{profiles:string[], galleries:string[]}` |
| POST `/api/export` | `{profileIds?:string[]}` → v2 分享 JSON（带图组依赖 + previews 快照），可直接再导入或给别人 |

## 通道语义（前端）

- **server 通道（默认）**：设备操作全部走上述 API；页面关掉轮播/场景照跑。
- **browser 通道（后备）**：页面内 Web Bluetooth 直连（同浏览器直连实现），用于桥不可用（无二进制/系统蓝牙权限）时；数据仍走 API，只有**设备传输**在浏览器。
- 两通道互斥：连接任一时另一通道 UI 禁用；切换断开原通道。
