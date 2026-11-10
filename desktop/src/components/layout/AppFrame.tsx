import { useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { AnimatePresence, m } from 'framer-motion'
import { FileArrowDown, LockKey, MagnifyingGlass } from '@phosphor-icons/react'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useAuth } from '@renderer/store/auth'
import { IconButton, Kbd } from '@renderer/components/ui/icon-button'
import { plural } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { IS_MAC, isModKey, isOverlayOpen, MOD } from '@renderer/lib/dom'
import { useDropTarget } from '@renderer/lib/drop-target'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'
import { SearchConsole } from '@renderer/components/search/SearchConsole'
import { HistoryGestures } from './HistoryGestures'
import { ThemeToggle } from './ThemeToggle'

const SECTIONS = [
  { to: '/accounts', label: 'Accounts' },
  { to: '/projects', label: 'Projects' },
  { to: '/devices', label: 'Devices' }
]

/**
 * The unlocked app's chrome: one bar at the top (sections, search, theme, lock)
 * on a flat canvas, and the page below it. No sidebar.
 */
export function AppFrame() {
  const navigate = useNavigate()
  const { pathname, key } = useLocation()
  const navigationType = useNavigationType()
  const { logout } = useAuth()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteRef = useRef(paletteOpen)
  paletteRef.current = paletteOpen
  const [dragging, setDragging] = useState(0)
  const mainRef = useRef<HTMLElement>(null)
  const dropTarget = useDropTarget((s) => s.target)

  const lock = useCallback(() => {
    void logout()
    navigate('/login')
  }, [logout, navigate])

  // Where each page was scrolled to, so back and forward return to it.
  const scrolls = useRef(new Map<string, number>())
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    const remember = (): void => {
      scrolls.current.set(keyRef.current, main.scrollTop)
    }
    main.addEventListener('scroll', remember, { passive: true })
    return () => main.removeEventListener('scroll', remember)
  }, [])

  // A new page starts at the top; one gone back or forward to, where it was left.
  const lastPath = useRef(pathname)
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    const saved = navigationType === 'POP' ? scrolls.current.get(key) : undefined
    if (saved !== undefined) {
      main.scrollTo({ top: saved })
      // Its content may only be laid out a frame later.
      requestAnimationFrame(() => main.scrollTo({ top: saved }))
    } else if (pathname !== lastPath.current) {
      main.scrollTo({ top: 0 })
    }
    lastPath.current = pathname
  }, [key, pathname, navigationType])

  // ⌘K search, ⌘1–3 sections, ⌘L lock.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isModKey(event)) return
      const key = event.key.toLowerCase()
      // Physical keys for the digits: on AZERTY, ⌘1 reports "&".
      const section = /^Digit([1-3])$/.exec(event.code)
      if (key === 'l') {
        event.preventDefault()
        lock()
      } else if (key === 'k') {
        event.preventDefault()
        // ⌘K closes the palette; it never opens over a modal or a confirmation.
        if (paletteRef.current) setPaletteOpen(false)
        else if (!isOverlayOpen()) setPaletteOpen(true)
      } else if (section && !isOverlayOpen()) {
        event.preventDefault()
        navigate(SECTIONS[Number(section[1]) - 1].to)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lock, navigate])

  // Files dragged onto the window. Rust keeps the paths; we only hear about it.
  const targetRef = useRef(dropTarget)
  targetRef.current = dropTarget
  useEffect(() => {
    if (!isTauri()) return
    const offs: Array<() => void> = []
    let alive = true
    const keep = (off: () => void): void => {
      if (alive) offs.push(off)
      else off()
    }
    listen<{ active: boolean; count: number }>('vault://drag', ({ payload }) =>
      setDragging(payload.active ? payload.count : 0)
    ).then(keep, () => {})
    listen<{ names: string[] }>('vault://drop', async ({ payload }) => {
      const target = targetRef.current
      if (!target) {
        toast.message('Open a project to add files to it')
        return
      }
      try {
        // Into the project's upload dialog, where each gets a description before it is added.
        const staged = unwrap(await api.stageDroppedFiles())
        for (const skipped of staged.skipped) toast.error(`${skipped.name}: ${skipped.reason}`)
        if (staged.files.length) useDropTarget.getState().setDropped(staged)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Couldn’t add ${plural(payload.names.length, 'file')}`)
      }
    }).then(keep, () => {})
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [])

  return (
    <div className="flex h-dvh flex-col">
      <header
        data-tauri-drag-region
        className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b pr-3"
        style={{ paddingLeft: IS_MAC ? 88 : 16 }}
      >
        <nav aria-label="Sections" className="flex rounded-lg border bg-secondary/70 p-0.5">
          {SECTIONS.map((section, i) => (
            <NavLink
              key={section.to}
              to={section.to}
              title={`${section.label} (${MOD}${i + 1})`}
              className={({ isActive }) =>
                cn(
                  'flex h-7 items-center rounded-md px-3 text-[13px] font-medium transition-[color,background-color,box-shadow] duration-150',
                  isActive
                    ? 'bg-white text-heading shadow-[0_1px_2px_rgb(30_34_70/0.07)] dark:bg-white/12 dark:shadow-none'
                    : 'text-muted-foreground hover:text-foreground'
                )
              }
            >
              {section.label}
            </NavLink>
          ))}
        </nav>
        <span className="flex-1 self-stretch" data-tauri-drag-region />
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-8 w-60 cursor-pointer items-center gap-2 rounded-lg border bg-secondary/50 px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
        >
          <MagnifyingGlass size={15} className="shrink-0" />
          Search everything
          <Kbd className="ml-auto bg-background/60">{MOD}K</Kbd>
        </button>
        <ThemeToggle />
        <IconButton label="Lock vault" shortcut={`${MOD}L`} onClick={lock}>
          <LockKey size={17} />
        </IconButton>
      </header>

      <main ref={mainRef} className="@container min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <Outlet />
      </main>

      <SearchConsole open={paletteOpen} onOpenChange={setPaletteOpen} />
      <HistoryGestures page={mainRef} />

      <AnimatePresence>
        {dragging > 0 && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none fixed inset-0 z-[250] flex items-center justify-center bg-(--scrim) p-6"
          >
            <div className="glass-strong flex w-full max-w-md flex-col items-center rounded-2xl border-2 border-dashed border-primary/40 px-8 py-10 text-center">
              <FileArrowDown size={32} className="text-primary" />
              <p className="mt-3 text-[16px] font-semibold text-heading">
                {dropTarget ? `Add ${plural(dragging, 'file')} to ${dropTarget.name}` : 'Open a project first'}
              </p>
              <p className="mt-1 text-[13.5px] text-muted-foreground">
                {dropTarget ? 'They are encrypted with your vault key.' : 'Files are added to the project you have open.'}
              </p>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
}
