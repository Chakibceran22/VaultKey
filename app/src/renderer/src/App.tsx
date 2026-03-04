import { useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Toaster } from 'sonner'
import { useAuth } from './store/auth'
import { useAppStore, useAppInit } from './store/app'
import { AuthStatus } from './types'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Vault from './pages/Vault'
import DomainDetail from './pages/DomainDetail'
import AddCredential from './pages/AddCredential'
import AddDomain from './pages/AddDomain'
import Error from './pages/Error'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

function LoadingScreen() {
  return (
    <div className="flex h-full items-center justify-center bg-crust">
      <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  )
}

function AppInit() {
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
  }, [])

  if (status === 'loading') return <LoadingScreen />
  return null
}

function AppRoutes() {
  const { isAuthenticated } = useAuth()

  return (
    <Routes>
      <Route path="/" element={<AppInit />} />
      <Route path="/signup" element={<Signup />} />
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/vault" replace /> : <Login />}
      />
      <Route
        path="/vault"
        element={
          <ProtectedRoute>
            <Vault />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vault/:domain"
        element={
          <ProtectedRoute>
            <DomainDetail />
          </ProtectedRoute>
        }
      />
      <Route
        path="/add-domain"
        element={
          <ProtectedRoute>
            <AddDomain />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vault/:domain/add"
        element={
          <ProtectedRoute>
            <AddCredential />
          </ProtectedRoute>
        }
      />
      <Route path="/error" element={<Error />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <div className="h-full w-full bg-base text-foreground">
          <Toaster
            position="bottom-right"
            theme="dark"
            icons={{ success: undefined, error: undefined }}
          />
          <AppRoutes />
        </div>
      </HashRouter>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
