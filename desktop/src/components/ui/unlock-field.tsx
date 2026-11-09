import { useState } from 'react'
import type { ComponentProps, KeyboardEvent, Ref } from 'react'
import { ArrowRight, Eye, EyeSlash } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { IconButton } from './icon-button'
import { Spinner } from './misc'

/**
 * The lock screen's password field: a pill of strong glass with show/hide and,
 * optionally, the submit arrow inside it (the macOS login-window pattern).
 */
export function UnlockField({
  inputRef,
  label,
  submitLabel,
  busy = false,
  onCapsLockChange,
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'ref'> & {
  inputRef?: Ref<HTMLInputElement>
  label: string
  /** Shows the round arrow button inside the field. */
  submitLabel?: string
  busy?: boolean
  onCapsLockChange?: (on: boolean) => void
}) {
  const [shown, setShown] = useState(false)
  const reportCapsLock = (event: KeyboardEvent<HTMLInputElement>): void =>
    onCapsLockChange?.(event.getModifierState('CapsLock'))

  return (
    <div
      className={cn(
        'glass-strong flex h-[52px] items-center rounded-full pr-1.5 pl-5 outline-primary/25 transition-[outline-color] duration-150 focus-within:outline-4 focus-within:outline-solid',
        className
      )}
    >
      <input
        ref={inputRef}
        type={shown ? 'text' : 'password'}
        aria-label={label}
        placeholder={label}
        onKeyDown={reportCapsLock}
        onKeyUp={reportCapsLock}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-[15.5px] text-heading outline-none placeholder:text-muted-foreground focus-visible:outline-none',
          shown && 'font-mono text-[14.5px]'
        )}
        {...props}
      />
      <IconButton
        label={shown ? 'Hide password' : 'Show password'}
        size="icon-sm"
        className="rounded-full"
        onClick={() => setShown(!shown)}
      >
        {shown ? <EyeSlash size={16} /> : <Eye size={16} />}
      </IconButton>
      {submitLabel && (
        <button
          type="submit"
          aria-label={submitLabel}
          disabled={busy}
          className="ml-1 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_4px_12px_-4px_color-mix(in_oklab,var(--primary)_70%,transparent)] transition-[scale,background-color] duration-150 ease-smooth hover:bg-primary/90 active:scale-95 disabled:cursor-default motion-reduce:active:scale-100"
        >
          {busy ? <Spinner size={18} /> : <ArrowRight size={18} weight="bold" />}
        </button>
      )}
    </div>
  )
}
