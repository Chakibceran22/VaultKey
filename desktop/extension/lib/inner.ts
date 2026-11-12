// The encrypted inner layer (plans/03-protocol.md; src-tauri/bridge/src/inner.rs): what
// travels inside `x` once a session is up. tests/fixtures/protocol/inner.json holds the
// exact JSON both sides agree on.
//
// `match` gives a page's cards (no secrets); `search` (the popup only) finds cards by name;
// `reveal` and `totp` take a card's handle.

export type InnerMethod = 'ping' | 'match' | 'search' | 'reveal' | 'totp'

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

/** "Signs in with": another account this one signs in with, or a hint for the page. */
export interface SignIn {
  /** A known id (`google`, `apple`, `microsoft`, `github`…), else the provider's
   * registrable domain ("okta.com"). */
  provider: string
  /** The account it signs in as: "me@gmail.com". */
  label: string
}

/** A login card (plans/08, contract 1). No secrets. */
export interface Card {
  /** Opaque, this session only, 10 minutes. */
  h: string
  /** `service_login`: a project service's own login (VaultKey's Projects). */
  kind: 'account' | 'service_login'
  /** The saved website as typed (accounts), or the service's name (service logins). */
  title: string
  /** The saved site, normalised: "github.com", "192.168.1.10:8000"; "" for a name only ("GitHub"). */
  host: string
  /** The email (accounts), or the login's username (service logins). */
  email: string
  username: string | null
  /** `linked`: no password, it signs in with another account (`signsInWith`). */
  method: 'password' | 'none' | 'linked'
  /** `related`: a domain that shares its logins with this one. `search`: from the popup's
   * search, for any site: filling it needs the user's confirmation. */
  tier: 'exact' | 'subdomain' | 'related' | 'search'
  hasTotp: boolean
  signsInWith: SignIn[]
  /** On a provider's page during a sign-in for some site: that site ("vercel.com"). */
  forSite: string | null
  lastUsed: string | null
}

export interface Matches {
  site: { host: string; registrable: string | null } | null
  cards: Card[]
  /** Logins saved for https, not offered because the page is http. */
  insecure: number
  /** The providers this site's accounts sign in with: for its "Continue with …" buttons. */
  ssoHints: SignIn[]
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

function parseSignIn(value: unknown): SignIn | null {
  if (!isRecord(value) || !hasKeys(value, 'label,provider')) return null
  const { provider, label } = value
  return isString(provider) && provider.length > 0 && isString(label) ? { provider, label } : null
}

function parseSignIns(value: unknown): SignIn[] | null {
  if (!Array.isArray(value)) return null
  const list = value.map(parseSignIn)
  return list.some((each) => each === null) ? null : (list as SignIn[])
}

type Tier = Card['tier']
/** A page's own tiers, from `match`; `search` gives only its own. */
const MATCH_TIERS: readonly Tier[] = ['exact', 'subdomain', 'related']
const SEARCH_TIERS: readonly Tier[] = ['search']

function parseCard(value: unknown, tiers: readonly Tier[]): Card | null {
  if (!isRecord(value) || !hasKeys(value, 'email,forSite,h,hasTotp,host,kind,lastUsed,method,signsInWith,tier,title,username')) return null
  const { h, kind, title, host, email, username, method, tier, hasTotp, forSite, lastUsed } = value
  const signsInWith = parseSignIns(value.signsInWith)
  if (
    !isString(h) ||
    (kind !== 'account' && kind !== 'service_login') ||
    !isString(title) ||
    !isString(host) ||
    !isString(email) ||
    !isStringOrNull(username) ||
    (method !== 'password' && method !== 'none' && method !== 'linked') ||
    !tiers.includes(tier as Tier) ||
    typeof hasTotp !== 'boolean' ||
    !signsInWith ||
    !isStringOrNull(forSite) ||
    !isStringOrNull(lastUsed)
  ) {
    return null
  }
  return { h, kind, title, host, email, username, method, tier: tier as Tier, hasTotp, signsInWith, forSite, lastUsed }
}

function parseCards(value: unknown, tiers: readonly Tier[]): Card[] | null {
  if (!Array.isArray(value)) return null
  const cards = value.map((each) => parseCard(each, tiers))
  return cards.some((card) => card === null) ? null : (cards as Card[])
}

export function parseMatches(value: Record<string, unknown>): Matches | null {
  if (!hasKeys(value, 'cards,insecure,site,ssoHints') || !isU32(value.insecure)) return null
  let site: Matches['site'] = null
  if (value.site !== null) {
    if (!isRecord(value.site) || !hasKeys(value.site, 'host,registrable')) return null
    const { host, registrable } = value.site
    if (!isString(host) || !isStringOrNull(registrable)) return null
    site = { host, registrable }
  }
  const cards = parseCards(value.cards, MATCH_TIERS)
  const ssoHints = parseSignIns(value.ssoHints)
  if (!cards || !ssoHints) return null
  return { site, cards, insecure: value.insecure, ssoHints }
}

/** `search`'s result: cards for any site, every one tier `search`. */
export function parseSearch(value: Record<string, unknown>): Card[] | null {
  return hasKeys(value, 'cards') ? parseCards(value.cards, SEARCH_TIERS) : null
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
