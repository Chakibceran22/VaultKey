import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowElbowDownLeft, FolderSimple, Key, MagnifyingGlass, Note, Stack, XCircle } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { Kbd } from '@renderer/components/ui/icon-button'
import { SiteTile } from '@renderer/components/ui/misc'
import { DEVICES, FACTORS } from '@renderer/components/accounts/kinds'
import { useAccountDetails, useAccounts, useLinks, useWorkspace } from '@renderer/hooks/use-vault'
import { cn } from '@renderer/lib/utils'

interface Result {
  key: string
  group: 'Accounts' | 'Projects' | 'Services' | 'Devices' | 'Secrets and files'
  title: string
  detail: string
  /** A site monogram, or an icon. */
  tile: { name: string } | { icon: Icon }
  to: string
  haystack: string
}

const GROUPS: Result['group'][] = ['Accounts', 'Projects', 'Services', 'Devices', 'Secrets and files']

/** Every word typed must appear somewhere: "coolify acme" finds Coolify in Acme Store. */
function matchesAll(haystack: string, words: string[]): boolean {
  const text = haystack.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** ⌘K: one search over everything in the vault; Enter opens the result. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop-motion fixed inset-0 z-[300] bg-(--scrim)" />
        <Dialog.Popup className="glass-strong panel-motion fixed top-[12vh] left-1/2 z-[300] flex max-h-[min(34rem,76vh)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-popover-foreground outline-none">
          <Dialog.Title className="sr-only">Search the vault</Dialog.Title>
          <Palette onClose={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { accounts } = useAccounts()
  const links = useLinks()
  const { projects, services, secrets } = useWorkspace()
  const { devices, factors, secrets: accountSecrets } = useAccountDetails()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [entering, setEntering] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), 450)
    return () => clearTimeout(timer)
  }, [])

  const all = useMemo<Result[]>(() => {
    const projectName = new Map(projects.map((p) => [p.id, p.name]))
    const accountById = new Map(accounts.map((a) => [a.id, a]))
    const deviceName = new Map(devices.map((d) => [d.id, d.name]))
    // An account is found by what it is and by everything attached to it:
    // its second steps and their devices, its secrets, what it signs in with.
    const context = (accountId: number): string =>
      [
        ...factors
          .filter((f) => f.accountId === accountId)
          .flatMap((f) => [FACTORS[f.kind].name, f.label, f.deviceId ? deviceName.get(f.deviceId) : '']),
        ...accountSecrets.filter((s) => s.accountId === accountId).map((s) => s.name),
        ...links
          .filter((l) => l.accountId === accountId)
          .map((l) => accountById.get(l.linkedAccountId)?.domainName ?? ''),
        ...services
          .filter((s) => s.accountId === accountId)
          .flatMap((s) => [s.name, projectName.get(s.projectId) ?? ''])
      ].join(' ')
    return [
      ...accounts.map((a) => ({
        key: `a${a.id}`,
        group: 'Accounts' as const,
        title: a.domainName,
        detail: a.email,
        tile: { name: a.domainName },
        to: `/accounts/${a.id}`,
        haystack: `${a.domainName} ${a.email} ${a.username ?? ''} ${context(a.id)}`
      })),
      ...projects.map((p) => ({
        key: `p${p.id}`,
        group: 'Projects' as const,
        title: p.name,
        detail: p.description || 'Project',
        tile: { icon: FolderSimple },
        to: `/projects/${p.id}`,
        haystack: `${p.name} ${p.description}`
      })),
      ...services.map((s) => ({
        key: `s${s.id}`,
        group: 'Services' as const,
        title: s.name,
        detail: `In ${projectName.get(s.projectId) ?? 'a project'}`,
        tile: { name: s.name },
        to: `/projects/${s.projectId}?tab=services`,
        haystack: `${s.name} ${s.url} ${projectName.get(s.projectId) ?? ''}`
      })),
      ...devices.map((d) => ({
        key: `d${d.id}`,
        group: 'Devices' as const,
        title: d.name,
        detail: DEVICES[d.kind].name,
        tile: { icon: DEVICES[d.kind].icon },
        to: `/devices?open=${d.id}`,
        haystack: `${d.name} ${DEVICES[d.kind].name} ${d.notes}`
      })),
      ...accountSecrets.map((s) => {
        const owner = accountById.get(s.accountId)?.domainName ?? 'an account'
        return {
          key: `as${s.id}`,
          group: 'Secrets and files' as const,
          title: s.name,
          detail: `${s.kind === 'note' ? 'Note' : 'Secret'} in ${owner}`,
          tile: { icon: s.kind === 'note' ? Note : Key },
          to: `/accounts/${s.accountId}?tab=secrets`,
          haystack: `${s.name} ${owner}`
        }
      }),
      ...secrets.map((s) => ({
        key: `k${s.id}`,
        group: 'Secrets and files' as const,
        title: s.name,
        detail: `${s.kind === 'file' ? 'File' : 'Secret'} in ${projectName.get(s.projectId) ?? 'a project'}`,
        tile: { icon: s.kind === 'file' ? Stack : Key },
        to: `/projects/${s.projectId}?tab=${s.kind === 'file' ? 'files' : 'secrets'}`,
        haystack: `${s.name} ${projectName.get(s.projectId) ?? ''}`
      }))
    ]
  }, [accounts, links, projects, services, secrets, devices, factors, accountSecrets])

  const needle = query.trim().toLowerCase()
  const words = needle.split(/\s+/).filter(Boolean)
  // Grouped, at most 6 per group while browsing, everything that matches while searching.
  const results = GROUPS.flatMap((group) => {
    const inGroup = all.filter((r) => r.group === group && matchesAll(r.haystack, words))
    return needle ? inGroup : inGroup.slice(0, 6)
  })
  const current = Math.min(active, Math.max(results.length - 1, 0))

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const go = (result: Result): void => {
    onClose()
    navigate(result.to)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
    } else if (event.key === 'Enter' && results[current]) {
      event.preventDefault()
      go(results[current])
    }
  }

  let index = -1
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b px-4">
        <MagnifyingGlass size={20} className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search accounts, projects, devices, secrets…"
          aria-label="Search the vault"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results[current] ? `palette-${results[current].key}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-14 min-w-0 flex-1 bg-transparent text-[16.5px] text-heading outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery('')}
            className="flex shrink-0 cursor-pointer rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <XCircle size={18} weight="fill" />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        id="palette-results"
        role="listbox"
        aria-label="Results"
        data-entering={entering || undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        {results.length === 0 ? (
          <p className="px-6 py-10 text-center text-[14px] text-muted-foreground">
            {needle ? `Nothing matches “${query.trim()}”` : 'Your vault is empty'}
          </p>
        ) : (
          GROUPS.map((group) => {
            const inGroup = results.filter((r) => r.group === group)
            if (!inGroup.length) return null
            return (
              <div key={group} role="group" aria-label={group} className="pb-1">
                <p className="px-3 pt-2 pb-1.5 text-[12.5px] font-semibold text-muted-foreground">{group}</p>
                {inGroup.map((result) => {
                  index += 1
                  const i = index
                  const selected = i === current
                  return (
                    <div
                      key={result.key}
                      id={`palette-${result.key}`}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      data-stagger
                      style={{ '--i': i } as CSSProperties}
                      onMouseMove={() => setActive(i)}
                      onClick={() => go(result)}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors',
                        selected ? 'bg-primary/10 dark:bg-primary/15' : 'hover:bg-secondary/60'
                      )}
                    >
                      {'name' in result.tile ? (
                        <SiteTile name={result.tile.name} size="sm" className="size-8 rounded-lg text-[13px]" />
                      ) : (
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                          <result.tile.icon size={16} />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14.5px] font-medium text-heading">{result.title}</p>
                        <p className="truncate text-[12.5px] text-muted-foreground">{result.detail}</p>
                      </div>
                      <ArrowElbowDownLeft
                        size={15}
                        aria-hidden="true"
                        className={cn('shrink-0 text-primary', selected ? 'opacity-100' : 'opacity-0')}
                      />
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-2.5 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          to open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd>
          to close
        </span>
      </div>
    </>
  )
}
