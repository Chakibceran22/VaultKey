import { useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { LazyMotion, MotionConfig, domMax } from 'framer-motion'
import { isTauri } from '@tauri-apps/api/core'
import { IS_MAC } from './lib/dom'
import { useAuth } from './store/auth'
import { useAppStore, useAppInit } from './store/app'
import { AuthStatus } from './types'
import { Toaster } from './components/ui/toaster'
import { TooltipProvider } from './components/ui/tooltip'
import { Spinner } from './components/ui/misc'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Accounts from './pages/Accounts'
import AccountPage from './pages/Account'
import Devices from './pages/Devices'
import Projects from './pages/Projects'
import ProjectPage from './pages/Project'
import { AppFrame } from './components/layout/AppFrame'
import ErrorPage from './pages/Error'
import { queryClient } from './lib/queryClient'

function ProtectedRoute({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

/** The status check takes a few ms; the spinner only fades in if it doesn't. */
function LoadingScreen(): React.ReactElement {
  return (
    <div className="relative flex h-full items-center justify-center">
      <Spinner size={20} className="relative text-primary [animation:rise-in_300ms_var(--ease-smooth)_300ms_both]" />
    </div>
  )
}

function AppInit(): React.ReactElement | null {
  const status = useAppStore((s) => s.status)
  const { checkAuthStatus } = useAppInit()
  const navigate = useNavigate()

  useEffect(() => {
    checkAuthStatus()
      .then((result) => {
        if (result === AuthStatus.NEEDS_SIGNUP) {
          navigate('/signup', { replace: true })
        } else {
          navigate('/login', { replace: true })
        }
      })
      .catch(() => {
        navigate('/error', { replace: true })
      })
  }, [checkAuthStatus, navigate])

  if (status === 'loading') return <LoadingScreen />
  return null
}

function AppRoutes(): React.ReactElement {
  const { isAuthenticated } = useAuth()

  return (
    <Routes>
      <Route path="/" element={<AppInit />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/login" element={isAuthenticated ? <Navigate to="/accounts" replace /> : <Login />} />
      <Route path="/error" element={<ErrorPage />} />
      {/* Behind the lock: one top bar, then Accounts, Projects or Devices. */}
      <Route
        element={
          <ProtectedRoute>
            <AppFrame />
          </ProtectedRoute>
        }
      >
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:accountId" element={<AccountPage />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
      </Route>
      <Route path="/vault" element={<Navigate to="/accounts" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/** Browser preview only (pnpm dev in a normal tab): stand-ins for the macOS
 *  traffic lights at their real position, and a badge so made-up preview data
 *  is never mistaken for the vault. */
function BrowserPreviewChrome(): React.ReactElement {
  return (
    <>
      {IS_MAC && (
        <div aria-hidden="true" className="pointer-events-none fixed top-[21px] left-[18px] z-[100] flex gap-2 opacity-80">
          <span className="size-3.5 rounded-full bg-[#ff5f57]" />
          <span className="size-3.5 rounded-full bg-[#febc2e]" />
          <span className="size-3.5 rounded-full bg-[#28c840]" />
        </div>
      )}
      <div className="pointer-events-none fixed bottom-3 left-3 z-[100] rounded-full border border-warning/40 bg-warning/15 px-3 py-1 text-[11.5px] font-medium text-warning backdrop-blur">
        Browser preview · made-up data, not your vault
      </div>
    </>
  )
}

export default function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      {/* domMax: layout animations (the sidebar's sliding highlight). */}
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <TooltipProvider>
            <HashRouter>
              <div className="h-full w-full text-foreground">
                <AppRoutes />
              </div>
              <Toaster />
              {import.meta.env.DEV && !isTauri() && <BrowserPreviewChrome />}
            </HashRouter>
          </TooltipProvider>
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  )
}
