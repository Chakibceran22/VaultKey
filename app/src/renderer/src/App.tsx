import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import Login from './pages/Login'
import Vault from './pages/Vault'
import DomainDetail from './pages/DomainDetail'
import AddCredential from './pages/AddCredential'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  const { isAuthenticated } = useAuth()

  return (
    <Routes>
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
        path="/add"
        element={
          <ProtectedRoute>
            <AddCredential />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <div className="h-full w-full bg-base text-foreground">
          <AppRoutes />
        </div>
      </AuthProvider>
    </HashRouter>
  )
}
