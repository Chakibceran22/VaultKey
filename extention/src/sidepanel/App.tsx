import { useState } from 'react'
import { fillFields } from '../content/utils/fillFields'
import { MessageType } from '@/types/MessageTypes'

// Catppuccin Frappé
const theme = {
  base: '#303446',
  mantle: '#292c3c',
  crust: '#232634',
  text: '#c6d0f5',
  subtext: '#a5adce',
  surface0: '#414559',
  surface1: '#51576d',
  mauve: '#ca9ee6',
  lavender: '#babbf1',
  green: '#a6d189',
  red: '#e78284',
}

const FAKE_ACCOUNTS = [
  { id: '1', email: 'john@gmail.com', password: 'pass123' },
  { id: '2', email: 'work@company.com', password: 'work456' },
  { id: '3', email: 'personal@gmail.com', password: 'personal789' },
  { id: '4', email: 'side@project.com', password: 'side456' },
]

export default function App() {
  const [selected, setSelected] = useState<string | null>(null)
  const [filled, setFilled] = useState(false)

  const handleSelect = (account: typeof FAKE_ACCOUNTS[0]) => {
    setSelected(account.id)
    setFilled(false)
  }

  const handleFill = () => {
    const account = FAKE_ACCOUNTS.find(a => a.id === selected)
    if (!account) return
    chrome.runtime.sendMessage({
    type: MessageType.FILL_FIELDS,
    payload: { email: account.email, password: account.password }
  })
    setFilled(true)
  }

  const handleClose = () => {
  window.close()
}

  return (
    <div style={{
      height: '100vh',
      background: theme.base,
      color: theme.text,
      fontFamily: "'Inter', sans-serif",
      display: 'flex',
      flexDirection: 'column',
      padding: '20px',
      boxSizing: 'border-box',
    }}>

      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginBottom: '24px',
        paddingBottom: '16px',
        borderBottom: `1px solid ${theme.surface0}`,
      }}>
        <span style={{ fontSize: '22px' }}>🔑</span>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: theme.mauve }}>
            VaultKey
          </h1>
          <p style={{ margin: 0, fontSize: '11px', color: theme.subtext }}>
            {window.location.hostname}
          </p>
        </div>

        {/* Close button */}
        <button
          onClick={handleClose}
          title="Close (Ctrl+B)"
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            border: `1px solid ${theme.surface1}`,
            background: 'transparent',
            color: theme.subtext,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            transition: 'all 0.15s ease',
            flexShrink: 0,
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = theme.red
            ;(e.currentTarget as HTMLButtonElement).style.color = theme.crust
            ;(e.currentTarget as HTMLButtonElement).style.borderColor = theme.red
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLButtonElement).style.color = theme.subtext
            ;(e.currentTarget as HTMLButtonElement).style.borderColor = theme.surface1
          }}
        >
          ✕
        </button>
      </div>

      {/* Accounts label */}
      <p style={{
        margin: '0 0 12px 0',
        fontSize: '12px',
        color: theme.subtext,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}>
        Accounts — {FAKE_ACCOUNTS.length} found
      </p>

      {/* Accounts list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        {FAKE_ACCOUNTS.map((account) => (
          <div
            key={account.id}
            onClick={() => handleSelect(account)}
            style={{
              padding: '12px 14px',
              background: selected === account.id ? theme.surface1 : theme.mantle,
              border: `1px solid ${selected === account.id ? theme.mauve : theme.surface0}`,
              borderRadius: '10px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              background: theme.surface0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '14px',
              flexShrink: 0,
            }}>
              {account.email[0].toUpperCase()}
            </div>
            <div>
              <p style={{ margin: 0, fontSize: '13px', color: theme.text, fontWeight: 500 }}>
                {account.email}
              </p>
              <p style={{ margin: 0, fontSize: '11px', color: theme.subtext }}>
                ••••••••
              </p>
            </div>
            {selected === account.id && (
              <span style={{ marginLeft: 'auto', color: theme.mauve, fontSize: '16px' }}>✓</span>
            )}
          </div>
        ))}
      </div>

      {/* Autofill button */}
      <button
        onClick={handleFill}
        disabled={!selected}
        style={{
          marginTop: '16px',
          padding: '12px',
          background: selected ? theme.mauve : theme.surface0,
          color: selected ? theme.crust : theme.subtext,
          border: 'none',
          borderRadius: '10px',
          cursor: selected ? 'pointer' : 'not-allowed',
          fontSize: '14px',
          fontWeight: 600,
          transition: 'all 0.2s ease',
        }}
      >
        {filled ? '✓ Filled!' : 'Autofill'}
      </button>

    </div>
  )
}