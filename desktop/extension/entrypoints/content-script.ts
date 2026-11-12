// In every http(s) frame (M3). It finds the login field when the page is idle (or when
// one is focused) and, once this browser is paired, draws the key icon in it (on every login
// field: the icon says nothing about the vault). When logins are saved for exactly this
// site, the menu opens under the field on focus, like Google's manager; otherwise on a click
// on the icon.
// It never sees account names (the menu gets them from the service worker), fills only
// when the service worker asks, for the origin the values were released for, and keeps
// nothing. Pages without a login field get nothing drawn, and little work after the idle
// scan (a batched look when fields or buttons are added).
// One exception (M4): by a "Continue with Google" button, a badge says which Google account
// you use on this site, when VaultKey knows (top frame only; display only, never a fill).

import { fieldKind, findTarget } from '@/lib/classify'
import { isFillRequest, type FillRequest, type FillResult } from '@/lib/content-messages'
import { fillField } from '@/lib/fill'
import {
  isContentCommand,
  type ContentRequest,
  type FieldKind,
  type FoundReply,
  type MenuKey,
  type OpenReply,
  type SsoReply,
  type TokenReply,
} from '@/lib/inline-messages'
import { Overlay } from '@/lib/overlay'
import { signInButtons } from '@/lib/sso'

/** How long an answer about this frame's logins is reused. */
const FOUND_MS = 3_000
/** How long the menu iframe may take to load and connect. */
const READY_MS = 2_000
/** How long the sign-in hints for this page are reused (the service worker's cache). */
const SSO_MS = 30_000

/** A menu iframe being made with `token`, until it connects (`vk.ready`) or times out. */
interface Waiting {
  promise: Promise<boolean>
  resolve: (ready: boolean) => void
  token: string | null
}
/** Added nodes that may be (or hold) a login field or a sign-in button: worth a scan. */
const WATCHED = 'input,button,iframe'
/** Fields worth a closer look, by attributes alone (no style work): the idle scan starts
 * only if one of these is on the page. A focused field is always looked at. */
const LIKELY =
  'input[type="password"],input[type="email"],input[autocomplete~="username"],input[autocomplete~="email"],input[autocomplete~="one-time-code"],input[name*="user" i],input[name*="login" i],input[name*="mail" i]'

