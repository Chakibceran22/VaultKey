// What the content script draws on a page (M3; plans/05 "Key icon", plans/02
// "Clickjacking defences"): the key icon inside a login field, and the host of the menu
// iframe under it.
//
// Each sits in its own plain <div> on <html> (not <body>, which single-page apps replace;
// not a custom element, which the page could define), with a closed shadow root, shown in
// the browser's top layer (`popover="manual"`) so page z-indexes can't cover it, and styled
// with `!important` so page CSS can't move it. Any change to them from outside (style,
// attributes, removal) closes the menu, and a menu that moved isn't trusted until it has
// stayed put again for a while. Nothing is drawn on pages without a login field.

const ICON = 20
const GAP = 4
const ROW = 44
const FOOTER = 33
/** The menu is always this tall (8 rows), whatever it shows: the page can't count the
 * accounts. The menu page draws its panel at the top (or the bottom, when it opens above
 * the field) and leaves the rest transparent; a click there closes it. */
export const MENU_HEIGHT = 8 * ROW + 8 + FOOTER

/** VaultKey's dial (extension/assets/icon-small.svg), at icon size. */
const MARK = `<svg viewBox="0 0 64 64" width="${ICON}" height="${ICON}" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#4f5bd5"/><circle cx="32" cy="33" r="23" fill="none" stroke="#fff" stroke-width="6.5"/><path d="M32 3.2l4.6 6.2h-9.2z" fill="#fff"/><path fill="#fff" fill-rule="evenodd" d="M32 21a12 12 0 1 1 0 24a12 12 0 1 1 0-24ZM29.9 35.6A4.2 4.2 0 1 1 34.1 35.6L35.1 41C35.2 41.9 34.7 42.5 33.9 42.5H30.1C29.3 42.5 28.8 41.9 28.9 41Z"/></svg>`

/** The menu's own height for `rows` rows (a locked or empty menu: one message row). */
export function frameHeight(rows: number): number {
  return Math.min(Math.max(rows, 1), 8) * ROW + 8 + FOOTER
}

const RESET = {
  all: 'initial',
  position: 'fixed',
  inset: 'auto',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'transparent',
  overflow: 'visible',
  'z-index': '2147483647',
  visibility: 'visible',
  opacity: '1',
  transform: 'none',
  filter: 'none',
}

const canPop = (element: HTMLElement): boolean => typeof element.showPopover === 'function'

/** An element's inline declarations, without custom properties (`--…`, which some
 * extensions, such as dark-mode ones, add to every styled element: they change nothing here). */
function declarations(element: HTMLElement): Map<string, string> {
  const map = new Map<string, string>()
  const style = element.style
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i)
    if (!name.startsWith('--')) map.set(name, `${style.getPropertyValue(name)}!${style.getPropertyPriority(name)}`)
  }
  return map
}

function same(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, value]) => b.get(name) === value)
}

interface Host {
  element: HTMLDivElement
  root: ShadowRoot
  /** The inline declarations this code last wrote: anything else came from the page. */
  style: Map<string, string>
}

export class Overlay {
  private icon: Host | null = null
  private menu: Host | null = null
  private frame: HTMLIFrameElement | null = null
  private field: HTMLInputElement | null = null
  private menuOpen = false
  private above = false
  private frameRows = 1
  private frameRequested = false
  private pending = 0
  /** Where the menu was last put, and when. */
  private placed = { left: 0, top: 0, width: 0, at: 0 }
  private readonly watcher: ResizeObserver
  private readonly guard: MutationObserver

  constructor(
    private readonly onIcon: () => void,
    /** The page tampered with our elements and the menu is gone. */
    private readonly onDropped: () => void = () => {},
  ) {
    this.watcher = new ResizeObserver(() => this.schedule())
    // Ours to change: a change from anywhere else (the page) closes the menu.
    this.guard = new MutationObserver((changes) => {
      for (const host of [this.icon, this.menu]) {
        if (!host) continue
        const restyled = changes.some(
          (change) => change.target === host.element && change.attributeName === 'style' && !same(declarations(host.element), host.style),
        )
        const gone = !host.element.isConnected || host.element.getAttribute('popover') !== 'manual'
        if (restyled || gone) {
          this.tampered()
          return
        }
      }
    })
    const reflow = () => this.schedule()
    addEventListener('scroll', reflow, { capture: true, passive: true })
    addEventListener('resize', reflow, { passive: true })
  }

