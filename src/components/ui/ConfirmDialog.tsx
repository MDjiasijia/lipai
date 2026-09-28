/**
 * ConfirmDialog：全站唯一的破坏性确认原语（Modal 薄封装）。
 * 分工：Modal 管开合动画/焦点/背板/Portal，这里只管确认语义
 * （alertdialog 角色 + 取消/确认按钮组）。tone 缺省 = danger（多数确认是删除）。
 * isConfirming：确认动作进行中 —— 确认钮转圈禁用、取消钮一并禁用（等结果再走）。
 */
import type { ReactElement } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '确认',
  tone = 'danger',
  isConfirming,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  /** 确认钮样式：danger（缺省，删除/破坏性）| primary（一般确认）。 */
  tone?: 'danger' | 'primary'
  /** 确认动作进行中（转圈 + 禁用）。 */
  isConfirming?: boolean
  onConfirm: () => void
  onClose: () => void
}): ReactElement | null {
  return (
    <Modal isOpen={open} onClose={onClose} ariaLabel={title} contentClassName="w-full max-w-sm p-5">
      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
      {body ? <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{body}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={isConfirming}>
          取消
        </button>
        <Button tone={tone} size="sm" isLoading={isConfirming} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}
