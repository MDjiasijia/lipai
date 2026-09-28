/**
 * 自定义数据源定义存取 —— API 客户端薄层。
 *
 * 旧版存 IndexedDB settings KV（key = `datafeed:<id>`）；
 * 本地版存服务端 config.json（settings.datafeeds，GET/PUT /api/settings/datafeeds）。
 * 服务端是全量 PUT（没有逐条端点），这里在薄层内做读-改-写：
 * list → 找目标 → 改 → 整份 PUT 回 —— 函数名与返回形状对齐旧版
 * （DataFeedManager / pipeline 渲染取 def 不感知存储差异）。
 */
import type { DataFeedDef } from './profile-types'
import * as api from '../api-server'

/** 列出全部数据源定义（updatedAt 降序）。 */
export async function listDataFeedDefs(): Promise<DataFeedDef[]> {
  const { datafeeds } = await api.listDataFeedsApi()
  return [...datafeeds].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** 读单个定义；不存在回 null。 */
export async function readDataFeedDef(id: string): Promise<DataFeedDef | null> {
  const list = await listDataFeedDefs()
  return list.find((d) => d.id === id) ?? null
}

/** 写定义（updatedAt 由调用方管；全量 PUT：读 → 有则替换无则追加 → 整份写回）。 */
export async function writeDataFeedDef(def: DataFeedDef): Promise<void> {
  const { datafeeds } = await api.listDataFeedsApi()
  const next = datafeeds.some((d) => d.id === def.id)
    ? datafeeds.map((d) => (d.id === def.id ? def : d))
    : [...datafeeds, def]
  await api.putDataFeedsApi(next)
}

/** 删除定义（全量 PUT：读 → 剔除 → 写回）。 */
export async function deleteDataFeedDef(id: string): Promise<void> {
  const { datafeeds } = await api.listDataFeedsApi()
  await api.putDataFeedsApi(datafeeds.filter((d) => d.id !== id))
}

/** 复制为新定义（id 换新、名字加后缀去重）。 */
export async function duplicateDataFeedDef(id: string): Promise<DataFeedDef | null> {
  const src = await readDataFeedDef(id)
  if (!src) return null
  const list = await listDataFeedDefs()
  const names = new Set(list.map((d) => d.name))
  let name = `${src.name} 副本`
  let i = 2
  while (names.has(name)) name = `${src.name} 副本 ${i++}`
  const now = Date.now()
  const copy: DataFeedDef = {
    ...src,
    id: `feed-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    createdAt: now,
    updatedAt: now,
  }
  await writeDataFeedDef(copy)
  return copy
}

/** 深拷贝卡模板（编辑器防误改引用）。 */
export function cloneCardTemplates(
  cards: DataFeedDef['cards'],
): DataFeedDef['cards'] {
  return JSON.parse(JSON.stringify(cards)) as DataFeedDef['cards']
}
