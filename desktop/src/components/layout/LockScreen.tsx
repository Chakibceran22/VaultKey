import type { ReactNode } from 'react'
import { m } from 'framer-motion'
import { container, item } from '@renderer/components/motion'
import { ThemeToggle } from './ThemeToggle'

/**
 * Login, signup and the error screen: no card. A hero (the dial) floats over
 * drifting aurora light, then the title and a single column of glass controls.
 */
export function LockScreen({
  hero,
  title,
  subtitle,
  children
}: {
  hero: ReactNode
  title: string
  subtitle: string
  footnote?: string
  children: ReactNode
}) {
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      {/* Drags the window; 56 px tall so its controls centre on the traffic lights. */}
      <div data-tauri-drag-region className="relative z-10 flex h-14 shrink-0 items-center justify-end px-3">
        <ThemeToggle />
      </div>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-16">
        <m.div
          variants={container}
          initial="hidden"
          animate="show"
          className="flex w-full max-w-[380px] flex-col items-center text-center"
        >
          <m.div
            variants={{
              hidden: { opacity: 0, scale: 0.85, y: 10 },
              show: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 200, damping: 20 } }
            }}
          >
            {hero}
          </m.div>
          <m.h1
            variants={item}
            className="mt-9 font-heading text-[30px] leading-tight font-bold tracking-[-0.03em] text-heading"
          >
            {title}
          </m.h1>
          <m.p variants={item} className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
            {subtitle}
          </m.p>
          <m.div variants={item} className="mt-9 w-full">
            {children}
          </m.div>
        </m.div>
      </main>

      
    </div>
  )
}

/** Reserved line under the fields: the Caps Lock warning, without layout shift. */
export function CapsLockHint({ on }: { on: boolean }) {
  return (
    <p aria-live="polite" className="mt-3 h-5 text-[12.5px] font-medium text-warning">
      {on ? 'Caps Lock is on' : ''}
    </p>
  )
}
