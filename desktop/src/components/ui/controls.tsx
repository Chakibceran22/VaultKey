import { useRef, useState } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import type { ComponentProps } from 'react'
import { MagnifyingGlass, PencilSimple, X } from '@phosphor-icons/react'
import type { AccountSummary } from '@renderer/shared/contracts'
import { cn } from '@renderer/lib/utils'
import { IconButton, Kbd } from './icon-button'
import { SiteTile } from './misc'

const fieldClass =
  'w-full min-w-0 rounded-lg border border-input bg-background/60 px-3 text-[14px] text-heading transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-3 focus-visible:ring-primary/15 focus-visible:outline-none dark:bg-background/30'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(fieldClass, 'min-h-28 resize-y py-2.5 leading-relaxed', className)}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      {...props}
    />
  )
}

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(fieldClass, 'h-10 cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  )
}

/** A choice between a few options, as one control (radio semantics). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded-lg border bg-secondary/70 p-0.5', className)}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-7 rounded-md px-3 text-[13px] font-medium transition-[color,background-color,box-shadow] duration-150',
              checked
                ? 'bg-white text-heading shadow-[0_1px_2px_rgb(30_34_70/0.07)] dark:bg-white/12 dark:shadow-none'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** The page-level search: a visible icon and label, "/" focuses it. */
export function SearchField({
  inputRef,
  value,
  onChange,
  placeholder,
  onKeyDown,
  ...props
}: Omit<ComponentProps<'input'>, 'onChange' | 'value' | 'ref'> & {
  inputRef?: React.Ref<HTMLInputElement>
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div className="frost flex h-11 items-center gap-2.5 rounded-xl px-3.5 transition-[box-shadow] focus-within:ring-3 focus-within:ring-primary/15">
      <MagnifyingGlass size={17} className="shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-heading outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        {...props}
      />
      {value ? (
        <IconButton label="Clear search" size="icon-sm" className="-mr-1.5" onClick={() => onChange('')}>
          <X size={14} />
        </IconButton>
      ) : (
        <Kbd className="bg-background/50">/</Kbd>
      )}
    </div>
  )
}

/**
 * Choose one or more of the vault's accounts by typing. Chosen accounts are
 * listed above the search, each removable.
 *
 * The suggestions are a Base UI combobox popup: portaled out of the form, so a
 * dialog's scrolling body can't clip them, flipped above the field when there is
 * no room below, and part of the dialog's layer stack, so picking one doesn't
 * count as a click outside the dialog.
 */
