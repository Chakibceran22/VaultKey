// The inline menu, in the service worker (M3; plans/05 "Inline menu", plans/02
// "Clickjacking defences").
//
// - A frame with a login field asks `found`: the frame's own address (from the browser) is
//   matched, so a frame only ever gets its own site's cards. The answer is just whether to
//   draw the key icon.
// - The menu is an extension page in an iframe. It connects with a one-time token the
//   content script got for it, which binds it to that tab and frame.
// - A pick counts only if it was a real action on a menu shown for ≥ 300 ms that has stayed
//   put for ≥ 300 ms, and that the browser and the page both report visible. Otherwise:
//   "Open the VaultKey popup".

import { explain, outcomeOf, type Caller, type Outcome } from './actions'
import { toBase64 } from './bytes'
import type { FillRequest } from './content-messages'
import { parseCode, parseMatches, parseRevealed, type Card, type Matches } from './inner'
import {
  MAX_SSO_HINTS,
  type FieldKind,
  type FoundReply,
  type MenuCard,
  type MenuKey,
  type MenuRequest,
  type MenuUpdate,
  type OpenReply,
  type SsoReply,
  type TokenReply,
  type VerifyReply,
} from './inline-messages'
import { cardName, cardTile, cardWhere, ssoText } from './labels'
import type { LinkState } from './link'

/** A frame, as the browser describes the sender of a message. */
export interface Frame {
  tabId: number
  frameId: number
  /** The frame's own address. */
  url: string
  /** The tab's address. */
  tabUrl: string
}

export interface InlineBrowser {
  /** Asks the frame's content script whether the menu is really on screen, and since when. */
  verify(frame: Frame): Promise<VerifyReply>
  close(frame: Frame): void
  fill(frame: Frame, request: FillRequest): Promise<unknown>
  badge(tabId: number, count: number): void
  openPopup(): void
  /** Brings VaultKey's window forward (works while locked: no session needed). */
  showApp(): void
  /** Tells the frame its menu iframe (made with `token`) connected. */
  ready(frame: Frame, token: string): void
}

export interface MenuPort {
  post(update: MenuUpdate): void
}

/** How long a page's cards are reused (handles live 10 minutes; a new session drops them). */
const CACHE_MS = 30_000
const TOKEN_MS = 30_000
/** "Picked in this tab" (multi-step logins: email page, then password page). */
const PICKED_MS = 3 * 60_000
/** A menu must have been visible this long before a click in it counts. */
export const MIN_SHOWN_MS = 300
export const MAX_ROWS = 8
/** `match` requests one tab may cause per minute: a page full of frames can't use up the
 * browser's budget (600 a minute) or keep VaultKey busy. */
export const TAB_MATCHES_PER_MINUTE = 30
/** The link states in which this browser is paired. */
const PAIRED: readonly LinkState['kind'][] = ['ready', 'locked', 'connecting']

interface Context {
  kind: FieldKind
  url: string
  tabUrl: string
  cards: Card[]
}

interface Menu {
  frame: Frame
  port: MenuPort
  context: Context | null
}

const frameKey = (frame: Pick<Frame, 'tabId' | 'frameId'>) => `${frame.tabId}:${frame.frameId}`

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** A menu row; `fillable: false` for an account that signs in with another (a hint). */
function menuCard(card: Card, fillable: boolean): MenuCard {
  return { h: card.h, name: cardName(card), where: cardWhere(card), tile: cardTile(card), hasTotp: card.hasTotp, fillable }
}

export class Inline {
  private cache = new Map<string, { at: number; matches: Matches }>()
  private tokens = new Map<string, { frame: Frame; until: number }>()
  private menus = new Map<string, Menu>()
  private picked = new Map<number, { email: string; username: string | null; at: number }>()
  private budgets = new Map<number, { start: number; count: number }>()
  private badged = new Set<number>()

