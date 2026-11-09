import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { m, useAnimationControls } from 'framer-motion'
import { ArrowRight } from '@phosphor-icons/react'
import { VaultDial } from '@renderer/components/brand/VaultMark'
import { CapsLockHint, LockScreen } from '@renderer/components/layout/LockScreen'
import { StrengthMeter } from '@renderer/components/StrengthMeter'
import { Spinner } from '@renderer/components/ui/misc'
import { UnlockField } from '@renderer/components/ui/unlock-field'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'
import { shakeX } from '@renderer/components/motion'

export default function Signup(): React.ReactElement {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [shake, setShake] = useState(0)
  const [capsLock, setCapsLock] = useState(false)
  const fields = useAnimationControls()
  const navigate = useNavigate()

  const reject = (message: string): void => {
    toast.error(message)
    setShake((count) => count + 1)
    void fields.start(shakeX)
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()

    if (!password) {
      reject('Please enter a master password')
      return
    }
    if (password.length < 8) {
      reject('Master password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      reject('Passwords do not match')
      return
    }

    setIsLoading(true)
    try {
      // Key derivation and the verifier are computed in Rust; nothing secret is stored.
      unwrap(await api.createVault(password))
      toast.success('Master password created successfully!')
      navigate('/login')
    } catch {
      reject('Failed to create the local vault.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <LockScreen
      hero={<VaultDial turns={password.length} busy={isLoading} shake={shake} />}
      title="Create your vault"
      subtitle="Choose a master password. It can’t be recovered, so make it one you’ll remember."
      footnote="Your master password never leaves this device"
    >
      <form onSubmit={handleSubmit}>
        <m.div animate={fields} className="space-y-3">
          <UnlockField
            label="Master password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onCapsLockChange={setCapsLock}
            autoFocus
          />
          <UnlockField
            label="Confirm master password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onCapsLockChange={setCapsLock}
          />
        </m.div>
        <div className="mt-4 px-2 text-left">
          <StrengthMeter password={password} />
        </div>
        <button
          type="submit"
          disabled={isLoading}
          className="mt-3 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-medium text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_6px_18px_-6px_color-mix(in_oklab,var(--primary)_70%,transparent)] transition-[scale,background-color] duration-150 ease-smooth hover:bg-primary/90 active:scale-[0.98] disabled:cursor-default disabled:opacity-70 motion-reduce:active:scale-100"
        >
          {isLoading ? (
            <>
              <Spinner size={17} />
              Creating vault…
            </>
          ) : (
            <>
              Create Vault
              <ArrowRight size={16} weight="bold" />
            </>
          )}
        </button>
        <CapsLockHint on={capsLock} />
      </form>
    </LockScreen>
  )
}
