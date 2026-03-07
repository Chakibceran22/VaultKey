import { KeyRound, X } from 'lucide-react'
import { theme } from '../theme'

interface HeaderProps {
  subtitle?: string
  onClose: () => void
}

export default function Header({ subtitle, onClose }: HeaderProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      marginBottom: '24px',
      paddingBottom: '16px',
      borderBottom: `1px solid ${theme.surface0}`,
    }}>
      <div style={{
        width: '36px',
        height: '36px',
        borderRadius: '10px',
        background: theme.surface0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <KeyRound size={18} color={theme.mauve} />
      </div>

      <div style={{ flex: 1 }}>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: theme.mauve }}>
          VaultKey
        </h1>
        {subtitle && (
          <p style={{ margin: 0, fontSize: '11px', color: theme.subtext }}>
            {subtitle}
          </p>
        )}
      </div>

      <button
        onClick={onClose}
        title="Close"
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
          transition: 'all 0.15s ease',
          flexShrink: 0,
          padding: 0,
        }}
        onMouseEnter={e => {
          ;(e.currentTarget as HTMLButtonElement).style.background = theme.red
          ;(e.currentTarget as HTMLButtonElement).style.color = theme.crust
          ;(e.currentTarget as HTMLButtonElement).style.borderColor = theme.red
        }}
        onMouseLeave={e => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          ;(e.currentTarget as HTMLButtonElement).style.color = theme.subtext
          ;(e.currentTarget as HTMLButtonElement).style.borderColor = theme.surface1
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
