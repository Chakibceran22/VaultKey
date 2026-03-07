import { useState } from 'react'
import { KeyRound, Lock, Eye, EyeOff, LogIn, Loader } from 'lucide-react'
import { theme } from '../theme'
import Header from './Header'

interface AuthPageProps {
  onUnlocked: () => void
}

export default function AuthPage({ onUnlocked }: AuthPageProps) {
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleUnlock = async () => {
    if (!password.trim()) return
    setLoading(true)
    setError(null)
    // mock: any non-empty password works after a short delay
    await new Promise(r => setTimeout(r, 800))
    setLoading(false)
    if (password === 'wrong') {
      setError('Wrong master password. Try again.')
      return
    }
    onUnlocked()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleUnlock()
  }

  return (
    <div style={{
      height: '100vh',
      background: theme.base,
      color: theme.text,
      fontFamily: "'Inter', sans-serif",
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      padding: '20px',
    }}>
      <Header onClose={() => window.close()} />

      {/* Centered body */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '24px',
        padding: '0 4px',
      }}>
        {/* Logo */}
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: '16px',
          background: theme.surface0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 0 0 1px ${theme.surface1}`,
        }}>
          <KeyRound size={26} color={theme.mauve} />
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: theme.text }}>
            Unlock your vault
          </h2>
          <p style={{ margin: '6px 0 0', fontSize: '13px', color: theme.subtext }}>
            Enter your master password to continue
          </p>
        </div>

        {/* Password field */}
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{
            fontSize: '12px',
            color: theme.subtext,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}>
            Master Password
          </label>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <div style={{
              position: 'absolute',
              left: '12px',
              color: theme.subtext,
              display: 'flex',
              alignItems: 'center',
            }}>
              <Lock size={15} />
            </div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="••••••••••••"
              autoFocus
              style={{
                width: '100%',
                padding: '12px 40px 12px 38px',
                background: theme.mantle,
                border: `1px solid ${error ? theme.red : theme.surface1}`,
                borderRadius: '10px',
                color: theme.text,
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.15s ease',
              }}
              onFocus={e => {
                if (!error) e.currentTarget.style.borderColor = theme.mauve
              }}
              onBlur={e => {
                if (!error) e.currentTarget.style.borderColor = theme.surface1
              }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              style={{
                position: 'absolute',
                right: '10px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: theme.subtext,
                display: 'flex',
                alignItems: 'center',
                padding: '4px',
              }}
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {error && (
            <p style={{ margin: 0, fontSize: '12px', color: theme.red }}>
              {error}
            </p>
          )}
        </div>

        {/* Unlock button */}
        <button
          onClick={handleUnlock}
          disabled={loading || !password.trim()}
          style={{
            width: '100%',
            padding: '13px',
            background: loading || !password.trim() ? theme.surface0 : theme.mauve,
            color: loading || !password.trim() ? theme.subtext : theme.crust,
            border: 'none',
            borderRadius: '10px',
            cursor: loading || !password.trim() ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: 600,
            transition: 'all 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          {loading
            ? <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Unlocking…</>
            : <><LogIn size={16} /> Unlock Vault</>
          }
        </button>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
