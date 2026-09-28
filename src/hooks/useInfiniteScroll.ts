/**
 * 无限滚动哨兵（IntersectionObserver）。
 *
 * 哨兵接近视口（rootMargin 预载带）→ 触发 onLoadMore。observer 常驻不随
 * loading/exhausted 重建 —— 回调读 ref 里的最新值；exhausted/无 cursor 时静默。
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

const DEFAULT_ROOT_MARGIN = '400px'

export function useInfiniteScroll({
  onLoadMore,
  hasMore,
  rootMargin = DEFAULT_ROOT_MARGIN,
}: {
  /** 触发加载下一页（应自带幂等/进行中保护）。 */
  onLoadMore: () => void
  /** false = 没有更多（不再触发）。 */
  hasMore: boolean
  rootMargin?: string
}): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /** 回调与 hasMore 走 ref：observer 常驻，deps 只留 rootMargin。 */
  const onLoadMoreRef = useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        if (hasMoreRef.current) onLoadMoreRef.current()
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])

  return sentinelRef
}
