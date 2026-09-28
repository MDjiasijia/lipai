/**
 * 自定义接口(DataFeedDef)存取:config.json KV。
 *
 * datafeed = 用户自定义 HTTP 接口卡(声明式 blocks + {path} 插值),渲染层
 * (前端 render-datafeed.ts / 轮播)按 TTL 缓存取数。本地工具沿用同一模型,
 * 定义存 config.json(settings.datafeeds)。
 */
import { readConfig, writeConfig } from './lib/profile-store.js';

import type { DataFeedDef } from './shared/profile-types.js';

const KEY = 'datafeeds';

export async function readDataFeeds(): Promise<DataFeedDef[]> {
  const cfg = await readConfig();
  return (cfg.settings?.[KEY] as DataFeedDef[] | undefined) ?? [];
}

export async function writeDataFeeds(defs: unknown): Promise<void> {
  const list = Array.isArray(defs) ? (defs as DataFeedDef[]) : [];
  const cfg = await readConfig();
  cfg.settings = { ...cfg.settings, [KEY]: list };
  await writeConfig(cfg);
}
