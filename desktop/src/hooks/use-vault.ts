import { useMemo } from 'react'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import type {
  AccountDetails,
  AccountLink,
  AccountSecretMeta,
  AccountSummary,
  Credential,
  Device,
  DomainRecord,
  Factor,
  Project,
  SecretMeta,
  Service,
  Workspace
} from '@renderer/shared/contracts'
import { api } from '@renderer/lib/api'
import { credentialsService } from '@renderer/lib/credentialsService'
import { domainService } from '@renderer/lib/domainsService'
import { unwrap } from '@renderer/lib/ipc'

export const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base' })

export async function fetchAccounts(): Promise<AccountSummary[]> {
  return unwrap(await api.listAccounts()).accounts
}

/** Every account with its website, no passwords. */
export function useAccounts(): { accounts: AccountSummary[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts })
  return { accounts: data ?? [], isLoading }
}

/** Every website, including those without accounts yet. */
export function useDomains(): { domains: DomainRecord[]; isLoading: boolean } {
  const { data, isLoading } = useQuery<DomainRecord[]>({
    queryKey: ['domains'],
    queryFn: () => domainService.getDomains()
  })
  return { domains: data ?? [], isLoading }
}

/** The decrypted accounts of one website: fetched only when one is being looked at. */
export function useWebsiteCredentials(domainId: number | undefined): {
  credentials: Credential[] | undefined
  isLoading: boolean
  isError: boolean
} {
  const { data, isLoading, isError } = useQuery<Credential[]>({
    queryKey: ['credentials', domainId],
    queryFn: () => credentialsService.getCredentials(domainId!),
    enabled: domainId !== undefined,
    // Plaintext passwords: dropped as soon as nothing shows them.
    gcTime: 0,
    staleTime: 0
  })
  return { credentials: data, isLoading, isError }
}

/** Projects, services and secret/file metadata (never values), in one call. */
export function useWorkspace(): Workspace & { isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: async () => unwrap(await api.loadWorkspace())
  })
  return {
    projects: data?.projects ?? [],
    services: data?.services ?? [],
    secrets: data?.secrets ?? [],
    isLoading
  }
}

const linksQuery = {
  queryKey: ['links'],
  queryFn: async (): Promise<AccountLink[]> => unwrap(await api.listAccountLinks()).links
}

export function useLinks(): AccountLink[] {
  return useQuery(linksQuery).data ?? []
}

/** The links, and whether they have loaded: a form that rewrites links must not start from "none yet". */
export function useLinksState(): { links: AccountLink[]; isSuccess: boolean; isError: boolean } {
  const { data, isSuccess, isError } = useQuery(linksQuery)
  return { links: data ?? [], isSuccess, isError }
}

/** Devices, second steps, account secrets (metadata only) and device links, in one call. */
export function useAccountDetails(): AccountDetails & { isLoading: boolean; isSuccess: boolean; isError: boolean } {
  const { data, isLoading, isSuccess, isError } = useQuery({
    queryKey: ['details'],
    queryFn: async () => unwrap(await api.loadAccountDetails())
  })
  return {
    devices: data?.devices ?? [],
    factors: data?.factors ?? [],
    secrets: data?.secrets ?? [],
    deviceLinks: data?.deviceLinks ?? [],
    isLoading,
    isSuccess,
    isError
  }
}

/** Everything an account connects to, so nothing about it lives only in memory. */
export interface AccountRelations {
  /** Accounts this one signs in with (e.g. Vercel → Google). */
  signsInWith: AccountSummary[]
  /** Accounts that sign in with this one (e.g. Google → Vercel, Coolify). */
  usedBy: AccountSummary[]
  /** Accounts that can recover this one (its recovery email, say). */
  recoveredBy: AccountSummary[]
  /** Accounts this one is the recovery account for. */
  recovers: AccountSummary[]
  /** Services (and their projects) that use this account, and its role there. */
  services: { service: Service; project: Project; role: string }[]
  /** Second steps and recovery codes. */
  factors: Factor[]
  /** Secrets and notes kept with it. */
  secrets: AccountSecretMeta[]
  /** Devices it is signed in on, and what it does there. */
  devices: (Device & { note: string })[]
}

