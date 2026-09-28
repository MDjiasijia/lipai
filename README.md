# 电子立牌本地管理工具（lipai-local）

纯本地的 IPS 电子立牌管理工具：**本地启动一个服务即可使用**，无登录、无云端依赖。浏览器控制台 + 原生蓝牙桥 + 常驻自动化 + MCP 工具集，一站式管理你的桌面立牌。

## 架构

```
浏览器(React 19 + Vite)  ──/api──▶  本地服务(Node/Hono, 5176)
  │  预览/编辑(浏览器渲染 Worker)         │
  │  设备后备通道:Web Bluetooth          ├─ BLE 桥(bin/ble-bridge-*, Rust/btleplug)
  │                                     ├─ 数据(~/.lipai/: profiles/gallery/library)
  └─ v2 分享 JSON(导入/导出)              ├─ 渲染(@napi-rs/canvas 135×240)
                                        └─ 常驻自动化(轮播/场景日程,页面关掉照跑)
```

- **双通道蓝牙**：默认走服务端原生 BLE 桥（Rust/btleplug 子进程，无浏览器限制、支持局域网内手机控制、自动化常驻）；Web Bluetooth 直连作为后备（桥不可用时浏览器直连）。
- **唯一数据源**：配置/图组/分享库全在服务端 `~/.lipai/`，多端访问无同步问题。
- **v2 分享文件完整兼容**：`lipai-profile`/`lipai-gallery` JSON（version 2）拖进「收进库」页即入库即用；导出同格式可分享给其他人。

## 运行

```bash
npm install
npm run dev        # 开发:vite(5173) + API(5176) 并行
```

```bash
npm run build            # 前端构建 → dist/
npm start                # 单进程:API + 静态托管(5176),浏览器开 http://127.0.0.1:5176
npm run build:release    # 打免安装产物包 release/lipai-local-<ver>-<platform>.tar.gz
```

同一 WiFi 下手机访问 `http://<电脑IP>:5176` 即可通过服务端桥控设备（不受 Web Bluetooth 的 HTTPS/手势限制）。

## 功能清单

- **设备**：连接/自动重连（5/10/20/30s 退避）、亮度/灯效/RGB 灯色、时间同步（时区/12-24h/网络校时）、Wi-Fi 配网、固件地址、重启/恢复出厂、协议探测（裸帧）、设备信息读取、通信日志（SSE 实时推送）。
- **4 槽位投屏**：选内容（天气/内置图库/我的图组/本地图片/自由画布/内置动画/自定义接口）→ 预览排序（拖拽/勾选/超容灰显 + 帧号角标）→ 推送（服务端桥或浏览器直连）。
- **自动化（常驻）**：轮播循环（时间线混排「切槽位/现取内容推送」，指纹去重免重传，掉线自动暂停、重连续播）+ 场景日程（时刻表/星期/持续时长，到点推图、结束切回默认）。
- **配置体系**：多 Profile 新建/复制/改名/删除、导出/导入（带图组依赖打包 + previews 快照）、应用到设备（逐槽推送）。
- **分享库**：v2 JSON 导入/浏览（辉光管实时走时预览）/搜索/标签/收藏星标/下载/导出/删除。
- **天气**：Open-Meteo 免 Key 直连（中文城市 geocoding），多卡片（主卡/气温/湿度/风/UV/降水/日照/预报）按天空状况配色；卡片拖拽排序。

## MCP 工具集（接入你自己的 agent）

服务内置 MCP（Model Context Protocol）端点 `http://127.0.0.1:5176/mcp`（Streamable HTTP / JSON-RPC 2.0），**67 个工具**全量开放 —— 你自己的 agent（Claude Code / Cursor / 任意 MCP 客户端）可直连：

```bash
# Claude Code
claude mcp add --transport http lipai http://127.0.0.1:5176/mcp
```

覆盖：

- **连接/控制**：`check_environment` `list_devices` `connect`（支持设备码 + 自动重连）`read_status` `set_brightness` `set_clock_style` `set_light_mode/color` `set_time` `set_weather(_by_city)` `configure_wifi` `set_firmware_address` `reboot` `factory_reset` `set_raw_command`（协议探测）
- **内容生成 + 推送**：`display_cards`（text/countdown/clock/qrcode/list/heartbeat 六模板）`display_weather` `get_weather_info/cards`（Open-Meteo）`push_random_gallery` `render_canvas_and_push`（文案主题 × 配色主题 × 背景图）`push_digit_clock` `push_animation`（8 种）`push_custom_animation`（emoji 序列）及对应 `get_*_preview`（只渲染不推送）
- **传图**：`start_image_transfer`（后台任务 + `get_transfer_progress`；进度同时走 SSE `imageProgress`）
- **常驻自动化**：`start_loop` / `stop_loop` / `get_loop_state`（混排切槽位/推内容，指纹去重）、`get/put_scene_schedule`（时刻表）
- **配置/图组/分享库**：`list/read/save/create/delete/apply/export/import_profile`、`save_sprite_gallery`（AI 生图 5×2 雪碧图 → 裁 10 帧，人物一致性方案）`save/list/get/delete/rename_user_gallery`、`list/add_to_library` `get/download/delete_library_item` `toggle_star` `import_library_item`

**生图管线**：AI 生图工具（如 `text2img`）出 1280×2048 网格大图 → `save_sprite_gallery` 裁成 10 帧（同一人物 10 个姿势/数字 0-9）→ 轮播 `start_loop({steps:['user-gallery'], userGalleryName})` 用它。

## 协议（设备通信）

帧结构（Nordic UART Service，MTU 512 / 分包 500B）：

```
0xA5 | cmd(1B) | payload(N B) | checksum(1B) | 0x5A     checksum = (cmd + Σ payload) & 0xFF
设备响应: 0xA5 | cmd | status(0=成功) | data... | checksum | 0x5A
```

4 个槽位（= 时钟样式 0-3）：槽 0/1/2 各 10 帧固件逐秒切换，槽 3「电子立牌」6 帧固定展示。传图时序：

```
imageSum(总包数) → setUpgradeMode(2) → 每张图 imageStart(/style{n}/{i}.jpg) → imageData×N(500B) → imageEnd
→ setUpgradeMode(0) → setWeatherVisible(0) → setClockStyle(style)
```

## 安全提示

- 服务绑定 `0.0.0.0`（局域网可控设备）；如只允许本机，设 `HOST=127.0.0.1`。
- Wi-Fi 密码仅在内存中下发，不落盘。
- 恢复出厂会清除设备端配置；固件地址必须来自可信源。
- ble-bridge 二进制 spawn 前按 `bin/sha256sums.txt` 校验完整性，路径白名单限制。

## License

MIT
