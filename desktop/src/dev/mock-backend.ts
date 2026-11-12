/**
 * Dev-only: lets `pnpm dev` run in a normal browser (no Tauri) so the UI can be
 * previewed and screenshotted, by answering every vault command from memory
 * with made-up data (DevNotes does the same).
 *
 * Loaded only when import.meta.env.DEV and not inside Tauri (see main.tsx), so
 * it never ships in the app and never runs in the Tauri window. It touches no
 * file: the real vault is never involved. Any master password unlocks except
 * "wrong", which exercises the failure path.
 */
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

interface MockCredential {
  id: number
  domainId: number
  username: string | null
  email: string
  password: string
  category?: string
}

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

const domains = [
  { id: 1, name: 'github.com', createdAt: iso(120), updatedAt: iso(1) },
  { id: 2, name: 'figma.com', createdAt: iso(90), updatedAt: iso(9) },
  { id: 3, name: 'linear.app', createdAt: iso(60), updatedAt: iso(3) },
  { id: 4, name: 'vercel.com', createdAt: iso(45), updatedAt: iso(21) },
  { id: 5, name: 'notion.so', createdAt: iso(30), updatedAt: iso(40) },
  { id: 6, name: 'stripe.com', createdAt: iso(20), updatedAt: iso(0.02) },
  { id: 7, name: 'google.com', createdAt: iso(200), updatedAt: iso(80) },
  { id: 8, name: 'apple.com', createdAt: iso(150), updatedAt: iso(95) },
  { id: 9, name: 'discord.com', createdAt: iso(140), updatedAt: iso(12) },
  { id: 10, name: 'proton.me', createdAt: iso(100), updatedAt: iso(5) },
  { id: 11, name: 'steampowered.com', createdAt: iso(400), updatedAt: iso(60) },
  { id: 12, name: 'BattleNet.com', createdAt: iso(380), updatedAt: iso(70) },
  { id: 13, name: 'claude.ai', createdAt: iso(50), updatedAt: iso(4) },
  { id: 14, name: 'paypal.com', createdAt: iso(300), updatedAt: iso(30) },
  { id: 15, name: 'revolut.com', createdAt: iso(260), updatedAt: iso(26) },
  { id: 16, name: 'netflix.com', createdAt: iso(500), updatedAt: iso(90) },
  { id: 17, name: 'amazon.fr', createdAt: iso(450), updatedAt: iso(15) },
  { id: 18, name: 'example.dev', createdAt: iso(35), updatedAt: iso(35) },
  { id: 19, name: 'hetzner.com', createdAt: iso(42), updatedAt: iso(6) }
]

const credentials: MockCredential[] = [
  { id: 1, domainId: 1, username: 'test-dev', email: 'test@example.com', password: 'gh-Xr7!qLm2#vTp9' },
  { id: 2, domainId: 1, username: null, email: 'work@example.com', password: 'Tq8$zN1u@Kc5wYe3' },
  { id: 3, domainId: 2, username: 'tester', email: 'test@example.com', password: '' },
  { id: 4, domainId: 3, username: null, email: 'test@example.com', password: 'lin-7Hq#2Vb9' },
  { id: 5, domainId: 4, username: 'tester1', email: 'test@example.com', password: '' },
  { id: 6, domainId: 6, username: null, email: 'billing@example.com', password: 'St9#qW2eR7tY!u' },
  { id: 7, domainId: 7, username: null, email: 'you@example.com', password: 'G0og!e-Qz82#kLp' },
  { id: 8, domainId: 7, username: null, email: 'work@example.org', password: 'password123' },
  { id: 9, domainId: 7, username: null, email: 'shop@example.com', password: 'Wq7!nB3#xP0s' },
  { id: 10, domainId: 8, username: null, email: 'you@example.net', password: 'Ap9#Lm2!qW7e' },
  { id: 11, domainId: 9, username: 'tester#4821', email: 'test@example.com', password: 'Dc5!zX8@vN1m' },
  { id: 12, domainId: 10, username: null, email: 'private@example.org', password: 'Pr0t#9Vn!2Qx' },
  { id: 13, domainId: 10, username: null, email: 'backup@example.org', password: 'Bk7@pR2#mL9z' },
  { id: 14, domainId: 11, username: 'test-player', email: 'you@example.com', password: 'St3am!kQ9#xL' },
  { id: 15, domainId: 12, username: 'Tester#2291', email: 'you@example.com', password: 'Bn7#qL2!vX9p' },
  { id: 16, domainId: 13, username: null, email: 'test@example.com', password: '' },
  { id: 17, domainId: 14, username: null, email: 'shop@example.com', password: 'Pp4!mZ8#tQ2w' },
  { id: 18, domainId: 15, username: null, email: 'you@example.com', password: 'Rv6@nL3#kP9s' },
  { id: 19, domainId: 16, username: null, email: 'you@example.com', password: 'Nf2#xQ7!bL4m' },
  { id: 20, domainId: 17, username: null, email: 'shop@example.com', password: 'Am9!pW3#rT6k' },
  { id: 21, domainId: 18, username: null, email: 'test@example.com', password: 'Au5#tR8!cH2q', category: 'Work' },
  { id: 22, domainId: 19, username: null, email: 'billing@example.com', password: 'Hz4!nR9#bL2t' }
]


