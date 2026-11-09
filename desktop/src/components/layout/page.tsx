import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CaretRight } from '@phosphor-icons/react'

/** Main content: centred and width-capped, never edge to edge. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[880px] px-8 pt-8 pb-20">{children}</div>
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
