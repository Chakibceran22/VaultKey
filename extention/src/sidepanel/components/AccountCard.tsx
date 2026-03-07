import { useState } from 'react'
import { User } from 'lucide-react'
import { theme } from '../theme'

export interface Account {
  id: string
  email: string
  password: string
}

interface AccountCardProps {
  account: Account
  onSelect: () => void
}

export default function AccountCard({ account, onSelect }: AccountCardProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '12px 14px',
        background: hovered ? theme.surface0 : theme.mantle,
        border: `1px solid ${hovered ? theme.surface1 : theme.surface0}`,
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
        color: theme.subtext,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <User size={15} />
      </div>

      <div>
        <p style={{ margin: 0, fontSize: '13px', color: theme.text, fontWeight: 500 }}>
          {account.email}
        </p>
        <p style={{ margin: 0, fontSize: '11px', color: theme.subtext }}>
          ••••••••
        </p>
      </div>
    </div>
  )
}
