/**
 * The rows of an account's page. Every way into the account shares one grid,
 *   [icon] [what] [the value or detail] [actions]
 * so credentials, second steps and recovery read as one list. Secrets are
 * decrypted only when shown, copied or (for notes) looked at.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowCounterClockwise,
  At,
  Eye,
  EyeSlash,
  Key,
  Note,
  Password,
  PencilSimple,
  SignIn,
  Trash,
  UserCircle
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { AccountSecretMeta, AccountSummary, Device, Factor } from '@renderer/shared/contracts'
import { CopyAction } from '@renderer/components/ui/copy'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Spinner } from '@renderer/components/ui/misc'
import { RowMenu, RowMenuItem, RowMenuSeparator } from '@renderer/components/ui/overlays'
import { api } from '@renderer/lib/api'
import { credentialsService } from '@renderer/lib/credentialsService'
import { unwrap } from '@renderer/lib/ipc'
import { formatRelativeTime } from '@renderer/lib/password'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'
import { DEVICES, FACTORS } from './kinds'
import { Chip, IconTile } from './parts'

const WAY_GRID = 'grid grid-cols-[2rem_8.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 min-h-14'
const MASK = '•'.repeat(12)

function Way({
  icon,
  label,
  children,
  actions,
  below
}: {
  icon: Icon
  label: string
  children: ReactNode
  actions?: ReactNode
  /** Revealed content, under the row. */
  below?: ReactNode
}) {
  return (
    <li>
      <div className={WAY_GRID}>
        <IconTile icon={icon} />
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <div className="min-w-0">{children}</div>
        <div className="flex items-center gap-0.5">{actions}</div>
      </div>
      {below && <div className="pr-4 pb-3.5 pl-[11.5rem]">{below}</div>}
    </li>
  )
}

function Plain({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <p data-selectable className={cn('truncate text-[14.5px]', muted ? 'text-muted-foreground' : 'text-heading')}>
      {children}
    </p>
  )
}

function Revealed({ children }: { children: string }) {
  return (
    <pre
      data-selectable
      className="reveal-in max-h-56 overflow-auto rounded-lg border bg-background/60 p-3 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap text-heading dark:bg-background/30"
    >
      {children}
    </pre>
  )
}

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback

// ── credentials ─────────────────────────────────────────────────────────────

export function EmailWay({ account }: { account: AccountSummary }) {
  return (
    <Way icon={At} label="Email" actions={<CopyAction label="Copy email" value={account.email} />}>
      <Plain>{account.email}</Plain>
    </Way>
  )
}

export function UsernameWay({ username }: { username: string }) {
  return (
    <Way icon={UserCircle} label="Username" actions={<CopyAction label="Copy username" value={username} />}>
      <Plain>{username}</Plain>
    </Way>
  )
}

/**
 * The password, decrypted only when shown or copied. The core decrypts the
 * website's accounts together; only this one is kept, and only while shown.
 */
