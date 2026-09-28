/**
 * Avatar：头像原语。图片优先，无图或加载失败回落首字符渐变圆（avatarChar）。
 * 尺寸档 sm(24)/md(28)/lg(40)；未登录占位用 text 传 '?'。
 * avatarChar 原在 lib/user.tsx（登录态模块）；本地版无登录概念，取首字符的
 * 纯函数随用随留在这里 —— 不再引一整个已删除的登录模块。
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import buildClassName from '../../util/buildClassName'

/** 取首字符（非空），大写化留给调用方（此处只做展示首字） */
function avatarChar(text: string): string {
  const t = text.trim()
  return t ? (t[0] ?? '?') : '?'
}

const SIZE_CLASS = {
  sm: 'h-6 w-6 text-[11px]',
  md: 'h-7 w-7 text-xs',
  lg: 'h-10 w-10 text-sm',
} as const

export function Avatar({
  src,
  text,
  size = 'sm',
  className,
}: {
  /** 头像图 URL；空 = 直接字符回落。 */
  src?: string
  /** 回落字符源（取首字符）；未登录场景直接传 '?'。 */
  text?: string
  size?: keyof typeof SIZE_CLASS
  className?: string
}): ReactElement {
  const [hasFailed, setHasFailed] = useState(false)
  const isImageOk = Boolean(src) && !hasFailed
  const box = buildClassName(
    'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full',
    isImageOk
      ? 'object-cover shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-700'
      : 'bg-gradient-to-br from-zinc-400 to-zinc-500 font-bold text-white dark:from-zinc-600 dark:to-zinc-700',
    SIZE_CLASS[size],
    className,
  )
  if (isImageOk) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className={box}
        onError={() => setHasFailed(true)}
      />
    )
  }
  return <span className={box}>{text ? avatarChar(text) : '?'}</span>
}
