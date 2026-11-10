import { CaretRight, Plus, Trash } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSummary, DomainRecord } from '@renderer/shared/contracts'
import { Button } from '@renderer/components/ui/button'
import { SiteTile } from '@renderer/components/ui/misc'
import type { ConfirmOptions } from '@renderer/components/ui/confirm'
import { refreshVault, type AccountRelations } from '@renderer/hooks/use-vault'
import { domainService } from '@renderer/lib/domainsService'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'
import { FACTOR_KINDS, FACTORS } from './kinds'
import { Expand } from './parts'

type Confirm = (options: ConfirmOptions) => Promise<boolean>

interface RowProps {
  rowId: string
  expanded: boolean
  active: boolean
  onToggle: () => void
  onCollapse: () => void
  confirm: Confirm
}

/** "via google.com" when the account signs in with another one. */
export function signInSummary(relations: AccountRelations): string {
  const [first, ...rest] = relations.signsInWith
  if (!first) return ''
  return rest.length ? `via ${first.domainName} +${rest.length}` : `via ${first.domainName}`
}

/** One account in a group panel: site, email, what protects it. It opens the account's page. */
export function AccountItem({
  account,
  relations,
  rowId,
  active,
  onOpen
}: {
  account: AccountSummary
  relations: AccountRelations
  rowId: string
  active: boolean
  onOpen: () => void
}) {
  const kinds = FACTOR_KINDS.filter((kind) => relations.factors.some((f) => f.kind === kind))
  const via = signInSummary(relations)
  const detail = via ? `${account.email}, ${via}` : account.hasPassword ? account.email : `${account.email}, no password`
  return (
    <li>
      <button
        type="button"
        id={rowId}
        onClick={onOpen}
        className={cn(
          'group flex h-14 w-full cursor-pointer items-center gap-3 px-3.5 text-left transition-colors duration-150 outline-none hover:bg-secondary/40 focus-visible:bg-secondary/60',
          active && 'bg-secondary/60'
        )}
      >
        <SiteTile name={account.domainName} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-heading">{account.domainName}</span>
          <span className="block truncate text-[12.5px] text-muted-foreground">{detail}</span>
        </span>
        {kinds.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground"
            role="img"
            aria-label={kinds.map((kind) => FACTORS[kind].name).join(', ')}
            title={kinds.map((kind) => FACTORS[kind].name).join(', ')}
          >
            {kinds.map((kind) => {
              const KindIcon = FACTORS[kind].icon
              return <KindIcon key={kind} size={13} />
            })}
          </span>
        )}
        <CaretRight
          size={11}
          weight="bold"
          className="shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
        />
      </button>
    </li>
  )
}

/** A website kept from the old app with no account left: add one, or delete it. */
export function EmptyWebsiteItem({
  domain,
  rowId,
  expanded,
  active,
  onToggle,
  onCollapse,
  confirm,
  onAddAccount
}: RowProps & { domain: DomainRecord; onAddAccount: (website: string) => void }) {
  const queryClient = useQueryClient()
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete “${domain.name}”?`,
      description: 'It has no accounts. This can’t be undone.',
      confirmLabel: 'Delete website',
      destructive: true
    })
    if (!ok) return
    try {
      await domainService.deleteDomain(domain.id)
      onCollapse()
      await refreshVault(queryClient)
      toast.success('Website deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete the website')
    }
  }
  return (
    <li className={cn('transition-colors duration-200', expanded && 'bg-secondary/30')}>
      <button
        type="button"
        id={rowId}
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'flex h-12 w-full cursor-pointer items-center gap-3 px-3.5 text-left transition-colors duration-150 outline-none hover:bg-secondary/40 focus-visible:bg-secondary/60',
          active && !expanded && 'bg-secondary/60'
        )}
      >
        <SiteTile name={domain.name} size="sm" className="opacity-70" />
        <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">{domain.name}</span>
        <CaretRight
          size={11}
          weight="bold"
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-200 ease-smooth motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
        />
      </button>
      <Expand open={expanded}>
        <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pl-14">
          <Button variant="secondary" size="sm" onClick={() => onAddAccount(domain.name)}>
            <Plus size={13} weight="bold" />
            Add account
          </Button>
          <Button variant="destructive-ghost" size="sm" onClick={() => void remove()}>
            <Trash size={14} />
            Delete website
          </Button>
        </div>
      </Expand>
    </li>
  )
}
