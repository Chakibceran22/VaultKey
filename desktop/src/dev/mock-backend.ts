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
  { id: 10, name: 'proton.me', createdAt: iso(100), updatedAt: iso(5) }
]

const credentials: MockCredential[] = [
  { id: 1, domainId: 1, username: 'alex-dev', email: 'alex@example.com', password: 'gh-Xr7!qLm2#vTp9' },
  { id: 2, domainId: 1, username: null, email: 'work@example.com', password: 'Tq8$zN1u@Kc5wYe3' },
  { id: 3, domainId: 2, username: 'alex', email: 'alex@example.com', password: '' },
  { id: 4, domainId: 3, username: null, email: 'alex@example.com', password: 'lin-7Hq#2Vb9' },
  { id: 5, domainId: 4, username: 'alexd', email: 'alex@example.com', password: '' },
  { id: 6, domainId: 6, username: null, email: 'billing@example.com', password: 'St9#qW2eR7tY!u' },
  { id: 7, domainId: 7, username: null, email: 'alex.martin@gmail.com', password: 'G0og!e-Qz82#kLp' },
  { id: 8, domainId: 7, username: null, email: 'alex.work@gmail.com', password: 'password123' },
  { id: 9, domainId: 7, username: null, email: 'alex.shop@gmail.com', password: 'Wq7!nB3#xP0s' },
  { id: 10, domainId: 8, username: null, email: 'alex@icloud.com', password: 'Ap9#Lm2!qW7e' },
  { id: 11, domainId: 9, username: 'alexd#4821', email: 'alex@example.com', password: 'Dc5!zX8@vN1m' },
  { id: 12, domainId: 10, username: null, email: 'alex@proton.me', password: 'Pr0t#9Vn!2Qx' },
  { id: 13, domainId: 10, username: null, email: 'alex.backup@proton.me', password: 'Bk7@pR2#mL9z' }
]


// ── projects, services, secrets, links (schema v2) ──
const projects = [
  { id: 1, name: 'Acme Store', description: 'Shop rebuild on Next.js, self-hosted on Hetzner.', createdAt: iso(40), updatedAt: iso(2) },
  { id: 2, name: 'Portfolio', description: 'Personal site and blog.', createdAt: iso(90), updatedAt: iso(30) },
  { id: 3, name: 'Side quest', description: '', createdAt: iso(5), updatedAt: iso(5) }
]
const services = [
  { id: 1, projectId: 1, name: 'Coolify', url: 'https://coolify.acme.dev', accountId: 7 as number | null, createdAt: iso(40), updatedAt: iso(3) },
  { id: 2, projectId: 1, name: 'Vercel', url: 'https://vercel.com/acme', accountId: 5 as number | null, createdAt: iso(39), updatedAt: iso(9) },
  { id: 3, projectId: 1, name: 'Supabase', url: 'https://supabase.com/dashboard/project/acme', accountId: null as number | null, createdAt: iso(38), updatedAt: iso(12) },
  { id: 4, projectId: 2, name: 'GitHub Pages', url: 'https://github.com/alex/site', accountId: 1 as number | null, createdAt: iso(90), updatedAt: iso(30) }
]
const secretValues = new Map<number, string>([
  [1, 'sk_live_51Hx0aBcDeFgHiJkLmNoPqRsTuVwXyZ'],
  [2, 'postgres://acme:R7q!vP2@db.acme.dev:5432/shop'],
  [3, 're_9xY2kLmN4pQ7rS1t'],
  [4, '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBpreview0nly0made0up0key0material0here0nothing0real0AAAA\n-----END OPENSSH PRIVATE KEY-----'],
  [5, 'DATABASE_URL=postgres://localhost/acme\nSTRIPE_KEY=sk_test_123\n']
])
const secrets = [
  { id: 1, projectId: 1, serviceId: null as number | null, kind: 'text', name: 'STRIPE_SECRET_KEY', mimeType: 'text/plain', size: 32, createdAt: iso(30), updatedAt: iso(4) },
  { id: 2, projectId: 1, serviceId: 3 as number | null, kind: 'text', name: 'DATABASE_URL', mimeType: 'text/plain', size: 46, createdAt: iso(30), updatedAt: iso(12) },
  { id: 3, projectId: 1, serviceId: null as number | null, kind: 'text', name: 'RESEND_API_KEY', mimeType: 'text/plain', size: 18, createdAt: iso(20), updatedAt: iso(20) },
  { id: 4, projectId: 1, serviceId: 1 as number | null, kind: 'file', name: 'id_ed25519', mimeType: 'application/octet-stream', size: 411, createdAt: iso(25), updatedAt: iso(25) },
  { id: 5, projectId: 1, serviceId: null as number | null, kind: 'file', name: 'production.env', mimeType: 'text/plain', size: 64, createdAt: iso(10), updatedAt: iso(10) },
  { id: 6, projectId: 1, serviceId: null as number | null, kind: 'file', name: 'logo.png', mimeType: 'image/png', size: 48213, createdAt: iso(8), updatedAt: iso(8) }
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
  [2, 'Recovery email is the Gmail account. The SSH key for pushes lives on the MacBook.\nOrg owner of alex-labs.'],
  [3, 'vc_preview_0nly_made_up']
])
const deviceLinks = [
  { accountId: 1, deviceId: 2 },
  { accountId: 1, deviceId: 1 },
  { accountId: 7, deviceId: 1 },
  { accountId: 7, deviceId: 2 },
  { accountId: 7, deviceId: 4 },
  { accountId: 10, deviceId: 1 },
  { accountId: 10, deviceId: 2 },
  { accountId: 10, deviceId: 4 }
]

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

