/**
 * Button：按钮原语（isLoading 语义收口）。
 *
 * 样式走 index.css 的 btn-* 复合类（btn-primary/ghost/danger + btn-sm），
 * 本组件只补两件事：
 * - isLoading：文字替换成 Spinner + 文案（不再各处手写三元 + 手动 disabled）
 * - disabled 随 isLoading 自动置真（进行中不可再点 —— 此前靠每个调用点记得写）
 *
 * 纯静态按钮（无异步态）继续直接写 <button className="btn-primary">，
 * 这个组件为「会转圈的按钮」存在。
 */
import type { ReactElement, ReactNode } from 'react'
import { Spinner } from './Spinner'
import buildClassName from '../../util/buildClassName'

export function Button({
  tone = 'primary',
  size,
  isLoading,
  loadingLabel = '处理中…',
  children,
  className,
  disabled,
  onClick,
  type = 'button',
  title,
}: {
  tone?: 'primary' | 'ghost' | 'danger'
  /** 小尺寸（btn-sm）；缺省 = 常规 44px。 */
  size?: 'sm'
  /** 进行中：转圈 + loadingLabel，按钮禁用。 */
  isLoading?: boolean
  loadingLabel?: string
  children: ReactNode
  className?: string
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
  title?: string
}): ReactElement {
  const isBusy = isLoading === true
  return (
    <button
      type={type}
      className={buildClassName(`btn-${tone}`, size === 'sm' && 'btn-sm', className)}
      disabled={disabled || isBusy}
      onClick={onClick}
      title={title}
    >
      {isBusy ? <Spinner className="h-3.5 w-3.5" /> : null}
      {isBusy ? loadingLabel : children}
    </button>
  )
}
