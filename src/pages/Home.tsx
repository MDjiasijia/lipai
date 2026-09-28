import type { ReactElement } from 'react'
/**
 * 素材库首页：单列 list，直接展示全部内容（无二级页面）。
 * 每条 = 立牌实时走时（6 管并排，每秒读表换帧）+ 标题/标签/署名 + 下载 + 导入 + 收藏。
 *
 * 与 share-web 版的差别：社交退役（点赞→收藏星标、评论删除、isOwner 归属判断删除），
 * 数据源换本地库 /api/library（listLibrary）；排序两档 最新(new)/收藏(starred)
 * （人气榜与名次角标随点赞一起删除）；导入从「我的图组」扩展为「本地配置/图组」
 * （importToLibrary，服务端落盘 ~/.lipai/）。
 * 筛选状态全部从 URL hash 派生（此前是镜像 state + mount-only effect：
 * 标签链接改了 URL 列表却不重筛、筛选变化触发两次请求 —— 一次派生两处修好）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryItem, LibraryPreviewGroup } from '../lib/api'
import {
  listLibrary,
  downloadLibraryItem,
  downloadLibraryItemBytes,
  toggleStar,
  deleteLibraryItem,
  getLibraryItem,
  useHashRoute,
  navigate,
} from '../lib/api'
import { timeAgo } from '../lib/time'
import { frameUrl } from '../lib/frame'
import NixieTube from '../components/NixieTube'
import { ImportButton } from '../components/ImportButton'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { toast } from '../components/ui/Toast'
import { EmptyState, ErrorBox, LoadingInline } from '../components/ui/StateViews'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import {
  IconDownload,
  IconStarFill,
  IconStarLine,
  IconDelete,
  IconBoard,
  IconShare,
} from '../components/icons'
import { setLiveRail } from '../lib/liveRailStore'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Spinner'

/** 展台 label 里的组名：语义名（图组名 / 槽位配方名）优先，旧记录缺失回落「槽位 N / 图组 N」 */
function groupLabel(idx: number, previews: { slot: number; label?: string }[]): string {
  const g = previews[idx]
  if (!g) return ''
  if (g.label) return g.label
  return g.slot >= 0 && g.slot < 4 ? `槽位 ${g.slot + 1}` : `图组 ${idx + 1}`
}

/** 分享文件按钮可见性（模块级判定一次）：Web Share level 2（files）可用才渲染。
 *  老桌面 Firefox / 内嵌 WKWebView 无 navigator.share，隐藏不占位。 */
const CAN_SHARE_FILE =
  typeof navigator !== 'undefined' &&
  typeof navigator.share === 'function' &&
  typeof navigator.canShare === 'function' &&
  navigator.canShare({ files: [new File([''], 'probe.json', { type: 'application/json' })] })

/** 空帧组常量（rec.previews 缺失时的稳定引用 —— 渲染期每次 `?? []` 新建数组
 *  会让补帧 effect 的依赖反复变化，触发重复请求） */
const NO_PREVIEWS: LibraryPreviewGroup[] = []

/** 列表条目 → 展台帧组（缺省第 0 组；服务端未带 previews 时为空数组，行内回落详情补全） */
function listPreviews(rec: LibraryItem): LibraryPreviewGroup[] {
  return rec.previews ?? NO_PREVIEWS
}

