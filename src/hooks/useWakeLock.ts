/**
 * 屏幕常亮（Screen Wake Lock API）。
 *
 * enabled 期间持有 'screen' 锁；enabled=false / 卸载即释放。
 * 锁被系统释放（页面切后台 / 屏幕锁 / 系统省电模式）后 sentinel
 * 变 released；页面回到可见时按需重新申请 —— 这条 re-acquire 是标准坑：
 * 锁不是「请求一次管到底」，而是「可见期间要一直维持」。
 *
 * 不可用（老浏览器）静默跳过：常亮是增益不是依赖。
 * 类型：lib.dom 已收录 WakeLock/WakeLockSentinel；wakeLock 在部分
 * 环境（内嵌 WKWebView / jsdom）不存在，导航器探测用宽类型收窄。
 */
import { useEffect, useRef } from 'react'

export function useWakeLock(enabled: boolean): void {
  // sentinel 与释放函数都挂 ref：effect 重跑（enabled/可见性变化）不丢句柄
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: WakeLock }
    if (!enabled || !nav.wakeLock) return

    let dead = false
    const acquire = async () => {
      if (dead || sentinelRef.current) return
      try {
        const s = await nav.wakeLock!.request('screen')
        if (dead) {
          // 申请期间 effect 已清理（快速开关）：立即放掉刚拿到的
          if (!s.released) void s.release().catch(() => {})
          return
        }
        sentinelRef.current = s
        s.addEventListener('release', () => {
          // 系统释放（切后台等）：清句柄，等可见性恢复再申请
          if (sentinelRef.current === s) sentinelRef.current = null
        })
      } catch {
        /* 省电模式 / 系统拒绝：常亮是增益不是依赖 */
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    void acquire()

    return () => {
      dead = true
      document.removeEventListener('visibilitychange', onVisible)
      const s = sentinelRef.current
      sentinelRef.current = null
      if (s && !s.released) void s.release().catch(() => {})
    }
  }, [enabled])
}
