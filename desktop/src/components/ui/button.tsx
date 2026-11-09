import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@renderer/lib/utils'

/** DevNotes' action buttons: rounded-lg, 13–14px, a soft press-in. */
const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap select-none outline-none transition-[color,background-color,border-color,box-shadow,scale,opacity] duration-150 ease-smooth focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.97] disabled:pointer-events-none disabled:opacity-55 motion-reduce:active:scale-100 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(30_34_70/0.14)] hover:bg-primary/90',
        secondary:
          'border bg-secondary/60 text-foreground hover:border-primary/40 hover:text-primary',
        ghost: 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        destructive: 'bg-destructive text-white hover:bg-destructive/90 dark:text-background',
        'destructive-ghost': 'text-destructive hover:bg-destructive/10'
      },
      size: {
        sm: 'h-7 px-2.5 text-[12.5px]',
        md: 'h-8 px-3 text-[13px]',
        lg: 'h-9 px-3.5 text-[13.5px]',
        xl: 'h-11 px-4 text-[14.5px] rounded-xl',
        icon: 'size-8',
        'icon-sm': 'size-7'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
}
