// Service worker → content script: fill this login or code. Values are written and dropped;
// the content script keeps nothing.

export interface FillRequest {
  type: 'vaultkey.fill'
  /** The origin the values were released for: a page that navigated since gets nothing. */
  origin: string
  login: { username: string | null; email: string; password: string } | null
  code: string | null
}

export interface FillResult {
  filled: number
  /** Why nothing was filled. */
  reason?: 'origin' | 'no_form'
}

const isString = (value: unknown): value is string => typeof value === 'string'

export function isFillRequest(value: unknown): value is FillRequest {
  if (typeof value !== 'object' || value === null) return false
  const { type, origin, login, code } = value as Record<string, unknown>
  if (type !== 'vaultkey.fill' || !isString(origin) || (code !== null && !isString(code))) return false
  if (login === null) return code !== null
  if (typeof login !== 'object') return false
  const { username, email, password } = login as Record<string, unknown>
  return (username === null || isString(username)) && isString(email) && isString(password)
}

export function isFillResult(value: unknown): value is FillResult {
  if (typeof value !== 'object' || value === null) return false
  const { filled, reason } = value as Record<string, unknown>
  return Number.isInteger(filled) && (reason === undefined || reason === 'origin' || reason === 'no_form')
}
