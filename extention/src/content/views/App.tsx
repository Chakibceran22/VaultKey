import { useState } from 'react'
import './App.css'
import { MessageType } from '@/types/MessageTypes'
import { KeyRound, Save, Check, AlertCircle } from 'lucide-react'
import { EMAIL_SELECTORS, PASSWORD_SELECTORS } from '../utils/selectorConfig'

type Toast = { message: string; type: 'success' | 'error' } | null

function App() {
  const [isLoading, setIsLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [toast, setToast] = useState<Toast>(null)



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
        onClick={openSidePanel}
        disabled={isLoading}
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          border: `2px solid ${"#cba6f7"}`,
          background: '#1e1e2e',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 4px 20px ${'rgba(203,166,247,0.3)'}`,
          transition: 'all 0.2s ease',
          color: "#cba6f7",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = `0 6px 24px ${'rgba(203,166,247,0.5)'}`
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 20px ${'rgba(203,166,247,0.3)'}`
        }}
      >
        {saved ? <Check size={20} strokeWidth={2.5} /> :  <KeyRound size={20} />}
      </button>
    </div>
  )
}

export default App
