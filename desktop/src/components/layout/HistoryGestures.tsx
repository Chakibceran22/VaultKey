import { useEffect, useRef, type RefObject } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { ArrowLeft } from '@phosphor-icons/react'
import { isTauri } from '@tauri-apps/api/core'
import { IS_MAC, isOverlayOpen, isTyping } from '@renderer/lib/dom'

/**
 * Back and forward the way browsers do it:
 *
 * - Two-finger swipe on a trackpad, fingers to the right for back, to the left for
 *   forward. On macOS it is WKWebView's own (Safari's) gesture, switched on in
 *   lib.rs: it sees the fingers touch and lift, so quick swipes are never missed
 *   and one swipe never counts twice. Elsewhere it is done here, from the only
 *   thing a page gets, anonymous wheel deltas: a ring fills around an arrow as the
 *   fingers travel, the page leans with them, and it goes once per gesture (the
 *   moment the ring is full, or on release after a flick past half way). A swipe
 *   the other way is recognised at once, even during the last one's momentum.
 * - The mouse's side buttons.
 * - ⌘[ ⌘] or ⌘← ⌘→ on macOS, Alt+← Alt+→ elsewhere.
 *
 * Nothing here re-renders React while swiping: wheel events only do arithmetic,
 * and the arrow and the page are painted directly, at most once per frame. After
 * the fingers lift, momentum events are recognised and ignored, so the arrow
 * leaves at once instead of waiting for them to stop.
 *
 * All of it stands down while a dialog is open, and a swipe that starts on
 * something that scrolls sideways itself (a text field, a wide block) is left to it.
 */

type Direction = 'back' | 'forward'

/** Horizontal travel, in px, that fills the ring and navigates. */
const THRESHOLD = 120
/** A flick released past this share of the way navigates too. */
const FLICK = 0.55
/** No wheel event for this long: the gesture (with its momentum) is over. */
const GESTURE_END_MS = 100
/** macOS app: the webview swipes natively (lib.rs); the browser preview has no such thing. */
const NATIVE_SWIPE = IS_MAC && isTauri()
/** How far the arrow travels in from the edge, and how far the page leans. */
const ARROW_HIDDEN = -56
const ARROW_REACH = 88
const PAGE_LEAN = 22
const RING = 2 * Math.PI * 19

/** react-router keeps each entry's position in `history.state.idx`. */
function historyIndex(): number {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx
  return typeof idx === 'number' ? idx : 0
}

/** The target (or a parent) scrolls sideways itself, and can still go that way. */
function scrollsSideways(target: EventTarget | null, deltaX: number): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (isTyping(el)) return true
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX
      const room = deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      if ((overflow === 'auto' || overflow === 'scroll') && room) return true
    }
  }
  return false
}

/** Eases out and never quite stops: resistance, like a rubber band. */
const rubber = (x: number): number => 1 - Math.exp(-x * 1.6)