  /** The field the icon (and menu) belongs to. */
  get anchor(): HTMLInputElement | null {
    return this.field
  }

  get isMenuOpen(): boolean {
    return this.menuOpen
  }

  /** Whether `node` is one of ours (a click on it isn't a click elsewhere). */
  owns(node: unknown): boolean {
    return node !== null && (node === this.icon?.element || node === this.menu?.element)
  }

  private makeHost(): Host {
    const element = document.createElement('div')
    element.setAttribute('popover', 'manual')
    const root = element.attachShadow({ mode: 'closed' })
    const host: Host = { element, root, style: new Map() }
    this.write(host, { ...RESET, display: 'none', width: '0', height: '0', top: '0', left: '0' })
    document.documentElement.append(element)
    this.guard.observe(element, { attributes: true })
    this.guard.observe(document.documentElement, { childList: true })
    return host
  }

  private write(host: Host, styles: Record<string, string>): void {
    for (const [name, value] of Object.entries(styles)) host.element.style.setProperty(name, value, 'important')
    host.style = declarations(host.element)
  }

  private show(host: Host): void {
    this.write(host, { display: 'block' })
    if (canPop(host.element) && !host.element.matches(':popover-open')) host.element.showPopover()
  }

  private hide(host: Host): void {
    if (canPop(host.element) && host.element.matches(':popover-open')) host.element.hidePopover()
    this.write(host, { display: 'none' })
  }

  /** The page changed our elements: close the menu, and make them again next time. */
  private tampered(): void {
    this.hideMenu()
    this.icon?.element.remove()
    this.icon = null
    this.dropMenu()
    this.onDropped()
  }

  /** Puts the key icon in `field`. */
  showIcon(field: HTMLInputElement): void {
    if (this.field !== field) {
      if (this.field) this.watcher.unobserve(this.field)
      this.watcher.observe(field)
      this.field = field
    }
    if (!this.icon) {
      const host = this.makeHost()
      const button = document.createElement('button')
      button.type = 'button'
      button.title = 'VaultKey'
      button.setAttribute('aria-label', 'Fill with VaultKey')
      button.innerHTML = MARK
      button.style.cssText = `all:initial;display:block;width:${ICON}px;height:${ICON}px;cursor:pointer;border-radius:6px;`
      // The field keeps the focus.
      button.addEventListener('pointerdown', (event) => event.preventDefault())
      button.addEventListener('click', (event) => {
        if (event.isTrusted) this.onIcon()
      })
      host.root.append(button)
      this.icon = host
    }
    this.place()
  }

  hideIcon(): void {
    if (this.icon) this.hide(this.icon)
  }

  /** Makes the menu's iframe (hidden), once: it loads while nothing waits for it. */
  ensureMenu(url: () => Promise<string | null>): Promise<boolean> {
    if (this.menu) return Promise.resolve(true)
    if (this.frameRequested) return Promise.resolve(false)
    this.frameRequested = true
    return url().then((src) => {
      this.frameRequested = false
      if (!src) return false
      const host = this.makeHost()
      // The host lets clicks through; only the menu itself takes them.
      this.write(host, { 'pointer-events': 'none' })
      const frame = document.createElement('iframe')
      frame.src = src
      frame.title = 'VaultKey'
      // Transparent where the menu draws nothing; the same color scheme as the menu page, so
      // the browser doesn't paint a backdrop behind it.
      frame.style.cssText = `all:initial;display:block;width:100%;height:${MENU_HEIGHT}px;border:0;background:transparent;pointer-events:auto;color-scheme:normal;`
      host.root.append(frame)
      this.menu = host
      this.frame = frame
      return true
    })
  }

  /** Forgets the menu iframe (its service-worker side is gone): the next open makes a new one. */
  dropMenu(): void {
    this.menuOpen = false
    this.menu?.element.remove()
    this.menu = null
    this.frame = null
  }

  /** Whether the menu would open above `field` (not enough room below). */
  opensAbove(field: HTMLInputElement): boolean {
    const rect = field.getBoundingClientRect()
    return rect.bottom + GAP + MENU_HEIGHT > innerHeight && rect.top - GAP - MENU_HEIGHT > 0
  }

