import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
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
import { CopyAction } from '@renderer/components/ui/copy'
import { IconButton } from '@renderer/components/ui/icon-button'
import { SiteTile } from '@renderer/components/ui/misc'
import { RowMenu, RowMenuItem, RowMenuSeparator } from '@renderer/components/ui/overlays'
import { formatSize, hostOf } from '@renderer/hooks/use-vault'
import { api } from '@renderer/lib/api'
import { credentialsService } from '@renderer/lib/credentialsService'
import { unwrap } from '@renderer/lib/ipc'
import { formatRelativeTime } from '@renderer/lib/password'
import { toast } from '@renderer/lib/toast'

const ROW = 'grid items-center gap-x-4 px-4 py-3'

/** An account a service uses, its role there, and what it signs in with (if anything). */
export interface ServiceAccountView {
  account: AccountSummary
  role: string
  via: AccountSummary | undefined
}

const COLUMNS = 'grid-cols-[2rem_minmax(0,5fr)_minmax(0,6fr)_6.5rem]'

/**
 * A service: its address, the accounts it uses (the main one first, each with its
 * role there), and quick copies for each.
 */
export function ServiceRow({
  service,
  accounts,
  onEdit,
  onDelete
}: {
  service: Service
  accounts: ServiceAccountView[]
  onEdit: () => void
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [main, ...others] = accounts

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
  const detail = ({ account, role, via }: ServiceAccountView): string =>
    [via ? `${account.domainName}, via ${via.domainName}` : account.domainName, role].filter(Boolean).join(' · ')
  const accountCell = (view: ServiceAccountView, small = false) => (
    <button
      type="button"
      onClick={() => navigate(`/accounts/${view.account.id}`)}
      className="min-w-0 cursor-pointer text-left"
      title={view.role || undefined}
    >
      <p className={`truncate text-heading hover:underline ${small ? 'text-[13.5px]' : 'text-[14px]'}`}>{view.account.email}</p>
      <p className={`truncate text-muted-foreground ${small ? 'text-[12.5px]' : 'text-[13px]'}`}>{detail(view)}</p>
    </button>
  )
  const copies = (view: ServiceAccountView) => (
    <>
      <CopyAction label={`Copy ${view.account.domainName} email`} value={view.account.email} />
      {!view.via && <CopyAction label={`Copy ${view.account.domainName} password`} value={passwordOf(view.account)} secret />}
    </>
  )

  return (
    <li>
      <div className={`${ROW} ${COLUMNS}`}>
        <SiteTile name={service.name} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-[14.5px] font-medium text-heading">{service.name}</p>
          <p className="truncate text-[13px] text-muted-foreground">{hostOf(service.url) || 'No address'}</p>
        </div>
        {main ? accountCell(main) : <p className="text-[13.5px] text-muted-foreground">No account linked</p>}
        <div className="flex items-center justify-end gap-0.5">
          {main && copies(main)}
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
      </div>
      {others.map((view) => (
        <div key={view.account.id} className={`grid items-center gap-x-4 px-4 pb-2.5 ${COLUMNS}`}>
          <span />
          <span />
          {accountCell(view, true)}
          <div className="flex items-center justify-end gap-0.5 pr-8">{copies(view)}</div>
        </div>
      ))}
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
  return (
    <li>
      <div className={`${ROW} grid-cols-[2rem_minmax(0,1fr)_auto_auto]`}>
        <span className="flex size-8 items-center justify-center rounded-[9px] bg-secondary text-muted-foreground">
          <RowIcon size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate font-mono text-[13.5px] text-heading" data-selectable>
            {secret.name}
          </p>
          {secret.description && (
            <p className="truncate text-[12.5px] text-foreground/80" title={secret.description}>
              {secret.description}
            </p>
          )}
          <p className="truncate text-[12.5px] text-muted-foreground">
            {isFile ? `${formatSize(secret.size)}, ${serviceName ?? 'whole project'}` : where}
          </p>
        </div>
        <span className="hidden text-[12.5px] text-muted-foreground tabular-nums @min-[40rem]:inline">
          {isFile ? 'Added' : 'Edited'} {formatRelativeTime(secret.updatedAt).toLowerCase()}
        </span>
        <div className="flex items-center gap-0.5">
          <IconButton label={shown !== null ? 'Hide' : isFile ? 'Show contents' : 'Show value'} size="icon-sm" onClick={() => void toggleShown()}>
            {shown !== null ? <EyeSlash size={15} /> : <Eye size={15} />}
          </IconButton>
          <CopyAction label={isFile ? 'Copy contents' : 'Copy value'} value={reveal} secret />
          {isFile && (
            <IconButton label="Save a decrypted copy" size="icon-sm" onClick={() => void save()}>
              <DownloadSimple size={15} />
            </IconButton>
          )}
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
      </div>
      {shown !== null && (
        <div className="pr-4 pb-3 pl-16">
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
