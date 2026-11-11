// The encrypted inner layer (plans/03-protocol.md; src-tauri/bridge/src/inner.rs): what
// travels inside `x` once a session is up. tests/fixtures/protocol/inner.json holds the
// exact JSON both sides agree on.
//
// `match` gives a page's cards (no secrets); `reveal` and `totp` take a card's handle.

export type InnerMethod = 'ping' | 'match' | 'reveal' | 'totp'

export interface InnerRequest {
  id: number
  m: InnerMethod
  p?: Record<string, unknown>
}

export type InnerMessage =
  | { kind: 'reply'; id: number; ok: true; r: Record<string, unknown> }
  | { kind: 'reply'; id: number; ok: false; e: { code: string; msg: string } }
  /** `locked`: the vault is locking, the session ends. `revoked`: forget the keys. */
  | { kind: 'event'; ev: 'locked' | 'revoked' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',')
}

function isU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff
}

/** The bytes of a request, as the app expects them (fixture-checked). */
export function encodeRequest(request: InnerRequest): string {
  return JSON.stringify(request.p === undefined ? { id: request.id, m: request.m } : { id: request.id, m: request.m, p: request.p })
}

/** A decrypted message from the app: exact shape or null. */
export function parseInner(text: string): InnerMessage | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if ('ev' in value) {
    return keys(value) === 'ev' && (value.ev === 'locked' || value.ev === 'revoked') ? { kind: 'event', ev: value.ev } : null
  }
  if (!isU32(value.id)) return null
  if (value.ok === true && keys(value) === 'id,ok,r' && isRecord(value.r)) {
    return { kind: 'reply', id: value.id, ok: true, r: value.r }
  }
  if (value.ok === false && keys(value) === 'e,id,ok' && isRecord(value.e) && keys(value.e) === 'code,msg') {
    const { code, msg } = value.e
    if (typeof code === 'string' && typeof msg === 'string') return { kind: 'reply', id: value.id, ok: false, e: { code, msg } }
  }
  return null
}

/** A login card for the page (plans/03, "Shared shapes"). No secrets. */
export interface Card {
  /** Opaque, this session only, 10 minutes. */
  h: string
  kind: 'account'
  title: string
  /** The saved site, normalised: "github.com", "192.168.1.10:8000". */
  host: string
  email: string
  username: string | null
  method: 'password' | 'none' | 'linked'
  tier: 'exact' | 'subdomain'
  hasTotp: boolean
  signsInWith: unknown[]
  lastUsed: string | null
}

export interface Matches {
  site: { host: string; registrable: string | null } | null
  cards: Card[]
  /** Logins saved for https, not offered because the page is http. */
  insecure: number
}

export interface Revealed {
  email: string
  username: string | null
  password: string
}

export interface AuthCode {
  code: string
  /** Unix time, milliseconds. */
  expiresAt: number
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'
const hasKeys = (value: Record<string, unknown>, expected: string): boolean => keys(value) === expected

function parseCard(value: unknown): Card | null {
  if (!isRecord(value) || !hasKeys(value, 'email,h,hasTotp,host,kind,lastUsed,method,signsInWith,tier,title,username')) return null
  const { h, kind, title, host, email, username, method, tier, hasTotp, signsInWith, lastUsed } = value
  if (
    !isString(h) ||
    kind !== 'account' ||
    !isString(title) ||
    !isString(host) ||
    !isString(email) ||
    !isStringOrNull(username) ||
    (method !== 'password' && method !== 'none' && method !== 'linked') ||
    (tier !== 'exact' && tier !== 'subdomain') ||
    typeof hasTotp !== 'boolean' ||
    !Array.isArray(signsInWith) ||
    !isStringOrNull(lastUsed)
  ) {
    return null
  }
  return { h, kind, title, host, email, username, method, tier, hasTotp, signsInWith, lastUsed }
}

export function parseMatches(value: Record<string, unknown>): Matches | null {
  if (!hasKeys(value, 'cards,insecure,site') || !Array.isArray(value.cards) || !isU32(value.insecure)) return null
  let site: Matches['site'] = null
  if (value.site !== null) {
    if (!isRecord(value.site) || !hasKeys(value.site, 'host,registrable')) return null
    const { host, registrable } = value.site
    if (!isString(host) || !isStringOrNull(registrable)) return null
    site = { host, registrable }
  }
  const cards = value.cards.map(parseCard)
  if (cards.some((card) => card === null)) return null
  return { site, cards: cards as Card[], insecure: value.insecure }
}

export function parseRevealed(value: Record<string, unknown>): Revealed | null {
  const { email, username, password } = value
  return hasKeys(value, 'email,password,username') && isString(email) && isStringOrNull(username) && isString(password)
    ? { email, username, password }
    : null
}

export function parseCode(value: Record<string, unknown>): AuthCode | null {
  const { code, expiresAt } = value
  return hasKeys(value, 'code,expiresAt') && isString(code) && /^\d{6,8}$/.test(code) && Number.isSafeInteger(expiresAt)
    ? { code, expiresAt: expiresAt as number }
    : null
}
