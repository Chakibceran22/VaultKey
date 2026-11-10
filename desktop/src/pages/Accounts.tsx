import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Globe, Plus } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { AccountModal } from '@renderer/components/accounts/AccountModal'
import { AccountItem, EmptyWebsiteItem } from '@renderer/components/accounts/rows'
import { EmptyFrame, Page, PageHeader } from '@renderer/components/layout/page'
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { SearchField } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { matches, plural, useDomains, useListRows, useRelations, type ListRow } from '@renderer/hooks/use-vault'
import { categoryIcon, categoryOf, categoryOrder } from '@renderer/lib/categories'
import { isModKey, isTyping, MOD, isOverlayOpen } from '@renderer/lib/dom'

const rowDomId = (key: string): string => `row-${key}`
const NO_ACCOUNT = 'Websites with no account'

/** Kept after closing, so the modal's content doesn't change while it fades out. */
interface ModalState {
  open: boolean
  website: string
}

interface Group {
  name: string
  icon: Icon
  rows: ListRow[]
}

/**
 * Pattern: List / Index, laid out as groups. Accounts are grouped by what they
 * are for (Games, Money, Developer and cloud…), each group a panel of the same
 * fixed size in an even grid, scrolling inside when it holds more than fits, so
 * the vault reads as a few short lists instead of one long one. The group is
 * guessed from the website until it is set on the account. Search filters every
 * group, and a group's name finds the whole group.
 */
