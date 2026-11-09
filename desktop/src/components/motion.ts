import type { TargetAndTransition, Variants } from 'framer-motion'

/** DevNotes' page entrance: children rise in one after another. */
export const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035 } }
}

export const item: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 0.08, 0.25, 1] } }
}

/** A short "no" shake, for rejected input. */
export const shakeX: TargetAndTransition = {
  x: [0, -10, 9, -6, 4, -2, 0],
  transition: { duration: 0.42, ease: 'easeOut' }
}
