import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { toast } from '@renderer/lib/toast'
import { Button } from './button'
import { Spinner } from './misc'
import { ModalBody, ModalFooter } from './overlays'

/**
 * The form inside a modal: submit runs `save`; while it runs the button shows a
 * spinner, and a failure stays in the form (as a toast) so nothing typed is lost.
 */
export function ModalForm({
  submitLabel,
  onCancel,
  save,
  footerStart,
  children
}: {
  submitLabel: string
  onCancel: () => void
  save: () => Promise<void>
  /** Left side of the footer, e.g. a destructive action. */
  footerStart?: ReactNode
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await save()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <ModalBody>{children}</ModalBody>
      <ModalFooter>
        {footerStart && <div className="mr-auto">{footerStart}</div>}
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy && <Spinner size={14} />}
          {submitLabel}
        </Button>
      </ModalFooter>
    </form>
  )
}
