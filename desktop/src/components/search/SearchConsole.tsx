import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowElbowDownLeft,
  CaretRight,
  FileText,
  FolderSimple,
  Key,
  MagnifyingGlass,
  Note,
  XCircle
} from '@phosphor-icons/react'
import { DEVICES, FACTORS } from '@renderer/components/accounts/kinds'
import { Button } from '@renderer/components/ui/button'
import { CopyAction } from '@renderer/components/ui/copy'
import { Kbd } from '@renderer/components/ui/icon-button'
import { SiteTile } from '@renderer/components/ui/misc'
import { useVaultGraph } from '@renderer/hooks/use-search'
import { categoryIcon } from '@renderer/lib/categories'
import { neighbours, searchGraph } from '@renderer/lib/search/engine'
import type { VaultGraph } from '@renderer/lib/search/graph'
import type { NodeKind, SearchHit, SearchNode } from '@renderer/lib/search/types'
import { cn } from '@renderer/lib/utils'
import type { DeviceKind, FactorKind } from '@renderer/shared/contracts'

const KIND_LABEL: Record<NodeKind, string> = {
  account: 'Account',
  group: 'Group',
  project: 'Project',
  service: 'Service',
  device: 'Device',
  step: 'Sign-in step',
  'account-secret': 'Secret',
  note: 'Note',
  'project-secret': 'Secret',
  file: 'File'
}

/** One thing the list can hold: a record, or an example question to try. */
type Item =
  | { type: 'node'; key: string; node: SearchNode; hit?: SearchHit }
  | { type: 'example'; key: string; text: string }

/**
 * ⌘K: the search console. Ask in your own words ("device for coolify
 * autotransfert"); it shows how the question was read, the records that answer
 * it, and, for the one selected, the chain of links that leads to it.
 */
