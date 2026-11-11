// What the popup and the shortcut can do, in the service worker (plans/05, "Popup",
// "Keyboard shortcut"). Page addresses come from the browser (the active tab), never
// from a page. The app matches them; this file only carries cards, handles and one
// login at a time to the tab's content script, which fills and drops it.

import { isFillResult, type FillRequest, type FillResult } from './content-messages'
import { parseCode, parseMatches, parseRevealed, type Card, type InnerMethod } from './inner'
import type { InnerReply } from './link'

/** The active tab, from the browser. */
export interface ActiveTab {
  id: number
  url: string
}

export interface Tabs {
  active(): Promise<ActiveTab | null>
  /** Sends to the tab's top frame; undefined when no content script answered. */
  send(tabId: number, request: FillRequest): Promise<unknown>
}

export interface Caller {
  call(method: InnerMethod, params?: Record<string, unknown>): Promise<InnerReply>
}

export type CardsResult =
  /** `secure`: the page is https. On http, anyone on the network can read what's sent. */
  | { kind: 'cards'; site: string; cards: Card[]; insecure: number; secure: boolean }
  /** Not a web page (a new tab, settings, a PDF viewer…). */
  | { kind: 'no_site' }
  | { kind: 'error'; message: string }

export type Outcome = { ok: true; message: string } | { ok: false; message: string }

export type CodeResult = { ok: true; code: string; expiresAt: number } | { ok: false; message: string }

/** What a refusal from VaultKey means to the person. */
export function explain(code: string): string {
  switch (code) {
    case 'UNKNOWN_HANDLE':
      return 'This list is out of date. Close and reopen the popup.'
    case 'ORIGIN_MISMATCH':
      return 'That login isn’t for this page.'
    case 'NO_SECRET':
      return 'VaultKey has no password or setup key saved for it.'
    case 'RATE_LIMITED':
      return 'Too many fills in a minute. Wait a moment, then try again.'
    case 'LOCKED':
      return 'VaultKey is locked. Unlock it, then try again.'
    default:
      return 'VaultKey couldn’t do that. Its log has the details.'
  }
}

function failure(error: unknown): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : 'VaultKey couldn’t do that.' }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export class Actions {
  constructor(
    private readonly vault: Caller,
    private readonly tabs: Tabs,
  ) {}

  /** The logins for the page in the active tab. */
  async cards(): Promise<CardsResult> {
    const tab = await this.tabs.active()
    if (!tab || !/^https?:/.test(tab.url)) return { kind: 'no_site' }
    try {
      const reply = await this.vault.call('match', { tabUrl: tab.url, frameUrl: tab.url })
      if (!reply.ok) return { kind: 'error', message: explain(reply.e.code) }
      const matches = parseMatches(reply.r)
      if (!matches) return { kind: 'error', message: 'VaultKey answered something this extension doesn’t understand. Update both.' }
      if (!matches.site) return { kind: 'no_site' }
      return {
        kind: 'cards',
        site: matches.site.host,
        cards: matches.cards,
        insecure: matches.insecure,
        secure: tab.url.startsWith('https:'),
      }
    } catch (error) {
      return { kind: 'error', message: failure(error).message }
    }
  }

  /**
   * Fills card `h`'s login into the active tab's login form. On an http page only once
   * the user confirmed it (`confirmedInsecure`), checked here against the tab as it is now.
   */
  async fill(h: string, via: 'popup' | 'shortcut', confirmedInsecure = false): Promise<Outcome> {
    const tab = await this.tabs.active()
    const origin = tab && originOf(tab.url)
    if (!tab || !origin) return { ok: false, message: 'There’s no page to fill.' }
    if (!tab.url.startsWith('https:') && !confirmedInsecure) {
      return { ok: false, message: 'This page isn’t secure (http). Open the popup again to fill it anyway.' }
    }
    try {
      const reply = await this.vault.call('reveal', { h, tabUrl: tab.url, frameUrl: tab.url, via })
      if (!reply.ok) return { ok: false, message: explain(reply.e.code) }
      const login = parseRevealed(reply.r)
      if (!login) return { ok: false, message: 'VaultKey answered something this extension doesn’t understand.' }
      return this.deliver(tab, { type: 'vaultkey.fill', origin, login, code: null })
    } catch (error) {
      return failure(error)
    }
  }

  /** Card `h`'s current code: for the clipboard, and filled into a code field if the page has one. */
  async code(h: string): Promise<CodeResult> {
    const tab = await this.tabs.active()
    const origin = tab && originOf(tab.url)
    if (!tab || !origin) return { ok: false, message: 'There’s no page for this code.' }
    try {
      const reply = await this.vault.call('totp', { h, tabUrl: tab.url, frameUrl: tab.url })
      if (!reply.ok) return { ok: false, message: explain(reply.e.code) }
      const code = parseCode(reply.r)
      if (!code) return { ok: false, message: 'VaultKey answered something this extension doesn’t understand.' }
      // Copied either way; typed into the page only if it's secure.
      if (tab.url.startsWith('https:')) await this.deliver(tab, { type: 'vaultkey.fill', origin, login: null, code: code.code })
      return { ok: true, code: code.code, expiresAt: code.expiresAt }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * The shortcut fills without showing anything, so only in the clearest case: an https
   * page with one login saved for exactly this host. Anything else (none, several, a
   * sibling subdomain, an http page) opens the popup, which shows what and where.
   */
  async shortcut(): Promise<Outcome | 'open_popup'> {
    const found = await this.cards()
    if (found.kind !== 'cards' || !found.secure) return 'open_popup'
    const fillable = found.cards.filter((card) => card.method === 'password')
    const only = fillable.length === 1 ? fillable[0] : undefined
    return only && only.tier === 'exact' ? this.fill(only.h, 'shortcut') : 'open_popup'
  }

  private async deliver(tab: ActiveTab, request: FillRequest): Promise<Outcome> {
    try {
      return outcomeOf(await this.tabs.send(tab.id, request))
    } catch {
      return outcomeOf(undefined)
    }
  }
}

/** What the content script's answer to a fill means to the person. */
export function outcomeOf(answer: unknown): Outcome {
  const result: FillResult | undefined = isFillResult(answer) ? answer : undefined
  if (!result) return { ok: false, message: 'This page can’t be filled yet. Reload it, then try again.' }
  if (result.reason === 'origin') return { ok: false, message: 'The page changed meanwhile. Try again.' }
  if (result.filled === 0) return { ok: false, message: 'No login form found here. Click into the login field, then try again.' }
  return { ok: true, message: 'Filled' }
}