export function HistoryGestures({ page }: { page: RefObject<HTMLElement | null> }) {
  const navigate = useNavigate()
  const { key } = useLocation()
  const type = useNavigationType()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  // How far forward history goes: opening a new page drops what was ahead of it.
  const furthest = useRef(historyIndex())
  const bubble = useRef<HTMLDivElement>(null)
  const ring = useRef<SVGCircleElement>(null)
  const arrow = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const idx = historyIndex()
    furthest.current = type === 'PUSH' ? idx : Math.max(furthest.current, idx)
  }, [key, type])

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const can = (dir: Direction): boolean => (dir === 'back' ? historyIndex() > 0 : historyIndex() < furthest.current)

    // ── painting, straight to the DOM ──
    let timers: ReturnType<typeof setTimeout>[] = []
    const later = (ms: number, run: () => void): void => {
      timers.push(setTimeout(run, ms))
    }
    const clearLater = (): void => {
      timers.forEach(clearTimeout)
      timers = []
    }
    const place = (dir: Direction): void => {
      const el = bubble.current
      if (!el) return
      el.style.left = dir === 'back' ? '0' : ''
      el.style.right = dir === 'forward' ? '0' : ''
      if (arrow.current) arrow.current.style.scale = dir === 'back' ? '1 1' : '-1 1'
    }
    /** Follows the fingers: no transitions, one write per frame. */
    const track = (dir: Direction, progress: number, possible: boolean): void => {
      const el = bubble.current
      if (!el) return
      const reach = possible ? rubber(progress) * ARROW_REACH : rubber(progress) * 26
      const sign = dir === 'back' ? 1 : -1
      el.dataset.state = 'tracking'
      el.style.transition = 'none'
      el.style.translate = `${sign * (ARROW_HIDDEN + reach)}px -50%`
      el.style.opacity = String(Math.min(1, progress * 2.2) * (possible ? 1 : 0.5))
      el.style.scale = '1'
      el.style.backgroundColor = ''
      el.style.color = ''
      if (ring.current) ring.current.style.strokeDashoffset = String(RING * (1 - (possible ? Math.min(1, progress) : 0)))
      const content = page.current
      if (content && !reduced.matches) {
        content.style.transition = 'none'
        content.style.translate = `${sign * rubber(progress) * (possible ? PAGE_LEAN : PAGE_LEAN / 3)}px 0`
      }
    }
    /** The page settles back. */
    const settle = (ms: number): void => {
      const content = page.current
      if (!content || !content.style.translate) return
      content.style.transition = `translate ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`
      content.style.translate = ''
      later(ms, () => {
        content.style.transition = ''
      })
    }
    /** Not far enough: the arrow slides back out. */
    const cancel = (dir: Direction): void => {
      const el = bubble.current
      if (!el) return
      el.dataset.state = 'cancel'
      el.style.transition = 'translate 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms linear'
      el.style.translate = `${(dir === 'back' ? 1 : -1) * ARROW_HIDDEN}px -50%`
      el.style.opacity = '0'
      settle(160)
      later(140, () => {
        if (el.dataset.state === 'cancel') el.dataset.state = 'hidden'
      })
    }
    /** Going: the ring fills, the arrow pops in the accent colour and slides out. */
    const commit = (dir: Direction): void => {
      const el = bubble.current
      if (!el) return
      clearLater()
      place(dir)
      const sign = dir === 'back' ? 1 : -1
      if (el.dataset.state !== 'tracking') {
        // From the keyboard or a mouse button: appear already in place.
        el.style.transition = 'none'
        el.style.translate = `${sign * (ARROW_HIDDEN + ARROW_REACH)}px -50%`
        el.style.opacity = '1'
      }
      el.dataset.state = 'commit'
      if (ring.current) ring.current.style.strokeDashoffset = '0'
      el.style.transition = 'scale 90ms cubic-bezier(0.34, 1.56, 0.64, 1), background-color 90ms linear, color 90ms linear'
      el.style.scale = '1.12'
      el.style.backgroundColor = 'var(--primary)'
      el.style.color = 'var(--primary-foreground)'
      settle(200)
      later(110, () => {
        el.style.transition = 'translate 170ms cubic-bezier(0.55, 0, 1, 0.45), opacity 150ms linear, scale 170ms ease-in'
        el.style.translate = `${sign * (ARROW_HIDDEN - 12)}px -50%`
        el.style.opacity = '0'
        el.style.scale = '0.9'
      })
      later(300, () => {
        if (el.dataset.state === 'commit') el.dataset.state = 'hidden'
      })
    }
    const go = (dir: Direction): void => {
      if (!can(dir)) return
      commit(dir)
      navigateRef.current(dir === 'back' ? -1 : 1)
    }

    // ── trackpad swipes ──
    type Phase = 'idle' | 'vertical' | 'blocked' | 'tracking' | 'done'
    let phase: Phase = 'idle'
    let travel = 0
    let peak = 0
    let falling = 0
    let lastSize = 0
    let frame = 0
    // The way the gesture was going: momentum never turns around, fingers can.
    let sign = 0
    let endTimer: ReturnType<typeof setTimeout> | undefined
    const direction = (): Direction => (travel > 0 ? 'back' : 'forward')
    const paint = (): void => {
      frame = 0
      if (phase !== 'tracking') return
      const dir = direction()
      place(dir)
      track(dir, Math.abs(travel) / THRESHOLD, can(dir))
    }
    /** The fingers lifted (or stopped): go if it was a flick past half way. */
    const release = (): void => {
      if (phase !== 'tracking') return
      phase = 'done'
      cancelAnimationFrame(frame)
      frame = 0
      const dir = direction()
      if (Math.abs(travel) / THRESHOLD >= FLICK && can(dir)) go(dir)
      else cancel(dir)
    }
    const reset = (): void => {
      phase = 'idle'
      travel = peak = falling = lastSize = sign = 0
    }
    const end = (): void => {
      release()
      reset()
    }
    /**
     * During the tail of a gesture that went somewhere: a swipe the other way. Only
     * that: momentum never turns around, while a same-way "new swipe" can't be told
     * from the same swipe slowing and speeding up again (it went twice).
     */
    const turnedAround = (event: WheelEvent): boolean =>
      phase === 'done' &&
      sign !== 0 &&
      Math.abs(event.deltaX) >= 3 &&
      Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5 &&
      Math.sign(event.deltaX) === -sign
    const onWheel = (event: WheelEvent): void => {
      // Pixel deltas come from trackpads (a mouse wheel scrolls in lines on most
      // systems); Ctrl+wheel is a pinch.
      if (event.deltaMode !== 0 || event.ctrlKey) return
      clearTimeout(endTimer)
      endTimer = setTimeout(end, GESTURE_END_MS)
      if (turnedAround(event)) reset()
      if (phase === 'idle') {
        if (Math.abs(event.deltaX) < 1 && Math.abs(event.deltaY) < 1) return
        // The first movement decides: a mostly vertical scroll never turns into a swipe.
        if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.5) phase = 'vertical'
        else if (isOverlayOpen() || scrollsSideways(event.target, event.deltaX)) phase = 'blocked'
        else {
          phase = 'tracking'
          clearLater()
        }
      }
      if (phase !== 'tracking') return
      travel -= event.deltaX
      sign = Math.sign(event.deltaX) || sign
      // Momentum after the fingers lift shrinks steadily: treat it as the release.
      const size = Math.abs(event.deltaX)
      peak = Math.max(peak, size)
      falling = size < lastSize ? falling + 1 : 0
      lastSize = size
      if (falling >= 3 && size < peak * 0.5) {
        release()
        return
      }
      if (Math.abs(travel) >= THRESHOLD && can(direction())) {
        // Full: go now, not on release; the rest of the gesture is ignored.
        phase = 'done'
        cancelAnimationFrame(frame)
        frame = 0
        go(direction())
        return
      }
      if (!frame) frame = requestAnimationFrame(paint)
    }

    // ── mouse side buttons (3 back, 4 forward) ──
    const onMouse = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return
      // Ours to handle: the webview must not navigate on its own as well.
      event.preventDefault()
      if (event.type === 'mouseup' && !isOverlayOpen()) go(event.button === 3 ? 'back' : 'forward')
    }

    // ── keyboard ──
    // They work with the cursor in a text field too (a page may focus its search when
    // it opens), as in browsers: none of them edits text. Except ⌘← ⌘→, which move
    // the cursor there.
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.shiftKey || event.repeat || isOverlayOpen()) return
      let dir: Direction | null = null
      if (IS_MAC && event.metaKey && !event.altKey && !event.ctrlKey) {
        const typing = isTyping(event.target)
        if (event.key === '[' || (event.key === 'ArrowLeft' && !typing)) dir = 'back'
        else if (event.key === ']' || (event.key === 'ArrowRight' && !typing)) dir = 'forward'
      } else if (!IS_MAC && event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === 'ArrowLeft') dir = 'back'
        else if (event.key === 'ArrowRight') dir = 'forward'
      }
      if (!dir) return
      event.preventDefault()
      go(dir)
    }

    document.documentElement.dataset.swipe = NATIVE_SWIPE ? 'native' : 'app'
    if (!NATIVE_SWIPE) window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('mousedown', onMouse)
    window.addEventListener('mouseup', onMouse)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(endTimer)
      clearLater()
      cancelAnimationFrame(frame)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('mousedown', onMouse)
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('keydown', onKey)
    }
  }, [page])

  // Always mounted and invisible until a gesture: nothing is created while swiping.
  return (
    <div
      ref={bubble}
      aria-hidden
      data-history-arrow
      data-state="hidden"
      className="glass-strong pointer-events-none fixed top-1/2 z-[150] flex size-11 items-center justify-center rounded-full text-foreground shadow-[0_8px_24px_-8px_rgb(0_0_0/0.45)]"
      style={{ left: 0, opacity: 0, translate: `${ARROW_HIDDEN}px -50%`, willChange: 'translate, opacity, scale' }}
    >
      <svg viewBox="0 0 44 44" className="absolute inset-0 size-full -rotate-90">
        <circle cx="22" cy="22" r="19" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="2" />
        <circle
          ref={ring}
          cx="22"
          cy="22"
          r="19"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={RING}
          strokeDashoffset={RING}
        />
      </svg>
      <span ref={arrow} className="flex">
        <ArrowLeft size={18} weight="bold" />
      </span>
    </div>
  )
}
