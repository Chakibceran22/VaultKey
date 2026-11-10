import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CaretRight,
  DownloadSimple,
  Eye,
  EyeSlash,
  File,
  FileImage,
  FileLock,
  FileText,
  Key,
  PencilSimple,
  Trash,
  UserCircle
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSummary, SecretMeta, Service } from '@renderer/shared/contracts'
import { Expand } from '@renderer/components/accounts/parts'
import { CopyAction } from '@renderer/components/ui/copy'
import { IconButton } from '@renderer/components/ui/icon-button'
import { SiteTile } from '@renderer/components/ui/misc'
import { RowMenu, RowMenuItem, RowMenuSeparator } from '@renderer/components/ui/overlays'
import { formatSize, hostOf } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { credentialsService } from '@renderer/lib/credentialsService'
import { unwrap } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/password'
import { toast } from '@renderer/lib/toast'

/** An account a service uses, its role there, and what it signs in with (if anything). */
export interface ServiceAccountView {
  account: AccountSummary
  role: string
  via: AccountSummary | undefined
}

/** The copy buttons' slot: room for two, whatever a row has to copy. */
const COPIES = 'flex w-[3.625rem] shrink-0 items-center justify-end gap-0.5'

/**
 * A service, built to stay readable at 30–40 per project: one 44 px line (name and
 * address, the main account and how many more), copies on hover or focus, and
 * everything else one click away, expanded in place: every account with its role
 * and its own copies, and the secrets and files kept for it.
 */
