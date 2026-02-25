import { useState, useEffect } from 'react'
import './App.css'
import { MessageType } from '@/types/MessageTypes'
import { KeyRound, Save, Check, AlertCircle } from 'lucide-react'

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name*="email"]',
  'input[name*="username"]',
  'input[name*="user"]',
  'input[name*="login"]',
  'input[id*="email"]',
  'input[id*="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
].join(',')

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete="current-password"]',
].join(',')

type Toast = { message: string; type: 'success' | 'error' } | null

function App() {
  const [isLoading, setIsLoading] = useState(false)
  const [isSignup, setIsSignup] = useState(false)
  const [saved, setSaved] = useState(false)
  const [toast, setToast] = useState<Toast>(null)

  useEffect(() => {
    const url = window.location.pathname.toLowerCase()
    const signupPatterns = ['/register', '/signup', '/sign-up', '/create-account', '/join']
    const isSignupUrl = signupPatterns.some(p => url.includes(p))
    const hasTwoPasswordFields = document.querySelectorAll('input[type="password"]').length >= 2
    setIsSignup(isSignupUrl || hasTwoPasswordFields)
  }, [])

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 2500)
  }

  const openSidePanel = () => {
    setIsLoading(true)
    chrome.runtime.sendMessage({ type: MessageType.OPEN_SIDEPANEL }, () => {
      setIsLoading(false)
    })
  }

  const handleSave = () => {
    const emailInput = document.querySelector(EMAIL_SELECTORS) as HTMLInputElement
    const passwordInput = document.querySelector(PASSWORD_SELECTORS) as HTMLInputElement

    if (!emailInput?.value || !passwordInput?.value) {
      showToast('Fill in your email and password first', 'error')
      return
    }

    console.log(emailInput.value, passwordInput.value)
    chrome.runtime.sendMessage({
      type: MessageType.SAVE_PASSWORD,
      payload: {
        domain: window.location.hostname,
        email: emailInput.value,
        password: passwordInput.value,
      }
    })

    setSaved(true)
    showToast('Saved successfully', 'success')
    setTimeout(() => setSaved(false), 2500)
  }

  const accentColor = isSignup ? '#a6d189' : '#cba6f7'
  const glowColor = isSignup ? 'rgba(166,209,137,0.3)' : 'rgba(203,166,247,0.3)'
  const glowHover = isSignup ? 'rgba(166,209,137,0.5)' : 'rgba(203,166,247,0.5)'

  return (
    <div style={{
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: 999999,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '10px',
    }}>
      {/* Toast popup */}
      {toast && (
        <div style={{
          background: '#1e1e2e',
          border: `1px solid ${toast.type === 'success' ? '#a6d189' : '#e78284'}`,
          borderRadius: '10px',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          color: toast.type === 'success' ? '#a6d189' : '#e78284',
          fontSize: '13px',
          fontFamily: "'Inter', system-ui, sans-serif",
          fontWeight: 500,
          boxShadow: `0 4px 20px rgba(0,0,0,0.4)`,
          animation: 'vaultkey-toast-in 0.2s ease',
          whiteSpace: 'nowrap',
        }}>
          {toast.type === 'success'
            ? <Check size={15} strokeWidth={2.5} />
            : <AlertCircle size={15} />
          }
          {toast.message}
        </div>
      )}

      <button
        onClick={isSignup ? handleSave : openSidePanel}
        disabled={isLoading}
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          border: `2px solid ${accentColor}`,
          background: '#1e1e2e',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 4px 20px ${glowColor}`,
          transition: 'all 0.2s ease',
          color: accentColor,
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = `0 6px 24px ${glowHover}`
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 20px ${glowColor}`
        }}
      >
        {saved ? <Check size={20} strokeWidth={2.5} /> : isSignup ? <Save size={20} /> : <KeyRound size={20} />}
      </button>
    </div>
  )
}

export default App
