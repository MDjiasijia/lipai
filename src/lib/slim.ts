/**
 * 列表瘦身（functions / server 两端共用）：控制列表接口响应体积与内存峰值。
 *
 * 背景：记录的 previews 是每槽 ≤10 帧 × ~15KB base64，单条可达数百 KB；
 * 一页 12 条的响应 MB 级，popular 全量收集时 Workers 128MB 内存上限有 OOM 风险。
 *
 * 规则：previews 只留第 0 组的帧（首页默认显示第 0 组，切组由前端按需拉详情补全），
 * 其余组保留 slot 与 frames:[] 占位；summary 是详情页专用的大 JSON，列表一并剥离；
 * thumb 与第 0 组首帧同源，留帧后整字段省掉 —— 但 previews 为空（旧格式无预览）的
 * 记录里 thumb 是列表唯一的视觉占位（首个图组首帧），保留。
 */
import type { ShareRecord } from '../types'

export function slimForList(rec: ShareRecord): ShareRecord {
  const { summary: _summary_, ...rest } = rec // eslint-disable-line @typescript-eslint/no-unused-vars
  if (rest.previews.length === 0) return rest as ShareRecord
  return {
    ...rest,
    // label（分组语义名）跟着占位走 —— 切组 chips 无帧也要能显示名字
    previews: rest.previews.map((p, i) =>
      i === 0 ? p : { slot: p.slot, frames: [], ...(p.label ? { label: p.label } : {}) },
    ),
    thumb: null,
  } as ShareRecord
}
