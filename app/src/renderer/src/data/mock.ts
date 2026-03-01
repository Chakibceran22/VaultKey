import type { Credential, DomainGroup } from '../types'

export const mockCredentials: Credential[] = [
  {
    id: '1',
    domain: 'google.com',
    username: 'john_doe',
    email: 'john.doe@gmail.com',
    password: 'xK#9mP$vL2nQ',
    createdAt: '2024-01-15T10:30:00Z',
    lastUsed: '2025-05-20T14:22:00Z'
  },
  {
    id: '2',
    domain: 'google.com',
    username: 'johndoe_work',
    email: 'john@acme-corp.com',
    password: 'W0rk$ecure!99',
    createdAt: '2024-03-20T09:15:00Z',
    lastUsed: '2025-05-19T11:45:00Z'
  },
  {
    id: '3',
    domain: 'google.com',
    username: 'jd_personal',
    email: 'jd.personal@gmail.com',
    password: 'P3rs0nal#Key!42',
    createdAt: '2024-06-10T16:00:00Z',
    lastUsed: '2025-05-15T08:30:00Z'
  },
  {
    id: '4',
    domain: 'github.com',
    username: 'john-dev',
    email: 'john.doe@gmail.com',
    password: 'G1tHub!Dev#22x',
    createdAt: '2023-11-05T12:00:00Z',
    lastUsed: '2025-05-20T16:10:00Z'
  },
  {
    id: '5',
    domain: 'github.com',
    username: 'jd-enterprise',
    email: 'john@acme-corp.com',
    password: 'Ent3rprise!GH$',
    createdAt: '2024-02-14T08:45:00Z',
    lastUsed: '2025-05-18T10:20:00Z'
  },
  {
    id: '6',
    domain: 'twitter.com',
    username: 'johndoe_tweets',
    email: 'john.doe@gmail.com',
    password: 'Tw1tter@Secure9',
    createdAt: '2023-09-01T14:30:00Z',
    lastUsed: '2025-05-17T20:15:00Z'
  },
  {
    id: '7',
    domain: 'amazon.com',
    username: 'john.shopper',
    email: 'john.doe@gmail.com',
    password: 'Amz$hopping!1k',
    createdAt: '2023-12-20T11:00:00Z',
    lastUsed: '2025-05-16T09:45:00Z'
  },
  {
    id: '8',
    domain: 'amazon.com',
    username: 'jd_prime',
    email: 'jd.personal@gmail.com',
    password: 'Pr1me#Access!7',
    createdAt: '2024-04-05T15:30:00Z',
    lastUsed: '2025-05-14T13:20:00Z'
  },
  {
    id: '9',
    domain: 'netflix.com',
    username: 'john_flix',
    email: 'john.doe@gmail.com',
    password: 'N3tflix!Watch@8',
    createdAt: '2024-01-10T19:00:00Z',
    lastUsed: '2025-05-20T21:00:00Z'
  },
  {
    id: '10',
    domain: 'spotify.com',
    username: 'john_music',
    email: 'john.doe@gmail.com',
    password: 'Sp0tify#Beats!3',
    createdAt: '2024-02-28T10:15:00Z',
    lastUsed: '2025-05-19T18:30:00Z'
  },
  {
    id: '11',
    domain: 'discord.com',
    username: 'john1337',
    email: 'john.doe@gmail.com',
    password: 'D1sc0rd!Chat#5',
    createdAt: '2023-10-15T20:00:00Z',
    lastUsed: '2025-05-20T22:45:00Z'
  },
  {
    id: '12',
    domain: 'discord.com',
    username: 'jd_gaming',
    email: 'jd.personal@gmail.com',
    password: 'G4ming#Server!2',
    createdAt: '2024-05-01T16:30:00Z',
    lastUsed: '2025-05-18T23:15:00Z'
  },
  {
    id: '13',
    domain: 'stackoverflow.com',
    username: 'john_overflow',
    email: 'john@acme-corp.com',
    password: 'St4ck!0verflow@',
    createdAt: '2023-08-20T09:00:00Z',
    lastUsed: '2025-05-15T15:40:00Z'
  }
]

export function groupByDomain(credentials: Credential[]): DomainGroup[] {
  const grouped = credentials.reduce<Record<string, Credential[]>>((acc, cred) => {
    if (!acc[cred.domain]) {
      acc[cred.domain] = []
    }
    acc[cred.domain].push(cred)
    return acc
  }, {})

  return Object.entries(grouped)
    .map(([domain, creds]) => ({
      domain,
      credentials: creds,
      totalAccounts: creds.length,
      lastUsed: creds.reduce(
        (latest, c) => (new Date(c.lastUsed) > new Date(latest) ? c.lastUsed : latest),
        creds[0].lastUsed
      )
    }))
    .sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime())
}

const ACCENT_COLORS = [
  '#8caaee',
  '#ca9ee6',
  '#e78284',
  '#ef9f76',
  '#a6d189',
  '#81c8be',
  '#f4b8e4',
  '#e5c890',
  '#85c1dc',
  '#99d1db',
  '#babbf1',
  '#eebebe',
  '#ea999c',
  '#f2d5cf'
]

export function getDomainColor(domain: string): string {
  const code = domain.charCodeAt(0) + domain.charCodeAt(1)
  return ACCENT_COLORS[code % ACCENT_COLORS.length]
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
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

export function generatePassword(length: number = 16): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const symbols = '!@#$%^&*_+-=?'
  const all = upper + lower + digits + symbols

  let password = ''
  password += upper[Math.floor(Math.random() * upper.length)]
  password += lower[Math.floor(Math.random() * lower.length)]
  password += digits[Math.floor(Math.random() * digits.length)]
  password += symbols[Math.floor(Math.random() * symbols.length)]

  for (let i = password.length; i < length; i++) {
    password += all[Math.floor(Math.random() * all.length)]
  }

  return password
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('')
}

export function getPasswordStrength(password: string): {
  score: number
  label: string
  color: string
} {
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (password.length >= 16) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z\d]/.test(password)) score++

  if (score <= 2) return { score, label: 'Weak', color: '#e78284' }
  if (score <= 4) return { score, label: 'Medium', color: '#e5c890' }
  return { score, label: 'Strong', color: '#a6d189' }
}