// ── projects, services, secrets, links (schema v2) ──
const projects = [
  { id: 1, name: 'Example Store', description: 'An example online shop, self-hosted.', createdAt: iso(40), updatedAt: iso(2) },
  { id: 2, name: 'Example Portfolio', description: 'An example personal site.', createdAt: iso(90), updatedAt: iso(30) },
  { id: 3, name: 'Test Project', description: '', createdAt: iso(5), updatedAt: iso(5) },
  { id: 4, name: 'Big Project', description: 'A big example project with many services.', createdAt: iso(60), updatedAt: iso(1) }
]
const services = [
  { id: 1, projectId: 1, name: 'Coolify', url: 'https://coolify.example.dev', accounts: [{ accountId: 7, role: 'admin, server owner' }, { accountId: 22, role: 'billing' }], createdAt: iso(40), updatedAt: iso(3) },
  { id: 2, projectId: 1, name: 'Vercel', url: 'https://vercel.com/example', accounts: [{ accountId: 5, role: '' }], createdAt: iso(39), updatedAt: iso(9) },
  { id: 3, projectId: 1, name: 'Supabase', url: 'https://supabase.com/dashboard/project/example', accounts: [] as { accountId: number; role: string }[], createdAt: iso(38), updatedAt: iso(12) },
  { id: 5, projectId: 1, name: 'Prod server', url: '203.0.113.7:22', accounts: [] as { accountId: number; role: string }[], createdAt: iso(20), updatedAt: iso(2) },
  { id: 4, projectId: 2, name: 'GitHub Pages', url: 'https://github.com/example/site', accounts: [{ accountId: 1, role: 'deploys the site' }], createdAt: iso(90), updatedAt: iso(30) },
  // Many services in one project, to see the list at that scale.
  ...[
    'Cloudflare', 'Coolify (prod)', 'Coolify (staging)', 'Datadog', 'DigitalOcean', 'Docker Hub', 'Fastly',
    'Firebase', 'GitHub', 'GitLab CI', 'Grafana', 'Hetzner', 'Linear', 'Mailgun', 'MongoDB Atlas', 'Neon',
    'Netlify', 'npm', 'OVHcloud', 'PlanetScale', 'Postmark', 'Railway', 'Redis Cloud', 'Render', 'Resend',
    'Scaleway', 'Sentry', 'Slack', 'Stripe', 'Supabase', 'Twilio', 'Upstash', 'Vercel', 'Zapier'
  ].map((name, i) => ({
    id: 200 + i,
    projectId: 4,
    name,
    url: `https://${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`,
    accounts: [
      { accountId: [1, 5, 6, 7, 22][i % 5], role: i % 3 === 0 ? 'admin' : '' },
      ...(i % 4 === 0 ? [{ accountId: [8, 10, 9][i % 3], role: 'billing' }] : [])
    ],
    createdAt: iso(60 - i),
    updatedAt: iso(i % 9)
  }))
]
// A service's own logins (a server's users), and their passwords.
type MockLogin = { id: number; username: string; note: string; hasPassword: boolean }
const serviceLogins = new Map<number, MockLogin[]>([
  [5, [{ id: 900, username: 'root', note: 'full access, SSH', hasPassword: true }, { id: 901, username: 'deploy', note: 'SSH key only', hasPassword: false }]]
])
const loginPasswords = new Map<number, string>([[900, 'correct-horse-battery']])
function saveLogins(serviceId: number, input: { id?: number; username: string; password?: string; note: string }[] = []): void {
  serviceLogins.set(
    serviceId,
    input.map((l) => {
      const id = l.id ?? nextId++
      if (l.password !== undefined) {
        if (l.password) loginPasswords.set(id, l.password)
        else loginPasswords.delete(id)
      }
      return { id, username: l.username.trim(), note: l.note, hasPassword: loginPasswords.has(id) }
    })
  )
}

