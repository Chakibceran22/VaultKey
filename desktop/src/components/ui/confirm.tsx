/**
 * Named confirmations on the same glass as every other panel (DevNotes'
 * useConfirm): the thing is named in the question, the verb is on the button.
 *
 *   const { confirm, dialog } = useConfirm()
 *   if (await confirm({ title: 'Delete “github.com”?', confirmLabel: 'Delete domain', destructive: true })) …
 *   …and render {dialog} once.
 */
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { useCallback, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button } from './button'

export const backdropClass = 'backdrop-motion fixed inset-0 z-50 bg-black/10 dark:bg-black/30'
export const popupClass =
  'glass-strong panel-motion fixed top-[16vh] left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-2xl p-5 text-popover-foreground outline-none'

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
}

export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  dialog: ReactElement
} {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [open, setOpen] = useState(false)
  const resolver = useRef<((value: boolean) => void) | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value)
    resolver.current = null
    setOpen(false)
  }, [])

  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false)
    setOptions(next)
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const dialog = (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && settle(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdropClass} />
        <AlertDialog.Popup
          // A destructive question starts on the safe answer.
          initialFocus={options?.destructive ? cancelRef : undefined}
          className={popupClass}
        >
          <AlertDialog.Title className="font-heading text-[17px] leading-snug font-semibold tracking-[-0.01em] text-heading">
            {options?.title}
          </AlertDialog.Title>
          {options?.description && (
            <AlertDialog.Description className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
              {options.description}
            </AlertDialog.Description>
          )}
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <Button ref={cancelRef} size="lg" onClick={() => settle(false)}>
              {options?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              size="lg"
              variant={options?.destructive ? 'destructive' : 'primary'}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )

  return { confirm, dialog }
}