/** The focused element, looking into open shadow roots (a field in a web component). */
function deepActive(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

async function fill(request: FillRequest, focused: HTMLInputElement | null): Promise<FillResult> {
  const target = findTarget(document, focused, request.login ? 'login' : 'code')
  if (!target) return { filled: 0, reason: 'no_form' }
  let filled = 0
  if (request.login) {
    const { username, email, password } = request.login
    if (target.username && (await fillField(target.username, target.wantsEmail ? email : (username ?? email)))) filled++
    // Focus ends on the password field; nothing is submitted.
    if (target.password && (await fillField(target.password, password))) filled++
  }
  if (request.code && target.code && (await fillField(target.code, request.code))) filled++
  return filled > 0 ? { filled } : { filled: 0, reason: 'no_form' }
}

function ask<T>(request: ContentRequest): Promise<T | undefined> {
  return browser.runtime.sendMessage(request).then(
    (answer) => answer as T | undefined,
    () => undefined,
  )
}

// Listed in the manifest (lib/manifest.ts: every http(s) frame, at document_start) as a
// plain script, not a WXT content script: WXT's wrapper for those (ContentScriptContext) is
// about 2 KB this script never uses, and it posts a message carrying the extension's ID to
// every page, which lets any site tell that VaultKey is installed.
export default defineUnlistedScript({
  main() {
    let focused: WeakRef<HTMLInputElement> | null = null
    let found: { at: number; answer: FoundReply } | null = null
    /** The menu iframe made with `token` has connected to the service worker (`vk.ready`). */
    let menuReady: Waiting | null = null
    /** The last real click or Tab press, and where: auto-open needs one on the field itself. */
    let lastAct: { target: EventTarget | undefined; at: number; tab: boolean } | null = null
    let rows = 0
    let active = -1
    let pickable = false
    /** This page's sign-in hints: provider → the badge's text. */
    let sso: { at: number; hints: Map<string, string> } | null = null

    const overlay = new Overlay(
      () => void toggle(),
      () => (menuReady = null),
      () => close(),
    )

    /** Badges by the page's sign-in buttons for the providers this site's accounts use. */
    async function signIns(): Promise<void> {
      if (!sso || Date.now() - sso.at > SSO_MS) {
        // Asked only when the page has a sign-in button.
        if (!signInButtons(document, null).length) return
        const answer = await ask<SsoReply>({ type: 'vk.sso' })
        sso = { at: Date.now(), hints: new Map(Array.isArray(answer?.hints) ? answer.hints : []) }
      }
      overlay.showBadges(signInButtons(document, sso.hints))
    }

    async function logins(): Promise<FoundReply> {
      if (found && Date.now() - found.at < FOUND_MS) return found.answer
      const answer = (await ask<FoundReply>({ type: 'vk.found' })) ?? { show: 'none', auto: false }
      found = { at: Date.now(), answer }
      return answer
    }

    /** Makes the menu iframe (once) and waits until it has connected. */
    function prepare(): Promise<boolean> {
      if (menuReady) return menuReady.promise
      let resolve: (ready: boolean) => void = () => {}
      const promise = new Promise<boolean>((done) => (resolve = done))
      const current: Waiting = { promise, resolve, token: null }
      menuReady = current
      const timer = setTimeout(() => current.resolve(false), READY_MS)
      void overlay
        .ensureMenu(async () => {
          const answer = await ask<TokenReply>({ type: 'vk.token' })
          current.token = answer?.token ?? null
          return answer?.token ? `${browser.runtime.getURL('/menu.html')}#${answer.token}` : null
        })
        .then((made) => {
          if (!made) current.resolve(false)
        })
      void promise.then((ready) => {
        clearTimeout(timer)
        // Not ready in time: try again next time, with a new one.
        if (!ready && menuReady === current) drop()
      })
      return promise
    }

    function drop(): void {
      overlay.dropMenu()
      menuReady = null
    }

    async function open(field: HTMLInputElement, kind: FieldKind, retry = true): Promise<void> {
      if (!(await prepare())) return
      const above = overlay.opensAbove(field)
      const answer = await ask<OpenReply>({ type: 'vk.open', kind, above })
      if (answer && !answer.menu && retry) {
        // The service worker lost this menu (it restarted, or the page came back from the
        // back/forward cache): a new one.
        drop()
        return open(field, kind, false)
      }
      rows = answer?.rows ?? 0
      if (rows === 0 || deepActive() !== field) return
      active = -1
      // A locked or empty menu has one message row, nothing to pick with the keyboard.
      pickable = answer?.pickable ?? false
      overlay.showMenu(field, rows, above)
    }

    function close(): void {
      if (!overlay.isMenuOpen) return
      overlay.hideMenu()
      void ask({ type: 'vk.closed' })
    }

    async function toggle(): Promise<void> {
      const field = overlay.anchor
      if (!field) return
      if (overlay.isMenuOpen) return close()
      field.focus()
      await open(field, fieldKind(field) ?? 'username')
    }

    // The page's first login field gets the icon once the page is idle: nothing is
    // scanned during load. Fields added later (single-page apps) are looked at in batches.
    let scanning = 0
    const scan = (): void => {
      scanning = 0
      if (window === top) void signIns()
      if (overlay.anchor?.isConnected || !document.querySelector(LIKELY)) return
      const target = findTarget(document, null)
      const field = target?.username ?? target?.password ?? target?.code
      if (!field) return
      void logins().then(({ show }) => {
        if (show !== 'icon' || overlay.anchor?.isConnected) return
        overlay.showIcon(field)
        // The menu loads now, while nothing waits for it.
        void prepare()
      })
    }
    const later = (): void => {
      if (scanning || document.hidden) return
      scanning = window.setTimeout(() => requestIdleCallback(scan, { timeout: 500 }), 300)
    }
    const watcher = new MutationObserver((changes) => {
      if (changes.some((change) => [...change.addedNodes].some((node) => node instanceof Element && (node.matches(WATCHED) || node.querySelector(WATCHED))))) later()
    })
    const watch = (): void => {
      if (document.hidden) return watcher.disconnect()
      watcher.observe(document.documentElement, { childList: true, subtree: true })
    }
    document.addEventListener('DOMContentLoaded', () => {
      later()
      watch()
    })
    document.addEventListener('visibilitychange', () => {
      watch()
      if (document.hidden) close()
    })
    // Back from the back/forward cache: the menu's connection to the service worker is gone.
    addEventListener('pageshow', (event) => {
      if (event.persisted) drop()
    })

    // A real click on a field, or a real Tab press (which moves the focus): what may open
    // the menu on focus. A page's own focus() a few seconds after any click doesn't.
    const act = (tab: boolean) => (event: Event) => {
      if (event.isTrusted && (!tab || (event as KeyboardEvent).key === 'Tab')) lastAct = { target: event.composedPath()[0], at: performance.now(), tab }
    }
    document.addEventListener('pointerdown', act(false), { capture: true, passive: true })
    document.addEventListener('keydown', act(true), { capture: true, passive: true })

    document.addEventListener(
      'focusin',
      (event) => {
        // Inside shadow DOM, the real field is the first node of the path.
        const target = event.composedPath()[0]
        if (!(target instanceof HTMLInputElement)) return
        focused = new WeakRef(target)
        const kind = fieldKind(target)
        if (!kind) return
        // Focus that follows a real click on this field, or a real Tab press just before (not
        // a page script's focus()): a page can't open the menu to learn whether a login is
        // saved for it.
        const recent = lastAct !== null && performance.now() - lastAct.at < 1000
        const byUser = recent && (lastAct?.tab === true || lastAct?.target === target)
        void logins().then(({ show, auto }) => {
          if (show === 'none' || deepActive() !== target) return
          overlay.showIcon(target)
          void prepare()
          // Opens on focus only for logins saved for exactly this site, like Google's;
          // anything else (locked, a sibling subdomain, none) waits for a click on the icon.
          if (auto && byUser) void open(target, kind)
        })
      },
      { capture: true, passive: true },
    )

    document.addEventListener(
      'focusout',
      () => {
        // Clicking the menu moves focus to its frame: that's still "in the menu".
        setTimeout(() => {
          if (!overlay.owns(document.activeElement) && deepActive() !== overlay.anchor) close()
        }, 0)
      },
      { capture: true },
    )

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!overlay.isMenuOpen) return
        const target = event.composedPath()[0]
        if (!overlay.owns(target) && target !== overlay.anchor) close()
      },
      { capture: true, passive: true },
    )

    document.addEventListener(
      'keydown',
      (event) => {
        // Only real key presses in the field drive the menu: the page can't fake them.
        if (!overlay.isMenuOpen || !event.isTrusted || event.composedPath()[0] !== overlay.anchor) return
        if (event.key === 'Escape') {
          close()
          return
        }
        const key = event.key as MenuKey
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          event.preventDefault()
          if (!pickable || rows === 0) return
          active = key === 'ArrowDown' ? (active + 1) % rows : (active - 1 + rows) % rows
          void ask({ type: 'vk.key', key })
        } else if (key === 'Enter' && active >= 0 && pickable) {
          // A highlighted row: Enter picks it instead of submitting the form.
          event.preventDefault()
          void ask({ type: 'vk.key', key })
        }
      },
      { capture: true },
    )

    browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      // Our own service worker only.
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return
      if (isContentCommand(message)) {
        if (message.type === 'vk.verify') sendResponse(overlay.verify())
        // Only the menu this frame is waiting for (not a late one it gave up on).
        else if (message.type === 'vk.ready') {
          if (menuReady && menuReady.token === message.token) menuReady.resolve(true)
        }
        else close()
        return
      }
      if (!isFillRequest(message)) return
      // The values were released for one origin: a page that navigated since gets nothing.
      if (location.origin !== message.origin) {
        sendResponse({ filled: 0, reason: 'origin' } satisfies FillResult)
        return
      }
      void fill(message, focused?.deref() ?? null).then(sendResponse)
      return true
    })
  },
})
