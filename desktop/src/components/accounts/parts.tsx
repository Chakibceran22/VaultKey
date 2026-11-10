import { useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { CaretRight, Eye, EyeSlash } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { CopyAction } from '@renderer/components/ui/copy'
import { IconButton } from '@renderer/components/ui/icon-button'
import { SiteTile, Spinner } from '@renderer/components/ui/misc'
import { cn } from '@renderer/lib/utils'

/*
 * One grid for the whole list, so every row lines up:
 *   [tile] [website] [account] [chevron]
 * and an expanded row's content starts under the website column (pl-16).
 */
export const ROW_GRID =
  'grid grid-cols-[2rem_minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)_1rem] items-center gap-x-4'
export const BODY_INSET = 'pr-4 pb-4 pl-16'
/** Label column inside an expanded row. */
export const LINE_GRID = 'grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-4'

/** A record's icon in a quiet tile, the same size as a site monogram. */
export function IconTile({ icon: TileIcon, className }: { icon: Icon; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-secondary text-muted-foreground dark:bg-white/8',
        className
      )}
    >
      <TileIcon size={16} />
    </span>
  )
}

export function RowHeader({
  id,
  title,
  subtitle,
  meta,
  icon,
  quiet = false,
  navigates = false,
  expanded,
  active,
  onToggle
}: {
  id: string
  title: string
  subtitle: string
  /** A short third column, e.g. how the account signs in. */
  meta?: ReactNode
  /** An icon tile instead of the site monogram. */
  icon?: Icon
  /** A placeholder subtitle (e.g. "No accounts yet"). */
  quiet?: boolean
  /** The row opens a page instead of expanding in place. */
  navigates?: boolean
  expanded: boolean
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      id={id}
      aria-expanded={navigates ? undefined : expanded}
      onClick={onToggle}
      className={cn(
        ROW_GRID,
        'h-14 w-full scroll-mt-28 cursor-pointer px-4 text-left transition-colors duration-150 outline-none hover:bg-secondary/40 focus-visible:bg-secondary/60',
        active && !expanded && 'bg-secondary/60'
      )}
    >
      {icon ? <IconTile icon={icon} /> : <SiteTile name={title} size="sm" />}
      <span className="truncate text-[14.5px] font-medium text-heading">{title}</span>
      <span className={cn('truncate text-[14px] text-muted-foreground', quiet && 'text-muted-foreground/70')}>
        {subtitle}
      </span>
      <span className="flex min-w-0 items-center gap-2 truncate text-[13px] text-muted-foreground">{meta}</span>
      <CaretRight
        size={13}
        weight="bold"
        className={cn(
          'justify-self-end text-muted-foreground transition-transform duration-200 ease-smooth motion-reduce:transition-none',
          expanded && 'rotate-90 text-foreground'
        )}
      />
    </button>
  )
}

/** Height-animated disclosure for a row's content. */
export function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  )
}

const MASK = '•'.repeat(12)

/** A labelled value with copy (and, for a secret, reveal). */
export function SecretLine({
  label,
  value,
  secret = false,
  loading = false,
  failed = false
}: {
  label: string
  value: string
  secret?: boolean
  loading?: boolean
  failed?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const unavailable = loading || failed
  return (
    <div className={cn(LINE_GRID, 'min-h-10')}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {loading ? (
        <Spinner size={14} className="text-muted-foreground" />
      ) : failed ? (
        <span className="text-[13.5px] text-muted-foreground">Couldn’t decrypt this password</span>
      ) : secret && !revealed ? (
        <span className="truncate font-mono text-[14px] tracking-[0.12em] text-muted-foreground">{MASK}</span>
      ) : (
        <span
          data-selectable
          className={cn(
            'truncate text-heading',
            secret ? 'reveal-in font-mono text-[14px]' : 'text-[14.5px]'
          )}
        >
          {value}
        </span>
      )}
      <div className="flex items-center gap-0.5">
        {secret && (
          <IconButton
            label={revealed ? 'Hide password' : 'Show password'}
            size="icon-sm"
            disabled={unavailable}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? <EyeSlash size={15} /> : <Eye size={15} />}
          </IconButton>
        )}
        <CopyAction label={`Copy ${label.toLowerCase()}`} value={value} secret={secret} disabled={unavailable} />
      </div>
    </div>
  )
}

