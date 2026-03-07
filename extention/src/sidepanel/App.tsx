import { useState } from 'react'
import AuthPage from './components/AuthPage'
import PasswordsPage from './components/PasswordsPage'

export default function App() {
  const [unlocked, setUnlocked] = useState(false)

  return unlocked
    ? <PasswordsPage />
    : <AuthPage onUnlocked={() => setUnlocked(true)} />
}
