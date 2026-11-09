import { CircleNotch } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'

const tileSizes = {
  sm: 'size-8 rounded-[9px] text-[13px]',
  md: 'size-10 rounded-xl text-[15px]',
  lg: 'size-12 rounded-[14px] text-[18px]',
  xl: 'size-16 rounded-[18px] text-[24px]'
} as const

/** A website's monogram: muted, one tint for every site. */
export function SiteTile({
  name,
  size = 'md',
  className
}: {
  name: string
  size?: keyof typeof tileSizes
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center bg-primary/10 font-semibold text-primary uppercase dark:bg-primary/15',
        tileSizes[size],
        className
      )}
    >
      {name.trim()[0] ?? '?'}
    </span>
  )
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <CircleNotch
      size={size}
      aria-hidden="true"
      className={cn('animate-spin motion-reduce:animate-none', className)}
    />
  )
}
