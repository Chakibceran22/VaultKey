// The inline menu's messages (M3, plans/05 "Key icon", "Inline menu"):
//
//   content script ──runtime.sendMessage──► service worker ──port──► menu (extension iframe)
//
// The content script never sees account names: it learns whether to show the key icon and
// how many rows the menu has. Cards go from the service worker to the menu only.

/** What kind of field the menu opens on. */
export type FieldKind = 'username' | 'password' | 'code'

/** Content script → service worker. */
export type ContentRequest =
  /** A login field is on this page: should it get a key icon? */
  | { type: 'vk.found' }
  /** The menu's iframe is being made: a one-time token for its URL. */
  | { type: 'vk.token' }
  /** Open the menu on a field of this kind, above or below it (decided once, at open). */
  | { type: 'vk.open'; kind: FieldKind; above: boolean }
  /** A real (isTrusted) key in the field while the menu is open. */
  | { type: 'vk.key'; key: MenuKey }
  | { type: 'vk.closed' }

export type MenuKey = 'ArrowDown' | 'ArrowUp' | 'Enter'

/**
 * `icon`: this browser is paired, so login fields get the key icon (on every login field:
 * whether one appears says nothing about the vault). `auto`: logins saved for exactly this
 * site, so the menu opens on focus, like Google's.
 */
export type FoundReply = { show: 'none' | 'icon'; auto: boolean }
export type TokenReply = { token: string | null }
/** How many rows the menu shows (0: don't open). `menu: false`: the service worker has no
 * menu for this frame (it restarted, or the page came back from the back/forward cache). */
export type OpenReply = { rows: number; menu: boolean; pickable: boolean }

/** Service worker → content script (tabs.sendMessage to that frame). */
export type ContentCommand =
  /** Before a click in the menu counts: is the menu really on screen, unobstructed? */
  | { type: 'vk.verify' }
  | { type: 'vk.close' }
  /** The menu iframe made with `token` has connected: it can be opened. */
  | { type: 'vk.ready'; token: string }

/** `stableMs`: how long the menu has stayed exactly where it is. */
export type VerifyReply = { visible: boolean; stableMs: number }

/** One row of the menu: no secrets. */
export interface MenuCard {
  h: string
  name: string
  where: string
  hasTotp: boolean
  fillable: boolean
}

/** Service worker → menu. */
export type MenuUpdate =
  | { type: 'show'; state: 'ready'; above: boolean; kind: FieldKind; site: string; cards: MenuCard[] }
  | { type: 'show'; state: 'locked'; above: boolean }
  | { type: 'show'; state: 'empty'; above: boolean; site: string }
  | { type: 'key'; key: MenuKey }
  | { type: 'result'; ok: boolean; message: string }

/** Menu → service worker. `shownMs`: how long it has been visible; `visible`: what the
 * browser's IntersectionObserver v2 says (null where it isn't supported). */
export type MenuRequest =
  | { type: 'pick'; h: string; code: boolean; trusted: boolean; shownMs: number; visible: boolean | null }
  | { type: 'open-app' }
  | { type: 'more' }
  | { type: 'escape' }

export const MENU_PORT = 'vk-menu'
const KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'Enter']
const KINDS: readonly string[] = ['username', 'password', 'code']

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',')
}

export function isContentRequest(value: unknown): value is ContentRequest {
  const message = record(value)
  if (!message) return false
  switch (message.type) {
    case 'vk.found':
    case 'vk.token':
    case 'vk.closed':
      return keys(message) === 'type'
    case 'vk.open':
      return keys(message) === 'above,kind,type' && KINDS.includes(message.kind as string) && typeof message.above === 'boolean'
    case 'vk.key':
      return keys(message) === 'key,type' && KEYS.includes(message.key as string)
    default:
      return false
  }
}

export function isContentCommand(value: unknown): value is ContentCommand {
  const message = record(value)
  if (!message) return false
  if (message.type === 'vk.ready') return keys(message) === 'token,type' && typeof message.token === 'string'
  return keys(message) === 'type' && (message.type === 'vk.verify' || message.type === 'vk.close')
}

export function isMenuRequest(value: unknown): value is MenuRequest {
  const message = record(value)
  if (!message) return false
  switch (message.type) {
    case 'pick':
      return (
        keys(message) === 'code,h,shownMs,trusted,type,visible' &&
        typeof message.h === 'string' &&
        message.h.length > 0 &&
        message.h.length <= 64 &&
        typeof message.code === 'boolean' &&
        typeof message.trusted === 'boolean' &&
        typeof message.shownMs === 'number' &&
        Number.isFinite(message.shownMs) &&
        (message.visible === null || typeof message.visible === 'boolean')
      )
    case 'open-app':
    case 'more':
    case 'escape':
      return keys(message) === 'type'
    default:
      return false
  }
}
