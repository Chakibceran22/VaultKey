import { MessageType } from '@/types/MessageTypes'
import { theme } from '../theme'
import Header from './Header'
import AccountCard, { Account } from './AccountCard'

const FAKE_ACCOUNTS: Account[] = [
  { id: '1', email: 'john@gmail.com', password: 'pass123' },
  { id: '2', email: 'work@company.com', password: 'work456' },
  { id: '3', email: 'personal@gmail.com', password: 'personal789' },
  { id: '4', email: 'side@project.com', password: 'side456' },
]

export default function PasswordsPage() {
  const handleSelect = (account: Account) => {
    chrome.runtime.sendMessage({
      type: MessageType.FILL_FIELDS,
      payload: { email: account.email, password: account.password },
    })
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
      <Header
        subtitle={window.location.hostname}
        onClose={() => window.close()}
      />

      <p style={{
        margin: '0 0 12px 0',
        fontSize: '12px',
        color: theme.subtext,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}>
        Accounts — {FAKE_ACCOUNTS.length} found
      </p>

      <div style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        {FAKE_ACCOUNTS.map(account => (
          <AccountCard
            key={account.id}
            account={account}
            onSelect={() => handleSelect(account)}
          />
        ))}
      </div>
    </div>
  )
}
