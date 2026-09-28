import type { ReactElement } from 'react'
/**
 * 收进本地库页（原上传页语义改造）：拖入/选择 v2 JSON → 纯前端解析校验（与 API 同规则）
 * → 帧即时预览 → 填标题（缺省 profile.name / gallery.name）/描述/标签/署名
 * → 提交（带进度）→ 回素材库并高亮。
 *
 * 与 share-web 版的差别：语义从「公开发布」改为「把分享文件收进本地库」——
 * 署名默认「本地导入」（不再读登录态，本地库无登录概念）；
 * POST /api/library 由本地服务校验后落 ~/.lipai/library/。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { navigate, uploadToLibrary } from '../lib/api'
import { validateShareFile, validateFrameBitmaps } from '../lib/validate'
import { deriveTags } from '../lib/meta'
import type { ShareFile } from '../types'
import { slotSpecLabel } from '../lib/ips/profile-types'
import NixieTube from '../components/NixieTube'
import { IconBoard } from '../components/icons'
import { Progress } from '../components/ui/Progress'
import { ErrorBox } from '../components/ui/StateViews'
import { setLiveRail, clearLiveRail } from '../lib/liveRailStore'

/** 署名缺省（本地库无登录概念：不读 IAM，固定「本地导入」；手填可改） */
const DEFAULT_AUTHOR = '本地导入'

