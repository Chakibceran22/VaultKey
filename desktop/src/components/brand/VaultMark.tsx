import { useEffect, useState } from 'react'
import { m, useAnimationControls } from 'framer-motion'
import { cn } from '@renderer/lib/utils'

/*
 * The VaultKey mark: a combination-lock dial with a keyhole hub, on a 64-unit
 * grid centred on (32, 32). src-tauri/icons/app-icon.svg uses the same geometry.
 */
const HUB_WITH_KEYHOLE =
  'M32 22.4a9.6 9.6 0 1 1 0 19.2a9.6 9.6 0 1 1 0-19.2Z' +
  'M30.3 34.2A3.4 3.4 0 1 1 33.7 34.2L34.5 38.6C34.6 39.3 34.2 39.8 33.5 39.8H30.5C29.8 39.8 29.4 39.3 29.5 38.6Z'
const POINTER = 'M32 4.7l3.2 4.4h-6.4z'

/** The dial's graduations: 24 ticks, every sixth one long. */
const TICKS = Array.from({ length: 24 }, (_, i) => {
  const angle = (i * 15 * Math.PI) / 180
  const major = i % 6 === 0
  const r1 = major ? 13 : 14.6
  const r2 = 16.9
  return {
    major,
    x1: 32 + r1 * Math.sin(angle),
    y1: 32 - r1 * Math.cos(angle),
    x2: 32 + r2 * Math.sin(angle),
    y2: 32 - r2 * Math.cos(angle)
  }
})

/**
 * The lock screen's centrepiece: a frosted dial that reacts to what you do.
 * - `turns`: the ring turns one notch per character typed, like dialing a combination.
 * - `busy`: the ring spins while the key is derived.
 * - `shake`: bump it on a wrong password; the dial wobbles back and flashes red.
 * - `open`: the keyhole turns a quarter, like a key, as the vault opens.
 */
export function VaultDial({
  size = 132,
  turns = 0,
  busy = false,
  open = false,
  shake = 0,
  tone = 'primary'
}: {
  size?: number
  turns?: number
  busy?: boolean
  open?: boolean
  shake?: number
  tone?: 'primary' | 'destructive'
}) {
  const controls = useAnimationControls()
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (!shake) return
    setFlash(true)
    void controls.start({ x: [0, -9, 8, -6, 4, -2, 0], transition: { duration: 0.45, ease: 'easeOut' } })
    const timer = setTimeout(() => setFlash(false), 700)
    return () => clearTimeout(timer)
  }, [shake, controls])

  const angle = turns * 15
  const color = tone === 'destructive' || flash ? 'text-destructive' : 'text-primary'

  return (
    <m.div animate={controls} className="relative" style={{ width: size, height: size }}>
      <m.div
        animate={{ scale: open ? 1.06 : 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="glass-strong absolute inset-0 rounded-full"
      />
      <m.svg
        viewBox="0 0 64 64"
        aria-hidden="true"
        animate={{ scale: open ? 1.06 : 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className={cn('relative size-full p-[9%] transition-colors duration-300', color)}
      >
        <circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" strokeWidth="3.4" />
        <path d={POINTER} fill="currentColor" />
        <m.g
          animate={busy ? { rotate: [angle, angle + 360] } : { rotate: angle }}
          transition={
            busy
              ? { duration: 1.1, ease: 'linear', repeat: Infinity }
              : { type: 'spring', stiffness: 220, damping: 18 }
          }
          stroke="currentColor"
          strokeLinecap="round"
        >
          {TICKS.map((tick, i) => (
            <line
              key={i}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              strokeWidth={tick.major ? 1.8 : 1.1}
              strokeOpacity={tick.major ? 0.95 : 0.45}
            />
          ))}
        </m.g>
        <m.path
          d={HUB_WITH_KEYHOLE}
          fill="currentColor"
          fillRule="evenodd"
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 16 }}
        />
      </m.svg>
    </m.div>
  )
}
