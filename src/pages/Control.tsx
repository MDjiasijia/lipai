import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
/**
 * 设备控制台（#/control）：单页 Tab 布局（窄侧栏易用性优先）。
 *
 * 布局（自上而下，全在一个页面里，切 Tab 不丢状态、不重连）：
 *   TopBar 连接条（状态灯 + 设备名 + ● 屏:XX + 连接/断开）
 *   → SlotApplyBar 应用条（当前配置名 + 按配置应用全部槽位 + 导出收进本地库）
 *   → TabNav（投屏 / 自动 / 设备 / 日志）
 *   → Tab 内容
 *
 * 设备连接是全局单例（deviceStore）：这里只消费 useDevice()，
 * 从首页/用量页切回来连接还在 —— 修复了此前每页各建 IpsDevice 的问题。
 */
import { useDevice } from '../lib/ips/useDevice'
import { IconRefresh, StatusDot } from '../components/icons'
import type { DisplayProfile, SlotSpec, LoopConfig, DataFeedDef, SceneSchedule, SceneSlot } from '../lib/ips/profile-types'
import { SLOT_STYLE_NAMES, SOURCE_LABELS, defaultLoopConfig } from '../lib/ips/profile-types'
import { listDataFeedDefs } from '../lib/ips/datafeed-store'
import { DataFeedManager } from '../components/ips/DataFeedManager'
// 数据走服务端 API 客户端薄层（~/.lipai/ 唯一真源）：函数名与返回形状对齐 share-web 版。
import {
  getCurrentProfile,
  writeProfile,
  readProfile,
  listProfiles,
  setCurrentProfile,
  createProfile,
  duplicateProfile,
  deleteProfile,
} from '../lib/ips/profile-store'
import { listUserGalleries } from '../lib/ips/gallery-store'
import { slotCapacity } from '../lib/ips/pipeline'
import { renderSlotAsync as renderSlot } from '../lib/ips/render/worker-client'
import { bytesToB64, cropLocalImage } from '../lib/ips/local-files'
import type { FrameMeta } from '../lib/ips/pipeline'
import { SlotStrip } from '../components/ips/SlotStrip'
import { PreviewStrip } from '../components/ips/PreviewStrip'
import { SourcePicker } from '../components/ips/SourcePicker'
import { listGalleryThemes } from '../lib/ips/render/gallery-index'
import { listGalleryImages } from '../lib/ips/render/render'
import { listColorThemes, listCanvasTopics, generateCanvasTextsImpl, generateCanvasColorsImpl } from '../lib/ips/render/canvas-gen'
import { CITY_TO_LOCATION_ID } from '../lib/ips/render/weather'
import { listAnimationTypes } from '../lib/ips/render/render'
import { LoopRunner, loopMinIntervalSec, type LoopState } from '../lib/ips/loopRunner'
import { useWakeLock } from '../hooks/useWakeLock'
import { kvGet, kvPut } from '../lib/ips/db'
import { sanitizeLoopSteps, LOOP_SOURCES, isSlotStep } from '../lib/ips/loop'
import { SceneScheduler, type SceneScheduleState } from '../lib/ips/sceneScheduler'
import type { LoopStep } from '../lib/ips/loop'
import { useTabParam, exportPayload } from '../lib/api'
import { listWeatherCities } from '../lib/api-server'
import { setLiveRail, clearLiveRail } from '../lib/liveRailStore'
import { toast } from '../components/ui/Toast'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { Progress } from '../components/ui/Progress'
import { Modal } from '../components/ui/Modal'
import { Transition } from '../components/ui/Transition'
import { TabList } from '../components/ui/Tabs'
import { Switcher } from '../components/ui/Switcher'
import { Button } from '../components/ui/Button'
import { RangeSlider } from '../components/ui/RangeSlider'
import { RadioGroup } from '../components/ui/Radio'
import { Select } from '../components/ui/Select'
import { SegmentedControl } from '../components/ui/SegmentedControl'

type Tab = 'cast' | 'auto' | 'device'
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'cast', label: '内容', hint: '编辑 4 个槽位内容：选内容 → 预览 → 推送（无需连接即可编辑分享）' },
  { id: 'auto', label: '自动', hint: '轮播循环：切槽位与推新图混排（服务端常驻，页面关掉照跑）' },
  { id: 'device', label: '设备', hint: '亮度/灯效/时间/Wi-Fi/维护 + 通信日志（需连接）' },
  // 用量 Tab 随内部平台数据链一起退役
]

