// What the content script draws on a page (M3; plans/05 "Key icon", plans/02
// "Clickjacking defences"): the key icon inside a login field, the host of the menu
// iframe under it, and (M4) a badge by a "Continue with Google" button you use on this site.
//
// Each sits in its own plain <div> on <html> (not <body>, which single-page apps replace;
// not a custom element, which the page could define), with a closed shadow root, shown in
// the browser's top layer (`popover="manual"`) so page z-indexes can't cover it, and styled
// with `!important` so page CSS can't move it. Any change to them from outside (style,
// attributes, removal) closes the menu, and a menu that moved isn't trusted until it has
// stayed put again for a while. Nothing is drawn on pages without a login field.

const ICON = 20
const GAP = 4
/** How often to check where the field is while something of ours is on screen. */
const FOLLOW_MS = 150
const ROW = 44
const FOOTER = 33
/** The panel's 1 px border, top and bottom. */
const BORDERS = 2
/** The menu's host is always this tall (8 rows), whatever it shows: the page can't count
 * the accounts. Inside the closed shadow root, the iframe is exactly the panel's height, at
 * the host's top (or its bottom, when the menu opens above the field). The rest of the host
 * is transparent (a plain element: nothing paints behind it); a click there closes it. */
export const MENU_HEIGHT = 8 * ROW + 8 + FOOTER + BORDERS

/** The badge's host is this wide whatever it says, so the page can't measure the text. */
const BADGE_WIDTH = 300
/** The badge, in its closed shadow root. Its text is generated content (`--t`): it isn't in
 * the page's DOM, so the page can't find or select it. Nothing in it takes a click or a hit
 * test (the first rule: `!important` beats the pill's `all:initial`, which would set
 * `pointer-events` back to `auto`): clicks reach the button under it, and the page can't
 * map the pill's width with elementFromPoint. */
export const BADGE_STYLE =
  '*{pointer-events:none!important}b{all:initial;display:flex;gap:4px;width:max-content;max-width:100%;margin-left:auto;padding:2px 8px 2px 2px;border-radius:9px;background:#4f5bd5;color:#fff;font:11px/14px system-ui;white-space:nowrap;overflow:hidden}b::after{content:var(--t)}svg{width:14px;height:14px}'

/** VaultKey's dial (extension/assets/icon-small.svg), at icon size. */
const MARK = `<svg viewBox="0 0 64 64" width="${ICON}" height="${ICON}" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#4f5bd5"/><circle cx="32" cy="33" r="23" fill="none" stroke="#fff" stroke-width="6.5"/><path d="M32 3.2l4.6 6.2h-9.2z" fill="#fff"/><path fill="#fff" fill-rule="evenodd" d="M32 21a12 12 0 1 1 0 24a12 12 0 1 1 0-24ZM29.9 35.6A4.2 4.2 0 1 1 34.1 35.6L35.1 41C35.2 41.9 34.7 42.5 33.9 42.5H30.1C29.3 42.5 28.8 41.9 28.9 41Z"/></svg>`