/** 单条素材：立牌 + 信息 + 内联操作（memo：无限滚动长列表不因父级 state 重渲染逐行刷新） */
const LibraryRow = memo(function LibraryRow({
  rec,
  isHighlighted,
  onDeleted,
}: {
  rec: LibraryItem
  isHighlighted?: boolean
  onDeleted?: (id: string) => void
}): ReactElement {
  const [starred, setStarred] = useState(rec.starred)
  const [starBusy, setStarBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadMsg, setDownloadMsg] = useState('')
  const [sharing, setSharing] = useState(false)
  // 本地库全部可删（无归属判断；ConfirmDialog 原语，替代行内两段确认的误触风险）
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // 帧组（多图组 / 多槽位可切换）：列表瘦身只带第 0 组帧（src/lib/slim.ts 协议），
  // 其余组为 frames: [] 占位 —— 切到空组时按需拉详情补全（每行至多一次）
  const [groupIdx, setGroupIdx] = useState(0)
  const [fullPreviews, setFullPreviews] = useState<LibraryPreviewGroup[] | null>(null)
  // 行内 previews 引用（rec.previews 可能缺失 → 空数组；详情补全后 fullPreviews 优先）
  const recPreviews = listPreviews(rec)
  const previews = fullPreviews ?? recPreviews
  const tubeFrames = previews[Math.min(groupIdx, Math.max(0, previews.length - 1))]?.frames ?? []
  // 当前组正在懒加载详情补全（避免闪「无预览帧」误导文案）
  const [groupLoading, setGroupLoading] = useState(false)
  // 补帧失败（离线且详情未缓存）：给可重试的错误态，不静默吞掉 ——
  // 静默时切组看起来「没反应/出错」，用户不知道是断网所致
  const [groupError, setGroupError] = useState(false)
  // 重试计数（错误态的重试钮 bump 它重跑补帧 effect —— fullPreviews 已是 null，改它不会再触发）
  const [groupRetry, setGroupRetry] = useState(0)
  // 翻面状态提升到 LibraryRow：NixieTube 的翻面按钮此前绝对定位在组件内部
  // （嵌在 stage button 里是非法嵌套 button，还被 overflow-hidden 裁掉）
  const [face, setFace] = useState<'front' | 'back'>('front')

  // 首帧占位（列表瘦身后 previews[0] 有帧；服务端完全未带 previews 时无占位 → 拉详情）
  const thumb = tubeFrames[0] ?? null

  // 补帧 effect：目标组无帧且未补全过 → 拉详情（依赖用拆开的稳定值，
  // 整个 rec 进依赖会在父级重渲染换引用时反复触发补帧请求）
  useEffect(() => {
    const target = recPreviews[groupIdx]
    if (!target || target.frames.length > 0 || fullPreviews) {
      setGroupLoading(false)
      setGroupError(false)
      return
    }
    let dead = false
    setGroupLoading(true)
    setGroupError(false)
    getLibraryItem(rec.id)
      .then((full) => {
        if (!dead) setFullPreviews(full.previews)
      })
      .catch(() => {
        if (!dead) setGroupError(true)
      })
      .finally(() => {
        if (!dead) setGroupLoading(false)
      })
    return () => {
      dead = true
    }
  }, [groupIdx, groupRetry, rec.id, recPreviews, fullPreviews])

  // 收藏状态：列表接口已随行返回（不再每行单独查）
  useEffect(() => {
    setStarred(rec.starred)
  }, [rec.id, rec.starred])

  // 全局展台（liveRailStore）：owner = 这条素材的 id ——
  // 挂载/懒加载补帧是背景写入（不抢别人）；点 chips/封面是显式选择（force 抢占）。
  // 修复：多条素材同时挂载/补帧时最后写入者无条件覆盖 → 「切了组但展台没变/串了」。
  const writeRail = useCallback(
    (force: boolean) => {
      if (tubeFrames.length > 0) {
        setLiveRail(
          {
            frames: tubeFrames,
            owner: rec.id,
            label: `${rec.title} · ${groupLabel(previews.length > 1 ? groupIdx : 0, previews)}`,
          },
          { force },
        )
      }
    },
    [tubeFrames, rec.id, rec.title, groupIdx, previews],
  )
  /** 显式选择标记：chips/封面点击后下一次写入 force（切组 / 上展台） */
  const forceNext = useRef(false)
  useEffect(() => {
    writeRail(forceNext.current)
    forceNext.current = false
  }, [writeRail])

  // 收藏星标（乐观更新 + 失败回滚；幂等切换由服务端保证，失败只回滚本地显示）
  const doStar = async () => {
    if (starBusy) return
    setStarBusy(true)
    const next = !starred
    setStarred(next)
    try {
      const s = await toggleStar(rec.id)
      setStarred(s.starred)
    } catch {
      setStarred(!next)
      toast('收藏操作失败（本地服务不可达）', 'error')
    } finally {
      setStarBusy(false)
    }
  }

  const doDownload = async () => {
    if (downloading) return
    setDownloading(true)
    setDownloadMsg('')
    try {
      await downloadLibraryItem(rec.id, rec.title)
      setDownloadMsg('已开始下载')
    } catch (e) {
      setDownloadMsg(e instanceof Error ? e.message : '下载失败')
    } finally {
      setDownloading(false)
    }
  }

  // 系统分享面板（Web Share API level 2：files）—— 弹 AirDrop/微信/存储文件
  // 不可用的环境（老 Firefox / 桌面 WKWebView）渲染时即隐藏，不占位
  const doShare = async () => {
    if (sharing) return
    setSharing(true)
    setDownloadMsg('')
    try {
      // 复用下载字节链路（含 OPFS 副本写入 + 下载计数）；title 给系统面板显示
      const blob = await downloadLibraryItemBytes(rec.id)
      const file = new File([blob], `${rec.title.replace(/[\\/:*?"<>|\s]+/g, '_')}.json`, {
        type: 'application/json',
      })
      if (!navigator.canShare({ files: [file] })) {
        setDownloadMsg('此环境不支持分享文件')
        return
      }
      await navigator.share({ files: [file], title: rec.title })
      setDownloadMsg('已打开系统分享')
    } catch (e) {
      // AbortError = 用户取消面板，不算失败不提示
      if (e instanceof DOMException && e.name === 'AbortError') return
      setDownloadMsg(e instanceof Error ? e.message : '分享失败')
    } finally {
      setSharing(false)
    }
  }

  const isProfile = rec.type === 'lipai-profile'

  const doDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await deleteLibraryItem(rec.id)
      toast('已从本地库移除', 'ok')
      onDeleted?.(rec.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error')
    } finally {
      setDeleting(false)
      setConfirmOpen(false)
    }
  }

  return (
    <article
      // 无模糊卡（性能铁律：无限列表不逐行 backdrop-blur；辉光感由 stage 与线脚承担）
      className={`card-flat group relative content-visibility-auto overflow-hidden transition-shadow ${
        isHighlighted ? 'ring-2 ring-signal-500' : ''
      }`}
      style={{ containIntrinsicSize: 'auto 320px' }}
      ref={(el) => {
        if (el && isHighlighted) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }}
    >
      {/* 液态玻璃斜向光：左上冷光 + 右下暖光（内容之下） */}
      <span aria-hidden className="glass-tint pointer-events-none absolute inset-0 z-0" />

      <div className="relative z-10 flex flex-col gap-0 sm:flex-row">
        {/* 左：活钟走时（6 管实拍形态，每秒读表换帧）+ 组切换。
            活钟是首页的灵魂 ——「每一条都在用真实时间走时」的展厅叙事；
            点击整块展台 = 送当前组上全局展台（LiveRail 常驻 header 下）。
            face 由 LibraryRow 持有（翻面按钮在展台底部，不再嵌进 stage button）。
            展台是行的主角：lg 起占行宽 60%（文字侧吃剩余），不再「吃文字剩下的」。 */}
        <div className="stage-frame relative z-0 m-3 flex min-w-0 flex-col items-center justify-center gap-2 p-3 pb-4 sm:mb-3 sm:flex-[3]">
          <span aria-hidden className="stage absolute inset-0" />
          <button
            type="button"
            onClick={() => {
              forceNext.current = true
              setGroupIdx(groupIdx)
              writeRail(true)
            }}
            title={`在展台播放「${rec.title}」${previews.length > 1 ? '（可切组）' : ''}`}
            className="relative flex w-full flex-col items-center"
          >
            {tubeFrames.length > 0 ? (
              <NixieTube frames={tubeFrames} theme="dark" face={face} />
            ) : groupLoading ? (
              <span className="flex w-full flex-col items-center gap-2 py-10 text-center">
                <span className="text-3xl opacity-40">
                  <IconBoard />
                </span>
                <p className="text-xs text-zinc-500">帧组载入中…</p>
              </span>
            ) : groupError ? (
              <span className="flex w-full flex-col items-center gap-2 py-10 text-center">
                <span className="text-3xl opacity-40">
                  <IconBoard />
                </span>
                <p className="text-xs text-zinc-500">这组帧还没缓存，离线时载入失败</p>
                <button
                  type="button"
                  className="btn-ghost btn-sm mt-1"
                  onClick={() => setGroupRetry((n) => n + 1)}
                >
                  联网后重试
                </button>
              </span>
            ) : (
              <span className="flex w-full flex-col items-center gap-2 py-10 text-center">
                {thumb ? (
                  <img
                    src={frameUrl(thumb)}
                    alt={rec.title}
                    loading="lazy"
                    className="rounded-[var(--radius-control)] border border-zinc-700 object-cover"
                    style={{ height: 160, aspectRatio: '135 / 240' }}
                  />
                ) : (
                  <span className="text-3xl opacity-40">
                    <IconBoard />
                  </span>
                )}
                <p className="text-xs text-zinc-500">该文件无预览帧，显示以设备实机为准</p>
              </span>
            )}
          </button>
          {/* 展台底部操作排：组切换（翻面钮不在这排 —— 固定在展台右下角，见下） */}
          <div className="relative z-10 flex flex-wrap items-center justify-center gap-1 pl-6 pr-[4.5rem]">
            {previews.length > 1 &&
              previews.map((g, i) => (
                <button
                  key={`${g.slot}-${i}`}
                  type="button"
                  onClick={() => {
                    forceNext.current = true
                    setGroupIdx(i)
                  }}
                  aria-pressed={i === groupIdx}
                  title={groupLabel(i, previews)}
                  className={`chip-xs chip border border-transparent active:scale-[0.97] ${
                    i === groupIdx
                      ? 'chip-on'
                      : 'bg-white/10 text-zinc-300 hover:bg-white/25 hover:text-white'
                  }`}
                >
                  {groupLabel(i, previews)}
                </button>
              ))}
          </div>
          {/* 翻面钮固定展台右下角（与 NixieTube 自带翻面钮/LiveRail 同位同语言）：
              不跟组 chips 混排 —— chips 多时换行导致钮位漂移 */}
          {tubeFrames.length > 0 && (
            <button
              type="button"
              onClick={() => setFace((f) => (f === 'front' ? 'back' : 'front'))}
              className="absolute bottom-3 right-3 z-20 rounded-full border border-white/15 bg-black/50 px-2 py-[3px] text-[9px] leading-none text-zinc-300 backdrop-blur-sm transition-colors hover:bg-black/70 hover:text-white"
              title={face === 'front' ? '查看背面（电路板）' : '返回正面'}
            >
              {face === 'front' ? '翻到背面 →' : '← 翻回正面'}
            </button>
          )}
        </div>

        {/* 右：信息 + 操作（sm 起与展台 3:2 分成 = 文字侧 40%；min-w-0 保证长标题正常截断） */}
        <div className="flex min-w-0 flex-col gap-4 p-5 sm:flex-[2]">
          <div className="flex items-start gap-2">
            <h2 className="flex-1 text-lg font-extrabold tracking-tight transition-colors group-hover:text-signal-600 dark:group-hover:text-signal-300">
              {rec.title}
            </h2>
            {/* 类型徽标：配置=signal 描边 / 图组=glow 描边（弃双渐变语言） */}
            <span
              className={`chip-xs chip mt-0.5 border ${
                isProfile
                  ? 'border-signal-500/40 text-signal-600 dark:text-signal-300'
                  : 'border-glow-500/40 text-glow-600 dark:text-glow-400'
              }`}
            >
              {isProfile ? '配置' : '图组'}
            </span>
          </div>

          {rec.description && (
            <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{rec.description}</p>
          )}

          <div className="flex flex-wrap gap-1">
            {rec.tags.map((t) => (
              <a
                key={t}
                href={`#/?tag=${encodeURIComponent(t)}`}
                className="chip-xs chip bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              >
                #{t}
              </a>
            ))}
          </div>

          {/* 署名行：作者 + 读数（时间/下载/大小）一行疏散排开 —— 读数统一 readout 等宽语言。
              本地库无登录概念：署名就是录入时填的自由文本（可空），不存在归属/头像语义。 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {rec.author && (
              <span className="flex items-center gap-1.5">
                <span className="font-medium text-zinc-700 dark:text-zinc-200">{rec.author}</span>
                <span className="text-zinc-400">收录</span>
              </span>
            )}
            <span className="readout">{timeAgo(rec.createdAt)}</span>
            <span className="readout">{rec.downloads} 次下载</span>
            <span className="readout">{rec.size >= 1024 ? `${(rec.size / 1024).toFixed(0)} KB` : `${rec.size} B`}</span>
          </div>

          {/* 操作区：文件动作一行 + 本地动作一行（大小已上署名行，不再挤按钮行尾） */}
          <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                tone="primary"
                size="sm"
                isLoading={downloading}
                loadingLabel="下载中…"
                onClick={doDownload}
                className="shrink-0"
              >
                <IconDownload className="inline-block align-[-0.15em]" />
                下载分享文件
              </Button>
              {CAN_SHARE_FILE && (
                <Button tone="ghost" size="sm" isLoading={sharing} loadingLabel="准备中…" onClick={doShare} className="shrink-0">
                  <IconShare className="inline-block align-[-0.15em]" />
                  分享
                </Button>
              )}
              <ImportButton id={rec.id} type={rec.type} />
              {downloadMsg && (
                <span className="readout ml-auto text-right text-[11px] text-zinc-400">{downloadMsg}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={doStar}
                disabled={starBusy}
                aria-pressed={starred}
                className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-[color,background-color,border-color,box-shadow,transform] duration-[var(--duration-fast)] active:scale-[0.97] ${
                  starred
                    ? 'bg-glow-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(217,119,6,0.4),0_5px_12px_-6px_rgba(217,119,6,0.5)] hover:bg-glow-600'
                    : 'border border-line bg-surface-2 text-zinc-600 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] hover:border-glow-200 hover:bg-glow-50 hover:text-glow-600 dark:text-zinc-300 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:hover:border-glow-800 dark:hover:bg-glow-950/40 dark:hover:text-glow-300'
                } disabled:opacity-60`}
                title={starred ? '取消收藏（从「收藏」筛选移除）' : '收藏（「收藏」筛选可见）'}
              >
                <span className="inline-flex items-center transition-transform">{starred ? <IconStarFill /> : <IconStarLine />}</span>
                <span className="text-xs opacity-75">{starred ? '已收藏' : '收藏'}</span>
              </button>

              {/* 本地库全部可删（ConfirmDialog 原语；不再有 isOwner 归属判断） */}
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="ml-auto flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 py-1.5 text-xs text-zinc-400 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] transition-[color,background-color,border-color,box-shadow] hover:border-red-200 hover:bg-red-50 hover:text-red-500 dark:text-zinc-500 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:hover:border-red-900 dark:hover:bg-red-950/40"
                title="从本地库移除这条素材"
              >
                <IconDelete className="inline-block align-[-0.15em]" /> 移除
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="从本地库移除？"
        body={`「${rec.title}」将从本地素材库移除（删除库文件与索引，不可恢复）。已导入到本地配置/图组的内容不受影响。`}
        confirmLabel="移除"
        isConfirming={deleting}
        onConfirm={doDelete}
        onClose={() => setConfirmOpen(false)}
      />
    </article>
  )
})

export default function Home(): ReactElement {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 本页内容来自离线缓存（网络失败回落）—— 顶部细条标注 */
  const [fromCache, setFromCache] = useState(false)

  // ── 筛选全部从 URL 派生（不再镜像 state + mount-only effect）──
  // 标签链接 / 深链 / 收录回跳改 hash → useHashRoute 重渲染 → 派生值变 → queryKey 变 → 重载。
  // 修复：标签链接改了 URL 列表却不重筛（Home 不重挂载、effect 只跑一次）。
  // 默认「全部类型」：配置分享（可直接应用）与图组同权展示，不再默认只推图组
  const { query } = useHashRoute()
  const q = query.get('q') ?? ''
  const rawType = query.get('type')
  const type = rawType === 'all' ? '' : (rawType ?? '')
  const tag = query.get('tag') ?? ''
  const sort: 'new' | 'starred' = query.get('sort') === 'starred' ? 'starred' : 'new'
  /** 收录成功后跳回列表时高亮的新条目 id（?highlight=<id>） */
  const highlightId = query.get('highlight')
  const [inputDraft, setInputDraft] = useState(q)

  const queryKey = useMemo(() => `${q}|${type}|${tag}|${sort}`, [q, type, tag, sort])

  // 请求代次：筛选/sort 变化时自增，过期响应直接丢弃（防止旧 load 晚到覆盖新结果）
  const loadSeq = useRef(0)

  // 筛选变化 → 重置列表（同时作废旧请求）
  useEffect(() => {
    loadSeq.current += 1
    setItems([])
    setCursor(undefined)
    setExhausted(false)
    setError('')
    setFromCache(false)
    setLoading(true)
  }, [queryKey])

  const load = useCallback(
    async (cur: string | undefined) => {
      const seq = loadSeq.current
      try {
        const resp = await listLibrary({ cursor: cur, q: q || undefined, type: type || undefined, tag: tag || undefined, sort })
        if (seq !== loadSeq.current) return // 已切筛选，丢弃过期响应
        setItems((prev) => (cur ? [...prev, ...resp.items] : resp.items))
        if (resp.nextCursor) setCursor(resp.nextCursor)
        else setExhausted(true)
        // 缓存回落 = 离线（或本地服务不可达）：标注给用户，联网重试后自动消失
        setFromCache(Boolean(resp.fromCache))
        setError('')
      } catch (e) {
        if (seq !== loadSeq.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [q, type, tag, sort],
  )

  // 首屏 / 筛选变化：只加载第 1 页。
  // 此前 [queryKey, cursor] 双依赖：筛选变化先重置 cursor → 本 effect 再跑一次 = 一次筛选两次请求。
  // load 随 queryKey 变化重载第 1 页（闭包读最新值；本项目 eslint 未装 react-hooks 插件，不写 disable 指令）
  useEffect(() => {
    void load(undefined)
  }, [queryKey])

  // 无限滚动（useInfiniteScroll 收口）：哨兵进入预载带 → 用当前 cursor 加载下一页
  const sentinel = useInfiniteScroll({
    onLoadMore: () => void load(cursor),
    hasMore: Boolean(cursor) && !exhausted,
  })

  // 筛选写入 URL（navigate 触发 hashchange → 派生值重算 → queryKey 变化重载；
  // 此前 replaceState 静默 —— 纯 URL 派生下它会让列表永远不刷新）
  const applyFilters = (nq: string, ntype: string, ntag: string, nsort: 'new' | 'starred' = sort) => {
    const sp = new URLSearchParams()
    if (nq) sp.set('q', nq)
    // 空字符串 = 全部类型（默认），URL 不存 type；显式选类型才写入
    if (ntype) sp.set('type', ntype)
    if (ntag) sp.set('tag', ntag)
    if (nsort !== 'new') sp.set('sort', nsort)
    navigate(`/?${sp.toString()}`)
  }

  const submitSearch = () => applyFilters(inputDraft.trim(), type, tag)

  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) for (const t of it.tags) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [items])

  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 pt-8">
      {/* Hero：标题 + 一句话说明（窄屏单行流式；后半段品牌渐变文字） */}
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight sm:text-[2rem] sm:leading-tight">
          本地{' '}
          <span className="text-brand-gradient">
            立牌素材库
          </span>
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          每一组立牌都在用真实时间走时 —— 把别人分享的 v2 文件收进本地库，在线预览 6 管辉光效果、一键下载或导入设备。
        </p>
      </div>

      {/* 搜索与筛选 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <form
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            submitSearch()
          }}
        >
          {/* 浮动标签：focus 或有内容时，placeholder 缩小飘到上边框（legend 效果） */}
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden>
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <input
              id="search-input"
              className="input peer min-h-11 !rounded-2xl !py-2.5 !pl-10 !pr-24 placeholder-transparent"
              placeholder="搜索标题 / 描述 / 标签"
              value={inputDraft}
              onChange={(e) => setInputDraft(e.target.value)}
            />
            {/* 浮动 label：空态居中于输入框，focus/有内容时飘到上边框。
                peer-placeholder-shown = 空态；peer-focus = 聚焦；not-placeholder-shown 用 peer-[:not(:placeholder-shown)] 不可靠，改数据属性 */}
            <label
              htmlFor="search-input"
              data-float={inputDraft ? '1' : undefined}
              className="pointer-events-none absolute left-10 top-1/2 origin-left -translate-y-1/2 select-none text-sm text-zinc-400 transition-all duration-150
                peer-focus:left-3.5 peer-focus:top-0 peer-focus:scale-[0.85] peer-focus:bg-white peer-focus:px-1.5 peer-focus:text-signal-700
                data-[float]:left-3.5 data-[float]:top-0 data-[float]:scale-[0.85] data-[float]:bg-white data-[float]:px-1.5
                dark:peer-focus:bg-zinc-900 dark:data-[float]:bg-zinc-900 dark:peer-focus:text-signal-300"
            >
              搜索标题 / 描述 / 标签
            </label>
            <button
              type="submit"
              className="btn-primary absolute right-1.5 top-1/2 !min-h-[2.5rem] !rounded-full !px-4 -translate-y-1/2"
            >
              搜索
            </button>
          </div>
        </form>
        <div className="flex items-center gap-2.5">
          {/* 类型筛选：三档互斥 → 玻璃分段控件（内凹槽 + 浮起镜片，对齐排序档） */}
          <SegmentedControl
            ariaLabel="类型筛选"
            value={type}
            onChange={(v) => applyFilters(q, v, tag)}
            segments={[
              { value: '' as const, label: '全部', hint: '图组与配置都显示' },
              { value: 'lipai-gallery' as const, label: '图组', hint: '立屏图片组（.lipai.json 图组文件）' },
              { value: 'lipai-profile' as const, label: '配置', hint: '4 槽位完整配方（.lipai.json 配置文件）' },
            ]}
          />
          <a href="#/upload" className="btn-primary min-h-11 !rounded-full !py-2.5" title="收进一份分享文件">
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path
                d="M10 4v9M10 4L6.5 7.5M10 4l3.5 3.5M4 13.5v1A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            收进库
          </a>
        </div>
      </div>

      {/* 排序切换 + 标签筛选行（小屏横滚，不换行堆叠） */}
      <div className="mt-4 -mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {/* 排序：最新 / 收藏（SegmentedControl 原语，chip-on 选中；人气榜随点赞一起退役） */}
        <SegmentedControl
          className="shrink-0"
          ariaLabel="排序方式"
          value={sort}
          onChange={(k) => applyFilters(q, type, tag, k)}
          segments={[
            { value: 'new' as const, label: '最新' },
            { value: 'starred' as const, label: '收藏', hint: '只看收藏星标的素材' },
          ]}
        />

        {(tags.length > 0 || tag) && <span className="h-4 w-px shrink-0 bg-line-strong" aria-hidden />}

        {/* 标签筛选 */}
        {(tags.length > 0 || tag) && (
          <>
            <button
              type="button"
              onClick={() => applyFilters(q, type, '')}
              aria-pressed={!tag}
              className={`chip-sm chip border border-transparent shrink-0 ${!tag ? 'chip-on' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}
            >
              全部
            </button>
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => applyFilters(q, type, t)}
                aria-pressed={tag === t}
                className={`chip-sm chip border border-transparent shrink-0 active:scale-[0.97] ${
                  tag === t
                    ? 'chip-on'
                    : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
                }`}
              >
                {t}
              </button>
            ))}
          </>
        )}
      </div>

      {/* 错误提示（ErrorBox 原语，role=alert） */}
      {error && <div className="mt-4"><ErrorBox message={`加载失败：${error}`} retry="重试" onRetry={() => applyFilters(q, type, tag)} /></div>}

      {/* 离线标注：本次内容来自缓存（本地服务不可达时的回落）—— 恢复后刷新即为最新 */}
      {fromCache && items.length > 0 && (
        <div role="status" className="mt-4 flex items-center gap-2 rounded-[var(--radius-control)] border border-glow-500/40 bg-glow-500/10 px-3 py-2 text-xs text-glow-700 dark:text-glow-300">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-glow-400" />
          当前展示的是离线缓存内容（本地服务不可达）—— 服务恢复后刷新即为最新。
        </div>
      )}

      {/* 单列 list：每条内联立牌 + 操作。
          行内主次：展台 60% / 文字 40%（flex-[3]/flex-[2]）—— 展示空间优先给实物仿真 */}
      {items.length > 0 ? (
        <div className="mt-5 flex flex-col gap-5">
          {items.map((rec) => (
            <LibraryRow
              key={rec.id}
              rec={rec}
              isHighlighted={rec.id === highlightId}
              onDeleted={(id) => {
                setItems((prev) => prev.filter((it) => it.id !== id))
              }}
            />
          ))}
        </div>
      ) : (
        !loading && !error && (
          <EmptyState
            className="mt-16"
            icon={<IconBoard className="h-10 w-10" />}
            title={q || tag ? '没有符合筛选条件的素材' : '本地库还是空的，收进第一份吧'}
            hint={q || tag ? '换个关键词，或清除筛选看看全部内容' : '把别人分享的 v2 JSON 文件拖进「收进库」，在线预览 6 管辉光效果'}
            action={
              q || tag ? (
                <button type="button" className="btn-ghost btn-sm" onClick={() => applyFilters('', '', '', 'new')}>
                  清除筛选
                </button>
              ) : (
                <a href="#/upload" className="btn-primary min-h-11 px-6">+ 收进一份</a>
              )
            }
          />
        )
      )}

      {/* 无限滚动哨兵 */}
      <div ref={sentinel} className="h-1" />
      {/* 首屏加载 = 骨架屏（列表行形状占位：展台块 + 两行文本，比「加载中」文字少等待感）；
          形状与真实行同构（手机竖排：展台在上信息在下 —— sm 起才横排 3:2），
          换帧时不跳变；追加页加载（items 已有）走底部 LoadingInline */}
      {loading && items.length === 0 && (
        <div className="mt-4 flex flex-col gap-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-flat flex flex-col gap-4 p-4 sm:flex-row">
              <Skeleton variant="rect" className="h-56 w-full shrink-0 sm:h-56 sm:w-56 md:w-72 lg:w-80" />
              <div className="flex flex-1 flex-col gap-2.5 sm:py-1">
                <Skeleton variant="text" className="w-1/3" />
                <Skeleton variant="text" className="w-2/3" />
                <div className="mt-auto flex gap-2">
                  <Skeleton variant="rect" className="h-9 w-32 rounded-full" />
                  <Skeleton variant="rect" className="h-9 w-24 rounded-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {loading && items.length > 0 && <div className="mt-8"><LoadingInline label="加载中…" /></div>}
      {exhausted && items.length > 0 && (
        <p className="readout mt-8 text-center text-xs text-zinc-400">— 到底啦，共 {items.length} 条 —</p>
      )}
    </div>
  )
}
