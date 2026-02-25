import { useState } from 'react'
import './App.css'
import { MessageType } from '@/types/MessageTypes'

function App() {
  const [isLoading, setIsLoading] = useState(false)

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
    }}>
      <button
        onClick={openSidePanel}
        disabled={isLoading}
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          border: '2px solid #cba6f7',
          background: '#1e1e2e',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 20px rgba(203, 166, 247, 0.3)',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 24px rgba(203, 166, 247, 0.5)'
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 20px rgba(203, 166, 247, 0.3)'
        }}
      >
        🔑
      </button>
    </div>
  )
}

export default App