export function ServiceRow({
  service,
  accounts,
  kept,
  expanded,
  onToggle,
  onEdit,
  onDelete
}: {
  service: Service
  accounts: ServiceAccountView[]
  /** Its secrets and files. */
  kept: SecretMeta[]
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [main] = accounts
  const more = accounts.length - 1
  const host = hostOf(service.url)

  // Decrypted only when copied.
  const passwordOf = (account: AccountSummary) => async (): Promise<string> => {
    const credentials = await queryClient.fetchQuery({
      queryKey: ['credentials', account.domainId],
      queryFn: () => credentialsService.getCredentials(account.domainId)
    })
    const credential = credentials.find((c) => c.id === account.id)
    if (!credential) throw new Error('This password could not be decrypted.')
    return credential.password
  }
  const copies = (view: ServiceAccountView) => (
    <>
      <CopyAction label={`Copy ${view.account.domainName} email`} value={view.account.email} />
      {!view.via && <CopyAction label={`Copy ${view.account.domainName} password`} value={passwordOf(view.account)} secret />}
    </>
  )

  return (
    <li className={cn('group transition-colors duration-100', expanded && 'bg-secondary/30')}>
      {/* Fixed-width slots after the button (copies, menu, chevron), so every row's
          columns line up whatever it has to copy. */}
      <div className="flex h-11 items-center pr-2 transition-colors duration-100 hover:bg-secondary/40">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="grid h-full min-w-0 flex-1 cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 pl-4 text-left outline-none focus-visible:bg-secondary/60"
        >
          <SiteTile name={service.name} size="sm" className="size-6 rounded-[7px] text-[11px]" />
          <span className="truncate">
            <span className="text-[14px] font-medium text-heading">{service.name}</span>
            {host && <span className="ml-2 text-[13px] text-muted-foreground">{host}</span>}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
            {main ? (
              <>
                <span className="truncate text-foreground">{main.account.email}</span>
                {more > 0 && (
                  <span className="shrink-0 rounded-md bg-secondary px-1.5 text-[11.5px] leading-5 text-muted-foreground tabular-nums dark:bg-white/8">
                    +{more}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-muted-foreground/70">No account linked</span>
            )}
          </span>
        </button>
        <div className={`${COPIES} opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100`}>
          {main && copies(main)}
        </div>
        <div className="flex shrink-0 items-center">
          <RowMenu label={`More actions for ${service.name}`}>
            <RowMenuItem icon={PencilSimple} onClick={onEdit}>
              Edit service
            </RowMenuItem>
            {main && (
              <RowMenuItem icon={UserCircle} onClick={() => navigate(`/accounts/${main.account.id}`)}>
                Open account
              </RowMenuItem>
            )}
            <RowMenuSeparator />
            <RowMenuItem icon={Trash} tone="destructive" onClick={onDelete}>
              Delete service
            </RowMenuItem>
          </RowMenu>
        </div>
        {/* A second way to the same toggle, for the pointer; the button above is the accessible one. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={onToggle}
          className="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center"
        >
          <CaretRight
            size={12}
            weight="bold"
            className={cn(
              'text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              expanded && 'rotate-90 text-foreground'
            )}
          />
        </button>
      </div>
      <Expand open={expanded}>
        <div className="space-y-1 pr-2 pb-3 pl-[3.25rem]">
          {accounts.map((view) => (
            <div key={view.account.id} className="flex items-center gap-0 py-1">
              <button
                type="button"
                onClick={() => navigate(`/accounts/${view.account.id}`)}
                className="min-w-0 flex-1 cursor-pointer text-left"
              >
                <p className="truncate text-[13.5px] text-heading hover:underline">{view.account.email}</p>
                <p className="truncate text-[12.5px] text-muted-foreground">
                  {[view.via ? `${view.account.domainName}, via ${view.via.domainName}` : view.account.domainName, view.role]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </button>
              <div className={COPIES}>{copies(view)}</div>
              {/* Under the menu and the chevron. */}
              <span aria-hidden="true" className="w-[3.25rem] shrink-0" />
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="py-1 text-[13px] text-muted-foreground">
              No account linked.{' '}
              <button type="button" onClick={onEdit} className="cursor-pointer text-primary hover:underline">
                Link one
              </button>
            </p>
          )}
          {kept.length > 0 && (
            <p className="truncate pt-1 text-[12.5px] text-muted-foreground">
              Keeps <span className="font-mono text-foreground/85">{kept.map((k) => k.name).join(', ')}</span>
            </p>
          )}
        </div>
      </Expand>
    </li>
  )
}

function fileIcon(secret: SecretMeta): Icon {
  if (secret.kind === 'text') return Key
  if (secret.mimeType.startsWith('image/')) return FileImage
  if (secret.mimeType === 'application/x-pem-file' || secret.mimeType === 'application/pgp-encrypted') return FileLock
  if (secret.mimeType.startsWith('text/') || secret.mimeType === 'application/json') return FileText
  return File
}

/** A text secret or a file. Values are decrypted only when shown, copied or saved. */
export function SecretRow({
  secret,
  serviceName,
  onEdit,
  onDelete
}: {
  secret: SecretMeta
  serviceName: string | undefined
  onEdit: () => void
  onDelete: () => void
}) {
  const [shown, setShown] = useState<string | null>(null)
  const RowIcon = fileIcon(secret)
  const isFile = secret.kind === 'file'
  const reveal = async (): Promise<string> => unwrap(await api.revealSecret(secret.id)).value

  const toggleShown = async (): Promise<void> => {
    if (shown !== null) {
      setShown(null)
      return
    }
    try {
      setShown(await reveal())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t decrypt this secret')
    }
  }

  const save = async (): Promise<void> => {
    try {
      const { saved } = unwrap(await api.exportSecret(secret.id))
      if (saved) toast.success(`Saved a decrypted copy of “${secret.name}”`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the file')
    }
  }

  const where = serviceName ?? 'Whole project'
  const open = shown !== null
  return (
    <li className="group">
      {/* One 44 px line, columns in fixed slots so every row lines up. */}
      <div className="flex h-11 items-center gap-3 pr-2 pl-4 transition-colors duration-100 hover:bg-secondary/40">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-secondary text-muted-foreground dark:bg-white/8">
          <RowIcon size={13} />
        </span>
        <p className="min-w-0 flex-1 truncate" title={secret.description || undefined}>
          <span className="font-mono text-[13.5px] text-heading" data-selectable>
            {secret.name}
          </span>
          {secret.description && <span className="ml-2 text-[13px] text-muted-foreground">{secret.description}</span>}
        </p>
        <span className="hidden w-44 shrink-0 truncate text-right text-[12.5px] text-muted-foreground tabular-nums @min-[44rem]:block">
          {isFile ? `${formatSize(secret.size)} · ${where}` : where} · {formatRelativeTime(secret.updatedAt).toLowerCase()}
        </span>
        <div
          className={cn(
            'flex w-[5.375rem] shrink-0 items-center justify-end gap-0.5 transition-opacity duration-100 group-hover:opacity-100 focus-within:opacity-100',
            open ? 'opacity-100' : 'opacity-0'
          )}
        >
          <IconButton label={open ? 'Hide' : isFile ? 'Show contents' : 'Show value'} size="icon-sm" onClick={() => void toggleShown()}>
            {open ? <EyeSlash size={15} /> : <Eye size={15} />}
          </IconButton>
          <CopyAction label={isFile ? 'Copy contents' : 'Copy value'} value={reveal} secret />
          {isFile && (
            <IconButton label="Save a decrypted copy" size="icon-sm" onClick={() => void save()}>
              <DownloadSimple size={15} />
            </IconButton>
          )}
        </div>
        <RowMenu label={`More actions for ${secret.name}`}>
          <RowMenuItem icon={PencilSimple} onClick={onEdit}>
            {isFile ? 'Rename or move' : 'Edit secret'}
          </RowMenuItem>
          {!isFile && (
            <RowMenuItem icon={DownloadSimple} onClick={() => void save()}>
              Save as a file
            </RowMenuItem>
          )}
          <RowMenuSeparator />
          <RowMenuItem icon={Trash} tone="destructive" onClick={onDelete}>
            {isFile ? 'Delete file' : 'Delete secret'}
          </RowMenuItem>
        </RowMenu>
      </div>
      {shown !== null && (
        <div className="pr-4 pb-3 pl-[3.25rem]">
          <pre
            data-selectable
            className="reveal-in max-h-56 overflow-auto rounded-lg border bg-background/60 p-3 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap text-heading dark:bg-background/30"
          >
            {shown}
          </pre>
        </div>
      )}
    </li>
  )
}
