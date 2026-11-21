import { useEffect, useLayoutEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const SYSTEM_DARK = '(prefers-color-scheme: dark)'

function stored(): Theme {
  try {
    const value = localStorage.getItem('amc.theme')
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored)
  const [systemDark, setSystemDark] = useState(() => matchMedia(SYSTEM_DARK).matches)
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  useEffect(() => {
    try {
      localStorage.setItem('amc.theme', theme)
    } catch {}
  }, [theme])
  useEffect(() => {
    const media = matchMedia(SYSTEM_DARK)
    const onChange = () => setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return { dark, setTheme }
}
