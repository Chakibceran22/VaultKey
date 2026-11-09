/** Uniform integer in [0, max) from the OS CSPRNG (rejection sampling: no modulo bias). */
function randomIndex(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max
  const buffer = new Uint32Array(1)
  do {
    crypto.getRandomValues(buffer)
  } while (buffer[0] >= limit)
  return buffer[0] % max
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const SYMBOLS = '!@#$%^&*_+-=?'
const ALL = UPPER + LOWER + DIGITS + SYMBOLS

const pick = (set: string): string => set[randomIndex(set.length)]

/**
 * A random password with at least one character of each class, in random
 * positions. (The Electron version used Math.random and always put the four
 * guaranteed classes first.)
 */
export function generatePassword(length = 16): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)]
  while (chars.length < length) chars.push(pick(ALL))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export interface Strength {
  /** 0–6, one point per rule met. */
  score: number
  label: string
  /** A CSS colour (theme token). */
  color: string
}

/** Same scoring as before; colours now come from the theme. */
export function getPasswordStrength(password: string): Strength {
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[A-Z]/.test(password)) score++
  if (/[a-z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++

  const levels = [
    { label: 'Very weak', color: 'var(--destructive)' },
    { label: 'Weak', color: 'var(--destructive)' },
    { label: 'Fair', color: 'var(--warning)' },
    { label: 'Good', color: 'var(--warning)' },
    { label: 'Strong', color: 'var(--success)' },
    { label: 'Excellent', color: 'var(--primary)' }
  ]
  return { score, ...levels[Math.min(score, levels.length - 1)] }
}

export function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${Math.floor(diffMonths / 12)}y ago`
}