const secretValues = new Map<number, string>([
  [1, 'sk_live_51Hx0aBcDeFgHiJkLmNoPqRsTuVwXyZ'],
  [2, 'postgres://example:R7q!vP2@db.example.dev:5432/shop'],
  [3, 're_9xY2kLmN4pQ7rS1t'],
  [4, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBpreview0nly0made0up0key0material0here0nothing0real0AAAA\n-----END OPENSSH PRIVATE KEY-----'],
  [5, 'DATABASE_URL=postgres://localhost/example\nSTRIPE_KEY=sk_test_123\n']
])
const secrets = [
  { id: 1, projectId: 1, serviceId: null as number | null, kind: 'text', name: 'STRIPE_SECRET_KEY', mimeType: 'text/plain', size: 32, description: 'Live mode, full access', createdAt: iso(30), updatedAt: iso(4) },
  { id: 2, projectId: 1, serviceId: 3 as number | null, kind: 'text', name: 'DATABASE_URL', mimeType: 'text/plain', size: 46, description: '', createdAt: iso(30), updatedAt: iso(12) },
  { id: 3, projectId: 1, serviceId: null as number | null, kind: 'text', name: 'RESEND_API_KEY', mimeType: 'text/plain', size: 18, description: '', createdAt: iso(20), updatedAt: iso(20) },
  { id: 4, projectId: 1, serviceId: 1 as number | null, kind: 'file', name: 'id_ed25519', mimeType: 'application/octet-stream', size: 411, description: 'Deploy key for the Coolify server', createdAt: iso(25), updatedAt: iso(25) },
  { id: 5, projectId: 1, serviceId: null as number | null, kind: 'file', name: 'production.env', mimeType: 'text/plain', size: 64, description: '', createdAt: iso(10), updatedAt: iso(10) },
  { id: 6, projectId: 1, serviceId: null as number | null, kind: 'file', name: 'logo.png', mimeType: 'image/png', size: 48213, description: '', createdAt: iso(8), updatedAt: iso(8) }
]
const links = [
  { accountId: 5, linkedAccountId: 1, kind: 'sign_in' },
  { accountId: 3, linkedAccountId: 7, kind: 'sign_in' },
  { accountId: 1, linkedAccountId: 7, kind: 'recovery' },
  { accountId: 6, linkedAccountId: 7, kind: 'recovery' },
  { accountId: 12, linkedAccountId: 13, kind: 'recovery' }
]

// ── devices, second steps, account secrets (schema v3) ──
const devices = [
  { id: 1, name: 'iPhone 15', kind: 'phone', notes: 'Personal SIM, Orange', createdAt: iso(200), updatedAt: iso(20) },
  { id: 2, name: 'MacBook Pro', kind: 'computer', notes: '', createdAt: iso(180), updatedAt: iso(30) },
  { id: 3, name: 'YubiKey 5C', kind: 'security_key', notes: 'On the keyring', createdAt: iso(150), updatedAt: iso(150) },
  { id: 4, name: 'iPad Air', kind: 'tablet', notes: '', createdAt: iso(100), updatedAt: iso(100) }
]
const factors = [
  { id: 1, accountId: 1, kind: 'authenticator', label: '1Password', deviceId: 1 as number | null, hasSecret: true, createdAt: iso(100), updatedAt: iso(100) },
  { id: 2, accountId: 1, kind: 'passkey', label: 'iCloud Keychain', deviceId: 2 as number | null, hasSecret: false, createdAt: iso(90), updatedAt: iso(90) },
  { id: 3, accountId: 1, kind: 'security_key', label: '', deviceId: 3 as number | null, hasSecret: false, createdAt: iso(80), updatedAt: iso(80) },
  { id: 4, accountId: 1, kind: 'recovery_codes', label: 'printed, in the drawer', deviceId: null as number | null, hasSecret: true, createdAt: iso(100), updatedAt: iso(100) },
  { id: 5, accountId: 7, kind: 'prompt', label: 'Gmail app', deviceId: 1 as number | null, hasSecret: false, createdAt: iso(150), updatedAt: iso(150) },
  { id: 6, accountId: 7, kind: 'sms', label: '+33 6 12 34 56 78', deviceId: null as number | null, hasSecret: false, createdAt: iso(150), updatedAt: iso(150) },
  { id: 7, accountId: 7, kind: 'recovery_codes', label: '', deviceId: null as number | null, hasSecret: true, createdAt: iso(150), updatedAt: iso(150) },
  { id: 8, accountId: 10, kind: 'prompt', label: 'Trusted device', deviceId: 1 as number | null, hasSecret: false, createdAt: iso(140), updatedAt: iso(140) },
  { id: 9, accountId: 6, kind: 'authenticator', label: 'Google Authenticator', deviceId: 1 as number | null, hasSecret: false, createdAt: iso(20), updatedAt: iso(20) },
  { id: 10, accountId: 11, kind: 'authenticator', label: 'Authy', deviceId: 1 as number | null, hasSecret: false, createdAt: iso(60), updatedAt: iso(60) }
]
const factorSecrets = new Map<number, string>([
  [1, 'JBSWY3DPEHPK3PXP'],
  [4, '4f2a-91bc\n7d0e-3a58\nb61c-0f47\n98e2-c5d1\n2a7f-e830\n5c19-7b4e\nd04b-61a9\n83fe-2c75'],
  [7, '7104 2286\n3391 0057\n6620 9148\n0875 4413']
])
const accountSecrets = [
  { id: 1, accountId: 1, kind: 'secret', name: 'Personal access token', size: 40, createdAt: iso(30), updatedAt: iso(30) },
  { id: 2, accountId: 1, kind: 'note', name: 'Good to know', size: 96, createdAt: iso(25), updatedAt: iso(25) },
  { id: 3, accountId: 5, kind: 'secret', name: 'VERCEL_TOKEN', size: 24, createdAt: iso(12), updatedAt: iso(12) }
]
const accountSecretValues = new Map<number, string>([
  [1, 'ghp_preview0nly0made0up0token0000000000'],
  [2, 'Recovery email is the Gmail account. The SSH key for pushes lives on the MacBook.\nOrg owner of example-labs.'],
  [3, 'vc_preview_0nly_made_up']
])
const staged: { token: number; name: string; size: number }[] = []
const deviceLinks = [
  { accountId: 1, deviceId: 2, note: 'git over SSH, passkey' },
  { accountId: 1, deviceId: 1, note: 'GitHub Mobile, authenticator' },
  { accountId: 7, deviceId: 1, note: '' },
  { accountId: 7, deviceId: 2, note: '' },
  { accountId: 7, deviceId: 4, note: '' },
  { accountId: 10, deviceId: 1, note: '' },
  { accountId: 10, deviceId: 2, note: '' },
  { accountId: 10, deviceId: 4, note: '' }
]

// Long lists, to see every list at the scale real vaults reach (preview only).
{
  const names = ['STRIPE', 'DATABASE', 'REDIS', 'SENTRY', 'RESEND', 'TWILIO', 'ALGOLIA', 'MAPBOX', 'OPENAI', 'S3']
  for (let i = 0; i < 45; i++) {
    const name = `${names[i % names.length]}_${['SECRET_KEY', 'URL', 'TOKEN', 'API_KEY', 'WEBHOOK_SECRET'][i % 5]}${i >= 10 ? `_${Math.floor(i / 10) + 1}` : ''}`
    secrets.push({ id: 300 + i, projectId: 4, serviceId: i % 3 === 0 ? 200 + (i % 34) : null, kind: 'text', name, mimeType: 'text/plain', size: 32, description: i % 4 === 0 ? ['Live mode, full access', 'read-only', 'staging only', 'rotates every 90 days'][i % 4 === 0 ? (i / 4) % 4 : 0] : '', createdAt: iso(50 - i), updatedAt: iso(i % 20) })
    secretValues.set(300 + i, `preview-value-${i}`)
  }
  for (let i = 0; i < 18; i++) {
    const name = ['id_ed25519', 'deploy_key', 'client.pem', 'production.env', 'staging.env', 'backup.sql.gz'][i % 6] + (i >= 6 ? `.${Math.floor(i / 6)}` : '')
    secrets.push({ id: 400 + i, projectId: 4, serviceId: null, kind: 'file', name, mimeType: 'text/plain', size: 400 + i * 37, description: i % 5 === 0 ? 'for the prod server' : '', createdAt: iso(40 - i), updatedAt: iso(i % 15) })
    secretValues.set(400 + i, 'preview file')
  }
  for (let i = 0; i < 24; i++) {
    const note = i % 3 === 0
    accountSecrets.push({ id: 500 + i, accountId: 1, kind: note ? 'note' : 'secret', name: note ? `Note ${i}: org settings` : `TOKEN_${i}`, size: 40, createdAt: iso(30 - i), updatedAt: iso(i % 12) })
    accountSecretValues.set(500 + i, note ? `First line of note ${i}.\nMore details below.` : `ghp_preview_${i}`)
  }
  for (let id = 2; id <= 21; id++) {
    if (id !== 7) links.push({ accountId: id, linkedAccountId: 7, kind: 'sign_in' })
    if (!deviceLinks.some((l) => l.accountId === id && l.deviceId === 1)) deviceLinks.push({ accountId: id, deviceId: 1, note: '' })
  }
}

/** Real RFC 6238 codes, so the preview's live code behaves like the app's. */
async function totp(secret: string): Promise<{ code: string; period: number; expiresAt: number }> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret.replace(/[\s=-]/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  const key = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2))
  const step = Math.floor(Date.now() / 30_000)
  const counter = new DataView(new ArrayBuffer(8))
  counter.setUint32(4, step)
  const hmacKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, counter.buffer))
  const offset = mac[19] & 0xf
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return { code: String(binary % 1_000_000).padStart(6, '0'), period: 30, expiresAt: (step + 1) * 30_000 }
}

