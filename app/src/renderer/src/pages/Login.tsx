import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { useAuth } from '../store/auth'
import { Input } from '../components/ui/input'

export default function Login() {
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!password) {
      setError('Please enter your master password')
      return
    }

    setIsLoading(true)
    setTimeout(() => {
      const success = login(password)
      if (success) {
        navigate('/vault')
      } else {
        setError('Invalid master password')
      }
      setIsLoading(false)
    }, 600)
  }

  return (
    <div className="flex h-full items-center justify-center bg-crust">
      <div className="w-full max-w-sm mx-auto px-6">
        <div className="flex flex-col items-center mb-10">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-5 ring-1 ring-primary/20">
            <Shield className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">PassVault</h1>
          <p className="text-sm text-muted-foreground mt-1.5">Enter your master password to unlock</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              placeholder="Master password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 pr-10 bg-mantle border-surface0 text-base"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-overlay1 hover:text-foreground transition-colors"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {error && <p className="text-sm text-red">{error}</p>}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-12 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:brightness-110 transition-all disabled:opacity-50 cursor-pointer"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <>
                Unlock
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-xs text-surface2 text-center mt-8">
          Your master password is never stored on disk
        </p>
      </div>
    </div>
  )
}
