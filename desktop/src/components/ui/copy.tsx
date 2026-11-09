import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { Check, Copy } from '@phosphor-icons/react'
import { writeSecret, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { toast } from '@renderer/lib/toast'
import { IconButton } from './icon-button'

/**
 * Copies a value (or one fetched on demand, e.g. decrypted only when asked) to
 * the native clipboard. Secrets are marked concealed, which keeps them out of
 * clipboard history. The icon pops to a check to confirm.
 */
export function CopyAction({
  label,
  value,
  secret = false,
  disabled = false
}: {
  label: string
  value: string | (() => Promise<string>)
  secret?: boolean
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async (): Promise<void> => {
    try {
      const text = typeof value === 'string' ? value : await value()
      await (secret ? writeSecret(text) : writeText(text))
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Couldn’t copy to the clipboard')
    }
  }

  return (
    <IconButton label={copied ? 'Copied' : label} size="icon-sm" disabled={disabled} onClick={() => void copy()}>
      <AnimatePresence mode="wait" initial={false}>
        <m.span
          key={copied ? 'done' : 'copy'}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 600, damping: 28 }}
          className="flex"
        >
          {copied ? <Check size={15} weight="bold" className="text-primary" /> : <Copy size={15} />}
        </m.span>
      </AnimatePresence>
    </IconButton>
  )
}
