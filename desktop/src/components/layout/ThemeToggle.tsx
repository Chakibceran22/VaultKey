import { AnimatePresence, m } from 'framer-motion'
import { MoonStars, Sun } from '@phosphor-icons/react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { useTheme } from '@renderer/hooks/use-theme'

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme()
  return (
    <IconButton
      label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggle}
      className={className}
    >
      <AnimatePresence mode="wait" initial={false}>
        <m.span
          key={theme}
          initial={{ rotate: -45, opacity: 0, scale: 0.6 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 45, opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.18 }}
          className="flex"
        >
          {theme === 'dark' ? <MoonStars size={17} /> : <Sun size={17} />}
        </m.span>
      </AnimatePresence>
    </IconButton>
  )
}