/** The menu panel's height for `rows` rows (a locked menu: two, its message and button). */
export function frameHeight(rows: number): number {
  return Math.min(Math.max(rows, 1), 8) * ROW + 8 + FOOTER + BORDERS
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

/** The field and everything around it, through shadow roots: a hit on one of these is the
 * field itself, not a button of the page's drawn over it. */
function around(field: Element): Set<Element> {
  const set = new Set<Element>()
  let node: Node | null = field
  while (node) {
    if (node instanceof Element) set.add(node)
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)
  }
  return set
}

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
  /** The timer that follows the field while something of ours is shown (see `follow`). */
  private following = 0
  /** showIcon() was called and hideIcon() wasn't since. */
  private iconWanted = false
  private badges: { host: Host; target: Element; text: string }[] = []
  /** The page tampered with our elements: no more badges on it. */
  private noBadges = false
  /** Where the menu was last put, and when. */
  private placed = { left: 0, top: 0, width: 0, at: 0 }
  private readonly watcher: ResizeObserver
  private readonly guard: MutationObserver

  constructor(
    private readonly onIcon: () => void,
    /** The page tampered with our elements and the menu is gone. */
    private readonly onDropped: () => void = () => {},
    /** A click in the menu's empty part (below or above the panel). */
    private readonly onOutside: () => void = () => {},
  ) {
    this.watcher = new ResizeObserver(() => this.schedule())
    // Ours to change: a change from anywhere else (the page) closes the menu.
    this.guard = new MutationObserver((changes) => {
      for (const host of [this.icon, this.menu, ...this.badges.map((badge) => badge.host)]) {
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
    if (host.style.get('display') !== 'block!important') this.write(host, { display: 'block' })
    if (canPop(host.element) && !host.element.matches(':popover-open')) host.element.showPopover()
  }

  private hide(host: Host): void {
    if (canPop(host.element) && host.element.matches(':popover-open')) host.element.hidePopover()
    if (host.style.get('display') !== 'none!important') this.write(host, { display: 'none' })
  }

  /** Writes only what changed: a style write the page didn't make is still a mutation. */
  private move(host: Host, styles: Record<string, string>): void {
    const changed = Object.entries(styles).filter(([name, value]) => host.style.get(name) !== `${value}!important`)
    if (changed.length) this.write(host, Object.fromEntries(changed))
  }

  /**
   * Pages move fields without scrolling or resizing anything: a card that slides or fades
   * in, a banner or an error shown above the form, a dialog that centres itself again. No
   * event says so, and the icon stayed where the field was. So while something of ours is
   * on screen, look where its field is a few times a second (one measurement; nothing is
   * written unless it moved). Nothing runs once it's all hidden.
   */
  private follow(on: boolean): void {
    if (on && !this.following) {
      this.following = window.setInterval(() => this.schedule(), FOLLOW_MS)
    } else if (!on && this.following) {
      clearInterval(this.following)
      this.following = 0
    }
  }

  /**
   * Where the icon goes: at the field's right end, or left of the page's own buttons there
   * (show password, clear, a caps-lock sign), so it never covers them or takes their clicks.
   */
  private iconLeft(field: HTMLInputElement, rect: DOMRect): number {
    let right = rect.right - 8
    if (typeof document.elementsFromPoint !== 'function') return Math.round(right - ICON)
    const ours = new Set<Element>([this.icon, this.menu, ...this.badges.map((badge) => badge.host)].flatMap((host) => (host ? [host.element] : [])))
    const field_ = around(field)
    const y = rect.top + rect.height / 2
    // At most two buttons side by side (an eye and a clear button), and never past the
    // field's middle: anything wider is the page's own field drawn over the input.
    for (let i = 0; i < 2; i++) {
      const hit = [right - 3, right - ICON / 2]
        .map((x) => document.elementsFromPoint(x, y).find((element) => !ours.has(element)))
        .find((element) => element && !field_.has(element))
      if (!hit) break
      // The whole button, not the svg inside it that was hit.
      const box = (hit.closest('button,[role="button"],a,label') ?? hit).getBoundingClientRect()
      if (box.width === 0 || box.width > rect.width / 2 || box.left < rect.left + rect.width / 2) break
      right = box.left - GAP
    }
    return Math.round(right - ICON)
  }

  /** The page changed our elements: close the menu, and make them again next time. */
  private tampered(): void {
    this.hideMenu()
    this.icon?.element.remove()
    this.icon = null
    this.noBadges = true
    this.showBadges([])
    this.dropMenu()
    this.onDropped()
  }

  /**
   * Badges by sign-in buttons: [button, "You use Google here — you@gmail.com"]. Display
   * only (clicks go through to the button); replaces the ones shown before.
   */
  showBadges(list: [Element, string][]): void {
    const same = list.length === this.badges.length && list.every(([target, text], i) => this.badges[i]?.target === target && this.badges[i]?.text === text)
    if (same) return this.place()
    for (const badge of this.badges) badge.host.element.remove()
    this.badges = []
    if (this.noBadges) return
    for (const [target, text] of list) {
      const host = this.makeHost()
      host.root.innerHTML = `<style>${BADGE_STYLE}</style><b>${MARK}</b>`
      ;(host.root.lastChild as HTMLElement).style.setProperty('--t', JSON.stringify(text))
      this.write(host, { 'pointer-events': 'none', width: `${BADGE_WIDTH}px`, height: '18px' })
      this.badges.push({ host, target, text })
    }
    this.place()
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
    this.iconWanted = true
    this.place()
  }

  hideIcon(): void {
    this.iconWanted = false
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
      // The empty part of the host takes clicks too (so the page can't tell where the panel
      // ends), and a click there closes the menu. Clicks in the iframe stay in the iframe.
      host.element.addEventListener('pointerdown', (event) => {
        if (event.isTrusted) this.onOutside()
      })
      const frame = document.createElement('iframe')
      frame.src = src
      frame.title = 'VaultKey'
      // Exactly the panel's size, corners clipped: no part of the frame is left to paint (an
      // iframe's empty canvas can come out white).
      frame.style.cssText =
        'all:initial;display:block;width:100%;height:0;border:0;border-radius:12px;overflow:hidden;background:transparent;color-scheme:normal;box-shadow:0 8px 24px rgb(15 18 40 / 0.22);'
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
    const height = frameHeight(rows)
    this.frame.style.setProperty('height', `${height}px`)
    // Above the field, the panel sits at the bottom of the host, right on the field.
    this.frame.style.setProperty('margin-top', above ? `${MENU_HEIGHT - height}px` : '0')
    if (this.field !== field) this.showIcon(field)
    this.menuOpen = true
    this.placed.at = performance.now()
    this.show(this.menu)
    this.place()
  }

  hideMenu(): void {
    // Badges wait while the menu is open (drawn after it, they'd sit above it): back now.
    if (this.menuOpen && this.badges.length) this.schedule()
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
    const shown = this.placeAll()
    this.follow(shown)
  }

  /** Puts everything where it belongs; says whether anything is on screen. */
  private placeAll(): boolean {
    let shown = false
    for (const { host, target } of this.badges) {
      const rect = target.getBoundingClientRect()
      // On the button's top edge, at its right end.
      if (this.menuOpen || !target.isConnected || rect.width < 4 || rect.bottom < 0 || rect.top > innerHeight) {
        this.hide(host)
        continue
      }
      this.move(host, { left: `${Math.round(Math.max(GAP, rect.right - 8 - BADGE_WIDTH))}px`, top: `${Math.round(rect.top - 9)}px` })
      this.show(host)
      shown = true
    }
    const field = this.field
    if (!field || !field.isConnected) {
      this.hideIcon()
      this.hideMenu()
      return shown
    }
    const rect = field.getBoundingClientRect()
    const onScreen = rect.width >= 60 && rect.height >= 16 && rect.bottom > 0 && rect.top < innerHeight
    if (this.icon) {
      if (onScreen && this.iconWanted) {
        this.move(this.icon, {
          left: `${this.iconLeft(field, rect)}px`,
          top: `${Math.round(rect.top + (rect.height - ICON) / 2)}px`,
          width: `${ICON}px`,
          height: `${ICON}px`,
        })
        this.show(this.icon)
        shown = true
      } else {
        this.hide(this.icon)
      }
    }
    if (this.menu && this.menuOpen) {
      if (!onScreen) {
        this.hideMenu()
        return shown
      }
      shown = true
      const width = Math.round(Math.min(Math.max(rect.width, 280), innerWidth - 2 * GAP))
      const left = Math.round(Math.min(Math.max(rect.left, GAP), innerWidth - width - GAP))
      // Above or below, as decided when it opened: it doesn't flip while open.
      const top = this.above ? Math.round(rect.top - GAP - MENU_HEIGHT) : Math.round(rect.bottom + GAP)
      // A menu that moves is new again: a click on it waits until it has stayed put.
      if (left !== this.placed.left || top !== this.placed.top || width !== this.placed.width) {
        this.placed = { left, top, width, at: performance.now() }
      }
      this.move(this.menu, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${MENU_HEIGHT}px` })
    }
    return shown
  }
}
