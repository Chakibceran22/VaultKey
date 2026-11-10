import { useEffect, useId, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CaretRight } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'

/**
 * Main content: centred and width-capped, never edge to edge. `wide` is for a
 * record with a side column, so a large window shows more of it at once.
 */
export function Page({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn('mx-auto w-full px-8 pt-8 pb-20', wide ? 'max-w-[1180px]' : 'max-w-[880px]')}>{children}</div>
  )
}

/** A titled block of a record page: its heading, and its one action on the right. */
export function Section({
  id,
  title,
  action,
  children
}: {
  id?: string
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-6">
      <div className="mb-3 flex h-8 items-center justify-between gap-4">
        <h2 id={headingId} className="text-[15px] font-semibold text-heading">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * `?show=<section>` (from search, or a drop of files) scrolls that section into
 * view once the record has loaded. Sections are found by `section-<name>`.
 */
export function useShowSection(ready: boolean): void {
  const [params] = useSearchParams()
  const show = params.get('show')
  useEffect(() => {
    if (ready && show) document.getElementById(`section-${show}`)?.scrollIntoView({ block: 'start' })
  }, [ready, show])
}

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** A record's facts (`facts`, first), when it was saved, and last edited if that was later. */
export function History({
  createdAt,
  updatedAt,
  facts = []
}: {
  createdAt: string
  updatedAt: string
  facts?: [string, ReactNode][]
}) {
  const added = new Date(createdAt)
  const edited = new Date(updatedAt)
  const dated = !Number.isNaN(added.getTime())
  const showEdited = dated && !Number.isNaN(edited.getTime()) && edited.getTime() - added.getTime() > 60_000
  if (!dated && facts.length === 0) return null
  return (
    <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-1 text-[12.5px]">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground">{value}</dd>
        </div>
      ))}
      {dated && (
        <>
          <dt className="text-muted-foreground">Added</dt>
          <dd className="text-foreground tabular-nums">
            <time dateTime={createdAt}>{DAY.format(added)}</time>
          </dd>
        </>
      )}
      {showEdited && (
        <>
          <dt className="text-muted-foreground">Last edited</dt>
          <dd className="text-foreground tabular-nums">
            <time dateTime={updatedAt}>{DAY.format(edited)}</time>
          </dd>
        </>
      )}
    </dl>
  )
}

/** A record page's body: the main column, and a side column beside it on wide windows. */
export function RecordColumns({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="mt-10 grid items-start gap-x-10 gap-y-12 lg:grid-cols-[minmax(0,1fr)_18.5rem]">
      <div className="min-w-0 space-y-10">{main}</div>
      <aside aria-label="Related" className="min-w-0 lg:sticky lg:top-6">
        {side}
      </aside>
    </div>
  )
}

/** One line inside a list frame that has nothing in it yet. */
export function EmptyLine({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="px-4 py-3.5 text-[13px] leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">{title}</span> {children}
    </li>
  )
}

/** Heading, one sentence, and the page's primary action on the right. */
export function PageHeader({
  title,
  description,
  actions,
  actionsAtTop = false,
  crumbs
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Align the actions with the title rather than the last line (tall headers). */
  actionsAtTop?: boolean
  /** Parent pages, e.g. [{ to: '/projects', label: 'Projects' }]. */
  crumbs?: { to: string; label: string }[]
}) {
  return (
    <div>
      {crumbs && (
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          {crumbs.map((crumb) => (
            <span key={crumb.to} className="flex items-center gap-1.5">
              <Link to={crumb.to} className="transition-colors hover:text-foreground">
                {crumb.label}
              </Link>
              <CaretRight size={10} className="opacity-60" />
            </span>
          ))}
        </nav>
      )}
      <div className={actionsAtTop ? 'flex items-start justify-between gap-6' : 'flex items-end justify-between gap-6'}>
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.015em] text-heading">{title}</h1>
          {description && <div className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className={actionsAtTop ? 'flex shrink-0 items-center gap-2 pt-1.5' : 'flex shrink-0 items-center gap-2'}>{actions}</div>}
      </div>
    </div>
  )
}

/** The L1 frame every list sits in: a border, hairline rows, a quiet footer. */
export function ListFrame({
  id,
  footer,
  children
}: {
  id?: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="frost overflow-hidden rounded-2xl">
      <ul id={id} className="divide-y divide-border">
        {children}
      </ul>
      {footer && <div className="border-t px-4 py-2.5 text-[12.5px] text-muted-foreground tabular-nums">{footer}</div>}
    </div>
  )
}

/** An empty or no-results state, inside the same frame as the list it replaces. */
export function EmptyFrame({
  title,
  description,
  action
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="frost rounded-2xl px-6 py-12 text-center">
      <p className="text-[15px] font-medium text-heading">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-[13.5px] leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
