import { useRef, useState } from 'react'
import { m, useAnimationControls } from 'framer-motion'
import { useAuth } from '@renderer/store/auth'
import { VaultDial } from '@renderer/components/brand/VaultMark'
import { CapsLockHint, LockScreen } from '@renderer/components/layout/LockScreen'
import { UnlockField } from '@renderer/components/ui/unlock-field'
import { toast } from '@renderer/lib/toast'
import { shakeX } from '@renderer/components/motion'

export default function Login(): React.ReactElement {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [shake, setShake] = useState(0)
  const [capsLock, setCapsLock] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const field = useAnimationControls()
  const { login } = useAuth()

  const reject = (message: string): void => {
    toast.error(message)
    setShake((count) => count + 1)
    void field.start(shakeX)
    // Like the macOS login window: clear the field and try again.
    setPassword('')
    inputRef.current?.focus()
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || open) return
    if (!password) {
      reject('Please enter your master password')
      return
    }

    setBusy(true)
    try {
      // Argon2id runs natively in Rust off the UI thread; the dial spins meanwhile.
      const valid = await login(password, async () => {
        setBusy(false)
        setOpen(true)
        await new Promise((resolve) => setTimeout(resolve, 560))
      })
      if (!valid) reject('Wrong Password')
    } catch {
      reject('Failed to verify the master password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <LockScreen
      hero={<VaultDial turns={password.length} busy={busy} open={open} shake={shake} />}
      title="Welcome back"
      subtitle="Enter your master password to unlock your vault"
      footnote="Your master password never leaves this device"
    >
      <form onSubmit={handleSubmit}>
        <m.div animate={field}>
          <UnlockField
            inputRef={inputRef}
            label="Master password"
            submitLabel="Unlock"
            busy={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onCapsLockChange={setCapsLock}
            disabled={open}
            autoFocus
          />
        </m.div>
        <CapsLockHint on={capsLock} />
      </form>
    </LockScreen>
  )
}