const PREVIEW_ENV = `# Shop production
STRIPE_SECRET_KEY=sk_live_51Hx9 # live payments, full write access
DATABASE_URL="postgres://shop:p#ss@db.internal:5432/shop" # production database
RESEND_API_KEY=re_8f2k
SENTRY_DSN=https://k@o1.ingest.sentry.io/4 # frontend error reporting
EMPTY_ONE=
not a variable line
`

function previewParseEnv(text: string): { entries: { line: number; name: string; value: string; comment: string }[]; skipped: { line: number; reason: string }[] } {
  const entries: { line: number; name: string; value: string; comment: string }[] = []
  const skipped: { line: number; reason: string }[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) return
    const match = /^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line)
    if (!match) return void skipped.push({ line: i + 1, reason: 'Not a NAME=value line.' })
    const [, name, rest] = match
    const quoted = /^(["'`])(.*?)\1\s*(?:#\s*(.*))?$/.exec(rest)
    const plain = /^(.*?)(?:(?:^|\s)#\s*(.*))?$/.exec(rest)!
    const value = quoted ? quoted[2] : plain[1].trim()
    const comment = (quoted ? quoted[3] : plain[2])?.trim() ?? ''
    if (!value) return void skipped.push({ line: i + 1, reason: `${name} has no value.` })
    const earlier = entries.findIndex((e) => e.name === name)
    if (earlier >= 0) skipped.push({ line: entries.splice(earlier, 1)[0].line, reason: `${name} is set again on line ${i + 1}, which is kept.` })
    entries.push({ line: i + 1, name, value, comment })
  })
  return { entries, skipped: skipped.sort((a, b) => a.line - b.line) }
}