  constructor(
    private readonly vault: Caller,
    private readonly state: () => LinkState,
    private readonly browser: InlineBrowser,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The session changed (locked, unlocked, reconnected): cached handles are worthless. */
  forget(): void {
    this.cache.clear()
    for (const menu of this.menus.values()) menu.context = null
  }

  /** VaultKey can't be reached or is locked: no counts on the toolbar. */
  clearBadges(): void {
    for (const tabId of this.badged) this.browser.badge(tabId, 0)
    this.badged.clear()
  }

  forgetTab(tabId: number): void {
    for (const key of [...this.menus.keys()]) if (key.startsWith(`${tabId}:`)) this.menus.delete(key)
    this.picked.delete(tabId)
    this.budgets.delete(tabId)
    this.badged.delete(tabId)
  }

  /** One more `match` for this tab, if its budget allows. */
  private spend(tabId: number): boolean {
    const now = this.now()
    const budget = this.budgets.get(tabId)
    if (!budget || now - budget.start >= 60_000) {
      this.budgets.set(tabId, { start: now, count: 1 })
      return true
    }
    if (budget.count >= TAB_MATCHES_PER_MINUTE) return false
    budget.count++
    return true
  }

  private async matches(frame: Frame): Promise<Matches | null> {
    // Matching reads the frame's scheme, host and port, and the tab's address: on a
    // provider's page (accounts.google.com), which site you're signing in to comes from the
    // tab's query (`forSite`, and the order). One answer per frame origin and tab address.
    const origin = originOf(frame.url)
    if (!origin) return null
    const key = `${origin} ${frame.tabUrl}`
    const now = this.now()
    const hit = this.cache.get(key)
    if (hit && now - hit.at < CACHE_MS) return hit.matches
    if (!this.spend(frame.tabId)) return null
    const reply = await this.vault.call('match', { tabUrl: frame.tabUrl, frameUrl: frame.url })
    const matches = reply.ok ? parseMatches(reply.r) : null
    if (!matches) return null
    for (const [old, entry] of this.cache) if (now - entry.at >= CACHE_MS) this.cache.delete(old)
    this.cache.set(key, { at: now, matches })
    return matches
  }

  private async cards(frame: Frame): Promise<Card[] | null> {
    return (await this.matches(frame))?.cards ?? null
  }

  /**
   * A login field is in this frame. Paired: the key icon (on every login field, so it says
   * nothing about the vault). Logins saved for exactly this site: the menu opens on focus.
   * And the toolbar badge, for the top frame.
   */
  async found(frame: Frame): Promise<FoundReply> {
    const state = this.state().kind
    if (!PAIRED.includes(state)) return { show: 'none', auto: false }
    if (state !== 'ready') return { show: 'icon', auto: false }
    const cards = await this.cards(frame).catch(() => null)
    const usable = cards?.filter((card) => card.method === 'password' || card.hasTotp) ?? []
    if (frame.frameId === 0) {
      this.browser.badge(frame.tabId, usable.length)
      if (usable.length > 0) this.badged.add(frame.tabId)
    }
    // A sibling subdomain's login ("Saved for app.example.com") waits for a click on the icon.
    return { show: 'icon', auto: usable.some((card) => card.tier === 'exact') }
  }

  /**
   * The page has "Continue with …" buttons: the providers this frame's own site's accounts
   * sign in with, and the badge text for each. Nothing unless VaultKey is unlocked.
   */
  async sso(frame: Frame): Promise<SsoReply> {
    if (this.state().kind !== 'ready') return { hints: [] }
    const matches = await this.matches(frame).catch(() => null)
    const hints = matches?.ssoHints.slice(0, MAX_SSO_HINTS) ?? []
    return { hints: hints.map((hint) => [hint.provider, ssoText(hint)]) }
  }

  /** A one-time token for the menu iframe this frame is about to make. */
  token(frame: Frame): TokenReply {
    const now = this.now()
    for (const [token, entry] of this.tokens) if (entry.until < now) this.tokens.delete(token)
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const token = toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    this.tokens.set(token, { frame, until: now + TOKEN_MS })
    return { token }
  }

  /**
   * A menu iframe connected with `token`, from tab `tabId`. Returns the key to route its
   * requests with, or null (unknown, used or expired token, another tab).
   */
  connect(token: string, tabId: number | undefined, port: MenuPort): string | null {
    const entry = this.tokens.get(token)
    this.tokens.delete(token)
    if (!entry || entry.until < this.now() || entry.frame.tabId !== tabId) return null
    const key = frameKey(entry.frame)
    this.menus.set(key, { frame: entry.frame, port, context: null })
    this.browser.ready(entry.frame, token)
    return key
  }

  /** The menu's port closed; only that menu is forgotten (a newer one may have replaced it). */
  disconnect(key: string, port: MenuPort): void {
    if (this.menus.get(key)?.port === port) this.menus.delete(key)
  }

  /** Opens the menu on a field of `kind`: how many rows (0: nothing to show). */
  async open(frame: Frame, kind: FieldKind, above = false): Promise<OpenReply> {
    const menu = this.menus.get(frameKey(frame))
    if (!menu) return { rows: 0, menu: false, pickable: false }
    const state = this.state().kind
    if (state === 'locked') {
      menu.context = null
      menu.port.post({ type: 'show', state: 'locked', above })
      // Its message and its "Open VaultKey" button.
      return { rows: 2, menu: true, pickable: false }
    }
    if (state !== 'ready') return { rows: 0, menu: true, pickable: false }
    const cards = await this.cards(frame).catch(() => null)
    if (!cards) return { rows: 0, menu: true, pickable: false }
    const usable = cards.filter((card) => (kind === 'code' ? card.hasTotp : card.method === 'password'))
    // The account picked a moment ago in this tab first (step 2 of a two-step login).
    const recent = this.picked.get(frame.tabId)
    if (recent && this.now() - recent.at < PICKED_MS) {
      const same = (card: Card) => card.email === recent.email && card.username === recent.username
      usable.sort((a, b) => Number(same(b)) - Number(same(a)))
    }
    // Accounts that sign in with another ("Signs in with Google · you@gmail.com") come after
    // the ones to fill, as hints: shown, never picked.
    const hints = kind === 'code' ? [] : cards.filter((card) => card.method === 'linked')
    const fill = usable.slice(0, MAX_ROWS)
    const shown = [...fill.map((card) => menuCard(card, true)), ...hints.map((card) => menuCard(card, false))].slice(0, MAX_ROWS)
    if (shown.length === 0) {
      menu.context = null
      menu.port.post({ type: 'show', state: 'empty', above, site: hostOf(frame.url) })
      return { rows: 1, menu: true, pickable: false }
    }
    // Only fillable cards can be picked.
    menu.context = { kind, url: frame.url, tabUrl: frame.tabUrl, cards: fill }
    menu.port.post({ type: 'show', state: 'ready', above, kind, site: hostOf(frame.url), cards: shown })
    return { rows: shown.length, menu: true, pickable: fill.length > 0 }
  }

  key(frame: Frame, key: MenuKey): void {
    this.menus.get(frameKey(frame))?.port.post({ type: 'key', key })
  }

  closed(frame: Frame): void {
    const menu = this.menus.get(frameKey(frame))
    if (menu) menu.context = null
  }

  /** A request from the menu bound to `key`. */
  async request(key: string, request: MenuRequest): Promise<void> {
    const menu = this.menus.get(key)
    if (!menu) return
    switch (request.type) {
      case 'escape':
        menu.context = null
        this.browser.close(menu.frame)
        return
      case 'more':
        this.browser.openPopup()
        return
      case 'open-app':
        this.browser.showApp()
        this.browser.close(menu.frame)
        return
      case 'pick': {
        const outcome = await this.pick(menu, request)
        menu.port.post({ type: 'result', ok: outcome.ok, message: outcome.message })
        if (outcome.ok) {
          menu.context = null
          this.browser.close(menu.frame)
        }
      }
    }
  }

  private async pick(menu: Menu, request: Extract<MenuRequest, { type: 'pick' }>): Promise<Outcome> {
    const context = menu.context
    const card = context?.cards.find((each) => each.h === request.h)
    const origin = context && originOf(context.url)
    if (!context || !card || !origin) return { ok: false, message: 'This list is out of date. Click the field again.' }
    // Clickjacking defences: a real action, on a menu shown long enough and not moved since
    // (a "quick swap" under the cursor restarts the clock), that both the browser
    // (IntersectionObserver v2) and the page's frame say is visible and unobstructed. In a
    // sub-frame, the parent page could fade the whole frame, which only the browser sees: its
    // answer is required there.
    const browserSaw = menu.frame.frameId === 0 ? request.visible !== false : request.visible === true
    const seen = request.trusted && request.shownMs >= MIN_SHOWN_MS && browserSaw
    const page = seen ? await this.browser.verify(menu.frame).catch(() => null) : null
    if (!page?.visible || page.stableMs < MIN_SHOWN_MS) {
      return { ok: false, message: 'Open the VaultKey popup to fill.' }
    }
    const where = { h: card.h, tabUrl: context.tabUrl, frameUrl: context.url }
    try {
      if (request.code) {
        const reply = await this.vault.call('totp', where)
        if (!reply.ok) return { ok: false, message: explain(reply.e.code) }
        const code = parseCode(reply.r)
        if (!code) return { ok: false, message: 'VaultKey answered something this extension doesn’t understand.' }
        return outcomeOf(await this.browser.fill(menu.frame, { type: 'vaultkey.fill', origin, login: null, code: code.code }))
      }
      const reply = await this.vault.call('reveal', { ...where, via: 'menu' })
      if (!reply.ok) return { ok: false, message: explain(reply.e.code) }
      const login = parseRevealed(reply.r)
      if (!login) return { ok: false, message: 'VaultKey answered something this extension doesn’t understand.' }
      const outcome = outcomeOf(await this.browser.fill(menu.frame, { type: 'vaultkey.fill', origin, login, code: null }))
      if (outcome.ok) this.picked.set(menu.frame.tabId, { email: card.email, username: card.username, at: this.now() })
      return outcome
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'VaultKey couldn’t do that.' }
    }
  }
}
