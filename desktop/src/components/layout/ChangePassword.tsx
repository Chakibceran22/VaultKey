import { useRef, useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { StrengthMeter } from '@renderer/components/StrengthMeter'
import { Button } from '@renderer/components/ui/button'
import { Field, PasswordInput } from '@renderer/components/ui/input'
import { ModalForm } from '@renderer/components/ui/modal-form'
import { Modal, ModalBody, ModalFooter } from '@renderer/components/ui/overlays'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

/**
 * Changing the master password. The data doesn't change: Rust wraps the vault key with
 * the new password's key, checks it, and saves it in one transaction. The recovery code
 * keeps working. From here, a new recovery code can replace the current one.
 */
export function ChangePassword({
  open,
  onOpenChange,
  onNewRecoveryCode
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNewRecoveryCode: () => void
}) {
  const working = useRef(false)
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !working.current && onOpenChange(next)}
      title="Change master password"
      description="Your vault opens with the new one from now on."
    >
      {open && (
        <ChangePasswordForm working={working} onClose={() => onOpenChange(false)} onNewRecoveryCode={onNewRecoveryCode} />
      )}
    </Modal>
  )
}

function ChangePasswordForm({
  working,
  onClose,
  onNewRecoveryCode
}: {
  working: React.MutableRefObject<boolean>
  onClose: () => void
  onNewRecoveryCode: () => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <>
        <ModalBody>
          <div className="flex items-start gap-3 text-[13.5px] leading-relaxed">
            <CheckCircle size={22} weight="fill" className="mt-0.5 shrink-0 text-primary" />
            <div className="space-y-1.5">
              <p className="text-heading">Your vault now opens with the new master password.</p>
              <p className="text-muted-foreground">
                Your recovery code still works. Lock the vault and unlock it once with the new password to be sure you
                have it.
              </p>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </ModalFooter>
      </>
    )
  }

  return (
    <ModalForm
      submitLabel="Change password"
      onCancel={onClose}
      footerStart={
        <Button variant="ghost" onClick={onNewRecoveryCode}>
          New recovery code
        </Button>
      }
      save={async () => {
        if (!current) throw new Error('Enter your current master password.')
        if (next.length < 8) throw new Error('The new master password needs at least 8 characters.')
        if (next !== confirm) throw new Error('The new passwords don’t match.')
        if (next === current) throw new Error('The new password is the same as the current one.')
        working.current = true
        try {
          unwrap(await api.changeMasterPassword(current, next))
          setDone(true)
          toast.success('Master password changed')
        } finally {
          working.current = false
        }
      }}
    >
      <Field label="Current master password">
        {(id) => (
          <PasswordInput id={id} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
        )}
      </Field>
      <Field label="New master password" hint="At least 8 characters">
        {(id) => (
          <div className="space-y-2">
            <PasswordInput id={id} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {next && <StrengthMeter password={next} />}
          </div>
        )}
      </Field>
      <Field label="Confirm new master password">
        {(id) => <PasswordInput id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />}
      </Field>
      <p className="rounded-lg border border-dashed px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
        Nothing in the vault is rewritten: its key is locked with the new password instead, in one step that either
        fully happens or doesn’t. If it fails, your current password keeps working.
      </p>
    </ModalForm>
  )
}