export default function Accounts(): React.ReactElement {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { rows, isLoading } = useListRows()
  const { domains } = useDomains()
  const relationsOf = useRelations()
  const { confirm, dialog } = useConfirm()

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  const [modal, setModal] = useState<ModalState>({ open: false, website: '' })
  const openNew = (website = ''): void => setModal({ open: true, website })
  const searchRef = useRef<HTMLInputElement>(null)

  const needle = query.trim().toLowerCase()
  const accountCount = rows.filter((row) => row.kind === 'account').length

  // Groups in their fixed order; websites with no account last.
  const groups = useMemo<Group[]>(() => {
    const byName = new Map<string, ListRow[]>()
    for (const row of rows) {
      const name = row.kind === 'account' ? categoryOf(row.account) : NO_ACCOUNT
      const hit = !needle || matches(row, needle) || (row.kind === 'account' && name.toLowerCase().includes(needle))
      if (!hit) continue
      byName.set(name, [...(byName.get(name) ?? []), row])
    }
    return [...byName.entries()]
      .sort(([a], [b]) => (a === NO_ACCOUNT ? 1 : b === NO_ACCOUNT ? -1 : categoryOrder(a, b)))
      .map(([name, groupRows]) => ({ name, icon: name === NO_ACCOUNT ? Globe : categoryIcon(name), rows: groupRows }))
  }, [rows, needle])

  // Arrow keys move through the rows in reading order: group by group.
  const visible = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const current = visible.length ? Math.min(active, visible.length - 1) : -1

  const openAccount = (accountId: number): void => {
    navigate(`/accounts/${accountId}`)
  }

  // Older deep links (/accounts?open=12) now go to the account's page.
  useEffect(() => {
    const open = Number(params.get('open'))
    if (!open) return
    if (open > 0) navigate(`/accounts/${open}`, { replace: true })
    else setParams({}, { replace: true })
  }, [params, setParams, navigate])

  // "/" focuses the search; ⌘N starts a new account.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === '/' && !isTyping(event.target) && !isOverlayOpen()) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (isModKey(event) && event.key.toLowerCase() === 'n' && !isOverlayOpen()) {
        event.preventDefault()
        setModal({ open: true, website: '' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (current >= 0) document.getElementById(rowDomId(visible[current].key))?.scrollIntoView({ block: 'nearest' })
  }, [current, visible])

  const toggle = (key: string): void => {
    setActive(visible.findIndex((row) => row.key === key))
    setExpanded((open) => (open === key ? null : key))
  }

  const activate = (index: number): void => {
    const row = visible[index]
    if (row.kind === 'account') openAccount(row.account.id)
    else toggle(row.key)
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!visible.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(current < 0 ? (step > 0 ? 0 : visible.length - 1) : (current + step + visible.length) % visible.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const target = current >= 0 ? current : visible.length === 1 ? 0 : -1
      if (target >= 0) activate(target)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (expanded) setExpanded(null)
      else if (query) setQuery('')
    }
  }

  const activeKey = current >= 0 ? visible[current].key : null

  return (
    <Page wide>
      <PageHeader
        title="Accounts"
        description={
          accountCount > 0
            ? `${plural(accountCount, 'account')} on ${plural(domains.length, 'website')}, grouped by what they are for.`
            : 'Every login you keep: how it signs in, what protects it, and where it is used.'
        }
        actions={
          <Button variant="primary" size="lg" onClick={() => openNew()} title={`New account (${MOD}N)`}>
            <Plus size={14} weight="bold" />
            New account
          </Button>
        }
      />

      <div className="mt-6">
        <SearchField
          inputRef={searchRef}
          value={query}
          onChange={(value) => {
            setQuery(value)
            setActive(-1)
          }}
          onKeyDown={onSearchKey}
          placeholder="Search accounts, or a group like “games”"
          role="combobox"
          aria-expanded="true"
          aria-controls="account-groups"
          aria-activedescendant={activeKey ? rowDomId(activeKey) : undefined}
          autoFocus
        />
        <p aria-live="polite" className="mt-2 h-4 px-1 text-[12.5px] text-muted-foreground tabular-nums">
          {needle && visible.length > 0 ? `${plural(visible.length, 'result')} for “${query.trim()}”` : ''}
        </p>
      </div>

      <div className="mt-3">
        {isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner size={20} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyFrame
            title={needle ? `No account matches “${query.trim()}”` : 'No accounts yet'}
            description={
              needle
                ? 'Check the spelling, or save it as a new account.'
                : 'Save the logins you use, with their passwords or the account they sign in with.'
            }
            action={
              <Button variant="primary" size="lg" onClick={() => openNew(needle ? query.trim() : '')}>
                <Plus size={14} weight="bold" />
                {needle ? `Add “${query.trim()}”` : 'New account'}
              </Button>
            }
          />
        ) : (
          <div id="account-groups" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => (
              <GroupPanel key={group.name} name={group.name} icon={group.icon} count={group.rows.length}>
                {group.rows.map((row) =>
                  row.kind === 'account' ? (
                    <AccountItem
                      key={row.key}
                      rowId={rowDomId(row.key)}
                      account={row.account}
                      relations={relationsOf(row.account.id)}
                      active={row.key === activeKey}
                      onOpen={() => openAccount(row.account.id)}
                    />
                  ) : (
                    <EmptyWebsiteItem
                      key={row.key}
                      rowId={rowDomId(row.key)}
                      domain={row.domain}
                      expanded={expanded === row.key}
                      active={row.key === activeKey}
                      onToggle={() => toggle(row.key)}
                      onCollapse={() => setExpanded(null)}
                      confirm={confirm}
                      onAddAccount={openNew}
                    />
                  )
                )}
              </GroupPanel>
            ))}
          </div>
        )}
      </div>

      <AccountModal
        open={modal.open}
        onOpenChange={(open) => !open && setModal((current) => ({ ...current, open: false }))}
        website={modal.website}
        onSaved={openAccount}
      />
      {dialog}
    </Page>
  )
}

/**
 * One group: its name and count, then its accounts. Every panel has the same
 * fixed height, so the grid keeps one even shape however many accounts a group
 * has; a long group scrolls inside its own panel.
 */
function GroupPanel({ name, icon: GroupIcon, count, children }: { name: string; icon: Icon; count: number; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="frost flex h-[22rem] flex-col overflow-hidden rounded-2xl">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3.5">
        <GroupIcon size={15} className="shrink-0 text-muted-foreground" />
        <h2 id={headingId} className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-heading">
          {name}
        </h2>
        <span className="text-[12.5px] text-muted-foreground tabular-nums">
          <span className="sr-only">, </span>
          {count}
        </span>
      </div>
      <ul className="panel-scroll min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain">{children}</ul>
    </section>
  )
}