export function SearchConsole({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop-motion fixed inset-0 z-[300] bg-(--scrim)" />
        <Dialog.Popup className="glass-strong panel-motion fixed top-[8vh] left-1/2 z-[300] flex h-[min(42rem,84vh)] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-popover-foreground outline-none">
          <Dialog.Title className="sr-only">Search the vault</Dialog.Title>
          <Console onClose={() => onOpenChange(false)} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Console({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const graph = useVaultGraph()
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const asking = deferred.trim().length > 0
  const response = useMemo(() => (asking ? searchGraph(graph, deferred) : null), [graph, deferred, asking])
  const examples = useMemo(() => exampleQuestions(graph), [graph])

  // The list, in order: answers, then what is connected (or, before typing,
  // examples and quick ways in).
  const sections = useMemo<{ title: string; note?: string; items: Item[] }[]>(() => {
    if (!response) {
      const of = (kind: NodeKind): Item[] =>
        [...graph.nodes.values()]
          .filter((node) => node.kind === kind)
          .slice(0, 6)
          .map((node) => ({ type: 'node', key: node.id, node }))
      return [
        { title: 'Ask in your own words', items: examples.map((text): Item => ({ type: 'example', key: `ex:${text}`, text })) },
        { title: 'Projects', items: of('project') },
        { title: 'Devices', items: of('device') }
      ].filter((section) => section.items.length > 0)
    }
    const answers = response.hits.filter((hit) => hit.answer)
    const rest = response.hits.filter((hit) => !hit.answer)
    const asked = response.understood.wants.map((w) => w.label)
    const toItem = (hit: SearchHit): Item => ({ type: 'node', key: hit.node.id, node: hit.node, hit })
    return [
      {
        title: asked.length ? asked[asked.length - 1] : 'Best matches',
        note:
          asked.length && answers.length === 0 && rest.length > 0
            ? 'Nothing of that kind is linked to what you named. These are the closest records.'
            : undefined,
        items: answers.map(toItem)
      },
      { title: 'Also connected', items: rest.map(toItem) }
    ].filter((section) => section.items.length > 0 || section.note)
  }, [response, graph, examples])

  const items = sections.flatMap((section) => section.items)
  const current = items.length ? Math.min(active, items.length - 1) : -1
  const selected = current >= 0 ? items[current] : undefined

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const openNode = (node: SearchNode): void => {
    onClose()
    navigate(node.to)
  }
  const choose = (item: Item): void => {
    if (item.type === 'example') {
      setQuery(item.text)
      setActive(0)
      inputRef.current?.focus()
    } else {
      openNode(item.node)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault()
      choose(selected)
    }
  }

  let index = -1
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b px-4">
        <MagnifyingGlass size={20} className="shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="What are you looking for? A site, a project, a device, or what you need from it"
          aria-label="Search the vault"
          role="combobox"
          aria-expanded="true"
          aria-controls="console-results"
          aria-activedescendant={selected ? `console-${selected.key}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-14 min-w-0 flex-1 bg-transparent text-[16.5px] text-heading outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            className="flex shrink-0 cursor-pointer rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <XCircle size={18} weight="fill" />
          </button>
        )}
      </div>

      {response && <ReadAs response={response} />}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div
          ref={listRef}
          id="console-results"
          role="listbox"
          aria-label="Results"
          className="min-h-0 overflow-y-auto overscroll-contain p-2"
        >
          {items.length === 0 && !sections.some((s) => s.note) ? (
            <p className="px-6 py-12 text-center text-[14px] text-muted-foreground">
              {response ? `Nothing matches “${query.trim()}”` : 'Your vault is empty'}
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.title} role="group" aria-label={section.title} className="pb-1">
                <p className="px-3 pt-2 pb-1.5 text-[12.5px] font-semibold text-muted-foreground">{section.title}</p>
                {section.note && <p className="px-3 pb-2 text-[12.5px] text-muted-foreground">{section.note}</p>}
                {section.items.map((item) => {
                  index += 1
                  const i = index
                  return (
                    <Row
                      key={item.key}
                      item={item}
                      index={i}
                      selected={i === current}
                      onHover={() => setActive(i)}
                      onChoose={() => choose(item)}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>

        <aside aria-label="Selected result" className="hidden min-h-0 overflow-y-auto overscroll-contain border-l md:block">
          {selected?.type === 'node' ? (
            <Preview graph={graph} node={selected.node} hit={selected.hit} onOpen={openNode} />
          ) : (
            <Hint />
          )}
        </aside>
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

/** How the question was read: what is wanted, which records the words named, what matched nothing. */
function ReadAs({ response }: { response: NonNullable<ReturnType<typeof searchGraph>> }) {
  const { wants, anchors, unmatched } = response.understood
  if (!wants.length && !anchors.length && !unmatched.length) return null
  return (
    <div
      aria-label="How the search read your question"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-[12.5px]"
    >
      {wants.length > 0 && (
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Looking for</span>
          {wants.map((w) => (
            <span key={w.label} className="rounded-md border bg-background/40 px-1.5 py-0.5 font-medium text-heading dark:bg-white/5">
              {w.label}
            </span>
          ))}
        </span>
      )}
      {anchors.map((anchor) => (
        <span key={anchor.words} className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground">“{anchor.words}”</span>
          <CaretRight size={10} className="shrink-0 text-muted-foreground" />
          {anchor.nodes.slice(0, 2).map((node) => (
            <span
              key={node.id}
              className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-md border bg-background/40 py-0.5 pr-1.5 pl-1 dark:bg-white/5"
            >
              <NodeIcon node={node} small />
              <span className="truncate text-foreground">{node.title}</span>
            </span>
          ))}
          {anchor.nodes.length > 2 && <span className="text-muted-foreground">+{anchor.nodes.length - 2}</span>}
        </span>
      ))}
      {unmatched.length > 0 && (
        <span className="flex items-center gap-1.5" title="Not found by name. Search by meaning will cover these.">
          <span className="text-muted-foreground">No match for</span>
          {unmatched.map((word) => (
            <span key={word} className="rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground">
              {word}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

function Row({
  item,
  index,
  selected,
  onHover,
  onChoose
}: {
  item: Item
  index: number
  selected: boolean
  onHover: () => void
  onChoose: () => void
}) {
  const className = cn(
    'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors',
    selected ? 'bg-primary/10 dark:bg-primary/15' : 'hover:bg-secondary/60'
  )
  if (item.type === 'example') {
    return (
      <div
        id={`console-${item.key}`}
        data-index={index}
        role="option"
        aria-selected={selected}
        onMouseMove={onHover}
        onClick={onChoose}
        className={className}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground dark:bg-white/8">
          <MagnifyingGlass size={15} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-foreground">{item.text}</span>
        <ArrowElbowDownLeft size={15} aria-hidden="true" className={cn('shrink-0 text-primary', selected ? 'opacity-100' : 'opacity-0')} />
      </div>
    )
  }
  const path = item.hit?.path ?? []
  return (
    <div
      id={`console-${item.key}`}
      data-index={index}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onClick={onChoose}
      className={className}
    >
      <NodeIcon node={item.node} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[14.5px] font-medium text-heading">{item.node.title}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground">{KIND_LABEL[item.node.kind]}</span>
        </p>
        {path.length > 1 ? (
          <p className="truncate text-[12.5px] text-muted-foreground">
            {path.slice(0, -1).map((step) => (
              <span key={step.node.id}>
                {step.node.title}
                <span aria-hidden="true" className="px-1 opacity-60">
                  ›
                </span>
              </span>
            ))}
            <span className="text-foreground">{item.node.title}</span>
          </p>
        ) : (
          <p className="truncate text-[12.5px] text-muted-foreground">{item.node.subtitle}</p>
        )}
      </div>
      <ArrowElbowDownLeft size={15} aria-hidden="true" className={cn('shrink-0 text-primary', selected ? 'opacity-100' : 'opacity-0')} />
    </div>
  )
}

/** The selected record: what it is, how the question leads to it, what else it links to. */
function Preview({
  graph,
  node,
  hit,
  onOpen
}: {
  graph: VaultGraph
  node: SearchNode
  hit?: SearchHit
  onOpen: (node: SearchNode) => void
}) {
  const path = hit?.path ?? []
  const around = neighbours(graph, node.id)
  const email = node.kind === 'account' ? node.subtitle.split(', ')[0] : null
  return (
    <div className="space-y-6 p-4">
      <div>
        <div className="flex items-center gap-3">
          <NodeIcon node={node} large />
          <div className="min-w-0">
            <p className="truncate text-[15.5px] font-semibold text-heading">{node.title}</p>
            <p className="text-[12.5px] text-muted-foreground">{KIND_LABEL[node.kind]}</p>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground" data-selectable>
          {node.subtitle}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => onOpen(node)}>
            Open {KIND_LABEL[node.kind].toLowerCase()}
            <Kbd className="ml-1 border-white/25 bg-white/15 text-primary-foreground">↵</Kbd>
          </Button>
          {email && <CopyAction label="Copy email" value={email} />}
        </div>
      </div>

      {path.length > 1 && (
        <section aria-label="How it connects">
          <p className="mb-2 text-[12px] font-medium text-muted-foreground">How it connects</p>
          <ol>
            {path.map((step, i) => (
              <li key={step.node.id} className="relative pl-5">
                {i < path.length - 1 && (
                  <span aria-hidden="true" className="absolute top-3.5 bottom-0 left-[5px] w-px bg-border" />
                )}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-[7px] left-0.5 size-[7px] rounded-full',
                    i === path.length - 1 ? 'bg-primary' : 'bg-muted-foreground/50'
                  )}
                />
                <p className="truncate text-[13px] text-heading">
                  {step.node.title}
                  <span className="ml-1.5 text-[11.5px] text-muted-foreground">{KIND_LABEL[step.node.kind]}</span>
                </p>
                {path[i + 1]?.via && <p className="pt-0.5 pb-1.5 text-[11.5px] text-muted-foreground">{path[i + 1].via}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {around.length > 0 && (
        <section aria-label="Linked to" className="space-y-3">
          {[...new Set(around.map((a) => a.via))].map((via) => (
            <div key={via}>
              <p className="mb-1 text-[12px] font-medium text-muted-foreground">
                {via[0].toUpperCase() + via.slice(1)}
              </p>
              <ul className="-mx-2">
                {around
                  .filter((a) => a.via === via)
                  .map(({ node: other }) => (
                    <li key={other.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(other)}
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/60"
                      >
                        <NodeIcon node={other} small />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                          {other.title}
                          {other.kind === 'step' && (
                            <span className="text-muted-foreground">, {other.subtitle.replace(/^For /, 'for ')}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function Hint() {
  return (
    <div className="space-y-3 p-5 text-[13px] leading-relaxed text-muted-foreground">
      <p className="font-medium text-heading">Search by what you remember</p>
      <p>
        Name what you know (a site, a project, a service) and what you need from it: a device, a passkey, recovery
        codes, a secret, a file.
      </p>
      <p>The results follow the links between them, and each one shows the path that leads to it.</p>
    </div>
  )
}

function NodeIcon({ node, small = false, large = false }: { node: SearchNode; small?: boolean; large?: boolean }) {
  const size = small ? 'size-5 rounded-[5px]' : large ? 'size-10 rounded-xl' : 'size-8 rounded-lg'
  const iconSize = small ? 11 : large ? 19 : 16
  if (node.kind === 'account' || node.kind === 'service') {
    return <SiteTile name={node.title} size="sm" className={cn(size, small ? 'text-[10px]' : large ? 'text-[15px]' : 'text-[13px]')} />
  }
  const NodeGlyph =
    node.kind === 'group'
      ? categoryIcon(node.title)
      : node.kind === 'project'
        ? FolderSimple
        : node.kind === 'device'
          ? DEVICES[(node.detail ?? 'other') as DeviceKind].icon
          : node.kind === 'step'
            ? FACTORS[node.detail as FactorKind].icon
            : node.kind === 'note'
              ? Note
              : node.kind === 'file'
                ? FileText
                : Key
  return (
    <span
      aria-hidden="true"
      className={cn('flex shrink-0 items-center justify-center bg-secondary text-muted-foreground dark:bg-white/8', size)}
    >
      <NodeGlyph size={iconSize} />
    </span>
  )
}

/**
 * Questions to try, made from this vault so they work: a device behind a
 * project's service, an account's recovery codes, a project's secrets.
 */
function exampleQuestions(graph: VaultGraph): string[] {
  const lower = (text: string): string => text.toLowerCase()
  const out: string[] = []
  const edgesOf = (id: string) => graph.edges.get(id) ?? []
  for (const service of graph.nodes.values()) {
    if (service.kind !== 'service' || out.length) continue
    const project = edgesOf(service.id).find((e) => e.via === 'in project')
    const account = edgesOf(service.id).find((e) => e.via === 'uses account')
    if (!project || !account) continue
    const viaStep = edgesOf(account.to).some(
      (e) => e.via === 'second step' && edgesOf(e.to).some((f) => f.via === 'lives on')
    )
    if (viaStep) {
      const projectWord = lower(graph.nodes.get(project.to)!.title).split(/\s+/)[0]
      out.push(`device for ${lower(service.title)} ${projectWord}`)
    }
  }
  const withCodes = [...graph.nodes.values()].find((n) => n.kind === 'step' && n.detail === 'recovery_codes')
  if (withCodes) {
    const owner = edgesOf(withCodes.id).find((e) => e.via === 'protects')
    if (owner) out.push(`${lower(graph.nodes.get(owner.to)!.title).replace(/\.[a-z]+$/, '')} recovery codes`)
  }
  const project = [...graph.nodes.values()].find(
    (n) => n.kind === 'project' && edgesOf(n.id).some((e) => graph.nodes.get(e.to)?.kind === 'project-secret')
  )
  if (project) out.push(`${lower(project.title)} secrets`)
  if ([...graph.nodes.values()].some((n) => n.kind === 'step' && n.detail === 'passkey')) out.push('passkeys')
  if (out.length < 3) out.push('what signs in with google')
  return out.slice(0, 4)
}

