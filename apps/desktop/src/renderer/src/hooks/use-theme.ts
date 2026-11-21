import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

function apply(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

function stored(): Theme {
  try {
    const value = localStorage.getItem('amc.theme')
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Light, dark or follow macOS. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored)
  useEffect(() => {
    apply(theme)
    try {
      localStorage.setItem('amc.theme', theme)
    } catch {}
    if (theme !== 'system') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])
  return { theme, setTheme }
}
