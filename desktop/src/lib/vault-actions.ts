/**
 * Multi-step saves, each one a single user action: an account (website created
 * on demand, then the account, then its sign-in links) and a service (its new
 * account first, when it has one).
 */
import type { QueryClient } from '@tanstack/react-query'
import type { AccountSummary, DeviceLinkInput, DomainRecord, ServiceAccount } from '@renderer/shared/contracts'
import { refreshVault } from '@renderer/hooks/use-vault'
import { api } from './api'
import { credentialsService } from './credentialsService'
import { domainService } from './domainsService'
import { unwrap } from './ipc'
import { toast } from './toast'

/** Same rule as the Rust core (validation.rs), checked before anything is created. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface AccountDraft {
  website: string
  username: string
  email: string
  /**
   * A password of its own, "Sign in with Google" style links to other accounts,
   * or nothing to type at all (passkey-only, or an account that only keeps keys).
   */
  method: 'password' | 'linked' | 'none'
  password: string
  /** The group it is shown in; '' lets the app guess from the website. */
  category: string
  signInWith: number[]
  /** Accounts that can recover this one (its recovery email). */
  recoveryBy: number[]
  /** Devices it is signed in on, each with what it does there. */
  devices: DeviceLinkInput[]
}

export function emptyAccountDraft(website = ''): AccountDraft {
  return {
    website,
    username: '',
    email: '',
    method: 'password',
    password: '',
    category: '',
    signInWith: [],
    recoveryBy: [],
    devices: []
  }
}

/** Links and devices, saved after the account itself, all together or not at all. */
async function saveConnections(accountId: number, draft: AccountDraft): Promise<void> {
  unwrap(
    await api.setAccountConnections(accountId, {
      // With a password, "Sign in with" links can be kept too.
      signIn: draft.method === 'none' ? [] : draft.signInWith,
      recovery: draft.recoveryBy,
      devices: draft.devices.map((d) => ({ deviceId: d.deviceId, note: d.note.trim() }))
    })
  )
}

function checkDraft(draft: AccountDraft, requireWebsite: boolean): void {
  if (requireWebsite && !draft.website.trim()) throw new Error('Enter the website.')
  if (!EMAIL.test(draft.email)) throw new Error('Enter a valid email.')
  if (draft.method === 'password' && !draft.password) {
    throw new Error('Enter the password, or choose an account it signs in with.')
  }
  if (draft.method === 'linked' && draft.signInWith.length === 0) {
    throw new Error('Choose the account it signs in with.')
  }
}

export async function createAccount(
  queryClient: QueryClient,
  domains: DomainRecord[],
  draft: AccountDraft
): Promise<number> {
  checkDraft(draft, true)
  const name = draft.website.trim()
  const existing = domains.find((d) => d.name.toLowerCase() === name.toLowerCase())
  const domainId = existing?.id ?? (await domainService.registerDomain(name))
  let id: number
  try {
    id = await credentialsService.createCredential({
      domainId,
      username: draft.username,
      email: draft.email,
      password: draft.method === 'password' ? draft.password : ''
    })
  } catch (error) {
    // Don't leave an empty website behind for an account that failed.
    if (!existing) await domainService.deleteDomain(domainId).catch(() => {})
    throw error
  }
  try {
    await saveConnections(id, draft)
    if (draft.category) unwrap(await api.setAccountCategory(id, draft.category))
  } catch (error) {
    // The account itself is saved: report the links, don't fail (a retry would
    // try to create the same account again).
    const reason = error instanceof Error && error.message ? error.message : 'they could not be saved'
    toast.error(`Account saved, but not its group, links and devices: ${reason}`)
  } finally {
    await refreshVault(queryClient, domainId)
  }
  return id
}

export async function updateAccount(
  queryClient: QueryClient,
  account: AccountSummary,
  draft: AccountDraft
): Promise<void> {
  checkDraft(draft, false)
  await credentialsService.updateCredential(account.id, {
    username: draft.username,
    email: draft.email,
    password: draft.method === 'password' ? draft.password : ''
  })
  try {
    await saveConnections(account.id, draft)
    if (draft.category !== (account.category ?? '')) {
      unwrap(await api.setAccountCategory(account.id, draft.category || null))
    }
  } finally {
    await refreshVault(queryClient, account.domainId)
  }
}

/** A login being edited in the service form. */
export interface LoginDraft {
  /** Keys the row while it has no id. */
  key: string
  id: number | null
  username: string
  /** Typed here. Empty keeps a saved one. */
  password: string
  hasPassword: boolean
  note: string
}

export interface ServiceDraft {
  name: string
  url: string
  /** The vault's accounts it uses, in order, each with its role there. Empty: none yet. */
  accounts: ServiceAccount[]
  /** Its own logins, for what has no account in the vault (a server's root user). */
  logins: LoginDraft[]
  /** Also create a new account for it (added after the chosen ones). */
  creating: boolean
  newAccount: AccountDraft
  newRole: string
}

export async function saveService(
  queryClient: QueryClient,
  domains: DomainRecord[],
  projectId: number,
  serviceId: number | null,
  draft: ServiceDraft,
  /** Called once the new account exists, so a retry uses it instead of creating it again. */
  onAccountCreated?: (accountId: number) => void
): Promise<void> {
  if (!draft.name.trim()) throw new Error('Enter the service name.')
  const accounts = draft.accounts.map((a) => ({ accountId: a.accountId, role: a.role.trim() }))
  if (draft.creating) {
    const accountId = await createAccount(queryClient, domains, draft.newAccount)
    onAccountCreated?.(accountId)
    accounts.push({ accountId, role: draft.newRole.trim() })
  }
  const logins = draft.logins
    // A row added and left blank is just dropped.
    .filter((l) => l.id !== null || l.username.trim() || l.password || l.note.trim())
    .map((l) => ({ id: l.id ?? undefined, username: l.username, password: l.password || undefined, note: l.note.trim() }))
  const input = { name: draft.name, url: draft.url, accounts, logins }
  if (serviceId) unwrap(await api.updateService(serviceId, input))
  else unwrap(await api.createService(projectId, input))
  await refreshVault(queryClient)
}