export default function Upload(): ReactElement {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ShareFile | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  // 引导文案：图组是库内主推内容，默认按图组引导
  const [hintKind, setHintKind] = useState<'gallery' | 'profile'>('gallery')

  // 表单
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [author, setAuthor] = useState(DEFAULT_AUTHOR)
  /** 用户手填过署名就不再重置回缺省（换文件时不霸占输入框） */
  const authorTouched = useRef(false)

  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  /** 上传进度（XHR upload.onprogress；此前 8MB JSON 慢链路只有按钮文字，像卡死） */
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 前端校验（与 API 同规则）：解析 → 预览 + 缺省标题/标签
  const handleFile = useCallback(async (f: File) => {
    setFile(f)
    setParsed(null)
    setErrors([])
    setSubmitErr('')
    const text = await f.text()
    const result = validateShareFile(text, f.size)
    if (!result.ok || !result.data) {
      setErrors(result.errors.length ? result.errors : ['文件校验未通过'])
      return
    }
    // 位图校验（同 API 规则）：解码帧确认 9:16 ±15%、尺寸 ≤ 300×600
    const frames = [
      ...(result.data.galleries ?? []).flatMap((g) => g?.frames ?? []),
      ...(result.data.previews ?? []).flatMap((pv) => (pv?.slots ?? []).flatMap((s) => s?.frames ?? [])),
      ...(result.data.profiles ?? []).flatMap((p) =>
        ((p as { previews?: { frames?: string[] }[] }).previews ?? []).flatMap((pv) => pv?.frames ?? []),
      ),
    ]
    const bitmapErrors = validateFrameBitmaps(frames)
    if (bitmapErrors.length > 0) {
      setErrors(bitmapErrors)
      return
    }
    const data = result.data
    setParsed(data)
    setHintKind(data.type === 'lipai-profile' ? 'profile' : 'gallery')
    // 缺省值：标题用 profile.name / gallery.name；标签用自动派生
    const fallbackTitle =
      data.shareMeta?.title ||
      (data.type === 'lipai-profile' ? data.profiles?.[0]?.name : data.galleries?.[0]?.name) ||
      ''
    setTitle(fallbackTitle)
    setDescription(data.shareMeta?.description ?? '')
    setTags(deriveTags(data).join(', '))
    // 署名缺省：手填过不覆盖 > 文件内 shareMeta.author > 固定缺省「本地导入」
    if (!authorTouched.current) {
      setAuthor(data.shareMeta?.author || DEFAULT_AUTHOR)
    }
  }, [])

  const previews = useMemo(() => {
    if (!parsed) return []
    if (parsed.type === 'lipai-gallery') {
      return (parsed.galleries ?? []).map((g, i) => ({ slot: i, frames: g.frames.filter(Boolean), label: g.name }))
    }
    // 顶层 previews（0.14.3+，按 profileId 关联）→ 旧导出回落读 profile 内嵌
    const out: { slot: number; frames: string[]; label?: string }[] = []
    const covered = new Set<string>()
    for (const pv of parsed.previews ?? []) {
      if (!pv || typeof pv.profileId !== 'string' || !Array.isArray(pv.slots)) continue
      const prof = (parsed.profiles ?? []).find((p) => p.id === pv.profileId)
      for (const s of pv.slots) {
        if (!s || typeof s.slot !== 'number' || !Array.isArray(s.frames)) continue
        const frames = s.frames.filter((f) => typeof f === 'string' && f.length > 0)
        if (frames.length > 0) {
          // 名称优先级：自定义槽位名 > 槽位配方语义名 > 配置名（与服务端 collectPreviews 同规则）
          const customName = typeof prof?.slotNames?.[s.slot] === 'string' ? prof.slotNames[s.slot].trim() : ''
          const specLabel = slotSpecLabel(prof?.slots?.[s.slot] ?? null)
          const label =
            customName || (specLabel !== '空槽位' ? specLabel : '') || (prof?.name ?? '')
          out.push({ slot: s.slot, frames, ...(label ? { label } : {}) })
          covered.add(pv.profileId)
        }
      }
    }
    for (const p of parsed.profiles ?? []) {
      if (covered.has(p.id)) continue
      for (const s of (p as { previews?: { slot: number; frames: string[] }[] }).previews ?? []) {
        if (!s || typeof s.slot !== 'number' || !Array.isArray(s.frames)) continue
        const frames = s.frames.filter((f) => typeof f === 'string' && f.length > 0)
        if (frames.length > 0) {
          const customName = typeof p.slotNames?.[s.slot] === 'string' ? p.slotNames[s.slot].trim() : ''
          const specLabel = slotSpecLabel(p.slots?.[s.slot] ?? null)
          const label = customName || (specLabel !== '空槽位' ? specLabel : '') || p.name
          out.push({ slot: s.slot, frames, ...(label ? { label } : {}) })
        }
      }
    }
    return out
  }, [parsed])

  const isProfile = parsed?.type === 'lipai-profile'
  const frameCount = useMemo(() => {
    if (!parsed) return 0
    return (parsed.galleries ?? []).reduce((n, g) => n + (g.frames?.length ?? 0), 0)
  }, [parsed])
  // 多图组 / 多槽位切换（与首页一致：默认第 0 组，可切换）
  const frameGroups = useMemo(() => previews.filter((p) => p.frames.length > 0), [previews])
  const [groupIdx, setGroupIdx] = useState(0)
  const tubeFrames = frameGroups[Math.min(groupIdx, Math.max(0, frameGroups.length - 1))]?.frames ?? []

  // 全局展台（liveRailStore）：收录预览的帧组上展台（与页内预览同一份）。
  // owner='upload' + label 不含 title —— 此前每敲一个键就重写全局展台。
  useEffect(() => {
    if (tubeFrames.length > 0) {
      setLiveRail({
        frames: tubeFrames,
        owner: 'upload',
        label: `收录预览 · ${parsed?.type === 'lipai-profile' ? '配置' : '图组'}`,
      })
    }
  }, [tubeFrames, parsed?.type])
  // 离开页面收走展台（不再永久残留「收录预览」）
  useEffect(() => () => clearLiveRail('upload'), [])

  const submit = async () => {
    if (!file || !parsed) return
    setSubmitting(true)
    setSubmitErr('')
    setUploadProgress({ sent: 0, total: file.size })
    try {
      const { id } = await uploadToLibrary(file, { title, description, tags, author }, (sent, total) =>
        setUploadProgress({ sent, total }),
      )
      navigate(`/?type=all&highlight=${id}`)
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
      setUploadProgress(null)
    }
  }

  const reset = () => {
    setFile(null)
    setParsed(null)
    setErrors([])
    setTitle('')
    setDescription('')
    setTags('')
    if (!authorTouched.current) setAuthor(DEFAULT_AUTHOR)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <h1 className="text-xl font-black tracking-tight">收进本地库</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
        {hintKind === 'profile' ? (
          <>
            检测到「配置分享文件」。也可以返回收进
            <button type="button" className="mx-1 text-signal-600 hover:underline" onClick={reset}>图组分享文件</button>
            —— 库内首推图组内容。
          </>
        ) : (
          <>
            把别人分享的「图组分享文件」（v2 JSON）拖到这里收进本地库，供预览、下载与导入设备；
            也支持「配置分享文件」。
          </>
        )}
      </p>

      {/* 第一步：选文件（液态玻璃展台，拖拽态亮起） */}
      {!file && (
        <div
          className={`glass mt-6 flex flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
            dragOver
              ? '!border-signal-500/70'
              : '!border-zinc-300/90 dark:!border-white/15'
          }`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void handleFile(f)
          }}
          role="button"
          tabIndex={0}
          aria-label="选择或拖入分享文件（JSON）"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
        >
          {/* 玻璃斜光覆层 */}
          <span aria-hidden className="glass-tint pointer-events-none absolute inset-0" />
          {/* 玻璃罩辉光管图标（与顶栏 logo 同源） */}
          <svg viewBox="0 0 30 30" className="relative h-14 w-14 drop-shadow-[0_0_14px_rgba(251,146,60,0.5)]" aria-hidden>
            <defs>
              <linearGradient id="up-glass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#e8f6ff" stopOpacity="0.95" />
                <stop offset="0.35" stopColor="#7dd3fc" stopOpacity="0.35" />
                <stop offset="1" stopColor="#0c4a6e" stopOpacity="0.55" />
              </linearGradient>
              <linearGradient id="up-flame" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#fef3c7" />
                <stop offset="0.55" stopColor="#fbbf24" />
                <stop offset="1" stopColor="#ea580c" />
              </linearGradient>
              <radialGradient id="up-halo" cx="0.5" cy="0.62" r="0.55">
                <stop offset="0" stopColor="#fdba74" stopOpacity="0.85" />
                <stop offset="1" stopColor="#fdba74" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="15" cy="15" r="10.5" fill="url(#up-halo)" className="logo-tube" />
            <path d="M9.5 24.5 v-11 a5.5 5.5 0 0 1 11 0 v11 z" fill="url(#up-glass)" stroke="rgba(255,255,255,0.75)" strokeWidth="1" />
            <g className="logo-tube">
              <rect x="13.4" y="9.5" width="3.2" height="12" rx="1.6" fill="url(#up-flame)" />
              <rect x="14.35" y="6.8" width="1.3" height="3.2" rx="0.65" fill="#fbbf24" opacity="0.9" />
            </g>
            <path d="M11.2 11.6 a4.2 4.2 0 0 1 3-3.4" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.2" strokeLinecap="round" />
            <rect x="7" y="24.5" width="16" height="2.6" rx="1.3" fill="#3f3f46" />
            <rect x="7" y="24.5" width="16" height="1" rx="0.5" fill="rgba(255,255,255,0.28)" />
          </svg>
          <p className="relative mt-4 text-sm font-medium text-zinc-600 dark:text-zinc-300">拖入分享文件到这里，或</p>
          <button type="button" className="btn-primary relative mt-3" onClick={() => inputRef.current?.click()}>
            选择 JSON 文件
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
              e.target.value = ''
            }}
          />
          <p className="relative mt-4 max-w-md text-xs text-zinc-500 dark:text-zinc-400">
            支持 lipai-profile / lipai-gallery v2 格式，文件 ≤ 8MB。
            别人从分享站下载的文件拖进来即收；本地库只读取与转发，不会改写文件内容。
          </p>
        </div>
      )}

      {/* 校验失败 */}
      {errors.length > 0 && (
        <div
          role="alert"
          className="mt-6 rounded-[var(--radius-control)] border border-red-500/40 bg-red-500/8 p-4 text-sm text-red-600 dark:text-red-400">
          <p className="font-medium">文件校验未通过：</p>
          <ul className="mt-1 list-inside list-disc text-xs leading-relaxed">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <button type="button" className="btn-ghost mt-3" onClick={reset}>重新选择文件</button>
        </div>
      )}

      {/* 第二步：预览 + 填写元数据 */}
      {parsed && (
        <div className="mt-6 grid gap-5 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {/* 即时预览（暮蓝→暖灰棕渐变展台 + 顶光，衬托玻璃罩高光，不死黑）；小屏置顶：先看到效果再填表 */}
          <div
            className="stage stage-frame relative order-first overflow-hidden p-4 md:order-none"
          >
            {/* 液态玻璃镜边：顶部一条内高光 */}
            <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-200">
              预览
              <span className={`chip-xs chip border ${isProfile ? 'border-signal-500/40 text-signal-600 dark:text-signal-300' : 'border-glow-500/40 text-glow-600 dark:text-glow-400'}`}>
                {isProfile ? '配置' : '图组'}
              </span>
            </div>
            {previews.length > 0 ? (
              <div className="flex w-full flex-col items-center gap-2">
                <NixieTube frames={tubeFrames} theme="dark" />
                {/* 多帧组切换（与首页一致） */}
                {frameGroups.length > 1 && (
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    {frameGroups.map((g, i) => (
                      <button
                        key={`${g.slot}-${i}`}
                        type="button"
                        onClick={() => setGroupIdx(i)}
                        className={`chip border border-transparent active:scale-[0.97] ${
                          i === groupIdx
                            ? 'chip-on'
                            : 'bg-white/10 text-zinc-400 hover:bg-white/20 hover:text-zinc-200'
                        }`}
                      >
                        {g.label ?? (g.slot >= 0 && g.slot < 4 ? `槽位 ${g.slot + 1}` : `图组 ${i + 1}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                className="flex flex-col items-center justify-center rounded-[var(--radius-control)] border border-dashed border-zinc-700 text-center"
                style={{ width: 'min(220px, 60vw)', aspectRatio: '135 / 240', margin: '0 auto' }}
              >
                <span className="text-2xl opacity-40"><IconBoard /></span>
                <p className="mt-2 px-3 text-xs text-zinc-400">无预览帧（旧格式文件）</p>
                <p className="mt-1 px-3 text-[11px] text-zinc-400">仍可收进库，设备实机显示为准</p>
              </div>
            )}
            <p className="mt-3 text-center text-[11px] text-zinc-300/90">
              {file?.name} · {(file!.size / 1024).toFixed(1)} KB
              {frameCount > 0 && ` · ${frameCount} 帧`}
            </p>
            <button
              type="button"
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] backdrop-blur-md transition-colors hover:border-white/40 hover:bg-white/20"
              onClick={reset}
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path
                  d="M4 10a6 6 0 1 1 1.76 4.24M4 10V6.5M4 10h3.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              换一个文件
            </button>
          </div>

          {/* 元数据表单（液态玻璃卡片） */}
          <div className="card-flat relative flex flex-col gap-3 overflow-hidden p-4">
            <div className="relative flex flex-col gap-3">
            <label className="block">
              <span className="text-xs font-medium">标题 *</span>
              <input
                className="input mt-1.5"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="缺省使用 profile.name / gallery.name"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">描述</span>
              <textarea
                className="input mt-1.5 min-h-20"
                value={description}
                maxLength={200}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="介绍这份素材的内容、适配的设备样式等（可选）"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">标签</span>
              <input
                className="input mt-1.5"
                value={tags}
                maxLength={200}
                onChange={(e) => setTags(e.target.value)}
                placeholder="逗号分隔，例如：天气, 图组"
              />
            </label>
            <label className="block">
              <span className="flex items-center gap-2 text-xs font-medium">
                署名
                <span className="chip-xs chip border border-line text-zinc-500 dark:text-zinc-400">本地库无登录概念，仅作展示</span>
              </span>
              <input
                className="input mt-1.5"
                value={author}
                maxLength={200}
                onChange={(e) => {
                  authorTouched.current = true
                  setAuthor(e.target.value)
                }}
                placeholder="默认「本地导入」，可修改"
              />
            </label>

            {submitErr && <ErrorBox message={submitErr} />}

            {uploadProgress && (
              <Progress
                value={uploadProgress.sent}
                total={uploadProgress.total}
                label="收进中"
              />
            )}

            {/* 提交钮边光（原 BorderBeam 组件的内联等义实现：border-beam 包未随本地化
                引入、不补依赖 —— 用渐变描边容器表达同一「可提交时边缘亮起」语义） */}
            <div
              className="relative mt-1 rounded-[10px] p-[2px] transition-opacity"
              style={{
                opacity: !submitting && Boolean(title.trim()) ? 1 : 0.5,
                background: 'linear-gradient(120deg, rgba(56,189,248,0.9), rgba(129,140,248,0.9))',
              }}
            >
              <button
                type="button"
                className="btn-primary min-h-11 w-full !rounded-[8px]"
                disabled={!title.trim() || submitting}
                onClick={submit}
              >
                {submitting ? '收进中…' : '收进本地库'}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              收进后即入库显示（~/.lipai/library/）。标题/描述/标签仅作展示，保存在索引侧表，不会写进你的分享文件；随时可从库中移除。
            </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