export default function Control({ initialTab }: { initialTab?: Tab } = {}): ReactElement {
  const {
    device,
    state: connState,
    info,
    error,
    available,
    connect,
    channel,
    bridge,
    serverDown,
    setChannel,
  } = useDevice()
  const connected = connState === 'connected'
  /** browser 通道才有「Web Bluetooth 不可用」提示；server 通道可用性看桥状态 */
  const browserUnavailable = channel === 'browser' && !available

  // 连接期间屏幕常亮（默认开）：投屏/调参盯着屏幕，灭了设备跟着走时
  // （轮播/时序依赖页面驱动）。设置存 IndexedDB settings；老设备无 wakeLock API 静默跳过
  const [keepAwake, setKeepAwake] = useState(true)
  useEffect(() => {
    void kvGet<boolean>('settings', 'controlKeepAwake').then((v) => {
      if (v !== undefined) setKeepAwake(v)
    })
  }, [])
  const toggleKeepAwake = useCallback(() => {
    setKeepAwake((v) => {
      const next = !v
      void kvPut('settings', 'controlKeepAwake', next)
      return next
    })
  }, [])
  useWakeLock(connected && keepAwake)

  // Tab 进 URL（#/control?tab=auto）：深链 / 后退键可用
  const [tabParam, setTabParam] = useTabParam('tab', ['cast', 'auto', 'device'])
  const tab: Tab = (tabParam ?? initialTab ?? 'cast') as Tab
  const setTab = setTabParam

  const [profile, setProfile] = useState<DisplayProfile | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; isDefault?: boolean }[]>([])
  const [editing, setEditing] = useState(0)
  const [galleries, setGalleries] = useState<{ name: string; frameCount: number }[]>([])
  const [applyState, setApplyState] = useState<{ done: number; total: number } | null>(null)

  // 连上设备即按存档静默恢复设备参数：设备断电/重启
  // 后不保持下过的参数（实测断电重启后时钟样式/灯效都不是存档值），观感就是
  // 「断电重连后配置变默认」。本地存档才是真相 —— 连接成功后重推一遍，
  // 全是毫秒级小帧，不重推槽位图（flash 断电也在，重推要 10-20 秒/槽位）。
  // 失败只 toast 一句：恢复是锦上添花，不能让连接本身报错。
  const profileRef = useRef<DisplayProfile | null>(null)
  profileRef.current = profile
  useEffect(() => {
    if (connState !== 'connected') return
    const p = profileRef.current
    if (!p?.deviceControl) return
    void applyDeviceControl(p).catch(() => {
      toast('设备参数恢复失败（不影响连接）', 'error')
    })
    // 只在连接成功那一刻恢复（不随其余依赖重跑）
  }, [connState])

  // 通知走全局 toast 原语（此前页内两套手写 toast，一套还被移动底栏遮住）
  const notify = useCallback((msg: string, kind?: 'info' | 'ok' | 'error') => toast(msg, kind), [])

  // 挂载：当前 profile + 配置列表 + 图组列表
  useEffect(() => {
    void (async () => {
      const p = await getCurrentProfile()
      if (p) {
        setProfile(p)
        setEditing(p.editingSlot ?? p.activeSlot ?? 0)
      }
      const list = await listProfiles()
      setProfiles(list.map((x) => ({ id: x.id, name: x.name, isDefault: x.isDefault })))
      const g = await listUserGalleries()
      setGalleries(g.map((x) => ({ name: x.name, frameCount: x.frameCount })))
    })()
  }, [])

  /** profile 落库（防抖 600ms） */
  const saveTimer = useRef<number | null>(null)
  const scheduleSave = useCallback((next: DisplayProfile) => {
    setProfile(next)
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void writeProfile({ ...next, updatedAt: Date.now() })
    }, 600)
  }, [])

  const slots = profile?.slots ?? [null, null, null, null]
  const spec: SlotSpec | null = slots[editing] ?? null

  const patchSpec = useCallback(
    (patch: Partial<SlotSpec>) => {
      if (!profile) return
      const nextSlots = [...(profile.slots ?? [])] as (SlotSpec | null)[]
      nextSlots[editing] = { ...(nextSlots[editing] ?? { source: 'weather' }), ...patch } as SlotSpec
      scheduleSave({ ...profile, slots: nextSlots, editingSlot: editing as 0 | 1 | 2 | 3 })
    },
    [profile, editing, scheduleSave],
  )

  /** 设备参数下发（亮度/灯效/灯色/时间/停在 activeSlot）。有值才下发 ——
   *  没配过的字段不动设备现状（绝不造默认值）。applyProfile 与连接后静默恢复共用。 */
  const applyDeviceControl = useCallback(
    async (p: DisplayProfile): Promise<void> => {
      const dc = p.deviceControl ?? {}
      if (typeof dc.brightness === 'number') await device.setBrightness(dc.brightness)
      if (typeof dc.lightMode === 'number') await device.setLightMode(dc.lightMode)
      if (dc.lightColor) {
        const m = /^#?([0-9a-f]{6})$/i.exec(dc.lightColor.trim())
        if (m) {
          const n = parseInt(m[1]!, 16)
          await device.setLightColor((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
        }
      }
      if (dc.timeFormat || dc.networkTime !== undefined || dc.timezoneQuarterHours !== undefined) {
        await device.setTime({
          timezoneQuarterHours: dc.timezoneQuarterHours ?? 32,
          use24Hour: (dc.timeFormat ?? '24') !== '12',
          useNetworkTime: dc.networkTime !== false,
        })
      }
      await device.setClockStyle(p.activeSlot ?? 3)
    },
    [device],
  )

  /** 应用配置到设备：按序推全部已配槽位 + 设备设置。
   *  时区随 profile.deviceControl 走（此前硬编码 32 —— 设备页选的时区永远落不了盘）。 */
  const applyProfile = useCallback(async () => {
    if (!profile || !connected) return
    const targets = slots
      .map((s, i) => ({ s, i }))
      .filter((x): x is { s: SlotSpec; i: number } => Boolean(x.s))
    if (targets.length === 0) {
      notify('这份配置还没有配任何槽位')
      return
    }
    setApplyState({ done: 0, total: targets.length })
    try {
      for (const { s, i } of targets) {
        const out = await renderSlot(i, s)
        if (out.frames.length > 0) {
          await device.sendImage(out.frames, i)
        }
        setApplyState((prev) => ({ done: (prev?.done ?? 0) + 1, total: targets.length }))
      }
      await applyDeviceControl(profile)
      const saved = { ...profile, updatedAt: Date.now() }
      scheduleSave(saved)
      notify(`已应用「${profile.name}」（${targets.length} 个槽位）`, 'ok')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setApplyState(null)
    }
  }, [profile, connected, slots, device, notify, scheduleSave, applyDeviceControl])

  /** 发布流程（PublishDialog）：预览 → 元数据 → 上传 → 结果链接。
   *  此前一键发布：硬编码标题/描述/标签、无预览无确认、上传 id 被丢弃（没有结果链接）。 */
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishBusy, setPublishBusy] = useState(false)
  const [publishMeta, setPublishMeta] = useState({ title: '', description: '', tags: '配置' })
  const [publishResult, setPublishResult] = useState<{ title: string } | null>(null)
  const [publishPreview, setPublishPreview] = useState<{ slot: number; frames: string[] }[]>([])

  const openPublish = useCallback(async () => {
    if (!profile) return
    // 步骤①的预览：各已配槽位现渲一套帧（与推送同一渲染器）
    const targets = (profile.slots ?? []).map((s, i) => ({ s, i })).filter((x) => Boolean(x.s))
    const out: { slot: number; frames: string[] }[] = []
    for (const { s, i } of targets.slice(0, 4)) {
      try {
        const r = await renderSlot(i, s!)
        if (r.frames.length > 0) {
          out.push({
            slot: i,
            frames: r.frames.map((f) => {
              let binary = ''
              for (let k = 0; k < f.length; k += 0x8000) binary += String.fromCharCode(...f.subarray(k, k + 0x8000))
              return btoa(binary)
            }),
          })
        }
      } catch {
        /* 单槽渲染失败不阻塞发布 */
      }
    }
    setPublishPreview(out)
    setPublishMeta({
      title: `${profile.name}（配置）`,
      description: `从设备控制台导出的立牌配置 · ${targets.length} 个槽位`,
      tags: '配置',
    })
    setPublishResult(null)
    setPublishOpen(true)
  }, [profile])

  // 「分享这份配置」= 导出 v2 JSON 下载到本地（exportPayload 走服务端 /api/export，
  // 带图组依赖 + previews 快照；不再上传分享站 —— 下载的文件可再导回本地库 / 发给别人 /
  // 传回分享站，shareMeta 一并写进文件头）
  const doPublish = useCallback(async () => {
    if (!profile || !publishMeta.title.trim()) return
    setPublishBusy(true)
    try {
      const payload = await exportPayload([profile.id])
      // shareMeta（标题/描述/标签）写进文件头：导入端（本地库 / 别人的工具）直接读
      const file = {
        ...payload,
        shareMeta: {
          title: publishMeta.title.trim(),
          description: publishMeta.description.trim(),
          tags: publishMeta.tags
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
          author: '控制台导出',
        },
      }
      const blob = new Blob([JSON.stringify(file)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${publishMeta.title.trim().replace(/[\\/:*?"<>|\s]+/g, '_')}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setPublishResult({ title: publishMeta.title.trim() })
      notify('已导出分享文件（浏览器下载）', 'ok')
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setPublishBusy(false)
    }
  }, [profile, publishMeta, notify])

  // ── 多配置 CRUD（此前只有下拉选择器：无创建/复制/改名/删除，用户永远只有一个 default） ──
  const [manageOpen, setManageOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const refreshProfiles = useCallback(async () => {
    const list = await listProfiles()
    setProfiles(list.map((x) => ({ id: x.id, name: x.name, isDefault: x.isDefault })))
  }, [])

  const reloadCurrent = useCallback(async () => {
    const p = await getCurrentProfile()
    if (p) {
      setProfile(p)
      setEditing(p.editingSlot ?? p.activeSlot ?? 0)
    }
  }, [])

  const doRename = useCallback(async () => {
    const name = renameDraft.trim()
    if (!name || !renameTarget) return
    const full = await readProfile(renameTarget.id)
    if (!full) return
    await writeProfile({ ...full, name, updatedAt: Date.now() })
    await refreshProfiles()
    if (renameTarget.id === profile?.id) await reloadCurrent()
    setRenameTarget(null)
  }, [renameDraft, renameTarget, profile, refreshProfiles, reloadCurrent])

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-6 sm:pt-8">
      {/* ── ControlHeader：仪器面板读数条（旅程①连接 的显示唯一出口）──
        * 连接只解锁「推真机」：未连接不是阻断态 —— 配内容/预览/分享全程可用（iOS 虚拟设备）。
        * 通道切换（SegmentedControl）：服务端桥（默认，页面关掉自动化照跑）/ 浏览器直连（后备）；
        * 互斥 —— 连接任一时另一通道禁用，切换先断开原通道（setChannel 内兜底）。 */}
      <div className="card-flat mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <StatusDot state={connState} className="h-2.5 w-2.5 shrink-0" />
          <span className="min-w-0 truncate">
            {connected
              ? `${info.name ?? '已连接'}${info.clockStyle !== undefined ? ` · 屏·${SLOT_STYLE_NAMES[info.clockStyle] ?? info.clockStyle}` : ''}`
              : connState === 'connecting'
                ? '连接中…'
                : connState === 'disconnected'
                  ? channel === 'server'
                    ? '桥掉线 · 服务端重连中'
                    : '已断开 · 自动重连中'
                  : '未连接'}
          </span>
          {!connected && (channel === 'server' || available) && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => void connect()}>
              连接设备
            </button>
          )}
          {connected && (
            <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={keepAwake}
                onChange={toggleKeepAwake}
                className="size-3.5 accent-signal-600"
              />
              屏幕常亮
            </label>
          )}
        </div>
        {/* 通道切换：server 桥不可用时显示原因（服务未起 / 桥二进制缺失），可切 browser 直连 */}
        <SegmentedControl
          ariaLabel="设备通道"
          segments={[
            { value: 'server', label: '服务端桥', hint: '默认：设备操作走本地服务桥，自动化常驻（页面关掉照跑）' },
            { value: 'browser', label: '浏览器直连', hint: '后备：Web Bluetooth 直连（需桌面 Chrome/Edge 或 Android Chrome）' },
          ]}
          value={channel}
          onChange={(next) => {
            void setChannel(next)
          }}
          className="shrink-0"
        />
        {channel === 'server' && (serverDown || (bridge && !bridge.bridgeRunning)) && (
          <p className="w-full text-xs leading-relaxed text-glow-600 dark:text-glow-400">
            {serverDown
              ? '本地服务未响应（npm start / dev:server）—— 检查服务是否在跑；期间可切「浏览器直连」。'
              : '服务端桥未运行（蓝牙二进制未就位 / 系统蓝牙权限未给）—— 设备连接会失败，可切「浏览器直连」后备。'}
          </p>
        )}
        {browserUnavailable && (
          <p className="w-full text-xs leading-relaxed text-glow-600 dark:text-glow-400">
            当前浏览器不支持 Web Bluetooth（需桌面 Chrome / Edge 或 Android Chrome）。配置编辑、预览与分享全程可用 ——
            推送到真机请切回「服务端桥」，或在电脑 / Android 设备上打开本页。
          </p>
        )}
        {connected && error && <p className="w-full text-xs text-red-500">{error}</p>}
      </div>

      {/* ── 配置读数条：旅程②配内容 / ④分享 的常驻入口 ── */}
      {profile && (
        <div className="card-flat mb-3 flex flex-wrap items-center gap-2 p-3 text-sm">
          <select
            className="input max-w-full w-auto min-h-9 py-1.5"
            value={profile.id}
            onChange={async (e) => {
              await setCurrentProfile(e.target.value)
              const p = await getCurrentProfile()
              if (p) {
                setProfile(p)
                setEditing(p.editingSlot ?? p.activeSlot ?? 0)
              }
            }}
            aria-label="当前配置"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isDefault ? '（默认）' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setManageOpen(true)} title="管理配置：新建 / 复制 / 改名 / 删除">
            管理
          </button>
          <span className="readout text-xs text-zinc-400">
            {slots.filter(Boolean).length}/4 槽位 · 停在 {SLOT_STYLE_NAMES[profile.activeSlot ?? 3]}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {applyState ? (
              <Progress value={applyState.done} total={applyState.total} label="应用中（每槽 10-20 秒蓝牙）" className="min-w-40" />
            ) : (
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={!connected || slots.filter(Boolean).length === 0}
                onClick={() => void applyProfile()}
                title={connected ? '按当前配置推全部已配槽位 + 应用设备设置' : '需连接设备（配置/预览/分享无需连接）'}
              >
                应用到设备
              </button>
            )}
            <button type="button" className="btn-ghost btn-sm" onClick={() => void openPublish()}>
              分享…
            </button>
          </div>
        </div>
      )}

      {/* TabNav（Tabs 原语：aria + 键盘 + URL 同步） */}
      <TabList
        className="mb-4"
        ariaLabel="控制台分区"
        tabs={TABS.map((t) => ({ key: t.id, label: t.label }))}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
      />

      {/* 未连接轻提示（不阻断）：仅设备 Tab 需要连接 */}
      {!connected && tab === 'device' && (
        <div className="mb-4 rounded-[var(--radius-control)] border border-glow-500/40 bg-glow-500/10 px-4 py-2.5 text-xs leading-relaxed text-glow-700 dark:text-glow-300 sm:text-sm">
          设备设置需要连接立牌（服务端桥通道不限浏览器；浏览器直连需桌面 Chrome / Edge 与 Android Chrome）。配置编辑、预览与分享不受影响。
        </div>
      )}

      {/* Tab 内容（Transition：切换交叉淡入，无空窗帧） */}
      {profile && (
        <Transition activeKey={tab} name="fade">
          {() => (
            <>
              {tab === 'cast' && (
                <CastTab
                  profile={profile}
                  editing={editing}
                  setEditing={setEditing}
                  slots={slots}
                  spec={spec}
                  patchSpec={patchSpec}
                  galleries={galleries}
                  connected={connected}
                  device={device}
                  notify={notify}
                  scheduleSave={scheduleSave}
                  deviceOnScreen={info.clockStyle ?? profile.activeSlot ?? 3}
                />
              )}
              {tab === 'auto' && (
                <AutoTab profile={profile} scheduleSave={scheduleSave} notify={notify} />
              )}
              {tab === 'device' && (
                <DeviceTab
                  device={device}
                  info={info}
                  connected={connected}
                  profile={profile}
                  scheduleSave={scheduleSave}
                />
              )}
              {/* usage Tab 已随内部平台数据链退役 */}
            </>
          )}
        </Transition>
      )}

      {/* ── PublishDialog：预览 → 元数据 → 结果（三步发布流） ── */}
      <Modal
        isOpen={publishOpen}
        onClose={() => {
          if (!publishBusy) setPublishOpen(false)
        }}
        ariaLabel="导出这份配置的分享文件"
        contentClassName="max-h-[85dvh] w-full max-w-lg overflow-y-auto p-5"
      >
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">导出「{profile?.name}」分享文件</h3>

            {!publishResult ? (
              <>
                {/* ① 预览：各已配槽位现渲帧（与推送同一渲染器） */}
                <p className="micro-label mt-4">预览 · {publishPreview.length} 个槽位</p>
                {publishPreview.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {publishPreview.map((p) => (
                      <span key={p.slot} className="stage-frame stage relative block overflow-hidden" style={{ width: 74 }}>
                        {p.frames[0] ? (
                          <img src={`data:image/jpeg;base64,${p.frames[0]}`} alt={`槽位 ${p.slot + 1} 首帧`} className="block w-full" style={{ aspectRatio: '135 / 240' }} />
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-zinc-400">没有可渲染的槽位（这份配置还没配内容）。</p>
                )}

                {/* ② 元数据（不再硬编码） */}
                <div className="mt-4 flex flex-col gap-3">
                  <div>
                    <label htmlFor="pub-title" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">标题 *</label>
                    <input id="pub-title" className="input" maxLength={200} value={publishMeta.title} onChange={(e) => setPublishMeta((m) => ({ ...m, title: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="pub-desc" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">描述</label>
                    <textarea id="pub-desc" className="input min-h-16" maxLength={200} value={publishMeta.description} onChange={(e) => setPublishMeta((m) => ({ ...m, description: e.target.value }))} />
                  </div>
                  <div>
                    <label htmlFor="pub-tags" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">标签（逗号分隔）</label>
                    <input id="pub-tags" className="input" maxLength={200} value={publishMeta.tags} onChange={(e) => setPublishMeta((m) => ({ ...m, tags: e.target.value }))} />
                  </div>
                </div>

                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setPublishOpen(false)} disabled={publishBusy}>取消</button>
                  <Button
                    tone="primary"
                    size="sm"
                    isLoading={publishBusy}
                    loadingLabel="导出中…"
                    disabled={!publishMeta.title.trim() || publishPreview.length === 0}
                    onClick={() => void doPublish()}
                  >
                    导出分享文件
                  </Button>
                </div>
              </>
            ) : (
              /* ③ 结果：文件已在浏览器下载（不再上传分享站 —— 文件就是分享本体） */
              <div className="mt-4 flex flex-col items-start gap-3">
                <p className="text-sm text-zinc-600 dark:text-zinc-300">
                  已导出「{publishResult.title}」.json（浏览器下载）—— 带图组依赖与预览快照，
                  可再导回本地库（素材库「导入」）、发给别人，或传回分享站。
                </p>
                <div className="flex gap-2">
                  <a className="btn-primary btn-sm" href="#/">去素材库导入回来</a>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setPublishOpen(false)}>继续编辑</button>
                </div>
              </div>
            )}
        </div>
      </Modal>

      {/* ── 配置管理弹层（CRUD：此前 store 全有、UI 全无） ── */}
      <Modal isOpen={manageOpen} onClose={() => setManageOpen(false)} ariaLabel="管理配置" contentClassName="max-h-[85dvh] w-full max-w-md overflow-y-auto p-5">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">配置管理</h3>
          <ul className="mt-3 flex flex-col gap-1">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-surface-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm"
                  aria-current={p.id === profile?.id}
                  onClick={async () => {
                    await setCurrentProfile(p.id)
                    await reloadCurrent()
                  }}
                >
                  {p.name}
                  {p.isDefault ? <span className="ml-1 text-xs text-zinc-400">（默认）</span> : null}
                  {p.id === profile?.id ? <span className="chip-on chip-xs chip border border-transparent ml-2">当前</span> : null}
                </button>
                <button type="button" className="chip-xs chip text-zinc-400 hover:text-signal-600" title="改名" onClick={() => { setRenameTarget(p); setRenameDraft(p.name) }}>改名</button>
                <button type="button" className="chip-xs chip text-zinc-400 hover:text-signal-600" title="复制一份" onClick={async () => { await duplicateProfile(p.id); await refreshProfiles(); }}>复制</button>
                <button
                  type="button"
                  className={`chip-xs chip ${p.isDefault ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-400 hover:text-red-500'}`}
                  title={p.isDefault ? '默认配置不可删除' : '删除'}
                  disabled={p.isDefault}
                  onClick={() => setDeleteTarget(p)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn-ghost btn-sm flex-1" onClick={async () => { await createProfile(); await refreshProfiles(); await reloadCurrent() }}>新建配置</button>
            <button type="button" className="btn-primary btn-sm" onClick={() => setManageOpen(false)}>完成</button>
          </div>
        </div>
      </Modal>

      {/* 删除确认（ConfirmDialog 原语） */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除配置「${deleteTarget?.name ?? ''}」？`}
        body="配置与其槽位配方会一并删除（已收进本地库的分享文件不受影响）。默认配置不可删除。"
        confirmLabel="删除"
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await deleteProfile(deleteTarget.id)
            await refreshProfiles()
            await reloadCurrent()
            toast('配置已删除', 'ok')
          } catch (e) {
            toast(e instanceof Error ? e.message : '删除失败', 'error')
          } finally {
            setDeleteTarget(null)
          }
        }}
      />

      {/* 改名对话框 */}
      <Modal isOpen={renameTarget !== null} onClose={() => setRenameTarget(null)} ariaLabel="配置改名" contentClassName="w-full max-w-sm p-5">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">改名</h3>
          <input
            className="input mt-3"
            maxLength={30}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            // 回车提交
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doRename()
            }}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setRenameTarget(null)}>取消</button>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={!renameDraft.trim()}
              onClick={() => void doRename()}
            >
              保存
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 投屏 Tab：槽位条 + 内容选择 + 预览推送
// ─────────────────────────────────────────────────────────────────────────────

function CastTab({
  profile,
  editing,
  setEditing,
  slots,
  spec,
  patchSpec,
  galleries,
  connected,
  device,
  notify,
  scheduleSave,
  deviceOnScreen,
}: {
  profile: DisplayProfile
  editing: number
  setEditing: (i: number) => void
  slots: (SlotSpec | null)[]
  spec: SlotSpec | null
  patchSpec: (p: Partial<SlotSpec>) => void
  galleries: { name: string; frameCount: number }[]
  connected: boolean
  device: ReturnType<typeof useDevice>['device']
  notify: (msg: string) => void
  scheduleSave: (next: DisplayProfile) => void
  deviceOnScreen: number
}): ReactElement {
  const [preview, setPreview] = useState<{ frames: Uint8Array[]; label: string; meta?: FrameMeta[]; all?: { image: Uint8Array; meta: FrameMeta }[] } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [pushing, setPushing] = useState<{ done: number; total: number } | null>(null)

  /** 预览当前配方（与推送同一渲染器，所见即所得） */
  const doPreview = useCallback(async () => {
    if (!spec) {
      setPreview({ frames: [], label: '空槽位（先选内容）' })
      return
    }
    setPreviewBusy(true)
    try {
      setPreview(await renderSlot(editing, spec))
    } finally {
      setPreviewBusy(false)
    }
  }, [spec, editing])

  const previewTimer = useRef<number | null>(null)
  useEffect(() => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(() => void doPreview(), 800)
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current)
    }
  }, [spec, doPreview])

  const doPush = useCallback(async () => {
    if (!connected || !spec) return
    setPushing({ done: 0, total: 1 })
    try {
      const out = await renderSlot(editing, spec)
      if (out.frames.length === 0) throw new Error('没有可推送的帧')
      await device.sendImage(out.frames, editing, (done, total) => setPushing({ done, total }))
      notify(`已推送到「${SLOT_STYLE_NAMES[editing]}」`)
      setPreview(out)
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    } finally {
      setPushing(null)
    }
  }, [connected, spec, editing, device, notify])

  /**
   * 切换内容来源 —— 一次性写入该来源的完整初始配方（修「切来源渲染失败/预览帧数不对」）：
   * 此前 SourcePicker 只 patch { source }：canvas 进「画布配置缺失」、旧来源字段残留
   * （weather 的 city 留在新槽里）、CanvasParamEditor 下拉显示值与 spec 脱钩。
   * 现在：清掉无关字段 + 写入新来源的可用默认值 —— 切过去即可预览、即可推送。
   */
  const pickSource = useCallback(
    (source: SlotSpec['source']) => {
      const base = {
        // 共通可保留字段（跨来源语义不变）
        stampNumbers: spec?.stampNumbers,
        updatedAt: Date.now(),
      }
      switch (source) {
        case 'weather':
          patchSpec({ ...base, source, city: spec?.source === 'weather' ? spec.city : '上海', weatherCardOrder: spec?.source === 'weather' ? spec.weatherCardOrder : undefined })
          break
        case 'gallery':
          patchSpec({ ...base, source, galleryTheme: spec?.source === 'gallery' ? spec.galleryTheme : 'anime' })
          break
        case 'user-gallery':
          // 不预选图组：让用户从「我的图组」下拉里挑（没有图组时编辑区会给引导）
          patchSpec({ ...base, source, userGalleryName: spec?.source === 'user-gallery' ? spec.userGalleryName : undefined })
          break
        case 'canvas': {
          // 切过来即生成最近主题（无缓存 = 第一主题）的一套帧 —— 永不进「配置缺失」
          const topic = lastCanvasGen.topic
          const theme = lastCanvasGen.theme
          const texts = generateCanvasTextsImpl(topic)
          const colors = generateCanvasColorsImpl(theme)
          patchSpec({
            ...base,
            source,
            canvas: {
              frameTexts: texts.lines,
              frameColors: colors.palettes,
              canvasInputText: texts.lines.join(' / '),
              canvasSplit: 'char',
              bgBase64: spec?.source === 'canvas' ? spec.canvas?.bgBase64 ?? null : null,
            },
          })
          break
        }
        case 'usage':
        case 'credit':
        case 'usage-credit':
          // 来源已移除：SourcePicker 不给入口，这条只兜旧配方直链（渲染占位卡）
          patchSpec({ ...base, source, usagePresetMixed: spec?.source === source ? spec.usagePresetMixed : '7' })
          break
        case 'animation':
          patchSpec({ ...base, source, animType: spec?.source === 'animation' ? spec.animType : 'moon', animTheme: spec?.source === 'animation' ? spec.animTheme : '霓虹蓝' })
          break
        case 'files':
          // 不预选文件：编辑区给「选图片」引导（帧由本地裁剪后存进配方 frames）
          patchSpec({ ...base, source, frames: spec?.source === 'files' ? spec.frames : undefined })
          break
        case 'datafeed':
          // 不预选数据源：编辑区给「选择数据源」引导（与 user-gallery 同语义）
          patchSpec({
            ...base,
            source,
            datafeed:
              spec?.source === 'datafeed' && spec.datafeed
                ? spec.datafeed
                : { defId: '' },
          })
          break
      }
    },
    [spec, patchSpec],
  )

  const previewB64 = useMemo(
    () =>
      (preview?.frames ?? []).map((f) => {
        let binary = ''
        for (let i = 0; i < f.length; i += 0x8000) binary += String.fromCharCode(...f.subarray(i, i + 0x8000))
        return btoa(binary)
      }),
    [preview],
  )

  /** 槽位条缩略图：每槽首帧（当前编辑槽 = 实时预览；其他槽 = 上次预览留存的快照缓存） */
  const [slotThumbCache, setSlotThumbCache] = useState<Record<number, string>>({})
  useEffect(() => {
    if (!previewBusy && previewB64.length > 0) {
      setSlotThumbCache((prev) => (prev[editing] === previewB64[0] ? prev : { ...prev, [editing]: previewB64[0]! }))
    }
  }, [editing, previewB64, previewBusy])
  const slotThumbs: (string | null)[] = [0, 1, 2, 3].map((i) =>
    i === editing ? (previewB64[0] ?? null) : (slotThumbCache[i] ?? null),
  )

  /** 全量候选（天气分支给）：转 base64 给预览条展示被排除/超容的置灰卡 */
  const previewAllB64 = useMemo(
    () =>
      (preview?.all ?? []).map((c) => {
        let binary = ''
        for (let i = 0; i < c.image.length; i += 0x8000) binary += String.fromCharCode(...c.image.subarray(i, i + 0x8000))
        return { image: btoa(binary), meta: c.meta }
      }),
    [preview],
  )

  /** 全局展台写入（liveRailStore）：编辑哪个槽位，App 外壳的 LiveRail 放哪套帧。
   *  owner='control'：守卫真正闭合（此前无主写入总能覆盖别人，Home 的背景写入又能反过来覆盖）。
   *  卸载清展台：切走 Tab/页面时收走（此前「编辑中 · 槽位 N」会永久滞留全站顶栏）。 */
  useEffect(() => {
    setLiveRail({
      frames: previewBusy ? [] : previewB64,
      owner: 'control',
      label: `编辑中 · 槽位 ${editing + 1}（${profile.slotNames?.[editing]?.trim() || SLOT_STYLE_NAMES[editing]}）`,
    })
    return () => clearLiveRail('control')
  }, [previewBusy, previewB64, editing, profile.slotNames])

  return (
    <div>
      {/* 槽位条（主心骨）：缩略图 + 屏上状态 + 「显示」切屏 + 就地改名 */}
      <div className="mb-4">
        <SlotStrip
          slots={slots}
          editing={editing}
          setEditing={setEditing}
          thumbs={slotThumbs}
          slotNames={profile.slotNames}
          setSlotName={(i, name) => {
            const next: [string, string, string, string] = [...(profile.slotNames ?? ['', '', '', ''])]
            next[i] = name
            scheduleSave({ ...profile, slotNames: next })
          }}
          onScreen={deviceOnScreen}
          connected={connected}
          confirmedSlots={[0, 1, 2, 3].map((i) => device.slotConfirmedAtOf(i))}
          confirmSlot={(i) => {
            device.confirmSlot(i)
            notify(`已确认「${profile.slotNames?.[i]?.trim() || SLOT_STYLE_NAMES[i]}」在屏上`)
          }}
          showDevice={(i) => {
            void (async () => {
              try {
                await device.setClockStyle(i)
                notify(`已切到「${profile.slotNames?.[i]?.trim() || SLOT_STYLE_NAMES[i]}」`)
                // 模拟显示与设备同步：切槽成功 = 展台放该槽位当前源的渲染帧
                // （owner 'loop' + force：设备当前显示抢占编辑态展台，与循环步同语义）
                const s = (profile.slots ?? [])[i]
                if (s) {
                  try {
                    const out = await renderSlot(i, s)
                    setLiveRail(
                      { frames: out.frames.map(bytesToB64), owner: 'loop', label: `设备 · 槽位 ${i + 1}（${out.label}）` },
                      { force: true },
                    )
                  } catch {
                    /* 渲染失败不阻塞切槽 */
                  }
                }
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err))
              }
            })()
          }}
        />
      </div>

      {/* 上下文提示条：正在编辑哪个槽位、容量多少 */}
      <div className="mb-4 rounded-[var(--radius-control)] border border-line bg-surface-2 px-4 py-2.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 sm:text-sm">
        正在编辑 <span className="font-medium text-zinc-700 dark:text-zinc-200">{profile.slotNames?.[editing]?.trim() || SLOT_STYLE_NAMES[editing]}</span>
        的内容（可放 <span className="readout">{slotCapacity(editing)}</span> 帧）—— 改动自动存进当前配置的这个槽位；
        {connected ? ' 预览即设备最终显示。' : ' 未连接也能编辑预览分享，推送需连接。'}
      </div>

      {/* 编辑区（Web 一屏式双栏：左 = 定内容，右 = 看结果；
          小屏单列同序：先选内容，再看预览（① 选内容 → ② 预览 → ③ 推送）。） */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* ① 选内容 + 来源参数（左栏） */}
        <SlotEditor
          spec={spec}
          patchSpec={patchSpec}
          pickSource={pickSource}
          galleries={galleries}
          onClearSlot={() => {
            const nextSlots = [...(profile.slots ?? [])] as (SlotSpec | null)[]
            nextSlots[editing] = null
            scheduleSave({ ...profile, slots: nextSlots, editingSlot: editing as 0 | 1 | 2 | 3 })
            setPreview({ frames: [], label: '空槽位' })
          }}
        />

        {/* ② 预览帧条 + ③ 推送（右栏；推送常驻预览底部，改完即推） */}
        <section className="card-flat relative order-first flex flex-col p-4 lg:order-none">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className="micro-label">② 预览{previewB64.length ? ` · ${previewB64.length} 帧` : ''}</h3>
            <span className="truncate text-xs text-zinc-400">
              {previewBusy ? '渲染中…' : preview?.label ?? ''}
            </span>
          </div>

          {previewB64.length === 0 && !previewBusy ? (
            <p className="py-10 text-center text-sm text-zinc-400">
              {spec ? '渲染中…（与推送同一渲染器）' : '空槽位 —— 左侧选个内容来源'}
            </p>
          ) : (
            <PreviewStrip frames={previewB64} meta={preview?.meta} all={previewAllB64} editing={editing} spec={spec} patchSpec={patchSpec} />
          )}

          {/* ③ 推送（常驻底部；帧条即时反映排序/勾选结果） */}
          <div className="mt-4 border-t border-line pt-3">
            {pushing ? (
              <Progress
                value={pushing.done}
                total={pushing.total}
                label="蓝牙传输中（一套约 10-20 秒，期间别断开）"
              />
            ) : (
              <button
                type="button"
                className="btn-primary w-full min-h-11 text-sm"
                disabled={!connected || !spec || previewB64.length === 0}
                onClick={() => void doPush()}
              >
                {connected
                  ? `推送到「${profile.slotNames?.[editing]?.trim() || SLOT_STYLE_NAMES[editing]}」`
                  : '连接设备后可推送（顶栏连接）'}
              </button>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              预览即设备最终显示 —— 推送与预览同一渲染器；推送完成后设备自动切到该槽位。
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}

/** 槽位内容编辑器（两级选来源 + 来源参数） */
function SlotEditor({
  spec,
  patchSpec,
  pickSource,
  galleries,
  onClearSlot,
}: {
  spec: SlotSpec | null
  patchSpec: (p: Partial<SlotSpec>) => void
  pickSource: (source: SlotSpec['source']) => void
  galleries: { name: string; frameCount: number }[]
  onClearSlot?: () => void
}): ReactElement {
  const GALLERY_THEMES = useMemo(() => listGalleryThemes(), [])
  // 最近一次 canvas 生成的主题（CanvasParamEditor 下拉初值；spec 不存主题名，缓存跟随）
  const canvasTopic = lastCanvasGen.topic
  const canvasTheme = lastCanvasGen.theme
  // 城市列表调服务端（GET /api/weather/cities，由服务端 listCities 提供；
  // 服务未起/请求失败回落前端静态映射 —— 编辑不该被服务状态卡死）
  const [cities, setCities] = useState<string[]>(() => Object.keys(CITY_TO_LOCATION_ID))
  useEffect(() => {
    void listWeatherCities()
      .then((r) => setCities(r.cities))
      .catch(() => undefined)
  }, [])

  return (
    <section className="card-flat flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="micro-label">① 选内容</h2>
        {spec && onClearSlot && (
          <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={onClearSlot}>
            清空该槽位
          </button>
        )}
      </div>
      {/* 单级来源选择（平铺直达，无大类绕行）—— 切来源即初始化完整配方（pickSource） */}
      <SourcePicker source={spec?.source} onSourceChange={pickSource} />

      <div className="mt-4 flex flex-col gap-3">
        {spec?.source === 'weather' && (
          <>
            <Select
              id="weather-city"
              label="城市"
              value={spec.city ?? '上海'}
              onChange={(v) => patchSpec({ city: v })}
              className="max-w-48"
            >
              {cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            <Switcher
              checked={Boolean(spec.stampNumbers)}
              onChange={(next) => patchSpec({ stampNumbers: next })}
              label="帧角标 0-9"
              hint="每帧右上角画序号，当秒数看（兼用作时钟）"
            />
          </>
        )}
        {spec?.source === 'gallery' && (
          <label className="text-sm">
            <span className="font-medium">图库主题</span>
            <select
              className="input mt-1 !w-auto"
              value={spec.galleryTheme ?? 'anime'}
              onChange={(e) => patchSpec({ galleryTheme: e.target.value as 'anime' | 'animals' })}
            >
              {GALLERY_THEMES.map((t) => (
                <option key={t} value={t}>
                  {t}（{listGalleryImages(t).length} 张）
                </option>
              ))}
            </select>
          </label>
        )}
        {spec?.source === 'user-gallery' && (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">我的图组</span>
              {galleries.length > 0 && (
                <span className="readout text-xs text-zinc-400">{galleries.length} 个图组</span>
              )}
            </div>
            {galleries.length === 0 ? (
              /* 空态：给两条真出路（不是一句干话）—— 素材库导入 / 上传自己的文件 */
              <div className="rounded-[var(--radius-control)] border border-line bg-surface-2 px-4 py-3">
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  还没有图组。两条路：
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a href="#/" className="btn-ghost !min-h-9 !px-3 text-xs">
                    去素材库导入（首页「导入图组」）
                  </a>
                  <a href="#/upload" className="btn-ghost !min-h-9 !px-3 text-xs">
                    上传图组分享文件
                  </a>
                </div>
              </div>
            ) : (
              <select
                className="input mt-1 !w-auto"
                value={spec.userGalleryName ?? ''}
                onChange={(e) => patchSpec({ userGalleryName: e.target.value })}
              >
                <option value="">选择…</option>
                {galleries.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.name}（{g.frameCount} 帧）
                  </option>
                ))}
              </select>
            )}
            {galleries.length > 0 && spec.userGalleryName && (
              <p className="text-[11px] text-zinc-400">
                图组由服务端落盘 ~/.lipai/gallery/（「导入图组」写入）；重名导入会自动加后缀。
              </p>
            )}
          </div>
        )}
        {/* usage/credit 参数编辑器已退役（无内部平台数据链路）；
            UsageParamEditor 函数体保留在文件尾部待数据卡扩展，暂无调用方 */}
        {spec?.source === 'canvas' && (
          <CanvasParamEditor
            key={`${spec.canvas?.frameTexts.length ?? 0}-${spec.canvas?.canvasInputText ?? ''}`}
            spec={spec}
            patchSpec={patchSpec}
            initialTopic={canvasTopic}
            initialTheme={canvasTheme}
          />
        )}
        {spec?.source === 'datafeed' && (
          <DataFeedParamEditor spec={spec} patchSpec={patchSpec} />
        )}
        {spec?.source === 'animation' && <AnimationParamEditor spec={spec} patchSpec={patchSpec} />}
        {spec?.source === 'files' && <FilesParamEditor spec={spec} patchSpec={patchSpec} />}
      </div>
    </section>
  )
}

/** 内置动画参数（动画类型 + 配色主题） */
function AnimationParamEditor({
  spec,
  patchSpec,
}: {
  spec: SlotSpec
  patchSpec: (p: Partial<SlotSpec>) => void
}): ReactElement {
  const anims = useMemo(() => listAnimationTypes(), [])
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label>
        <span className="font-medium">动画</span>
        <select
          className="input mt-1 !w-auto"
          value={spec.animType ?? 'moon'}
          onChange={(e) => patchSpec({ animType: e.target.value })}
        >
          {anims.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="font-medium">配色</span>
        <select
          className="input mt-1 !w-auto"
          value={spec.animTheme ?? '霓虹蓝'}
          onChange={(e) => patchSpec({ animTheme: e.target.value })}
        >
          {listColorThemes().map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <p className="w-full text-[11px] text-zinc-400">
        10 帧动画推到该槽位（设备每秒切一帧，10 秒循环）；帧数按槽位容量截断。
      </p>
    </div>
  )
}

/** 本地图片参数（选文件 → 前端裁剪成帧存进配方；帧不落服务端） */
function FilesParamEditor({
  spec,
  patchSpec,
}: {
  spec: SlotSpec
  patchSpec: (p: Partial<SlotSpec>) => void
}): ReactElement {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const frames = spec.frames ?? []
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => fileRef.current?.click()}>
          {frames.length > 0 ? `换图片（现有 ${frames.length} 帧）` : '选图片…'}
        </button>
        {frames.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {frames.slice(0, 4).map((f, i) => (
              <img
                key={i}
                src={`data:image/jpeg;base64,${f}`}
                alt={`第 ${i + 1} 帧`}
                className="h-10 rounded border border-line"
              />
            ))}
            {frames.length > 4 ? <span className="text-xs text-zinc-400">…共 {frames.length} 帧</span> : null}
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length === 0) return
            // 逐张裁成 135×240 帧（与推送/预览同一裁剪规则）；本地图片无法按配方复现，帧直接存配方
            const cropped: string[] = []
            for (const f of files.slice(0, 10)) {
              cropped.push(await cropLocalImage(f))
            }
            patchSpec({ frames: cropped })
          }}
        />
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-400">
        本地图片裁剪成 135×240 帧直接存进配方（不落服务端）；换图 = 整组替换。
      </p>
    </div>
  )
}

/** 最近一次 canvas 生成的主题（CanvasParamEditor / pickSource 共写；spec 不存主题名） */
const lastCanvasGen = { topic: '打工人日常', theme: '暗夜' }

/** 自定义接口参数（选数据源 + 卡片勾选/排序） */
function DataFeedParamEditor({
  spec,
  patchSpec,
}: {
  spec: SlotSpec
  patchSpec: (p: Partial<SlotSpec>) => void
}): ReactElement {
  const [defs, setDefs] = useState<DataFeedDef[]>([])
  const [manageOpen, setManageOpen] = useState(false)
  const df = spec.datafeed

  useEffect(() => {
    void listDataFeedDefs().then(setDefs)
  }, [manageOpen])

  const def = defs.find((d) => d.id === df?.defId) ?? null

  /** 勾/取消一张卡（cardIds；空 = 全出，取消第一张时先补全其余） */
  const toggleCard = (id: string): void => {
    const current = df?.cardIds?.length ? df.cardIds : (def?.cards.map((c) => c.id) ?? [])
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    patchSpec({ datafeed: { ...(df ?? { defId: def?.id ?? '' }), cardIds: next } })
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">数据源</span>
        <select
          className="input !w-auto min-h-9"
          value={df?.defId ?? ''}
          onChange={(e) => patchSpec({ datafeed: { defId: e.target.value } })}
        >
          <option value="">{defs.length === 0 ? '还没有数据源' : '选择…'}</option>
          {defs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}（{d.cards.length} 张卡）
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setManageOpen(true)}>
          管理数据源…
        </button>
      </div>

      {defs.length === 0 && (
        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          数据源 = 接口 + 卡片模板（像天气那样按数据渲染）。点「管理数据源」新建一个 ——
          配置好后这里选择即可，预览立即生效。
        </p>
      )}

      {def && (
        <>
          {/* 卡片勾选（空 = 全出；与混合流勾选同语义） */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">出卡：</span>
            {def.cards.map((c) => {
              const on = df?.cardIds?.length ? df.cardIds.includes(c.id) : true
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleCard(c.id)}
                  className={`chip-xs chip border border-transparent ${
                    on ? 'chip-on' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                  }`}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            接口： <span className="readout break-all text-[11px]">{def.url}</span>
            {def.cacheTtlMs === 0 ? ' · 不缓存（每次渲染都请求）' : ` · 缓存 ${Math.round((def.cacheTtlMs ?? 600000) / 60000)} 分钟`}
          </p>
        </>
      )}

      <DataFeedManager open={manageOpen} onClose={() => setManageOpen(false)} />
    </div>
  )
}

/** 自由画布参数（文案主题 + 配色 + 自定义分句 + 背景图） */
function CanvasParamEditor({
  spec,
  patchSpec,
  initialTopic,
  initialTheme,
}: {
  spec: SlotSpec
  patchSpec: (p: Partial<SlotSpec>) => void
  initialTopic: string
  initialTheme: string
}): ReactElement {
  const canvas = spec.canvas ?? {
    frameTexts: [],
    frameColors: [],
    canvasInputText: '',
    canvasSplit: 'char' as const,
    bgBase64: null,
  }
  // topic/theme 受控：初值从调用方传入（key={source+canvas 引用} 重建时刷新）——
  // 此前本地 state 与 spec 脱钩：切来源回来，下拉显示的与实际存的不是一套。
  const [topic, setTopic] = useState(initialTopic)
  const [theme, setTheme] = useState(initialTheme)
  const [input, setInput] = useState(canvas.canvasInputText)
  const bgRef = useRef<HTMLInputElement | null>(null)

  const generate = (t: string, th: string) => {
    lastCanvasGen.topic = t
    lastCanvasGen.theme = th
    const texts = generateCanvasTextsImpl(t)
    const colors = generateCanvasColorsImpl(th)
    patchSpec({
      source: 'canvas',
      canvas: {
        frameTexts: texts.lines,
        frameColors: colors.palettes,
        canvasInputText: texts.lines.join(' / '),
        canvasSplit: 'char',
        bgBase64: canvas.bgBase64,
      },
    })
    setInput(texts.lines.join(' / '))
  }

  const topics = listCanvasTopics()
  const themes = listColorThemes()
  return (
    <div className="flex flex-col gap-4 text-sm">
      {/* 主题选择：chip 流平铺（主题名即预览，不用点开下拉逐个猜）；
          chip-on 选中 + 按压形变，全站同一套材质语言 */}
      <div>
        <span className="micro-label">文案主题</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {topics.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTopic(t)
                generate(t, theme)
              }}
              aria-pressed={t === topic}
              className={`chip-xs chip border border-transparent active:scale-[0.97] ${
                t === topic
                  ? 'chip-on'
                  : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 hover:text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="micro-label">配色主题</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {themes.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTheme(t)
                generate(topic, t)
              }}
              aria-pressed={t === theme}
              className={`chip-xs chip border border-transparent active:scale-[0.97] ${
                t === theme
                  ? 'chip-on'
                  : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 hover:text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <label>
        <span className="font-medium">自定义文案（逗号 / 换行分句，每句一帧）</span>
        <textarea
          className="input mt-1 min-h-16"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => {
            const lines = input.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
            if (lines.length === 0) return
            const colors = generateCanvasColorsImpl(theme)
            patchSpec({
              source: 'canvas',
              canvas: {
                frameTexts: lines.slice(0, 10),
                frameColors: colors.palettes,
                canvasInputText: input,
                canvasSplit: 'space',
                bgBase64: canvas.bgBase64,
              },
            })
          }}
          placeholder="例如: 起床好困, 咖啡续命, 等下班"
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => bgRef.current?.click()}>
          {canvas.bgBase64 ? '换背景图' : '加背景图（可选）'}
        </button>
        {canvas.bgBase64 && (
          <button
            type="button"
            className="text-xs text-zinc-400 hover:text-red-500"
            onClick={() => patchSpec({ canvas: { ...canvas, bgBase64: null } })}
          >
            移除背景
          </button>
        )}
        <input
          ref={bgRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            patchSpec({ canvas: { ...canvas, bgBase64: await cropLocalImage(f) } })
          }}
        />
      </div>    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 自动 Tab：轮播循环
// ─────────────────────────────────────────────────────────────────────────────

function AutoTab({
  profile,
  scheduleSave,
  notify,
}: {
  profile: DisplayProfile
  scheduleSave: (p: DisplayProfile) => void
  notify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
}): ReactElement {
  const [loopState, setLoopState] = useState<LoopState | null>(null)
  const runnerRef = useRef<LoopRunner | null>(null)

  // 服务端常驻轮播：挂载即拉当前状态对齐（页面关掉期间它照跑 —— 轮数/最近动作接得上），
  // SSE loop 事件订阅也在这里挂上（refresh 内部：running/paused 才订阅）。
  useEffect(() => {
    runnerRef.current = new LoopRunner(null, setLoopState)
    void runnerRef.current?.refresh()
    return () => {
      // 卸载只摘订阅 —— 不停服务端循环（常驻语义：关页面 ≠ 停轮播，用户要停点「停止」）
      runnerRef.current?.stopDetach()
    }
  }, [])

  // 掉线暂停 / 重连续播由服务端自理（runtime.resumeAutomationAfterConnect）：
  // 前端不再跟着 connState 拉扯 —— 只在重连成功时刷一次状态（读数对齐）。

  const loop: LoopConfig = profile.loop ?? defaultLoopConfig()
  const steps = sanitizeLoopSteps(loop.loopSteps)
  const minSec = loopMinIntervalSec(loop.loopSteps)

  const patchLoop = useCallback(
    (patch: Partial<LoopConfig>) => {
      const next = { ...defaultLoopConfig(), ...loop, ...patch }
      scheduleSave({ ...profile, loop: next })
    },
    [profile, loop, scheduleSave],
  )

  const addStep = useCallback(
    (step: LoopStep) => {
      const next = [...steps]
      if (!next.some((s) => String(s) === String(step))) next.push(step)
      patchLoop({ loopSteps: next })
    },
    [steps, patchLoop],
  )
  const removeStep = useCallback(
    (i: number) => patchLoop({ loopSteps: steps.filter((_, idx) => idx !== i) }),
    [steps, patchLoop],
  )
  const moveStep = useCallback(
    (i: number, dir: -1 | 1) => {
      const j = i + dir
      if (j < 0 || j >= steps.length) return
      const next = [...steps]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      patchLoop({ loopSteps: next })
    },
    [steps, patchLoop],
  )

  // 起点选择（勾了多步才显示）：null = 不选 = 从第一步开始
  const [loopStartIdx, setLoopStartIdx] = useState<number | null>(null)
  const startLoop = useCallback(() => {
    if (steps.length === 0) return
    const startFrom =
      loopStartIdx !== null ? Math.min(loopStartIdx, Math.max(0, steps.length - 1)) : undefined
    void runnerRef.current?.start(
      { ...defaultLoopConfig(), ...loop, loopInterval: Math.max(loop.loopInterval || minSec, minSec) },
      undefined,
      undefined,
      startFrom,
    )
    notify(`循环已启动（${steps.length} 步 · 间隔 ≥${Math.max(loop.loopInterval || minSec, minSec)}s，服务端常驻）`, 'ok')
  }, [steps, loop, minSec, notify, loopStartIdx])

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="card-flat p-5">
        <h2 className="micro-label mb-3">循环步骤（按顺序轮）</h2>
        <div className="flex flex-wrap gap-1.5">
          {[0, 1, 2, 3].map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => addStep(slot)}
              className="chip active:scale-[0.97] bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700"
            >
              + 切到{SLOT_STYLE_NAMES[slot]}
            </button>
          ))}
          {LOOP_SOURCES.filter((s) => s !== 'frames' && s !== 'usage' && s !== 'credit' && s !== 'usage-credit').map((src) => (
            <button
              key={src}
              type="button"
              onClick={() => addStep(src)}
              className="chip active:scale-[0.97] bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700"
            >
              + 推{SOURCE_LABELS[src] ?? src}
            </button>
          ))}
        </div>
        <ol className="mt-4 flex flex-col gap-1.5">
          {steps.length === 0 ? (
            <p className="text-sm text-zinc-400">还没有步骤 —— 上面加几个（切槽位与推新图可混排）。</p>
          ) : (
            steps.map((step, i) => (
              <li
                key={`${String(step)}-${i}`}
                className="flex items-center gap-2 rounded-[var(--radius-control)] bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/60"
              >
                <span className="tabular-nums text-xs text-zinc-400">{i + 1}</span>
                <span
                  className={`chip ${
                    isSlotStep(step)
                      ? 'border border-signal-500/40 text-signal-700 dark:text-signal-300'
                      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  }`}
                >

                  {isSlotStep(step) ? `切到${SLOT_STYLE_NAMES[step]}` : `推${SOURCE_LABELS[step] ?? step}`}
                </span>
                <span className="text-[10px] text-zinc-400">{isSlotStep(step) ? '毫秒级' : '10-20s 蓝牙'}</span>
                <span className="ml-auto flex items-center gap-1">
                  <button type="button" className="flex size-8 items-center justify-center rounded-[var(--radius-control)] text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700" onClick={() => moveStep(i, -1)} aria-label="上移">↑</button>
                  <button type="button" className="flex size-8 items-center justify-center rounded-[var(--radius-control)] text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700" onClick={() => moveStep(i, 1)} aria-label="下移">↓</button>
                  <button type="button" className="flex size-8 items-center justify-center rounded-[var(--radius-control)] text-zinc-400 hover:text-red-500" onClick={() => removeStep(i)} aria-label="移除">✕</button>
                </span>
              </li>
            ))
          )}
        </ol>
        <label className="mt-4 block text-sm">
          <span className="flex items-center justify-between font-medium">
            间隔
            <span className="tabular-nums text-xs text-zinc-400">秒/步（下限 {minSec}s）</span>
          </span>
          {/* number 输入框：区间 5–3600 跨 3 个数量级，滑杆根本拉不准；
              输入框直接键入 + 快捷 chips 兜底常用档 */}
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={minSec}
              max={3600}
              step={1}
              value={Math.max(loop.loopInterval || minSec, minSec)}
              onChange={(e) => {
                const v = Number(e.target.value)
                // 允许输入中途态（NaN/空不落库）；失焦才钳位
                patchLoop({ loopInterval: Number.isFinite(v) ? v : minSec })
              }}
              onBlur={(e) => {
                const v = Math.min(3600, Math.max(minSec, Number(e.target.value) || minSec))
                e.target.value = String(v)
                patchLoop({ loopInterval: v })
              }}
              className="input !w-28 !py-1.5 tabular-nums"
            />
            <span className="text-xs text-zinc-400">秒</span>
            {[30, 60, 300, 600].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => patchLoop({ loopInterval: Math.max(v, minSec) })}
                className={`chip active:scale-[0.97] ${
                  Math.max(loop.loopInterval || minSec, minSec) === Math.max(v, minSec)
                    ? 'chip-on'
                    : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700'
                }`}
              >
                {v >= 60 ? `${v / 60} 分` : `${v} 秒`}
              </button>
            ))}
          </div>
        </label>
        <p className="mt-1 text-xs text-zinc-400">含推图步骤下限 30 秒；纯切槽位可到 1 秒（逐帧动画）。</p>
        {/* 起点选择：勾了多步才有意义（单步循环永远从它开始） */}
        {steps.length > 1 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-400">从哪步开始：</span>
            <button
              type="button"
              onClick={() => setLoopStartIdx(null)}
              className={`chip active:scale-[0.97] ${
                loopStartIdx === null
                  ? 'chip-on'
                  : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700'
              }`}
            >
              第一步
            </button>
            {steps.map((s, i) => (
              <button
                key={`${i}:${String(s)}`}
                type="button"
                onClick={() => setLoopStartIdx(i)}
                className={`chip active:scale-[0.97] ${
                  loopStartIdx === i
                    ? 'chip-on'
                    : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700'
                }`}
              >
                {isSlotStep(s) ? `切到${SLOT_STYLE_NAMES[s] ?? s + 1}` : `推${SOURCE_LABELS[s] ?? s}`}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card-flat flex flex-col p-5">
        <h2 className="micro-label mb-3">运行</h2>
        <div className="well rounded-[var(--radius-control)] p-4">
          <div className="micro-label mb-2">运行读数</div>
          <p className="readout text-xs text-zinc-400">状态：{loopState ? (loopState.status === 'running' ? '● 运行中' : loopState.status === 'paused' ? '⏸ 已暂停（重连自动继续）' : loopState.status === 'error' ? '● 出错' : '■ 已停止') : '■ 未启动'}</p>
          <p className="readout text-xs text-zinc-400">轮数：<span className="text-zinc-200">{loopState?.rounds ?? 0}</span></p>
          <p className="readout text-xs text-zinc-400">最近：{loopState?.lastAction || '—'}</p>
          {loopState?.error && <p className="mt-1 text-red-400">{loopState.error}</p>}
        </div>
        <div className="mt-4 flex gap-2">
          {loopState?.status === 'running' || loopState?.status === 'paused' ? (
            <button type="button" className="btn-ghost flex-1 !py-2 text-sm" onClick={() => void runnerRef.current?.stop()}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary flex-1 !py-2 text-sm"
              disabled={steps.length === 0}
              onClick={startLoop}
            >
              启动循环
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          注：循环常驻服务端 —— 页面关掉照跑（断电重启自动恢复）。设备断开时服务端自动暂停、重连后从暂停处继续；这里只是控制台，关页面不停轮播（要停点「停止」）。
        </p>
      </section>

      <SceneScheduleSection notify={notify} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景日程：按时刻表切换（早 / 中 / 晚 多时段）—— 服务端常驻（GET/PUT /api/scene + SSE scene）
// ─────────────────────────────────────────────────────────────────────────────

/** 星期几速记（编辑器勾选行） */
const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const

/**
 * 场景日程面板：时段表编辑 + 运行读数。
 *
 * 运行器常驻服务端（server/lib/scene-scheduler.ts：时段表推算 + 到点推图 +
 * config.json 落盘自动拉起）—— 页面关掉照跑。这里只是编辑器与读数面板：
 *  - 改时刻表 → PUT /api/scene（服务端校验 + 存档 + 立即按新表对齐）
 *  - 读数 → GET /api/scene 挂载对齐 + SSE scene 事件（SceneScheduler.refresh 内订阅）
 */
function SceneScheduleSection({
  notify,
}: {
  notify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
}): ReactElement {
  const [schedule, setSchedule] = useState<SceneSchedule>({ enabled: false, slots: [] })
  const [sceneState, setSceneState] = useState<SceneScheduleState | null>(null)
  const schedulerRef = useRef<SceneScheduler | null>(null)

  /** 落库 + 服务端立即生效（PUT /api/scene）。改了时刻表即按新表对齐 —— 常驻运行器推算天然支持。 */
  const persistAndRun = useCallback(
    (next: SceneSchedule) => {
      setSchedule(next)
      void schedulerRef.current
        ?.start(next)
        .then(() => {
          setSceneState(schedulerRef.current?.getState() ?? null)
        })
        .catch((err) => {
          notify(err instanceof Error ? err.message : '时刻表保存失败', 'error')
        })
    },
    [notify],
  )

  // 挂载：拉服务端存档 + 常驻运行器当前状态（页面没开它也在跑 —— 读数对齐）
  useEffect(() => {
    schedulerRef.current = new SceneScheduler()
    void schedulerRef.current.refresh().then((resp) => {
      if (resp) {
        setSchedule(resp.schedule ?? { enabled: false, slots: [] })
        setSceneState(resp.state)
      }
    })
    return () => {
      // 卸载只摘订阅 —— 不停服务端日程（常驻语义；停用走「启用」开关）
      schedulerRef.current?.detach()
    }
  }, [])

  // 运行读数兜底轮询：SSE scene 事件优先（refresh 内已订阅），断流时 5s 对齐一次防冻结
  useEffect(() => {
    const timer = window.setInterval(() => {
      const s = schedulerRef.current?.getState()
      if (s) setSceneState(s)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  /** 时段编辑：整体替换一条 */
  const patchSlot = (id: string, patch: Partial<SceneSlot>) => {
    persistAndRun({
      ...schedule,
      slots: schedule.slots.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    })
  }
  const addSlot = () => {
    const id = `scene-${Date.now().toString(36)}`
    persistAndRun({
      ...schedule,
      slots: [...schedule.slots, { id, time: '12:00', label: '', spec: undefined }],
    })
  }
  const removeSlot = (id: string) => {
    persistAndRun({ ...schedule, slots: schedule.slots.filter((s) => s.id !== id) })
  }

  const activeId = sceneState?.activeSlotId ?? null
  return (
    <section className="card-flat p-5 lg:col-span-2">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="micro-label">场景日程（到点切内容，早 / 中 / 晚多时段）</h2>
        <button
          type="button"
          onClick={() => persistAndRun({ ...schedule, enabled: !schedule.enabled })}
          className={`chip active:scale-[0.97] ${
            schedule.enabled
              ? 'chip-on'
              : 'bg-zinc-100 text-zinc-500 shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] dark:hover:bg-zinc-700'
          }`}
        >
          {schedule.enabled ? '✓ 已启用' : '启用'}
        </button>
      </div>

      {schedule.slots.length === 0 ? (
        <p className="text-sm text-zinc-400">还没有时段 —— 加一条（到点推什么内容到电子立牌）。</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {schedule.slots.map((s) => {
            const active = activeId === s.id
            return (
              <li
                key={s.id}
                className={`well flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] p-3 ${
                  active ? 'ring-1 ring-glow-500/60' : ''
                }`}
              >
                {/* 时刻 + 标签 */}
                <input
                  type="time"
                  value={s.time}
                  onChange={(e) => patchSlot(s.id, { time: e.target.value })}
                  className="input !w-28 !py-1.5 tabular-nums"
                  aria-label="开始时刻"
                />
                <input
                  value={s.label ?? ''}
                  placeholder="标签（如「午饭时间」）"
                  maxLength={12}
                  onChange={(e) => patchSlot(s.id, { label: e.target.value })}
                  className="input !w-40 !py-1.5"
                />
                {/* 内容来源：直接选天气/图库/画布等（同槽位配方） */}
                <select
                  value={s.spec?.source ?? ''}
                  onChange={(e) =>
                    patchSlot(s.id, {
                      spec: e.target.value
                        ? ({ source: e.target.value } as SceneSlot['spec'])
                        : undefined,
                    })
                  }
                  className="input !w-32 !py-1.5"
                  aria-label="内容来源"
                >
                  <option value="">未配内容</option>
                  {LOOP_SOURCES.filter((x) => x !== 'frames' && x !== 'usage' && x !== 'credit' && x !== 'usage-credit').map((src) => (
                    <option key={src} value={src}>
                      推{SOURCE_LABELS[src] ?? src}
                    </option>
                  ))}
                </select>
                {/* 持续分钟 */}
                <label className="flex items-center gap-1 text-xs text-zinc-400">
                  持续
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={s.durationMin ?? ''}
                    placeholder="到下一段"
                    onChange={(e) =>
                      patchSlot(s.id, {
                        durationMin: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                    className="input !w-24 !py-1.5 tabular-nums"
                  />
                  分
                </label>
                {/* 星期几（不勾 = 每天） */}
                <span className="flex items-center gap-1">
                  {DAY_LABELS.map((d, di) => {
                    const on = s.daysOfWeek?.includes(di) ?? false
                    return (
                      <button
                        key={d}
                        type="button"
                        title={`周${d}`}
                        onClick={() => {
                          const cur = new Set(s.daysOfWeek ?? [])
                          if (on) cur.delete(di)
                          else cur.add(di)
                          patchSlot(s.id, {
                            daysOfWeek: cur.size ? [...cur].sort((a, b) => a - b) : undefined,
                          })
                        }}
                        className={`h-6 w-6 rounded-md text-[11px] transition-colors ${
                          on
                            ? 'bg-zinc-800 text-zinc-100 dark:bg-zinc-200 dark:text-zinc-900'
                            : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-500 dark:hover:bg-zinc-700'
                        }`}
                      >
                        {d}
                      </button>
                    )
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => removeSlot(s.id)}
                  className="ml-auto text-xs text-zinc-400 transition-colors hover:text-red-500"
                  title="删除时段"
                >
                  删除
                </button>
                {active ? (
                  <span className="text-[10px] text-glow-600 dark:text-glow-400">● 进行中</span>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="chip" onClick={addSlot}>
          + 加时段
        </button>
        {sceneState?.activeSlotId ? (
          <span className="text-xs text-zinc-400">
            当前：{schedule.slots.find((s) => s.id === sceneState.activeSlotId)?.label || '（未命名时段）'}
          </span>
        ) : schedule.enabled ? (
          <span className="text-xs text-zinc-400">当前不在任何时段 —— 屏幕放默认时钟</span>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        到点服务端现取内容推到电子立牌（槽位 3，带指纹去重）；时段结束或没命中切回默认时钟。
        日程常驻服务端（页面关掉照跑，服务重启自动拉起）—— 这里只是编辑器与读数。
      </p>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 设备 Tab：控制 + 信息 + Wi-Fi + 维护 + 日志
// ─────────────────────────────────────────────────────────────────────────────

/** 灯效档（协议语义 0=关 1=静态 2=追逐 3=彩虹，对齐原版 ips-ext mcp-toolset）——
 *  此前误写成「关/呼吸/流水/闪烁/常亮」五档，值与设备语义全错位，点了无效果。 */
const LIGHT_MODES = ['关', '静态', '追逐', '彩虹'] as const
/** 各灯效档的一句话说明（RadioGroup 副说明 —— 第一次用的人不用猜）。 */
const LIGHT_MODE_HINTS = ['底灯关闭', '恒定显示选定灯色', '灯色依次流动', '多色循环流转'] as const
const TZ_OPTIONS: [string, number][] = [
  ['UTC+8 北京', 32],
  ['UTC+9 东京', 36],
  ['UTC+0 伦敦', 0],
  ['UTC-5 纽约', -20],
  ['UTC-8 洛杉矶', -32],
  ['UTC+1 巴黎', 4],
]

/**
 * 设备 Tab：双向绑定版。
 * 值的唯一来源 = profile.deviceControl（配置里存的）fallback 设备实报真值（info）——
 * 此前全是本地 useState 初始 75/#53c8f9（设备实际亮度读不回来 → UI 一直在造假）。
 * 变更 = 立即下发蓝牙 + patchDeviceControl 落盘（切 Tab 不丢，applyProfile 同一套真相）。
 * 读不到真值时显示「—」（绝不造默认值）。
 */
function DeviceTab({
  device,
  info,
  connected,
  profile,
  scheduleSave,
}: {
  device: ReturnType<typeof useDevice>['device']
  info: ReturnType<typeof useDevice>['info']
  connected: boolean
  profile: DisplayProfile
  scheduleSave: (p: DisplayProfile) => void
}): ReactElement {
  const { log, clearLog } = useDevice()
  const [wifiSsid, setWifiSsid] = useState('')
  const [wifiPass, setWifiPass] = useState('')
  const [firmwareUrl, setFirmwareUrl] = useState('')
  const [busy, setBusy] = useState('')
  /** ConfirmDialog 目标动作（重启/恢复出厂 —— 替代 window.confirm） */
  const [confirmAction, setConfirmAction] = useState<'reboot' | 'factory' | null>(null)
  const notify = useCallback((msg: string, kind?: 'info' | 'ok' | 'error') => toast(msg, kind), [])
  // 城市列表调服务端（与 SlotEditor 同源；失败回落前端静态映射）
  const [cities, setCities] = useState<string[]>(() => Object.keys(CITY_TO_LOCATION_ID))
  useEffect(() => {
    void listWeatherCities()
      .then((r) => setCities(r.cities))
      .catch(() => undefined)
  }, [])

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busy) return
      setBusy(label)
      try {
        await fn()
        notify(`${label} ✓`, 'ok')
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        setBusy('')
      }
    },
    [busy, notify],
  )

  // ── 双向绑定的读写桥 ──
  // 配置有值用配置；配置没值用设备实报（getLightMode/Brightness/Color 现在会进 info）；
  // 都没有 = 「—」，提示用户先下发一个值。
  const dc = profile.deviceControl
  const brightness = dc?.brightness ?? info.brightness
  const lightMode = dc?.lightMode ?? info.lightMode
  const lightColor = dc?.lightColor ?? info.lightColor
  const tz = dc?.timezoneQuarterHours ?? 32
  const use24 = (dc?.timeFormat ?? '24') !== '12'

  /** 变更即下发 + 落盘（deviceControl 整块替换，缺省字段保底） */
  const patchDeviceControl = useCallback(
    (patch: Partial<NonNullable<DisplayProfile['deviceControl']>>) => {
      const base = profile.deviceControl ?? {
        brightness: 75,
        clockStyle: 3,
        lightMode: 0,
        lightColor: '#53c8f9',
        timeFormat: '24',
        networkTime: true,
        weatherEnabled: false,
        weatherCity: '上海',
        tempUnit: 'c',
      }
      scheduleSave({ ...profile, deviceControl: { ...base, ...patch } })
    },
    [profile, scheduleSave],
  )

  const setBrightnessAndPush = (v: number): void => {
    const clamped = Math.min(100, Math.max(0, Math.round(v)))
    patchDeviceControl({ brightness: clamped })
    if (connected) void run(`亮度 ${clamped}`, () => device.setBrightness(clamped))
  }
  const setLightModeAndPush = (mode: number): void => {
    patchDeviceControl({ lightMode: mode })
    if (connected) void run(`灯效:${LIGHT_MODES[mode] ?? mode}`, () => device.setLightMode(mode))
  }
  const setLightColorAndPush = (hex: string): void => {
    patchDeviceControl({ lightColor: hex })
    if (connected) {
      const n = parseInt(hex.replace('#', ''), 16)
      if (Number.isFinite(n)) {
        void run('设置灯色', () => device.setLightColor((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff))
      }
    }
  }
  const syncTime = (): void => {
    if (connected) {
      void run('同步时间', () =>
        device.setTime({ timezoneQuarterHours: tz, use24Hour: use24, useNetworkTime: dc?.networkTime !== false }),
      )
    }
  }

  /** 显示值：读不到真值时「—」（反造假原则） */
  const dash = '—'

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* 左列 */}
      <div className="flex flex-col gap-5">
        <section className="card-flat p-5">
          <h2 className="micro-label mb-4">屏幕与灯光</h2>
          <label className="block text-sm">
            <span className="flex items-center justify-between font-medium">
              亮度
              <span className="readout text-xs text-zinc-400">{brightness === undefined ? '未读到' : '0–100'}</span>
            </span>
            {/* number 输入 + 快捷档（触屏滑杆拖不准）；Enter/失焦才下发蓝牙 */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={brightness ?? ''}
                placeholder={dash}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (e.target.value !== '' && Number.isFinite(v)) patchDeviceControl({ brightness: Math.min(100, Math.max(0, Math.round(v))) })
                }}
                onBlur={(e) => {
                  const raw = e.target.value
                  const v = Number(raw)
                  if (raw !== '' && Number.isFinite(v)) setBrightnessAndPush(v)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="input w-24 py-1.5 readout"
              />
              <span className="text-xs text-zinc-400">%</span>
              {[25, 50, 75, 100].map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={!connected}
                  aria-pressed={brightness === v}
                  onClick={() => setBrightnessAndPush(v)}
                  className={`chip-sm chip border border-transparent active:scale-[0.97] ${brightness === v ? 'chip-on' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-400">
              {brightness === undefined ? '设备当前亮度未读到（连接后自动读取）' : '已存进配置 —— 应用配置时随其余设置一并下发'}
            </p>
            {/* 滑杆（telegram-tt RangeSlider 移植）：拖动即下发，触屏比 number 输入顺手 */}
            <div className="mt-3">
              <RangeSlider
                min={0}
                max={100}
                step={5}
                value={brightness ?? 75}
                onChange={setBrightnessAndPush}
                renderValue={(v) => `${v}%`}
              />
            </div>
          </label>
          <div className="mt-4">
            <span className="text-sm font-medium">灯效</span>
            {/* RadioGroup：竖排档位 + 各档说明（连着设备实时下发，选中即生效） */}
            <RadioGroup
              name="light-mode"
              className="mt-2"
              selected={lightMode !== undefined ? LIGHT_MODES[lightMode as 0 | 1 | 2 | 3] : undefined}
              onChange={(label) => setLightModeAndPush(LIGHT_MODES.indexOf(label as (typeof LIGHT_MODES)[number]))}
              options={LIGHT_MODES.map((m, i) => ({
                value: m,
                label: m,
                subLabel: LIGHT_MODE_HINTS[i],
                disabled: !connected,
              }))}
            />
            {lightMode === undefined && <p className="mt-1.5 text-[11px] text-zinc-400">设备当前灯效未读到（{dash}）</p>}
          </div>
          <label className="mt-4 flex items-center justify-between text-sm font-medium">
            RGB 灯色
            <span className="flex items-center gap-2">
              <input
                type="color"
                value={lightColor ?? '#53c8f9'}
                disabled={!connected}
                onChange={(e) => setLightColorAndPush(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-line bg-transparent"
              />
              <span className="readout text-xs text-zinc-400">{lightColor ?? dash}</span>
            </span>
          </label>
        </section>

        <section className="card-flat p-5">
          <h2 className="micro-label mb-4">时间同步</h2>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Switcher
              checked={use24}
              onChange={(next) => patchDeviceControl({ timeFormat: next ? '24' : '12' })}
              label="24 小时制"
            />
            <select
              className="input w-auto py-1.5"
              value={tz}
              onChange={(e) => patchDeviceControl({ timezoneQuarterHours: Number(e.target.value) })}
              aria-label="时区"
            >
              {TZ_OPTIONS.map(([label, v]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={!connected}
              onClick={syncTime}
              title="显式下发（此前连接即自动 setTime —— StrictMode 下还会双发）"
            >
              立即同步
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
            时区/制式存进配置（此前设备页选的时区应用配置时被硬编码 UTC+8 覆盖）。
          </p>
        </section>

        <section className="card-flat p-5">
          <h2 className="mb-4 micro-label">设备原生天气</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              className="input !w-auto !py-1.5"
              defaultValue={CITY_TO_LOCATION_ID['上海'] ?? ''}
              onChange={(e) => {
                const id = e.target.value
                void run('下发天气', () =>
                  device.setWeather({ enabled: true, locationId: id, fahrenheit: false }),
                )
              }}
            >
              {cities.map((c) => (
                <option key={c} value={CITY_TO_LOCATION_ID[c] ?? ''}>
                  {c}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-ghost !py-1.5 text-sm"
              disabled={!connected}
              onClick={() => void run('关闭设备天气', () => device.setWeather({ enabled: false, locationId: '上海', fahrenheit: false }))}
            >
              关闭
            </button>
          </div>
        </section>
      </div>

      {/* 右列 */}
      <div className="flex flex-col gap-5">
        <section className="card-flat p-5">
          <h2 className="mb-4 micro-label">设备信息</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {[
              ['名称', info.name],
              ['固件', info.firmware],
              ['硬件', info.hardware],
              ['IP', info.ip],
              ['MAC', info.mac],
              ['存储', info.storage],
              ['当前槽位', info.clockStyle !== undefined ? SLOT_STYLE_NAMES[info.clockStyle] : undefined],
            ].map(([k, v]) => (
              <div key={String(k)} className="min-w-0">
                <dt className="text-xs text-zinc-400">{k}</dt>
                <dd className="truncate font-medium">{v || '—'}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="btn-ghost mt-4 !py-1.5 text-sm"
            disabled={!connected}
            onClick={() => void run('读取状态', () => device.readStatus())}
          >
            <IconRefresh className="h-4 w-4" />
            刷新
          </button>
        </section>

        <section className="card-flat p-5">
          <h2 className="mb-4 micro-label">Wi-Fi 配网</h2>
          <div className="flex flex-col gap-2">
            <input className="input" placeholder="Wi-Fi 名称（SSID）" value={wifiSsid} onChange={(e) => setWifiSsid(e.target.value)} />
            <input className="input" type="password" placeholder="Wi-Fi 密码" value={wifiPass} onChange={(e) => setWifiPass(e.target.value)} />
            <button
              type="button"
              className="btn-primary !py-1.5 text-sm"
              disabled={!connected || !wifiSsid || !wifiPass}
              onClick={() => void run('下发 Wi-Fi', () => device.configureWifi(wifiSsid, wifiPass))}
            >
              下发凭据
            </button>
          </div>
        </section>

        <section className="card-flat p-5">
          <h2 className="mb-4 micro-label">维护</h2>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="固件升级地址（可选）"
                value={firmwareUrl}
                onChange={(e) => setFirmwareUrl(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost shrink-0 !py-1.5"
                disabled={!connected || !firmwareUrl.trim()}
                onClick={() => void run('下发固件地址', () => device.setFirmwareAddress(firmwareUrl))}
              >
                下发
              </button>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!connected}
                onClick={() => setConfirmAction('reboot')}
              >
                重启
              </button>
              <button
                type="button"
                className="btn-danger btn-sm"
                disabled={!connected}
                onClick={() => setConfirmAction('factory')}
              >
                恢复出厂
              </button>
            </div>
          </div>
        </section>

        {/* 通信日志：已提升为全局浮窗（底栏「日志」胶囊，任意页面可开）——
            这里只留入口引导，不再内嵌第二份展示（同一数据两处渲染必然漂移） */}
        <section className="card-flat p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="micro-label">通信日志</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">{log.length} 条</span>
              <button type="button" className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" onClick={clearLog}>
                清空
              </button>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            协议帧实时显示在右下角的「日志」浮窗 —— 全站任何页面都能看（投屏/轮播调试时切页不再丢日志）。
          </p>
        </section>
      </div>
        <ConfirmDialog
          open={confirmAction !== null}
          title={confirmAction === 'factory' ? '恢复出厂设置？' : '重启设备？'}
          body={
            confirmAction === 'factory'
              ? '设备端设置（亮度/灯效/时间/Wi-Fi）将清除，页面配置不受影响。设备会自动重启。'
              : '设备将断开并重启，稍后需要重新连接。'
          }
          confirmLabel={confirmAction === 'factory' ? '恢复出厂' : '重启'}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            const action = confirmAction
            setConfirmAction(null)
            if (action === 'reboot') void run('重启', () => device.reboot())
            if (action === 'factory') void run('恢复出厂', () => device.factoryReset())
          }}
        />
    </div>
  )
}
