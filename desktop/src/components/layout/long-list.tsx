import { useEffect, useState } from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { plural } from '@renderer/hooks/use-vault'
import { isOverlayOpen, isTyping } from '@renderer/lib/dom'
import { EmptyLine } from './page'

/*
 * Every list that can grow (services, secrets, files, an account's secrets and notes)
 * behaves the same way from a handful of items to fifty:
 *
 *   - the first few are shown, then "26 more…" and "Show all 34";
 *   - from a handful on, a filter in the section header (and "/" jumps to it), which
 *     always searches everything, shown or not;
 *   - the footer counts ("3 of 40 secrets"); a filter that matches nothing says so.
 */

/** Rows shown before "Show all". */
export const SHOWN = 8
/** The filter appears from this many items. */
export const FILTER_FROM = 7

export interface LongList<T> {
  query: string
  setQuery: (query: string) => void
  needle: string
  total: number
  matching: T[]
  visible: T[]
  hidden: number
  all: boolean
  setAll: (all: boolean) => void
  filterable: boolean
}

/** `text` is everything the filter searches for an item: its name, description… */
export function useLongList<T>(items: T[], text: (item: T) => string, shown = SHOWN): LongList<T> {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const needle = query.trim().toLowerCase()
  const matching = needle ? items.filter((item) => text(item).toLowerCase().includes(needle)) : items
  const visible = needle || all ? matching : matching.slice(0, shown)
  return {
    query,
    setQuery,
    needle,
    total: items.length,
    matching,
    visible,
    hidden: matching.length - visible.length,
    all,
    setAll,
    filterable: items.length >= FILTER_FROM
  }
}

/** The filter, for a section header. Nothing until the list is long enough to need it. */
export function ListFilter({ list, label }: { list: LongList<unknown>; label: string }) {
  if (!list.filterable) return null
  return (
    <label className="frost flex h-8 w-52 items-center gap-2 rounded-lg px-2.5 transition-[box-shadow] focus-within:ring-3 focus-within:ring-primary/15">
      <MagnifyingGlass size={14} className="shrink-0 text-muted-foreground" />
      <input
        data-list-filter
        value={list.query}
        onChange={(e) => list.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && list.query) {
            e.preventDefault()
            e.stopPropagation()
            list.setQuery('')
          }
        }}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
      {list.query && (
        <button
          type="button"
          aria-label="Clear the filter"
          onClick={() => list.setQuery('')}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <X size={12} weight="bold" />
        </button>
      )}
    </label>
  )
}

/** The footer: how many (of how many), and "Show all" / "Show fewer". */
export function listFooter(list: LongList<unknown>, noun: string) {
  if (list.total === 0) return undefined
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{list.needle ? `${list.matching.length} of ${plural(list.total, noun)}` : plural(list.total, noun)}</span>
      {!list.needle && list.total > SHOWN && (
        <button
          type="button"
          onClick={() => list.setAll(!list.all)}
          className="cursor-pointer font-medium text-primary hover:underline"
        >
          {list.all ? 'Show fewer' : `Show all ${list.total}`}
        </button>
      )}
    </div>
  )
}

/** The last row while some are hidden: "26 more secrets…". */
export function MoreLine({ list, noun }: { list: LongList<unknown>; noun: string }) {
  if (list.hidden <= 0) return null
  return (
    <li>
      <button
        type="button"
        onClick={() => list.setAll(true)}
        className="h-9 w-full cursor-pointer px-4 text-left text-[13px] text-muted-foreground hover:bg-secondary/40 hover:text-foreground"
      >
        {plural(list.hidden, `more ${noun}`)}…
      </button>
    </li>
  )
}

/** A filter that matches nothing. */
export function NoMatchLine({ list, searches }: { list: LongList<unknown>; searches: string }) {
  if (!list.needle || list.matching.length > 0 || list.total === 0) return null
  return (
    <EmptyLine title={`Nothing matches “${list.query.trim()}”.`}>It looks in {searches}.</EmptyLine>
  )
}

/** "/" jumps to the page's first list filter (when it has one). */
export function useSlashToFilter(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || isTyping(event.target) || isOverlayOpen()) return
      const filter = document.querySelector<HTMLInputElement>('[data-list-filter]')
      if (!filter) return
      event.preventDefault()
      filter.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
