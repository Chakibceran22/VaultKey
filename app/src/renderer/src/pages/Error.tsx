import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldAlert, RefreshCw } from 'lucide-react'
import { useAppInit } from '@renderer/store/app'

export default function Error() {
  const [isRetrying, setIsRetrying] = useState(false)
  const navigate = useNavigate()
  const { checkAuthStatus } = useAppInit()

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      const status = await checkAuthStatus()
      if (status === 'needs_signup') {
        navigate('/signup', { replace: true })
      } else if (status === 'needs_login') {
        navigate('/login', { replace: true })
      }
    } catch {
      // Still failing, stay on error page
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-crust">
      <div className="w-full max-w-sm mx-auto px-6">
        <div className="flex flex-col items-center mb-10">
          <div className="w-20 h-20 rounded-2xl bg-red/10 flex items-center justify-center mb-5 ring-1 ring-red/20">
            <ShieldAlert className="w-10 h-10 text-red" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Connection Error</h1>
          <p className="text-sm text-muted-foreground mt-1.5 text-center">
            Could not connect to the server. Make sure the backend is running.
          </p>
        </div>

        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="w-full h-12 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:brightness-110 transition-all disabled:opacity-50 cursor-pointer"
        >
          {isRetrying ? (
            <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
          ) : (
            <>
              Retry Connection
              <RefreshCw className="w-4 h-4" />
            </>
          )}
        </button>

        <p className="text-xs text-surface2 text-center mt-8">
          The app will reconnect once the server is available
        </p>
      </div>
    </div>
  )
}