export function PasswordWay({ account }: { account: AccountSummary }) {
  const [shown, setShown] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const decrypt = async (): Promise<string> => {
    const credentials = await credentialsService.getCredentials(account.domainId)
    const credential = credentials.find((c) => c.id === account.id)
    if (!credential) throw new Error('This password could not be decrypted.')
    return credential.password
  }
  const toggle = async (): Promise<void> => {
    if (shown !== null) return setShown(null)
    setBusy(true)
    try {
      setShown(await decrypt())
    } catch (error) {
      toast.error(errorText(error, 'Couldn’t decrypt this password'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Way
      icon={Password}
      label="Password"
      actions={
        <>
          <IconButton
            label={shown !== null ? 'Hide password' : 'Show password'}
            size="icon-sm"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {shown !== null ? <EyeSlash size={15} /> : <Eye size={15} />}
          </IconButton>
          <CopyAction label="Copy password" value={shown ?? decrypt} secret />
        </>
      }
    >
      {shown !== null ? (
        <p data-selectable className="reveal-in truncate font-mono text-[14px] text-heading">
          {shown}
        </p>
      ) : busy ? (
        <Spinner size={14} className="text-muted-foreground" />
      ) : (
        <p className="truncate font-mono text-[14px] tracking-[0.12em] text-muted-foreground">{MASK}</p>
      )}
    </Way>
  )
}

export function NoPasswordWay() {
  return (
    <Way icon={Password} label="Password">
      <Plain muted>None. It signs in another way.</Plain>
    </Way>
  )
}

/** Accounts as chips that open them (sign in with, recovery account). */
export function AccountsWay({ icon, label, accounts }: { icon: Icon; label: string; accounts: AccountSummary[] }) {
  const navigate = useNavigate()
  return (
    <Way icon={icon} label={label}>
      <div className="flex flex-wrap gap-1.5">
        {accounts.map((a) => (
          <Chip
            key={a.id}
            item={{ key: `${a.id}`, title: a.domainName, detail: a.email, onOpen: () => navigate(`/accounts/${a.id}`) }}
          />
        ))}
      </div>
    </Way>
  )
}

export const SignInWithWay = (props: { accounts: AccountSummary[] }) => (
  <AccountsWay icon={SignIn} label="Signs in with" accounts={props.accounts} />
)
export const RecoveryAccountWay = (props: { accounts: AccountSummary[] }) => (
  <AccountsWay icon={ArrowCounterClockwise} label="Recovery account" accounts={props.accounts} />
)

// ── second steps and recovery codes ─────────────────────────────────────────

/** Re-renders every second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** The current authenticator code, fetched again as each one expires. */
function LiveCode({ factorId }: { factorId: number }) {
  const now = useNow()
  const { data, isError } = useQuery({
    queryKey: ['totp', factorId],
    queryFn: async () => unwrap(await api.factorCode(factorId)),
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt
      return expiresAt ? Math.max(expiresAt - Date.now(), 0) + 80 : false
    },
    refetchIntervalInBackground: false,
    gcTime: 0,
    staleTime: 0
  })
  if (isError) return <Plain muted>The setup key can’t make codes</Plain>
  if (!data) return <Spinner size={14} className="text-muted-foreground" />
  const left = Math.max(0, Math.ceil((data.expiresAt - now) / 1000))
  const half = Math.ceil(data.code.length / 2)
  const radius = 7
  const circumference = 2 * Math.PI * radius
  return (
    <div className="flex items-center gap-3">
      <span data-selectable className="font-mono text-[18px] tracking-[0.06em] text-heading tabular-nums">
        {data.code.slice(0, half)}
        <span className="inline-block w-2" />
        {data.code.slice(half)}
      </span>
      <span
        className={cn('flex items-center gap-1.5 text-[12px] tabular-nums', left <= 5 ? 'text-warning' : 'text-muted-foreground')}
        title={`Changes in ${left} s`}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" className="-rotate-90">
          <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - left / data.period)}
            className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
          />
        </svg>
        {left}s
      </span>
    </div>
  )
}

/** "Google Authenticator, on iPhone" */
function factorDetail(factor: Factor, device: Device | undefined): string {
  return [factor.label, device && `on ${device.name}`].filter(Boolean).join(', ')
}

export function FactorWay({
  factor,
  device,
  onEdit,
  onDelete,
  onOpenDevice
}: {
  factor: Factor
  device: Device | undefined
  onEdit: () => void
  onDelete: () => void
  onOpenDevice: (deviceId: number) => void
}) {
  const meta = FACTORS[factor.kind]
  const [shown, setShown] = useState<string | null>(null)
  const reveal = async (): Promise<string> => unwrap(await api.revealFactor(factor.id)).value
  const toggle = async (): Promise<void> => {
    if (shown !== null) return setShown(null)
    try {
      setShown(await reveal())
    } catch (error) {
      toast.error(errorText(error, 'Couldn’t decrypt it'))
    }
  }
  const codes = factor.kind === 'recovery_codes'
  const live = factor.kind === 'authenticator' && factor.hasSecret
  const detail = factorDetail(factor, device)

  return (
    <Way
      icon={meta.icon}
      label={meta.name}
      actions={
        <>
          {codes && factor.hasSecret && (
            <>
              <IconButton label={shown !== null ? 'Hide codes' : 'Show codes'} size="icon-sm" onClick={() => void toggle()}>
                {shown !== null ? <EyeSlash size={15} /> : <Eye size={15} />}
              </IconButton>
              <CopyAction label="Copy codes" value={reveal} secret />
            </>
          )}
          {live && (
            <CopyAction label="Copy code" value={async () => unwrap(await api.factorCode(factor.id)).code} secret />
          )}
          <RowMenu label={`More actions for the ${meta.name.toLowerCase()}`}>
            <RowMenuItem icon={PencilSimple} onClick={onEdit}>
              Edit
            </RowMenuItem>
            {live && (
              <RowMenuItem icon={Key} onClick={() => void toggle()}>
                {shown !== null ? 'Hide setup key' : 'Show setup key'}
              </RowMenuItem>
            )}
            {device && (
              <RowMenuItem icon={DEVICES[device.kind].icon} onClick={() => onOpenDevice(device.id)}>
                Open {device.name}
              </RowMenuItem>
            )}
            <RowMenuSeparator />
            <RowMenuItem icon={Trash} tone="destructive" onClick={onDelete}>
              Remove
            </RowMenuItem>
          </RowMenu>
        </>
      }
      below={shown !== null ? <Revealed>{shown}</Revealed> : undefined}
    >
      {live ? (
        <div className="min-w-0">
          <LiveCode factorId={factor.id} />
          {detail && <p className="truncate text-[12.5px] text-muted-foreground">{detail}</p>}
        </div>
      ) : codes ? (
        <Plain muted={!factor.hasSecret}>
          {factor.hasSecret ? 'Saved, encrypted' : 'Not saved'}
          {factor.label && <span className="text-muted-foreground">, also {factor.label}</span>}
        </Plain>
      ) : (
        <Plain muted={!detail}>{detail || 'No details'}</Plain>
      )}
    </Way>
  )
}