const PREVIEW_WORDS = 'gesture panda orbit velvet sample lunar kidney rescue amateur hockey fabric meadow tunnel boring easily quantum jacket olive rival thunder walnut cabin depart zebra'.split(' ')
const previewRecovery = { saved: false }

function removeWhere<T>(list: T[], test: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) list.splice(i, 1)
}
let nextId = 1000

let nextDomainId = 20
let nextCredentialId = 23

function fail(code: string, message: string): never {
  throw { code, message }
}

function domainList() {
  return {
    domains: domains.map((d) => ({
      ...d,
      _count: { credentials: credentials.filter((c) => c.domainId === d.id).length }
    }))
  }
}

/** Settings → Browser extension, in memory: two browsers installed, one paired. */
const bridge = {
  enabled: false,
  listening: false,
  available: true,
  dev: true,
  browsers: [
    { name: 'Brave', installed: true, registered: false },
    { name: 'Chrome', installed: true, registered: false },
    { name: 'Edge', installed: false, registered: false }
  ],
  paired: [{ id: 1, name: 'Brave on macOS', createdAt: iso(3), lastSeenAt: iso(0.01) }],
  recent: [
    { at: iso(0.002), browser: 'Brave on macOS', account: 'github.com · alice@example.com', site: 'github.com', what: 'login' as const, crossSite: false },
    { at: iso(0.03), browser: 'Brave on macOS', account: 'stripe.com · billing@example.com', site: 'dashboard.example.dev', what: 'login' as const, crossSite: true }
  ]
}

/**
 * Websites saved as a name the extension can't match. Kept apart from `domains` so the
 * accounts list (and the README's screenshots) stays as it is. Sorted by name, like the app.
 */
let unmatched = [
  { domainId: 102, name: 'GitHub work', suggestion: 'github.com', accounts: 2 },
  { domainId: 101, name: 'GitLab', suggestion: 'gitlab.com', accounts: 1 },
  { domainId: 103, name: 'Home router', suggestion: null as string | null, accounts: 1 }
]

/** Background & auto-lock, in memory, with the app's defaults. */
const background = { keepRunning: true, autoLockMinutes: 5 }

