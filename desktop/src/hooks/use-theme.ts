import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'vaultkey-theme'

type Theme = 'light' | 'dark'

export function useTheme(): { theme: Theme; toggle: () => void } {
  // public/theme-init.js already applied the right theme before React mounted.
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // Native bits (scrollbars, form controls) follow the app's theme, not the system's.
    document.documentElement.style.colorScheme = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // storage blocked: the theme lasts for this session
    }
  }, [theme])

  /** Crossfades between themes where View Transitions exist (and motion is welcome). */
  const toggle = useCallback(() => {
    const next: Theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
    const apply = (): void => {
      // Update the DOM synchronously so the transition captures the new theme.
      document.documentElement.classList.toggle('dark', next === 'dark')
      setTheme(next)
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!('startViewTransition' in document) || reduceMotion) apply()
    else document.startViewTransition(apply)
  }, [])

  return { theme, toggle }
}
