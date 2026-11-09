import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { Button, type ButtonProps } from './button'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/**
 * A square ghost icon button with a real tooltip naming the action (plus its
 * shortcut). `label` is also the accessible name.
 */
export function IconButton({
  label,
  shortcut,
  side = 'bottom',
  className,
  size = 'icon',
  variant = 'ghost',
  children,
  ...props
}: Omit<ButtonProps, 'aria-label' | 'children'> & {
  label: string
  /** Shown in the tooltip, e.g. "⌘K". */
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Optional when used as a Base UI `render` element (the part passes the icon). */
  children?: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size={size}
            aria-label={label}
            className={cn('rounded-lg active:scale-[0.94]', className)}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut && <kbd data-slot="kbd">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-secondary px-1 font-sans text-[11px] text-foreground',
        className
      )}
    >
      {children}
    </kbd>
  )
}