export function useRelations(): (accountId: number) => AccountRelations {
  const { accounts } = useAccounts()
  const links = useLinks()
  const { services, projects } = useWorkspace()
  const { factors, secrets, devices, deviceLinks } = useAccountDetails()
  return useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]))
    const projectById = new Map(projects.map((p) => [p.id, p]))
    const deviceById = new Map(devices.map((d) => [d.id, d]))
    const present = <T,>(value: T | undefined): value is T => value !== undefined
    const linked = (accountId: number, kind: AccountLink['kind'], reverse: boolean): AccountSummary[] =>
      links
        .filter((l) => l.kind === kind && (reverse ? l.linkedAccountId : l.accountId) === accountId)
        .map((l) => byId.get(reverse ? l.accountId : l.linkedAccountId))
        .filter(present)
    return (accountId: number) => ({
      signsInWith: linked(accountId, 'sign_in', false),
      usedBy: linked(accountId, 'sign_in', true),
      recoveredBy: linked(accountId, 'recovery', false),
      recovers: linked(accountId, 'recovery', true),
      services: services.flatMap((service) => {
        const use = service.accounts.find((a) => a.accountId === accountId)
        const project = projectById.get(service.projectId)
        return use && project ? [{ service, project, role: use.role }] : []
      }),
      factors: factors.filter((f) => f.accountId === accountId),
      secrets: secrets.filter((s) => s.accountId === accountId),
      devices: deviceLinks.flatMap((l) => {
        const device = l.accountId === accountId ? deviceById.get(l.deviceId) : undefined
        return device ? [{ ...device, note: l.note }] : []
      })
    })
  }, [accounts, links, services, projects, factors, secrets, devices, deviceLinks])
}

/** What depends on a device: the second steps that live on it and the accounts signed in on it. */
export interface DeviceUsage {
  steps: { factor: Factor; account: AccountSummary }[]
  /** Accounts signed in on it, and what each does there. */
  signedIn: (AccountSummary & { note: string })[]
  /** Accounts whose only second step is on this device, with no recovery codes or recovery account saved. */
  noBackup: AccountSummary[]
}

export function useDeviceUsage(): (deviceId: number) => DeviceUsage {
  const { accounts } = useAccounts()
  const links = useLinks()
  const { factors, deviceLinks } = useAccountDetails()
  return useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]))
    return (deviceId: number) => {
      const steps = factors
        .filter((f) => f.deviceId === deviceId)
        .map((factor) => ({ factor, account: byId.get(factor.accountId) }))
        .filter((s): s is { factor: Factor; account: AccountSummary } => !!s.account)
      const signedIn = deviceLinks.flatMap((l) => {
        const account = l.deviceId === deviceId ? byId.get(l.accountId) : undefined
        return account ? [{ ...account, note: l.note }] : []
      })
      const noBackup = [...new Map(steps.map((s) => [s.account.id, s.account])).values()].filter((account) => {
        const own = factors.filter((f) => f.accountId === account.id)
        const elsewhere = own.some((f) => f.kind === 'recovery_codes' || f.deviceId !== deviceId)
        const recovery = links.some((l) => l.kind === 'recovery' && l.accountId === account.id)
        return !elsewhere && !recovery
      })
      return { steps, signedIn, noBackup }
    }
  }, [accounts, links, factors, deviceLinks])
}

/** After any change: everything derived from accounts, websites, links, projects and account details. */
export function refreshVault(queryClient: QueryClient, domainId?: number): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['domains'] }),
    queryClient.invalidateQueries({ queryKey: ['links'] }),
    queryClient.invalidateQueries({ queryKey: ['workspace'] }),
    queryClient.invalidateQueries({ queryKey: ['details'] }),
    queryClient.invalidateQueries({ queryKey: ['totp'] }),
    domainId !== undefined
      ? queryClient.invalidateQueries({ queryKey: ['credentials', domainId] })
      : queryClient.invalidateQueries({ queryKey: ['credentials'] })
  ])
}

export type ListRow =
  | { kind: 'account'; key: string; title: string; subtitle: string; account: AccountSummary }
  | { kind: 'website'; key: string; title: string; subtitle: string; domain: DomainRecord }

/** The accounts list: every account, plus websites that have none yet. */
export function useListRows(): { rows: ListRow[]; isLoading: boolean } {
  const { accounts, isLoading: loadingAccounts } = useAccounts()
  const { domains, isLoading: loadingDomains } = useDomains()
  const rows = useMemo(() => {
    const list: ListRow[] = accounts.map((account) => ({
      kind: 'account',
      key: `a${account.id}`,
      title: account.domainName,
      subtitle: account.email,
      account
    }))
    for (const domain of domains) {
      if (domain._count.credentials === 0) {
        list.push({ kind: 'website', key: `w${domain.id}`, title: domain.name, subtitle: 'No accounts yet', domain })
      }
    }
    return list.sort((a, b) => byName(a.title, b.title) || byName(a.subtitle, b.subtitle))
  }, [accounts, domains])
  return { rows, isLoading: loadingAccounts || loadingDomains }
}

export function matches(row: ListRow, needle: string): boolean {
  if (!needle) return true
  const haystack =
    row.kind === 'account'
      ? `${row.account.domainName} ${row.account.email} ${row.account.username ?? ''}`
      : row.domain.name
  return haystack.toLowerCase().includes(needle)
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** "google.com" from "https://accounts.google.com/x" (or the text as typed). */
export function hostOf(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, '')
  } catch {
    return trimmed
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export type { SecretMeta }
