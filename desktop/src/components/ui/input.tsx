import { useId, useState } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Eye, EyeSlash } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { IconButton } from './icon-button'

const inputClass =
  'h-10 w-full min-w-0 rounded-lg border border-input bg-background/60 px-3 text-[14px] text-heading transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-3 focus-visible:ring-primary/15 focus-visible:outline-none aria-invalid:border-destructive/60 dark:bg-background/30'

/** Single-line text field in DevNotes' vocabulary. */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(inputClass, className)}
      // WebKit (unlike Electron's Chromium) can autocorrect, smart-quote or autofill
      // text inputs, including revealed passwords. Never let it rewrite a secret.
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      {...props}
    />
  )
}

/** A password field with a show/hide toggle inside it. */
export function PasswordInput({
  className,
  revealed,
  onRevealedChange,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
}) {
  const [ownRevealed, setOwnRevealed] = useState(false)
  const shown = revealed ?? ownRevealed
  const setShown = onRevealedChange ?? setOwnRevealed
  return (
    <div className="relative">
      <Input
        type={shown ? 'text' : 'password'}
        className={cn('pr-11', shown && 'font-mono text-[13.5px] tracking-[0.01em]', className)}
        {...props}
      />
      <IconButton
        label={shown ? 'Hide password' : 'Show password'}
        size="icon-sm"
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        onClick={() => setShown(!shown)}
      >
        {shown ? <EyeSlash size={16} /> : <Eye size={16} />}
      </IconButton>
    </div>
  )
}

/** A visible label tied to its control, with an optional hint on the right. */
export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: (id: string) => ReactElement
}) {
  const id = useId()
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-heading">
          {label}
        </label>
        {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      </div>
      {children(id)}
    </div>
  )
}