// ── secrets and notes ───────────────────────────────────────────────────────

export function AccountSecretRow({
  secret,
  onEdit,
  onDelete
}: {
  secret: AccountSecretMeta
  onEdit: () => void
  onDelete: () => void
}) {
  const note = secret.kind === 'note'
  const [shown, setShown] = useState(false)
  // A note is read where it is shown; a secret only when asked.
  const { data: value, isError } = useQuery({
    // `shown` in the key: hiding a secret leaves its cache entry unwatched, so it is dropped.
    queryKey: ['account-secret', secret.id, secret.updatedAt, note || shown],
    queryFn: async () => unwrap(await api.revealAccountSecret(secret.id)).value,
    enabled: note || shown,
    gcTime: 0,
    staleTime: Infinity
  })
  const reveal = async (): Promise<string> => value ?? unwrap(await api.revealAccountSecret(secret.id)).value
  // A note's first line, shown after its name while it is closed.
  const preview = note && value ? value.split('\n').find((line) => line.trim())?.trim() : undefined
  const edited = formatRelativeTime(secret.updatedAt).toLowerCase()

  return (
    <li className="group">
      {/* One 44 px line, like every long list; a note opens in place (its name is the toggle),
          a secret's value only with the eye. */}
      <div className="flex h-11 items-center gap-3 pr-2 pl-4 transition-colors duration-100 hover:bg-secondary/40">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-secondary text-muted-foreground dark:bg-white/8">
          {note ? <Note size={13} /> : <Key size={13} />}
        </span>
        {note ? (
          <button
            type="button"
            aria-expanded={shown}
            onClick={() => setShown(!shown)}
            className="min-w-0 flex-1 cursor-pointer truncate text-left outline-none focus-visible:underline"
          >
            <span className="text-[14px] text-heading">{secret.name}</span>
            {preview && !shown && <span className="ml-2 text-[13px] text-muted-foreground">{preview}</span>}
          </button>
        ) : (
          <p className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-heading" data-selectable>
            {secret.name}
          </p>
        )}
        <span className="hidden w-32 shrink-0 truncate text-right text-[12.5px] text-muted-foreground tabular-nums @min-[44rem]:block">
          {note ? 'Note' : 'Secret'} · {edited}
        </span>
        <div
          className={cn(
            'flex w-[3.625rem] shrink-0 items-center justify-end gap-0.5 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100',
            shown ? 'opacity-100' : 'opacity-0'
          )}
        >
          {!note && (
            <IconButton label={shown ? 'Hide value' : 'Show value'} size="icon-sm" onClick={() => setShown(!shown)}>
              {shown ? <EyeSlash size={15} /> : <Eye size={15} />}
            </IconButton>
          )}
          <CopyAction label={note ? 'Copy note' : 'Copy value'} value={reveal} secret={!note} />
        </div>
        <RowMenu label={`More actions for ${secret.name}`}>
          <RowMenuItem icon={PencilSimple} onClick={onEdit}>
            Edit
          </RowMenuItem>
          <RowMenuSeparator />
          <RowMenuItem icon={Trash} tone="destructive" onClick={onDelete}>
            Delete
          </RowMenuItem>
        </RowMenu>
      </div>
      {shown && (
        <div className="pr-4 pb-3.5 pl-[3.25rem]">
          {isError ? (
            <p className="text-[13px] text-muted-foreground">Couldn’t decrypt this.</p>
          ) : value === undefined ? (
            <Spinner size={14} className="text-muted-foreground" />
          ) : note ? (
            <p data-selectable className="text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">
              {value}
            </p>
          ) : (
            <Revealed>{value}</Revealed>
          )}
        </div>
      )}
    </li>
  )
}