function handle(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'vault_status':
      return { status: 'NEEDS_LOGIN', recoveryCode: true }
    case 'create_vault':
      return null
    case 'unlock_vault':
      return { valid: args.masterPassword !== 'wrong' }
    case 'lock_vault':
      return null
    case 'change_master_password':
      if (args.currentPassword === 'wrong') fail('AUTH_FAILED', 'The master password is wrong.')
      return null
    // The recovery code, for the preview: a fixed list of 24 words, nothing kept.
    case 'security_status':
      return { vaultKey: true, recoveryCode: previewRecovery.saved, waitingOn: [] }
    case 'new_recovery_code':
      return { words: PREVIEW_WORDS }
    case 'save_recovery_code': {
      if (args.masterPassword === 'wrong') fail('AUTH_FAILED', 'The master password is wrong.')
      for (const { position, word } of args.answers as { position: number; word: string }[]) {
        if (PREVIEW_WORDS[position - 1] !== word.trim().toLowerCase()) fail('INVALID_INPUT', `Word ${position} doesn’t match. Check what you wrote down.`)
      }
      previewRecovery.saved = true
      return null
    }
    case 'recover_vault':
      if ((args.recoveryCode as string).trim().split(/\s+/).length !== 24) fail('INVALID_INPUT', 'A recovery code has 24 words.')
      return null
    case 'fetch_domains':
      return domainList()
    case 'register_domain': {
      const name = String(args.name).trim()
      if (domains.some((d) => d.name === name)) fail('ALREADY_EXISTS', 'That record already exists.')
      const id = nextDomainId++
      domains.push({ id, name, createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'delete_domain': {
      const at = domains.findIndex((d) => d.id === args.domainId)
      if (at < 0) fail('NOT_FOUND', 'Domain not found.')
      domains.splice(at, 1)
      for (let i = credentials.length - 1; i >= 0; i--) {
        if (credentials[i].domainId === args.domainId) credentials.splice(i, 1)
      }
      return null
    }
    case 'list_accounts':
      return {
        accounts: credentials
          .map((c) => {
            const domain = domains.find((d) => d.id === c.domainId)!
            return {
              id: c.id,
              domainId: c.domainId,
              domainName: domain.name,
              username: c.username,
              email: c.email,
              hasPassword: c.password !== '',
              category: c.category ?? null,
              createdAt: domain.createdAt,
              updatedAt: domain.updatedAt
            }
          })
          .sort((a, b) => a.domainName.localeCompare(b.domainName) || a.email.localeCompare(b.email))
      }
    case 'fetch_credentials':
      return {
        credentials: credentials
          .filter((c) => c.domainId === args.domainId)
          .map(({ domainId: _domainId, ...c }) => c)
      }
    case 'create_credential': {
      const input = args.input as { domainId: number; username?: string; email: string; password: string }
      if (credentials.some((c) => c.domainId === input.domainId && c.email === input.email)) {
        fail('ALREADY_EXISTS', 'That email is already used in this domain.')
      }
      const id = nextCredentialId++
      credentials.push({
        id,
        domainId: input.domainId,
        username: input.username ?? null,
        email: input.email,
        password: input.password
      })
      return { id }
    }
    case 'update_credential': {
      const credential = credentials.find((c) => c.id === args.credentialId)
      if (!credential) fail('NOT_FOUND', 'Credential not found.')
      Object.assign(credential, args.input as object)
      return null
    }
    case 'delete_credential': {
      const at = credentials.findIndex((c) => c.id === args.credentialId)
      if (at < 0) fail('NOT_FOUND', 'Credential not found.')
      credentials.splice(at, 1)
      const gone = (id: number): boolean => id === args.credentialId
      removeWhere(links, (l) => gone(l.accountId) || gone(l.linkedAccountId))
      removeWhere(factors, (f) => gone(f.accountId))
      removeWhere(accountSecrets, (x) => gone(x.accountId))
      removeWhere(deviceLinks, (l) => gone(l.accountId))
      for (const service of services) service.accounts = service.accounts.filter((a) => !gone(a.accountId))
      return null
    }
    case 'load_workspace':
      return { projects, services: services.map((x) => ({ ...x, logins: serviceLogins.get(x.id) ?? [] })), secrets }
    case 'create_project': {
      const input = args.input as { name: string; description?: string }
      const id = nextId++
      projects.push({ id, name: input.name.trim(), description: input.description ?? '', createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_project': {
      const project = projects.find((p) => p.id === args.projectId)
      if (!project) fail('NOT_FOUND', 'Project not found.')
      Object.assign(project, args.input as object, { updatedAt: iso(0) })
      return null
    }
    case 'delete_project': {
      const at = projects.findIndex((p) => p.id === args.projectId)
      if (at < 0) fail('NOT_FOUND', 'Project not found.')
      projects.splice(at, 1)
      return null
    }
    case 'create_service': {
      const input = args.input as { name: string; url?: string; accounts?: { accountId: number; role: string }[]; logins?: { id?: number; username: string; password?: string; note: string }[] }
      const id = nextId++
      services.push({ id, projectId: args.projectId as number, name: input.name, url: input.url ?? '', accounts: input.accounts ?? [], createdAt: iso(0), updatedAt: iso(0) })
      saveLogins(id, input.logins)
      return { id }
    }
    case 'update_service': {
      const service = services.find((x) => x.id === args.serviceId)
      if (!service) fail('NOT_FOUND', 'Service not found.')
      const { logins, ...rest } = args.input as { logins?: { id?: number; username: string; password?: string; note: string }[] }
      Object.assign(service, rest, { updatedAt: iso(0) })
      saveLogins(service.id, logins)
      return null
    }
    case 'reveal_service_login': {
      const password = loginPasswords.get(args.loginId as number)
      if (password === undefined) fail('NOT_FOUND', 'This login has no password.')
      return { value: password }
    }
    case 'delete_service': {
      const at = services.findIndex((x) => x.id === args.serviceId)
      services.splice(at, 1)
      return null
    }
    case 'create_secret': {
      const input = args.input as { name: string; value: string; serviceId?: number | null; description?: string }
      const id = nextId++
      secretValues.set(id, input.value)
      secrets.push({ id, projectId: args.projectId as number, serviceId: input.serviceId ?? null, kind: 'text', name: input.name, mimeType: 'text/plain', size: input.value.length, description: input.description ?? '', createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_secret': {
      const secret = secrets.find((x) => x.id === args.secretId)
      if (!secret) fail('NOT_FOUND', 'Secret not found.')
      const input = args.input as { name: string; serviceId?: number | null; value?: string; description?: string }
      secret.name = input.name
      secret.serviceId = input.serviceId ?? null
      if (input.description !== undefined) secret.description = input.description
      if (input.value) secretValues.set(secret.id, input.value)
      secret.updatedAt = iso(0)
      return null
    }
    case 'reveal_secret': {
      const secret = secrets.find((x) => x.id === args.secretId)
      if (!secret) fail('NOT_FOUND', 'Secret not found.')
      if (secret.mimeType.startsWith('image/')) fail('INVALID_INPUT', `“${secret.name}” isn’t a text file. Save it as a file instead.`)
      return { value: secretValues.get(secret.id) ?? '' }
    }
    case 'delete_secret': {
      const at = secrets.findIndex((x) => x.id === args.secretId)
      secrets.splice(at, 1)
      return null
    }
    // The upload dialog. The browser has no native picker here: "choosing" adds two made-up files.
    case 'stage_files':
    case 'stage_dropped_files': {
      for (const name of ['deploy_key', 'staging.env']) {
        staged.push({ token: nextId++, name: `${name}-${nextId}`, size: name.length * 97 })
      }
      return { files: staged, skipped: [] }
    }
    case 'unstage_file':
      removeWhere(staged, (f) => f.token === args.token)
      return { files: staged, skipped: [] }
    case 'clear_staged_files':
      staged.length = 0
      return null
    case 'import_staged_files': {
      const imported: number[] = []
      for (const { token, name, description } of args.files as { token: number; name?: string; description: string }[]) {
        const file = staged.find((f) => f.token === token)
        if (!file) fail('INVALID_INPUT', 'A file is no longer in the list. Add it again.')
        const id = nextId++
        secretValues.set(id, 'preview file')
        secrets.push({ id, projectId: args.projectId as number, serviceId: (args.serviceId as number | null) ?? null, kind: 'file', name: name?.trim() || file.name, mimeType: 'text/plain', size: file.size, description, createdAt: iso(0), updatedAt: iso(0) })
        imported.push(id)
      }
      removeWhere(staged, (f) => imported.length > 0 && (args.files as { token: number }[]).some((x) => x.token === f.token))
      return { imported, skipped: [] }
    }
    case 'export_secret':
      return { saved: true }
    // The .env import. The app reads with src-tauri/src/dotenv.rs; this is a short
    // stand-in for the browser preview (one-line values only).
    case 'parse_env':
      return previewParseEnv(args.text as string)
    case 'pick_env_file':
    case 'read_staged_env':
      staged.length = 0
      return { name: 'production.env', text: PREVIEW_ENV }
    case 'import_env': {
      let added = 0
      let updated = 0
      for (const input of args.secrets as { name: string; value: string; description: string; replace: number | null }[]) {
        const existing = secrets.find((x) => x.id === input.replace)
        if (existing) {
          existing.description = input.description
          existing.updatedAt = iso(0)
          secretValues.set(existing.id, input.value)
          updated++
        } else {
          const id = nextId++
          secretValues.set(id, input.value)
          secrets.push({ id, projectId: args.projectId as number, serviceId: (args.serviceId as number | null) ?? null, kind: 'text', name: input.name, mimeType: 'text/plain', size: input.value.length, description: input.description, createdAt: iso(0), updatedAt: iso(0) })
          added++
        }
      }
      return { added, updated }
    }
    case 'list_account_links':
      return { links }
    case 'set_sign_in_links':
    case 'set_account_links': {
      const kind = cmd === 'set_sign_in_links' ? 'sign_in' : String(args.kind)
      removeWhere(links, (l) => l.accountId === args.accountId && l.kind === kind)
      for (const linked of args.linkedAccountIds as number[]) links.push({ accountId: args.accountId as number, linkedAccountId: linked, kind })
      return null
    }
    case 'load_account_details':
      return { devices, factors, secrets: accountSecrets, deviceLinks }
    case 'create_device': {
      const input = args.input as { name: string; kind: string; notes?: string }
      if (devices.some((d) => d.name === input.name.trim())) fail('ALREADY_EXISTS', 'A device with that name already exists.')
      const id = nextId++
      devices.push({ id, name: input.name.trim(), kind: input.kind, notes: input.notes ?? '', createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_device': {
      const device = devices.find((d) => d.id === args.deviceId)
      if (!device) fail('NOT_FOUND', 'Device not found.')
      Object.assign(device, args.input as object, { updatedAt: iso(0) })
      return null
    }
    case 'delete_device': {
      removeWhere(devices, (d) => d.id === args.deviceId)
      for (const f of factors) if (f.deviceId === args.deviceId) f.deviceId = null
      removeWhere(deviceLinks, (l) => l.deviceId === args.deviceId)
      return null
    }
    case 'create_factor': {
      const input = args.input as { kind: string; label?: string; deviceId?: number | null; secret?: string }
      if (input.kind === 'recovery_codes' && !input.secret?.trim()) fail('INVALID_INPUT', 'Enter the recovery codes.')
      const id = nextId++
      if (input.secret?.trim()) factorSecrets.set(id, input.secret.trim())
      factors.push({ id, accountId: args.accountId as number, kind: input.kind, label: input.label?.trim() ?? '', deviceId: input.deviceId ?? null, hasSecret: !!input.secret?.trim(), createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_factor': {
      const factor = factors.find((f) => f.id === args.factorId)
      if (!factor) fail('NOT_FOUND', 'That sign-in step no longer exists.')
      const input = args.input as { label?: string; deviceId?: number | null; secret?: string }
      factor.label = input.label?.trim() ?? ''
      factor.deviceId = input.deviceId ?? null
      if (input.secret !== undefined) {
        if (input.secret.trim()) factorSecrets.set(factor.id, input.secret.trim())
        else factorSecrets.delete(factor.id)
        factor.hasSecret = !!input.secret.trim()
      }
      factor.updatedAt = iso(0)
      return null
    }
    case 'delete_factor':
      removeWhere(factors, (f) => f.id === args.factorId)
      return null
    case 'reveal_factor': {
      const value = factorSecrets.get(args.factorId as number)
      if (!value) fail('NOT_FOUND', 'Nothing secret is saved for this.')
      return { value }
    }
    case 'create_account_secret': {
      const input = args.input as { kind: string; name: string; value: string }
      const id = nextId++
      accountSecretValues.set(id, input.value)
      accountSecrets.push({ id, accountId: args.accountId as number, kind: input.kind, name: input.name.trim(), size: input.value.length, createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_account_secret': {
      const secret = accountSecrets.find((x) => x.id === args.secretId)
      if (!secret) fail('NOT_FOUND', 'Secret not found.')
      const input = args.input as { name: string; value?: string }
      secret.name = input.name.trim()
      if (input.value !== undefined) accountSecretValues.set(secret.id, input.value)
      secret.updatedAt = iso(0)
      return null
    }
    case 'reveal_account_secret':
      return { value: accountSecretValues.get(args.secretId as number) ?? '' }
    case 'delete_account_secret':
      removeWhere(accountSecrets, (x) => x.id === args.secretId)
      return null
    case 'set_account_connections': {
      const accountId = args.accountId as number
      removeWhere(links, (l) => l.accountId === accountId && (l.kind === 'sign_in' || l.kind === 'recovery'))
      for (const id of args.signIn as number[]) links.push({ accountId, linkedAccountId: id, kind: 'sign_in' })
      for (const id of args.recovery as number[]) links.push({ accountId, linkedAccountId: id, kind: 'recovery' })
      removeWhere(deviceLinks, (l) => l.accountId === accountId)
      for (const { deviceId, note } of args.devices as { deviceId: number; note: string }[]) deviceLinks.push({ accountId, deviceId, note })
      return null
    }
    case 'set_account_category': {
      const credential = credentials.find((c) => c.id === args.accountId)
      if (!credential) fail('NOT_FOUND', 'Account not found.')
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      credential.category = name || undefined
      return null
    }
    case 'set_account_devices': {
      const kept = new Map(deviceLinks.filter((l) => l.accountId === args.accountId).map((l) => [l.deviceId, l.note]))
      removeWhere(deviceLinks, (l) => l.accountId === args.accountId)
      for (const deviceId of args.deviceIds as number[]) deviceLinks.push({ accountId: args.accountId as number, deviceId, note: kept.get(deviceId) ?? '' })
      return null
    }
    case 'vault_activity':
      return null
    case 'bridge_settings':
      return bridge
    case 'set_bridge_enabled':
      bridge.enabled = args.enabled === true
      bridge.listening = bridge.enabled
      for (const browser of bridge.browsers) browser.registered = bridge.enabled && browser.installed
      return bridge
    case 'revoke_browser':
      bridge.paired = bridge.paired.filter((browser) => browser.id !== args.browserId)
      return bridge
    case 'pending_pairing':
      return null
    case 'answer_pairing':
      return fail('NOT_FOUND', 'That pairing request has already ended.')
    case 'unmatched_websites':
      return { websites: unmatched }
    case 'set_website_address': {
      const address = String(args.address).trim().toLowerCase()
      // Like the app: an address needs a dot (or is an IP); a name stays unmatchable.
      if (!address.includes('.')) fail('INVALID_INPUT', 'Enter a web address, like github.com.')
      if (domains.some((d) => d.name.toLowerCase() === address)) fail('ALREADY_EXISTS', 'A website with that address is already saved.')
      unmatched = unmatched.filter((w) => w.domainId !== args.domainId)
      return { websites: unmatched }
    }
    case 'background_settings':
      return background
    case 'set_background_settings': {
      const minutes = args.autoLockMinutes as number
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) fail('INVALID_INPUT', 'Auto-lock is 1 to 60 minutes.')
      background.keepRunning = args.keepRunning === true
      background.autoLockMinutes = minutes
      return background
    }
    case 'plugin:clipboard-manager|write_text':
    case 'plugin:clipboard-manager|write_secret':
      return null
    case 'plugin:window|is_fullscreen':
      return false
    default:
      return fail('INTERNAL', `The browser preview does not implement "${cmd}".`)
  }
}

export function installMockBackend(): void {
  mockIPC(async (cmd: string, payload?: InvokeArgs) => {
    // A little latency, so loading states are visible like in the app.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const args = (payload ?? {}) as Record<string, unknown>
    if (cmd === 'factor_code') {
      const secret = factorSecrets.get(args.factorId as number)
      if (!secret) fail('NOT_FOUND', 'No setup key is saved for this.')
      return totp(secret)
    }
    // Copied like real IPC (JSON over the bridge): never hand out the live arrays,
    // or an in-place change would look unchanged to the query cache.
    return structuredClone(handle(cmd, args))
  })
  document.documentElement.dataset.preview = 'browser'
}