export interface ChipItem {
  key: string
  title: string
  detail?: string
  /** An icon instead of the site monogram (devices). */
  icon?: Icon
  onOpen: () => void
}

/** A related record as a chip that jumps to it. */
export function Chip({ item }: { item: ChipItem }) {
  const ChipIcon = item.icon
  return (
    <button
      type="button"
      onClick={item.onOpen}
      className="inline-flex h-7 max-w-full cursor-pointer items-center gap-2 rounded-md border bg-background/50 px-2 text-[13px] transition-colors hover:border-primary/40 hover:text-heading dark:bg-white/5"
    >
      {ChipIcon ? (
        <ChipIcon size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <SiteTile name={item.title} size="sm" className="size-4.5 rounded-[5px] text-[9.5px]" />
      )}
      <span className="truncate font-medium text-heading">{item.title}</span>
      {item.detail && <span className="truncate text-muted-foreground">{item.detail}</span>}
    </button>
  )
}

/** A labelled line of related records, each a chip that jumps to it. */
export function LinkLine({ label, items, empty }: { label: string; items: ChipItem[]; empty?: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, CHIPS_SHOWN)
  const hidden = items.length - shown.length
  return (
    <div className="grid min-h-10 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-4 py-1">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 && empty ? (
          <span className="text-[13px] text-muted-foreground/70">{empty}</span>
        ) : (
          shown.map((item) => <Chip key={item.key} item={item} />)
        )}
        {items.length > CHIPS_SHOWN && (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="inline-flex h-7 cursor-pointer items-center rounded-lg px-2 text-[12.5px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          >
            {all ? 'Show fewer' : `+${hidden} more`}
          </button>
        )}
      </div>
    </div>
  )
}

/** A form line: label on the left (tied to the control), control on the right. */
export function FormLine({
  label,
  children
}: {
  label: string
  children: (id: string) => ReactElement
}) {
  const id = useId()
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-4">
      <label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  )
}

/**
 * One kind of connection in a record's side column: a quiet label, then each
 * related record as a row that opens it, or a plain line when there are none.
 */
/** A side panel's group shows this many, then "N more…" (Google can sign in to 30 sites). */
const GROUP_SHOWN = 5
/** A line of chips shows this many, then "+N more". */
const CHIPS_SHOWN = 8

export function RelatedGroup({ label, items, empty }: { label: string; items: ChipItem[]; empty: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, GROUP_SHOWN)
  const hidden = items.length - shown.length
  return (
    <div className="px-2 py-2.5">
      <p className="flex items-baseline justify-between px-2 pb-1 text-[12px] font-medium text-muted-foreground">
        {label}
        {items.length > GROUP_SHOWN && <span className="font-normal tabular-nums">{items.length}</span>}
      </p>
      {items.length === 0 ? (
        <p className="px-2 pt-0.5 pb-1 text-[13px] text-muted-foreground/70">{empty}</p>
      ) : (
        <ul>
          {shown.map((item) => {
            const ItemIcon = item.icon
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={item.onOpen}
                  className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 outline-none hover:bg-secondary/60 focus-visible:bg-secondary/60"
                >
                  {ItemIcon ? (
                    <span
                      aria-hidden="true"
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground dark:bg-white/8"
                    >
                      <ItemIcon size={14} />
                    </span>
                  ) : (
                    <SiteTile name={item.title} size="sm" className="size-7 rounded-lg text-[12px]" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-heading">{item.title}</span>
                    {item.detail && (
                      <span className="line-clamp-2 text-[12.5px] break-words text-muted-foreground">{item.detail}</span>
                    )}
                  </span>
                  <CaretRight
                    size={11}
                    weight="bold"
                    className="shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                  />
                </button>
              </li>
            )
          })}
          {items.length > GROUP_SHOWN && (
            <li>
              <button
                type="button"
                onClick={() => setAll(!all)}
                className="w-full cursor-pointer rounded-lg px-2 py-1.5 text-left text-[12.5px] text-muted-foreground transition-colors duration-100 hover:bg-secondary/60 hover:text-foreground"
              >
                {all ? 'Show fewer' : `${hidden} more…`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
