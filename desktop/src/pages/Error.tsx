import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowClockwise } from '@phosphor-icons/react'
import { useAppInit } from '@renderer/store/app'
import { AuthStatus } from '@renderer/types'
import { VaultDial } from '@renderer/components/brand/VaultMark'
import { LockScreen } from '@renderer/components/layout/LockScreen'
import { Spinner } from '@renderer/components/ui/misc'

export default function ErrorPage(): React.ReactElement {
  const [isRetrying, setIsRetrying] = useState(false)
  const [shake, setShake] = useState(0)
  const navigate = useNavigate()
  const { checkAuthStatus } = useAppInit()

  const handleRetry = async (): Promise<void> => {
    setIsRetrying(true)
    try {
      const status = await checkAuthStatus()
      if (status === AuthStatus.NEEDS_SIGNUP) {
        navigate('/signup', { replace: true })
      } else if (status === AuthStatus.NEEDS_LOGIN) {
        navigate('/login', { replace: true })
      }
    } catch {
      // Still failing: stay here.
      setShake((count) => count + 1)
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <LockScreen
      hero={<VaultDial tone="destructive" busy={isRetrying} shake={shake} />}
      title="Local Vault Error"
      subtitle="VaultKey could not open its local database. Check the app data directory and retry."
      footnote="Your vault data stays on this device"
    >
      <button
        type="button"
        onClick={handleRetry}
        disabled={isRetrying}
        className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-medium text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition-[scale,background-color] duration-150 ease-smooth hover:bg-primary/90 active:scale-[0.98] disabled:cursor-default disabled:opacity-70 motion-reduce:active:scale-100"
      >
        {isRetrying ? (
          <>
            <Spinner size={17} />
            Retrying…
          </>
        ) : (
          <>
            Retry Vault
            <ArrowClockwise size={16} weight="bold" />
          </>
        )}
      </button>
    </LockScreen>
  )
}
