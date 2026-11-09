import { Plus, Trash } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccountSummary, DomainRecord } from '@renderer/shared/contracts'
import { Button } from '@renderer/components/ui/button'
import type { ConfirmOptions } from '@renderer/components/ui/confirm'
import { refreshVault, type AccountRelations } from '@renderer/hooks/use-vault'
import { domainService } from '@renderer/lib/domainsService'
import { toast } from '@renderer/lib/toast'
import { cn } from '@renderer/lib/utils'
import { FACTOR_KINDS, FACTORS } from './kinds'
import { BODY_INSET, Expand, RowHeader } from './parts'

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

/** One account. It opens the account's page. */
export function AccountRow({
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
  // What protects it, as quiet icons: one per kind of second step.
  const kinds = FACTOR_KINDS.filter((kind) => relations.factors.some((f) => f.kind === kind))
  const via = signInSummary(relations)
  return (
    <li>
      <RowHeader
        id={rowId}
        title={account.domainName}
        subtitle={account.email}
        navigates
        meta={
          <>
            {kinds.length > 0 && (
              <span
                className="flex shrink-0 items-center gap-1"
                aria-label={kinds.map((kind) => FACTORS[kind].name).join(', ')}
                title={kinds.map((kind) => FACTORS[kind].name).join(', ')}
              >
                {kinds.map((kind) => {
                  const KindIcon = FACTORS[kind].icon
                  return <KindIcon key={kind} size={14} />
                })}
              </span>
            )}
            {via && <span className="truncate">{via}</span>}
            {!via && !account.hasPassword && <span className="truncate">No password</span>}
          </>
        }
        expanded={false}
        active={active}
        onToggle={onOpen}
      />
    </li>
  )
}

/** A website with no accounts yet (kept from the old app, or emptied). */
export function WebsiteRow({
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
      <RowHeader
        id={rowId}
        title={domain.name}
        subtitle="No accounts yet"
        quiet
        expanded={expanded}
        active={active}
        onToggle={onToggle}
      />
      <Expand open={expanded}>
        <div className={cn(BODY_INSET, 'flex items-center gap-2')}>
          <p className="text-[13.5px] text-muted-foreground">Nothing saved for this website yet.</p>
          <span className="flex-1" />
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
