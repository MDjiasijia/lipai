/**
 * 导入按钮（库 → 本地配置/图组的最后一米）：把素材库的文件直接导入本地 ~/.lipai/。
 * 旧版走浏览器 IndexedDB（downloadShareBytes → validateShareFile →
 * importPayload）；本地版统一交给服务端 —— POST /api/library/:id/import 由
 * 服务端落盘（id 冲突换新、图组重名加 -2、引用改写），浏览器不再持有导入逻辑。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import { importToLibrary } from '../lib/api'
import { toast } from './ui/Toast'
import { Button } from './ui/Button'
import { IconStack } from './icons'

export function ImportButton({ id, type }: { id: string; type: 'lipai-profile' | 'lipai-gallery' }): ReactElement {
  const [busy, setBusy] = useState(false)
  const isProfile = type === 'lipai-profile'

  // 导入目标从「我的图组」扩展为「本地配置/图组」：
  // 配置文件连带依赖图组一起落盘；图组文件只落图组。
  const doImport = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const imported = await importToLibrary(id)
      const profileNote = imported.profiles.length > 0 ? `${imported.profiles.length} 份配置` : ''
      const galleryNote = imported.galleries.length > 0 ? `${imported.galleries.length} 个图组` : ''
      const note = [profileNote, galleryNote].filter(Boolean).join(' + ')
      toast(note ? `已导入${note}，去控制台即可使用` : '文件里没有可导入的配置或图组', note ? 'ok' : 'error')
    } catch (e) {
      toast(e instanceof Error ? e.message : '导入失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      tone="ghost"
      size="sm"
      isLoading={busy}
      loadingLabel="导入中…"
      onClick={doImport}
      className="shrink-0"
      title={isProfile ? '导入为本地配置（服务端落盘，自动带依赖图组）' : '导入为本地图组（服务端落盘，重名自动加后缀）'}
    >
      <IconStack className="inline-block align-[-0.15em]" />
      {isProfile ? '导入配置' : '导入图组'}
    </Button>
  )
}