  /** Opens the menu (`rows`: what it shows; `above`: decided at open, kept while open). */
  showMenu(field: HTMLInputElement, rows: number, above: boolean): void {
    if (!this.menu || !this.frame) return
    this.frameRows = rows
    this.above = above
    if (this.field !== field) this.showIcon(field)
    this.menuOpen = true
    this.placed.at = performance.now()
    this.show(this.menu)
    this.place()
  }

  hideMenu(): void {
    this.menuOpen = false
    if (this.menu) this.hide(this.menu)
  }

  /**
   * Before a click in the menu counts: the menu is open in the top layer, exactly where it
   * was put, and it is what's under the menu (nothing laid over it); nothing fades, hides or
   * clips it or the page. `stableMs`: how long it has stayed there. The menu checks its own
   * visibility too (IntersectionObserver v2).
   */
  verify(): { visible: boolean; stableMs: number } {
    const stableMs = performance.now() - this.placed.at
    const no = { visible: false, stableMs }
    const menu = this.menu
    const host = menu?.element
    if (!menu || !host || !this.menuOpen || !host.isConnected) return no
    if (canPop(host) && !host.matches(':popover-open')) return no
    if (!same(declarations(host), menu.style)) return no
    const rect = host.getBoundingClientRect()
    if (Math.abs(rect.left - this.placed.left) > 1 || Math.abs(rect.top - this.placed.top) > 1 || Math.abs(rect.width - this.placed.width) > 1) {
      return no
    }
    // Where the panel is inside the menu: at its top, or at its bottom when above.
    const height = frameHeight(this.frameRows)
    const offset = this.above ? MENU_HEIGHT - height : 0
    if (rect.width < 40) return no
    for (const [x, y] of [
      [0.5, 0.2],
      [0.15, 0.5],
      [0.85, 0.5],
      [0.5, 0.85],
    ] as const) {
      if (document.elementFromPoint(rect.left + rect.width * x, rect.top + offset + height * y) !== host) return no
    }
    for (const element of [host, document.documentElement, document.body]) {
      if (!element) continue
      const style = getComputedStyle(element)
      const clip = style.getPropertyValue('clip-path')
      const opacity = Number.parseFloat(style.opacity)
      if (
        (Number.isFinite(opacity) && opacity < 1) ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        (style.filter && style.filter !== 'none') ||
        (clip && clip !== 'none') ||
        (style.mixBlendMode && style.mixBlendMode !== 'normal')
      ) {
        return no
      }
    }
    return { visible: true, stableMs }
  }

  private schedule(): void {
    if (this.pending) return
    this.pending = requestAnimationFrame(() => {
      this.pending = 0
      this.place()
    })
  }

  private place(): void {
    const field = this.field
    if (!field || !field.isConnected) {
      this.hideIcon()
      this.hideMenu()
      return
    }
    const rect = field.getBoundingClientRect()
    const onScreen = rect.width >= 60 && rect.height >= 16 && rect.bottom > 0 && rect.top < innerHeight
    if (this.icon) {
      if (onScreen) {
        this.write(this.icon, {
          left: `${Math.round(rect.right - ICON - 8)}px`,
          top: `${Math.round(rect.top + (rect.height - ICON) / 2)}px`,
          width: `${ICON}px`,
          height: `${ICON}px`,
        })
        this.show(this.icon)
      } else {
        this.hide(this.icon)
      }
    }
    if (this.menu && this.menuOpen) {
      if (!onScreen) {
        this.hideMenu()
        return
      }
      const width = Math.round(Math.min(Math.max(rect.width, 280), innerWidth - 2 * GAP))
      const left = Math.round(Math.min(Math.max(rect.left, GAP), innerWidth - width - GAP))
      // Above or below, as decided when it opened: it doesn't flip while open.
      const top = this.above ? Math.round(rect.top - GAP - MENU_HEIGHT) : Math.round(rect.bottom + GAP)
      // A menu that moves is new again: a click on it waits until it has stayed put.
      if (left !== this.placed.left || top !== this.placed.top || width !== this.placed.width) {
        this.placed = { left, top, width, at: performance.now() }
      }
      this.write(this.menu, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${MENU_HEIGHT}px` })
    }
  }
}
