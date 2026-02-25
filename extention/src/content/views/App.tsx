import { useState, useEffect } from 'react'
import './App.css'
import { MessageType } from '@/types/MessageTypes'

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

function App() {
  const [isLoading, setIsLoading] = useState(false)
  const [isSignup, setIsSignup] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const url = window.location.pathname.toLowerCase()
    const signupPatterns = ['/register', '/signup', '/sign-up', '/create-account', '/join']
    const isSignupUrl = signupPatterns.some(p => url.includes(p))
    const hasTwoPasswordFields = document.querySelectorAll('input[type="password"]').length >= 2
    setIsSignup(isSignupUrl || hasTwoPasswordFields)
  }, [])

  const openSidePanel = () => {
    setIsLoading(true)
    chrome.runtime.sendMessage({ type: MessageType.OPEN_SIDEPANEL }, () => {
      setIsLoading(false)
    })
  }

  const handleSave = () => {
    const emailInput = document.querySelector(EMAIL_SELECTORS) as HTMLInputElement
    const passwordInput = document.querySelector(PASSWORD_SELECTORS) as HTMLInputElement

    if (!emailInput?.value || !passwordInput?.value) return
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
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: 999999,
    }}>
      <button
        onClick={isSignup ? handleSave : openSidePanel}
        disabled={isLoading}
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          border: `2px solid ${isSignup ? '#a6d189' : '#cba6f7'}`,
          background: '#1e1e2e',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 4px 20px ${isSignup ? 'rgba(166,209,137,0.3)' : 'rgba(203,166,247,0.3)'}`,
          transition: 'all 0.2s ease',
          fontSize: '20px',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = `0 6px 24px ${isSignup ? 'rgba(166,209,137,0.5)' : 'rgba(203,166,247,0.5)'}`
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 20px ${isSignup ? 'rgba(166,209,137,0.3)' : 'rgba(203,166,247,0.3)'}`
        }}
      >
        {saved ? '✓' : isSignup ? '💾' : '🔑'}
      </button>
    </div>
  )
}

export default App