function removeWhere<T>(list: T[], test: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) list.splice(i, 1)
}
let nextId = 100

let nextDomainId = 11
let nextCredentialId = 14

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

function handle(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'vault_status':
      return { status: 'NEEDS_LOGIN' }
    case 'create_vault':
      return null
    case 'unlock_vault':
      return { valid: args.masterPassword !== 'wrong' }
    case 'lock_vault':
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
      return null
    }
    case 'load_workspace':
      return { projects, services, secrets }
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
      const input = args.input as { name: string; url?: string; accountId?: number | null }
      const id = nextId++
      services.push({ id, projectId: args.projectId as number, name: input.name, url: input.url ?? '', accountId: input.accountId ?? null, createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_service': {
      const service = services.find((x) => x.id === args.serviceId)
      if (!service) fail('NOT_FOUND', 'Service not found.')
      Object.assign(service, args.input as object, { updatedAt: iso(0) })
      return null
    }
    case 'delete_service': {
      const at = services.findIndex((x) => x.id === args.serviceId)
      services.splice(at, 1)
      return null
    }
    case 'create_secret': {
      const input = args.input as { name: string; value: string; serviceId?: number | null }
      const id = nextId++
      secretValues.set(id, input.value)
      secrets.push({ id, projectId: args.projectId as number, serviceId: input.serviceId ?? null, kind: 'text', name: input.name, mimeType: 'text/plain', size: input.value.length, createdAt: iso(0), updatedAt: iso(0) })
      return { id }
    }
    case 'update_secret': {
      const secret = secrets.find((x) => x.id === args.secretId)
      if (!secret) fail('NOT_FOUND', 'Secret not found.')
      const input = args.input as { name: string; serviceId?: number | null; value?: string }
      secret.name = input.name
      secret.serviceId = input.serviceId ?? null
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
    case 'import_files':
    case 'import_dropped_files': {
      const id = nextId++
      secretValues.set(id, 'preview file')
      secrets.push({ id, projectId: args.projectId as number, serviceId: null, kind: 'file', name: `cert-${id}.pem`, mimeType: 'application/x-pem-file', size: 1834, createdAt: iso(0), updatedAt: iso(0) })
      return { imported: [id], skipped: [] }
    }
    case 'export_secret':
      return { saved: true }
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
      for (const deviceId of args.deviceIds as number[]) deviceLinks.push({ accountId, deviceId })
      return null
    }
    case 'set_account_devices': {
      removeWhere(deviceLinks, (l) => l.accountId === args.accountId)
      for (const deviceId of args.deviceIds as number[]) deviceLinks.push({ accountId: args.accountId as number, deviceId })
      return null
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
