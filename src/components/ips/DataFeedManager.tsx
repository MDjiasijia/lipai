/**
 * 自定义数据源管理器（数据源列表 + 编辑器弹层）。
 *
 * 一个数据源 = 接口（URL/方法/头/体）+ 卡片模板列表（每张模板渲一帧）。
 * 编辑器的「测试」按钮真实打一次请求，把返回 JSON 树展示出来：
 * 点树里的值就把 `{path}` 插进当前聚焦的模板输入框 —— 用户不用手写路径。
 *
 * 打开方式：控制台「投屏」Tab 选「自定义接口」来源 → 管理数据源；
 * 或分享配置槽位里引用了不存在的数据源时的「去创建」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { DataFeedDef, DataFeedCardTemplate, DataFeedBlock } from '../../lib/ips/profile-types'
import { DATAFEED_DEFAULT_TTL_MS } from '../../lib/ips/profile-types'
import {
  listDataFeedDefs,
  readDataFeedDef,
  writeDataFeedDef,
  deleteDataFeedDef,
  duplicateDataFeedDef,
} from '../../lib/ips/datafeed-store'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Modal } from '../ui/Modal'
import { IconPlug, IconDelete } from '../icons'

/* ── 工具 ─────────────────────────────────────────────────────────────────── */

function newDef(name: string): DataFeedDef {
  const now = Date.now()
  return {
    id: `feed-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    createdAt: now,
    updatedAt: now,
    url: '',
    method: 'GET',
    cacheTtlMs: DATAFEED_DEFAULT_TTL_MS,
    cards: [newCard('main', '主卡')],
  }
}

function newCard(id: string, label: string): DataFeedCardTemplate {
  return {
    id,
    label,
    blocks: [
      { kind: 'label', text: label },
      { kind: 'hero', text: '{value}' },
      { kind: 'caption', text: '' },
    ],
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/* ── JSON 树（点选字段 → 生成路径） ──────────────────────────────────────── */

/** 把 JSON 值摊平成 [路径, 预览] 列表（数组只展前 3 项，深度限 4，总量限 80 行）。 */
function flattenJson(value: unknown, prefix = '', depth = 0, out: [string, string][] = []): [string, string][] {
  if (out.length >= 80 || depth > 4) return out
  if (value === null || typeof value !== 'object') {
    out.push([prefix, String(value)])
    return out
  }
  if (Array.isArray(value)) {
    value.slice(0, 3).forEach((v, i) => flattenJson(v, prefix ? `${prefix}.${i}` : String(i), depth + 1, out))
    if (value.length > 3) out.push([`${prefix}.…`, `… 共 ${value.length} 项`])
    return out
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flattenJson(v, prefix ? `${prefix}.${k}` : k, depth + 1, out)
  }
  return out
}

/* ── 编辑器 ───────────────────────────────────────────────────────────────── */

function FeedEditor({ def, onClose }: { def: DataFeedDef; onClose: () => void }): ReactElement {
  const [draft, setDraft] = useState<DataFeedDef>(() => clone(def))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  /** 当前聚焦的模板输入框（点 JSON 树插 {path} 的目标）。 */
  const [focusKey, setFocusKey] = useState<string>('')
  const [saveErr, setSaveErr] = useState('')
  const focusRef = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({})

  const patch = (p: Partial<DataFeedDef>): void => setDraft((d) => ({ ...d, ...p }))
  const patchCard = (idx: number, p: Partial<DataFeedCardTemplate>): void =>
    setDraft((d) => ({ ...d, cards: d.cards.map((c, i) => (i === idx ? { ...c, ...p } : c)) }))
  const patchBlock = (ci: number, bi: number, p: Partial<DataFeedBlock>): void =>
    setDraft((d) => ({
      ...d,
      cards: d.cards.map((c, i) =>
        i === ci ? { ...c, blocks: c.blocks.map((b, j) => (j === bi ? ({ ...b, ...p } as DataFeedBlock) : b)) } : c,
      ),
    }))

  /** 点 JSON 树：把 {path} 追加到聚焦输入框的光标处。 */
  const insertPath = (path: string): void => {
    const el = focusRef.current[focusKey]
    const snippet = `{${path}}`
    if (!el) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const next = el.value.slice(0, start) + snippet + el.value.slice(end)
    el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true }))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + snippet.length, start + snippet.length)
    })
  }

  const runTest = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const method = draft.method ?? 'GET'
      const headers: Record<string, string> = { ...(draft.headers ?? {}) }
      let body: string | undefined
      if (method === 'POST') {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
        body = draft.body || undefined
      }
      const resp = await fetch(draft.url, { method, headers, body })
      const text = await resp.text()
      let pretty = text
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        /* 非 JSON 原样显示 */
      }
      setTestResult({ ok: resp.ok, text: `HTTP ${resp.status} · ${pretty.slice(0, 4000)}` })
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }, [draft])

  const save = async (): Promise<void> => {
    if (!draft.name.trim() || !draft.url.trim()) {
      setSaveErr('名称和接口地址必填')
      return
    }
    try {
      await writeDataFeedDef({ ...draft, name: draft.name.trim(), url: draft.url.trim(), updatedAt: Date.now() })
      onClose()
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 卡 id 冲突检测（cardIds 引用靠 id，重复会让挑选歧义）。 */
  const dupIds = new Set(draft.cards.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i))

  return (
    <Modal isOpen onClose={onClose} ariaLabel="编辑数据源" className="p-3" contentClassName="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden p-5">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="flex-1 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {def.url ? '编辑数据源' : '新建数据源'}
          </h3>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>取消</button>
          <button type="button" className="btn-primary btn-sm" onClick={() => void save()}>保存</button>
        </div>
        {saveErr && <p className="mb-2 text-xs text-red-500">{saveErr}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* ── 基本信息 ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              名称 *
              <input
                className="input mt-1"
                value={draft.name}
                maxLength={40}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="如：GitHub Trending"
              />
            </label>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              缓存时长（分钟，0 = 不缓存）
              <input
                className="input mt-1 readout"
                type="number"
                min={0}
                max={1440}
                value={Math.round((draft.cacheTtlMs ?? DATAFEED_DEFAULT_TTL_MS) / 60000)}
                onChange={(e) => patch({ cacheTtlMs: Math.max(0, Number(e.target.value) || 0) * 60000 })}
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            接口地址 *（返回 JSON；浏览器直连 —— 目标服务需允许跨域，测试按钮会立刻告诉你行不行）
            <div className="mt-1 flex gap-2">
              <select
                className="input w-auto"
                value={draft.method ?? 'GET'}
                onChange={(e) => patch({ method: e.target.value as 'GET' | 'POST' })}
                aria-label="请求方法"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
              <input
                className="input flex-1"
                value={draft.url}
                maxLength={500}
                onChange={(e) => patch({ url: e.target.value })}
                placeholder="https://api.example.com/v1/data"
              />
            </div>
          </label>
          {draft.method === 'POST' && (
            <label className="mt-3 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              请求体（JSON）
              <textarea
                className="input mt-1 min-h-16 font-mono text-xs"
                value={draft.body ?? ''}
                maxLength={2000}
                onChange={(e) => patch({ body: e.target.value })}
                placeholder='{"q": "…"}'
              />
            </label>
          )}

          {/* ── 自定义请求头 ── */}
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <p className="micro-label flex-1">自定义请求头</p>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => patch({ headers: { ...draft.headers, '': '' } })}
              >
                + 加一个
              </button>
            </div>
            {draft.headers && Object.entries(draft.headers).length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                {Object.entries(draft.headers).map(([key, value], i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      className="input w-36 py-1 font-mono text-xs"
                      value={key}
                      maxLength={100}
                      placeholder="字段名（如 X-Token）"
                      onChange={(e) => {
                        const entries = Object.entries(draft.headers ?? {})
                        entries[i] = [e.target.value, value]
                        patch({ headers: Object.fromEntries(entries.filter(([k]) => k.trim() !== '')) })
                      }}
                      aria-label={`请求头 ${i + 1} 名称`}
                    />
                    <input
                      className="input flex-1 py-1 font-mono text-xs"
                      value={value}
                      maxLength={500}
                      placeholder="值"
                      onChange={(e) => {
                        const entries = Object.entries(draft.headers ?? {})
                        entries[i] = [key, e.target.value]
                        patch({ headers: Object.fromEntries(entries) })
                      }}
                      aria-label={`请求头 ${i + 1} 值`}
                    />
                    <button
                      type="button"
                      className="shrink-0 text-[11px] text-zinc-400 transition-colors hover:text-red-500"
                      onClick={() => {
                        const next = { ...draft.headers }
                        delete next[key]
                        patch({ headers: next })
                      }}
                      title="删除这个头"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              Authorization / Cookie 等受限头浏览器禁止自定义（请求会直接失败）；Accept、X-* 这类自定义头可用，是否放行取决于目标服务的 CORS 配置。
            </p>
          </div>
          <div className="mt-3 flex items-end gap-2">
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void runTest()} disabled={testing || !draft.url.trim()}>
              {testing ? '请求中…' : '▶ 测试请求'}
            </button>
            <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              测试 = 按当前配置真实打一次接口。返回的 JSON 树里点任意值，会把 <code className="readout">{'{路径}'}</code> 插进下面正在编辑的输入框。
            </p>
          </div>

          {/* ── 测试结果 + JSON 树 ── */}
          {testResult && (
            <div className={`mt-3 rounded-[var(--radius-control)] border px-3 py-2 text-xs ${testResult.ok ? 'border-line bg-surface-2' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'}`}>
              <p className={`mb-1.5 flex items-center gap-1 font-medium ${testResult.ok ? 'text-zinc-600 dark:text-zinc-300' : ''}`}>
                {testResult.ok ? '返回内容（点值插入路径）' : '请求失败'}
              </p>
              <div className="max-h-48 overflow-y-auto">
                {testResult.ok ? (
                  <ul className="grid gap-0.5">
                    {flattenJson(safeParse(testResult.text)).map(([path, preview], i) => (
                      <li key={`${path}.${i}`}>
                        <button
                          type="button"
                          onClick={() => insertPath(path.replace(/\.…$/, ''))}
                          className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          title={`插入 {${path}}`}
                        >
                          <code className="readout shrink-0 text-[11px] text-signal-600 dark:text-signal-300">{path}</code>
                          <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{preview}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="break-all">{testResult.text}</p>
                )}
              </div>
            </div>
          )}

          {/* ── 卡片模板 ── */}
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex items-center gap-2">
              <p className="micro-label flex-1">卡片模板（每张渲一帧，135×240）</p>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => {
                  const n = draft.cards.length
                  patch({ cards: [...draft.cards, newCard(`card-${n + 1}`, `卡 ${n + 1}`)] })
                }}
              >
                + 加一张
              </button>
            </div>
            {draft.cards.map((card, ci) => (
              <div key={ci} className="mb-3 rounded-[var(--radius-control)] border border-line bg-surface-2/60 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    className="input w-28 py-1 text-xs"
                    value={card.label}
                    maxLength={20}
                    onChange={(e) => patchCard(ci, { label: e.target.value })}
                    aria-label="卡名"
                    onFocus={() => setFocusKey(`c${ci}-label`)}
                    ref={(el) => {
                      focusRef.current[`c${ci}-label`] = el
                    }}
                  />
                  <input
                    className={`input w-32 py-1 font-mono text-xs ${dupIds.has(card.id) ? 'border-red-400' : ''}`}
                    value={card.id}
                    maxLength={20}
                    onChange={(e) => patchCard(ci, { id: e.target.value.trim().replace(/\s+/g, '-') })}
                    aria-label="卡 ID（配方引用用）"
                    title="卡 ID：槽位配方按它挑卡，不能重复"
                    onFocus={() => setFocusKey(`c${ci}-id`)}
                    ref={(el) => {
                      focusRef.current[`c${ci}-id`] = el
                    }}
                  />
                  <div className="flex-1" />
                  <span className="flex shrink-0 flex-col leading-none">
                    <button
                      type="button"
                      aria-label="上移这张卡"
                      className="text-[8px] text-zinc-400 hover:text-signal-600 disabled:opacity-30"
                      disabled={ci === 0}
                      onClick={() => {
                        const cards = [...draft.cards]
                        ;[cards[ci - 1], cards[ci]] = [cards[ci]!, cards[ci - 1]!]
                        patch({ cards })
                      }}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label="下移这张卡"
                      className="text-[8px] text-zinc-400 hover:text-signal-600 disabled:opacity-30"
                      disabled={ci === draft.cards.length - 1}
                      onClick={() => {
                        const cards = [...draft.cards]
                        ;[cards[ci], cards[ci + 1]] = [cards[ci + 1]!, cards[ci]!]
                        patch({ cards })
                      }}
                    >
                      ▼
                    </button>
                  </span>
                  {draft.cards.length > 1 && (
                    <button
                      type="button"
                      className="text-xs text-zinc-400 transition-colors hover:text-red-500"
                      onClick={() => patch({ cards: draft.cards.filter((_, i) => i !== ci) })}
                      title="删除这张卡"
                    >
                      <IconDelete className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {/* 配色（简化：三色 = 背景/文字/强调） */}
                <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="shrink-0">配色</span>
                  {(['bgA', 'fg', 'accent'] as const).map((key) => (
                    <input
                      key={key}
                      type="color"
                      className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
                      value={card.theme?.[key] ?? (key === 'bgA' ? '#0d1b2a' : key === 'fg' ? '#e8f2ff' : '#37c3ff')}
                      onChange={(e) => patchCard(ci, { theme: { ...card.theme, [key]: e.target.value } })}
                      title={key === 'bgA' ? '背景（亮端）' : key === 'fg' ? '文字' : '强调色'}
                      aria-label={key}
                    />
                  ))}
                  <span className="flex-1" />
                  <span className="text-[10px] text-zinc-400">{card.blocks.length} 块</span>
                </div>

                {/* 内容块 */}
                <div className="flex flex-col gap-1.5">
                  {card.blocks.map((b, bi) => (
                    <div key={bi} className="flex items-center gap-1.5">
                      <select
                        className="input w-auto py-1 text-xs"
                        value={b.kind}
                        onChange={(e) => {
                          const kind = e.target.value as DataFeedBlock['kind']
                          patchBlock(ci, bi, kind === 'gap' ? { kind, h: 8 } : { kind, text: '' })
                        }}
                        aria-label="块类型"
                      >
                        <option value="label">标签</option>
                        <option value="hero">大字</option>
                        <option value="body">正文</option>
                        <option value="caption">注脚</option>
                        <option value="emoji">emoji</option>
                        <option value="gap">留空</option>
                      </select>
                      {b.kind !== 'gap' && (
                        <input
                          className="input flex-1 py-1 text-xs"
                          value={'text' in b ? b.text : ''}
                          maxLength={200}
                          placeholder="支持 {路径} 取接口数据"
                          onChange={(e) => patchBlock(ci, bi, { kind: b.kind, text: e.target.value } as Partial<DataFeedBlock>)}
                          onFocus={() => setFocusKey(`c${ci}-b${bi}`)}
                          ref={(el) => {
                            focusRef.current[`c${ci}-b${bi}`] = el
                          }}
                        />
                      )}
                      {/* 块级覆盖：颜色 + 对齐（留空 = 随卡） */}
                      {b.kind !== 'gap' && (
                        <>
                          <input
                            type="color"
                            className="h-5 w-7 shrink-0 cursor-pointer rounded border border-line bg-transparent"
                            value={'color' in b && b.color ? b.color : '#8fb3d9'}
                            onChange={(e) => patchBlock(ci, bi, { kind: b.kind, color: e.target.value } as Partial<DataFeedBlock>)}
                            title="这块的文字颜色（缺省随配色）"
                            aria-label={`块 ${bi + 1} 颜色`}
                          />
                          <select
                            className="input w-auto shrink-0 py-0.5 text-[10px]"
                            value={'align' in b ? b.align ?? 'center' : 'center'}
                            onChange={(e) =>
                              patchBlock(ci, bi, { kind: b.kind, align: e.target.value as 'left' | 'center' | 'right' } as Partial<DataFeedBlock>)
                            }
                            aria-label={`块 ${bi + 1} 对齐`}
                            title="对齐"
                          >
                            <option value="center">居中</option>
                            <option value="left">居左</option>
                            <option value="right">居右</option>
                          </select>
                        </>
                      )}
                      <span className="flex shrink-0 flex-col leading-none">
                        <button
                          type="button"
                          aria-label="上移这块"
                          className="text-[8px] text-zinc-400 hover:text-signal-600 disabled:opacity-30"
                          disabled={bi === 0}
                          onClick={() => {
                            const blocks = [...card.blocks]
                            ;[blocks[bi - 1], blocks[bi]] = [blocks[bi]!, blocks[bi - 1]!]
                            patchCard(ci, { blocks })
                          }}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          aria-label="下移这块"
                          className="text-[8px] text-zinc-400 hover:text-signal-600 disabled:opacity-30"
                          disabled={bi === card.blocks.length - 1}
                          onClick={() => {
                            const blocks = [...card.blocks]
                            ;[blocks[bi], blocks[bi + 1]] = [blocks[bi + 1]!, blocks[bi]!]
                            patchCard(ci, { blocks })
                          }}
                        >
                          ▼
                        </button>
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-[11px] text-zinc-400 transition-colors hover:text-red-500 disabled:opacity-30"
                        disabled={card.blocks.length <= 1}
                        onClick={() => patchCard(ci, { blocks: card.blocks.filter((_, j) => j !== bi) })}
                        title="删除这块"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="self-start text-[11px] text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
                    onClick={() =>
                      patchCard(ci, { blocks: [...card.blocks, { kind: 'caption', text: '' } as DataFeedBlock] })
                    }
                  >
                    + 加一行
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </Modal>
  )
}

function safeParse(maybeJsonWithPrefix: string): unknown {
  const json = maybeJsonWithPrefix.replace(/^HTTP \d+[^·]*· /, '')
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/* ── 列表 + 入口 ──────────────────────────────────────────────────────────── */

export function DataFeedManager({
  open,
  onClose,
  pickId,
}: {
  open: boolean
  onClose: () => void
  /** 选好数据源回填（槽位配方引用）；不传 = 纯管理。 */
  pickId?: (id: string) => void
}): ReactElement | null {
  const [defs, setDefs] = useState<DataFeedDef[]>([])
  const [editing, setEditing] = useState<DataFeedDef | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DataFeedDef | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setDefs(await listDataFeedDefs())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  if (!open) return null

  return (
    <>
      <Modal isOpen onClose={onClose} ariaLabel="自定义数据源" contentClassName="flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden p-5">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="flex-1 text-base font-semibold text-zinc-900 dark:text-zinc-50">自定义数据源</h3>
            <button type="button" className="btn-ghost btn-sm" onClick={onClose}>关闭</button>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            数据源 = 接口 + 卡片模板。配置好之后在投屏槽位选「自定义接口」引用它 ——
            「自动」轮播即可按你的接口数据换卡展示。
          </p>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="py-6 text-center text-xs text-zinc-400">载入中…</p>
            ) : defs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <span className="opacity-30"><IconPlug className="h-10 w-10" /></span>
                <p className="text-xs text-zinc-400">还没有数据源</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {defs.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2/60 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{d.name}</span>
                      <span className="readout block truncate text-[11px] text-zinc-400">{d.url}</span>
                    </span>
                    {pickId && (
                      <button
                        type="button"
                        className="btn-primary btn-sm shrink-0"
                        onClick={() => {
                          pickId(d.id)
                          onClose()
                        }}
                      >
                        选它
                      </button>
                    )}
                    <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void readDataFeedDef(d.id).then((v) => v && setEditing(v))}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
                      title="复制"
                      onClick={() =>
                        void duplicateDataFeedDef(d.id).then(() => reload())
                      }
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-zinc-400 transition-colors hover:text-red-500"
                      title="删除"
                      onClick={() => setDeleteTarget(d)}
                    >
                      <IconDelete className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button type="button" className="btn-primary mt-3 min-h-11 w-full text-sm" onClick={() => setEditing(newDef(`数据源 ${defs.length + 1}`))}>
            ＋ 新建数据源
          </button>
        </div>
      </Modal>

      {editing && <FeedEditor def={editing} onClose={() => { setEditing(null); void reload() }} />}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个数据源？"
        body={`「${deleteTarget?.name ?? ''}」将被删除；引用它的槽位会显示「数据源已被删除」占位帧。`}
        confirmLabel="删除"
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteDataFeedDef(deleteTarget.id)
            setDeleteTarget(null)
            void reload()
          }
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  )
}