export function AccountPicker({
  accounts,
  selected,
  onChange,
  multiple = false,
  excludeId,
  placeholder = 'Search accounts',
  notes
}: {
  accounts: AccountSummary[]
  selected: number[]
  onChange: (selected: number[]) => void
  multiple?: boolean
  excludeId?: number
  placeholder?: string
  /** A short note per chosen account (what it is for there), edited in its row. */
  notes?: {
    value: (accountId: number) => string
    onChange: (accountId: number, note: string) => void
    placeholder: string
    label: (account: AccountSummary) => string
  }
}) {
  const [query, setQuery] = useState('')

  const chosen = selected
    .map((id) => accounts.find((a) => a.id === id))
    .filter((a): a is AccountSummary => !!a)
  const available = accounts.filter((a) => a.id !== excludeId && !selected.includes(a.id))
  const needle = query.trim().toLowerCase()
  const options = available
    .filter((a) => !needle || `${a.domainName} ${a.email} ${a.username ?? ''}`.toLowerCase().includes(needle))
    .slice(0, 40)

  const pick = (account: AccountSummary): void => {
    onChange(multiple ? [...selected, account.id] : [account.id])
    setQuery('')
  }

  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <ul className="space-y-1.5">
          {chosen.map((account) => (
            <li key={account.id} className={cn('frost rounded-lg pr-1.5 pl-2.5', notes && 'pb-2')}>
              <div className="flex h-11 items-center gap-3">
                <SiteTile name={account.domainName} size="sm" className="size-7 rounded-[8px] text-[12px]" />
                <span className="min-w-0 flex-1 truncate text-[13.5px]">
                  <span className="font-medium text-heading">{account.domainName}</span>
                  <span className="ml-2 text-muted-foreground">{account.email}</span>
                </span>
                <IconButton
                  label={`Remove ${account.domainName}`}
                  size="icon-sm"
                  onClick={() => onChange(selected.filter((id) => id !== account.id))}
                >
                  <X size={13} />
                </IconButton>
              </div>
              {notes && (
                <input
                  aria-label={notes.label(account)}
                  placeholder={notes.placeholder}
                  value={notes.value(account.id)}
                  maxLength={200}
                  onChange={(event) => notes.onChange(account.id, event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(fieldClass, 'ml-10 h-8 w-[calc(100%-2.5rem-0.375rem)] text-[13px]')}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {(multiple || chosen.length === 0) && (
        <Combobox.Root
          items={available}
          filteredItems={options}
          // Picking adds the account (above); the search itself never holds a value.
          value={null}
          onValueChange={(account: AccountSummary | null) => {
            if (account) pick(account)
          }}
          inputValue={query}
          onInputValueChange={(value, details) => {
            // Don't put the picked account's name in the search box.
            if (details.reason !== 'item-press') setQuery(value)
          }}
          itemToStringLabel={(account: AccountSummary) => account.domainName}
          isItemEqualToValue={(a: AccountSummary, b: AccountSummary) => a.id === b.id}
          autoHighlight
        >
          <Combobox.Input
            placeholder={chosen.length ? 'Add another account' : placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(fieldClass, 'h-10')}
          />
          <Combobox.Portal>
            <Combobox.Positioner sideOffset={6} collisionPadding={12} className="z-[300] outline-none">
              <Combobox.Popup className="glass max-h-[min(15rem,var(--available-height))] w-(--anchor-width) overflow-y-auto overscroll-contain rounded-xl p-1 outline-none">
                <Combobox.Empty className="px-3 py-2 text-[13px] text-muted-foreground empty:hidden">
                  {options.length === 0 ? 'No matching account' : null}
                </Combobox.Empty>
                <Combobox.List>
                  {(account: AccountSummary) => (
                    <Combobox.Item
                      key={account.id}
                      value={account}
                      className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[13.5px] outline-none data-highlighted:bg-primary/10 dark:data-highlighted:bg-primary/15"
                    >
                      <SiteTile name={account.domainName} size="sm" className="size-6 rounded-[7px] text-[11px]" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-heading">{account.domainName}</span>
                        <span className="ml-2 text-muted-foreground">{account.email}</span>
                      </span>
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
      )}
    </div>
  )
}

/**
 * Edits one value where it is shown. Display and input share a single grid
 * cell, so nothing around it moves. Enter or leaving the field saves; Esc
 * cancels; an unchanged value is a no-op.
 */
export function InlineEdit({
  value,
  label,
  placeholder,
  onSave,
  className
}: {
  value: string
  /** Accessible name, e.g. "Project name". */
  label: string
  placeholder: string
  onSave: (value: string) => Promise<void> | void
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const settled = useRef(false)

  const start = (): void => {
    settled.current = false
    setText(value)
    setEditing(true)
  }
  const finish = (save: boolean): void => {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    if (save && text.trim() !== value.trim()) void onSave(text)
  }

  return (
    <span className={cn('group/inline inline-grid max-w-full align-top', className)}>
      <button
        type="button"
        onClick={start}
        aria-label={`Edit ${label.toLowerCase()}`}
        className={cn(
          'col-start-1 row-start-1 -mx-1 flex min-w-0 cursor-text items-center gap-2 rounded-md px-1 text-left [font:inherit] outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-primary/40',
          editing && 'invisible',
          !value && 'text-muted-foreground'
        )}
      >
        <span className="truncate">{value || placeholder}</span>
        <PencilSimple
          size={14}
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/inline:opacity-100 group-focus-within/inline:opacity-100"
        />
      </button>
      {editing && (
        <input
          autoFocus
          value={text}
          aria-label={label}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finish(true)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              finish(false)
            }
          }}
          onBlur={() => finish(true)}
          autoComplete="off"
          spellCheck={false}
          className="col-start-1 row-start-1 -mx-1 min-w-[16ch] rounded-md bg-background/70 px-1 text-inherit ring-2 ring-primary/45 outline-none [font:inherit] [letter-spacing:inherit] dark:bg-background/40"
        />
      )}
    </span>
  )
}
