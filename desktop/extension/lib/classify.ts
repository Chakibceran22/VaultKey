// Finding the login form to fill (plans/05, "Finding login fields"). Lazy: nothing is
// scanned until a fill is asked for. Then: the form of the field the user last focused,
// or the first login form on the page.
//
// Only fields a person can see and type in count: visible, enabled, not read-only, at
// least 4×4 px. A hidden field never gets a value (plans/02, "Rules for filling").

const USER = /user|login|identif|account|compte|e-?mail|courriel|pseudo|utilisateur|sign.?in|phone|t[ée]l[ée]phone/i
const EMAIL = /e-?mail|courriel/i
const CODE = /otp|totp|2fa|mfa|one.?time|verif|v[ée]rification|authenticat|security.?code|\bcode\b/i
const NEGATIVE = /search|recherche|newsletter|subscribe|coupon|promo|captcha|card|cvv|cvc|iban|address|adresse|postal|zip|city|ville/i
const TEXTISH = new Set(['text', 'email', 'tel', ''])

export interface Target {
  username: HTMLInputElement | null
  /** The username field asks for an email address (fill the email, not the username). */
  wantsEmail: boolean
  password: HTMLInputElement | null
  code: HTMLInputElement | null
}

/** What the page says about a field: its name, id, placeholder, labels. */
function describe(el: HTMLInputElement): string {
  const labels = el.labels ? [...el.labels].map((label) => label.textContent ?? '') : []
  return [el.name, el.id, el.placeholder, el.getAttribute('aria-label') ?? '', ...labels].join(' ')
}

/** A search box, a coupon, a postal address… unless it also says it's the login
 * ("Adresse courriel" is an email address). */
function isNegative(el: HTMLInputElement): boolean {
  const text = describe(el)
  return NEGATIVE.test(text) && !USER.test(text)
}

function autocomplete(el: HTMLInputElement): string {
  return (el.getAttribute('autocomplete') ?? '').toLowerCase()
}

/** How see-through a field is, its ancestors included (1: fully drawn). */
function opacity(el: Element): number {
  let total = 1
  for (let node: Element | null = el, depth = 0; node && depth < 32; node = node.parentElement, depth++) {
    const value = Number.parseFloat(getComputedStyle(node).opacity)
    if (Number.isFinite(value)) total *= value
  }
  return total
}

/** A person can see it and type in it: on the page, drawn, at least 4×4 px. */
export function isUsable(el: HTMLInputElement): boolean {
  if (el.disabled || el.readOnly || el.type === 'hidden') return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 4 || rect.height < 4) return false
  // Pushed off the page (left of or above its start): no one scrolls there.
  const view = el.ownerDocument.defaultView
  if (rect.right + (view?.scrollX ?? 0) <= 0 || rect.bottom + (view?.scrollY ?? 0) <= 0) return false
  const visible = (el as HTMLInputElement & { checkVisibility?: (options: object) => boolean }).checkVisibility
  if (typeof visible === 'function' && !visible.call(el, { opacityProperty: true, visibilityProperty: true })) return false
  return opacity(el) >= 0.2
}

/**
 * The field to put the saved password in, if this is a login form: the field marked
 * `current-password`, or the only password field. Two or more unmarked ones are a sign-up
 * or change-password form ("password" and "confirm"): no password.
 */
function loginPassword(fields: HTMLInputElement[]): HTMLInputElement | null {
  const passwords = fields.filter((el) => el.type === 'password')
  const marked = passwords.find((el) => autocomplete(el).includes('current-password'))
  if (marked) return marked
  const only = passwords.length === 1 ? passwords[0] : undefined
  return only && !autocomplete(only).includes('new-password') ? only : null
}

export function isCode(el: HTMLInputElement): boolean {
  if (!TEXTISH.has(el.type) && el.type !== 'number') return false
  if (autocomplete(el).includes('one-time-code')) return true
  const text = describe(el)
  return CODE.test(text) && !isNegative(el) && !USER.test(text)
}

function isUsernameLike(el: HTMLInputElement): boolean {
  if (!TEXTISH.has(el.type) || isCode(el)) return false
  const auto = autocomplete(el)
  if (auto.includes('username') || auto.includes('email')) return true
  return !isNegative(el) && (el.type === 'email' || USER.test(describe(el)))
}

/** What a focused field is, for the key icon and the menu: null for anything else. */
export function fieldKind(el: HTMLInputElement): 'username' | 'password' | 'code' | null {
  if (!isUsable(el)) return null
  if (el.type === 'password') return autocomplete(el).includes('new-password') ? null : 'password'
  if (isCode(el)) return 'code'
  return isUsernameLike(el) ? 'username' : null
}

function inputs(scope: ParentNode): HTMLInputElement[] {
  return [...scope.querySelectorAll('input')].filter(isUsable)
}

function before(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** The form a field belongs to, or the nearest container that holds a password field. */
function scopeOf(el: HTMLInputElement): ParentNode {
  if (el.form) return el.form
  const body = el.ownerDocument.body
  for (let node = el.parentElement; node && node !== body; node = node.parentElement) {
    if (node.querySelector('input[type="password"]')) return node
  }
  return el.ownerDocument
}

/** The first login form (with a password to fill); else one with a username or code field. */
function firstLoginScope(doc: Document): ParentNode | null {
  const forms = [...doc.forms]
  const withPassword = forms.find((form) => loginPassword(inputs(form)) !== null)
  if (withPassword) return withPassword
  const loose = inputs(doc)
    .filter((el) => el.type === 'password' && !el.form)
    .map(scopeOf)
    .find((scope) => loginPassword(inputs(scope)) !== null)
  if (loose) return loose
  const step = (el: HTMLInputElement) => isUsernameLike(el) || isCode(el)
  return forms.find((form) => inputs(form).some(step)) ?? (inputs(doc).some(step) ? doc : null)
}

/**
 * The fields to fill. For a login: the focused field's form if it's a login form, else the
 * page's first login form, else the focused field's area (a one-field email step). For a
 * code: the focused code field's area first. A focused newsletter box never beats a real
 * login form elsewhere on the page.
 */
export function findTarget(doc: Document, focused: HTMLInputElement | null, want: 'login' | 'code' = 'login'): Target | null {
  const near = focused && focused.isConnected && focused.ownerDocument === doc && isUsable(focused) ? focused : null
  const fromFocus = near ? targetIn(scopeOf(near), near) : null
  if (want === 'login' ? fromFocus?.password : fromFocus?.code) return fromFocus
  const scope = firstLoginScope(doc)
  const fromPage = scope ? targetIn(scope, null) : null
  if (want === 'login' ? fromPage?.password : fromPage?.code) return fromPage
  return fromFocus ?? fromPage
}

function targetIn(scope: ParentNode, near: HTMLInputElement | null): Target | null {
  const fields = inputs(scope)
  const password = loginPassword(fields)
  let username: HTMLInputElement | null = null
  if (near && isUsernameLike(near)) {
    username = near
  } else if (password) {
    // The text field just before the password field.
    const candidates = fields.filter((el) => TEXTISH.has(el.type) && !isCode(el) && !isNegative(el) && before(el, password))
    username = candidates.at(-1) ?? null
  } else {
    // A one-field step (email first, password on the next page).
    username = fields.find(isUsernameLike) ?? null
  }
  const code = near && isCode(near) ? near : (fields.find((el) => autocomplete(el).includes('one-time-code')) ?? null)
  if (!username && !password && !code) return null
  const wantsEmail = username !== null && (username.type === 'email' || autocomplete(username).includes('email') || EMAIL.test(describe(username)))
  return { username, wantsEmail, password, code }
}
