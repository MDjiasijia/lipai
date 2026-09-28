/**
 * 主题（light / dark / auto）三态：
 *  - 默认 auto = 跟随设备（prefers-color-scheme），系统变化实时跟随；
 *  - 手动选 light / dark 存 localStorage（lipai-theme）；
 *  - 顶栏按钮三态循环 auto → light → dark → auto，随时可回到跟随设备；
 *  - <head> 内联脚本先读缓存设 <html class>，避免首屏闪烁。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'
/** auto = 跟随设备配置（null 存储态） */
export type ThemePref = Theme | 'auto'

const STORAGE_KEY = 'lipai-theme'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readPref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

const ThemeCtx = createContext<{ pref: ThemePref; theme: Theme; cycle: () => void }>({
  pref: 'auto',
  theme: 'light',
  cycle: () => {},
})

/** 三态循环顺序：auto → light → dark → auto */
const CYCLE: ThemePref[] = ['auto', 'light', 'dark']

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(() => readPref())
  const [system, setSystem] = useState<Theme>(() => systemTheme())

  // 跟随设备：系统深色模式变化实时生效（auto 态的唯一驱动）
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme: Theme = pref === 'auto' ? system : pref

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const cycle = () => {
    const next = CYCLE[(CYCLE.indexOf(pref) + 1) % CYCLE.length]!
    if (next === 'auto') {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, next)
    }
    setPref(next)
  }

  return <ThemeCtx.Provider value={{ pref, theme, cycle }}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  return useContext(ThemeCtx)
}
