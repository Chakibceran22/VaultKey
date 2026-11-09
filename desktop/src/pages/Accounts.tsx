import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from '@phosphor-icons/react'
import { AccountModal } from '@renderer/components/accounts/AccountModal'
import { AccountRow, WebsiteRow } from '@renderer/components/accounts/rows'
import { EmptyFrame, ListFrame, Page, PageHeader } from '@renderer/components/layout/page'
import { Button } from '@renderer/components/ui/button'
import { useConfirm } from '@renderer/components/ui/confirm'
import { SearchField } from '@renderer/components/ui/controls'
import { Spinner } from '@renderer/components/ui/misc'
import { matches, plural, useDomains, useListRows, useRelations } from '@renderer/hooks/use-vault'
import { isModKey, isTyping, MOD, isOverlayOpen } from '@renderer/lib/dom'

const rowDomId = (key: string): string => `row-${key}`

/** Kept after closing, so the modal's content doesn't change while it fades out. */
interface ModalState {
  open: boolean
  website: string
}

/**
 * Pattern: List / Index. Search, one row per account; a row opens the account's
 * page. Websites without an account open in place. New accounts are made in a modal.
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
  const visible = useMemo(() => rows.filter((row) => matches(row, needle)), [rows, needle])
  const current = visible.length ? Math.min(active, visible.length - 1) : -1
  const accountCount = rows.filter((row) => row.kind === 'account').length

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

  const toggle = (key: string, index: number): void => {
    setActive(index)
    setExpanded((open) => (open === key ? null : key))
  }

  const activate = (index: number): void => {
    const row = visible[index]
    if (row.kind === 'account') openAccount(row.account.id)
    else toggle(row.key, index)
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

  return (
    <Page>
      <PageHeader
        title="Accounts"
        description="Every login you keep: how it signs in, what protects it, and where it is used."
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
          placeholder="Search accounts"
          role="combobox"
          aria-expanded="true"
          aria-controls="account-list"
          aria-activedescendant={current >= 0 ? rowDomId(visible[current].key) : undefined}
          autoFocus
        />
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Spinner size={20} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyFrame
            title={needle ? `No account matches “${query.trim()}”` : 'No accounts yet'}
            description={
              needle ? 'Check the spelling, or save it as a new account.' : 'Save the logins you use, with their passwords or the account they sign in with.'
            }
            action={
              <Button variant="primary" size="lg" onClick={() => openNew(needle ? query.trim() : '')}>
                <Plus size={14} weight="bold" />
                {needle ? `Add “${query.trim()}”` : 'New account'}
              </Button>
            }
          />
        ) : (
          <ListFrame
            id="account-list"
            footer={
              needle
                ? `${plural(visible.length, 'result')} for “${query.trim()}”`
                : `${plural(accountCount, 'account')} on ${plural(domains.length, 'website')}`
            }
          >
            {visible.map((row, index) =>
              row.kind === 'account' ? (
                <AccountRow
                  key={row.key}
                  rowId={rowDomId(row.key)}
                  account={row.account}
                  relations={relationsOf(row.account.id)}
                  active={index === current}
                  onOpen={() => openAccount(row.account.id)}
                />
              ) : (
                <WebsiteRow
                  key={row.key}
                  rowId={rowDomId(row.key)}
                  domain={row.domain}
                  expanded={expanded === row.key}
                  active={index === current}
                  onToggle={() => toggle(row.key, index)}
                  onCollapse={() => setExpanded(null)}
                  confirm={confirm}
                  onAddAccount={openNew}
                />
              )
            )}
          </ListFrame>
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
