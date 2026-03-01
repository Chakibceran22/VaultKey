import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Eye, EyeOff, Save, Check } from 'lucide-react'
import { Input } from '../components/ui/input'
import { generatePassword, getPasswordStrength } from '../data/mock'

export default function AddCredential() {
  const navigate = useNavigate()
  const [domain, setDomain] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [saved, setSaved] = useState(false)

  const strength = password ? getPasswordStrength(password) : null

  const handleGenerate = () => {
    setPassword(generatePassword(20))
    setShowPassword(true)
  }

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    setSaved(true)
    setTimeout(() => navigate('/vault'), 800)
  }

  return (
    <div className="flex flex-col h-full bg-base">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-5 py-3.5 bg-mantle border-b border-surface0">
        <button
          onClick={() => navigate('/vault')}
          className="w-8 h-8 rounded-lg bg-surface0 flex items-center justify-center text-overlay1 hover:text-foreground transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-sm font-semibold text-foreground">New Credential</h1>
      </header>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-5 py-5 flex justify-center">
        <form onSubmit={handleSave} className="w-full max-w-lg space-y-4">
          {/* Site info - domain + username side by side */}
          <div className="bg-mantle rounded-xl border border-surface0 p-4 space-y-4">
            <p className="text-xs font-medium text-overlay0 uppercase tracking-wider">Site info</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-subtext0">Domain</label>
                <Input
                  placeholder="example.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="bg-base border-surface0"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-subtext0">Username</label>
                <Input
                  placeholder="john_doe"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-base border-surface0"
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-subtext0">Email</label>
              <Input
                type="email"
                placeholder="john@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-base border-surface0"
                required
              />
            </div>
          </div>

          {/* Password section - its own card */}
          <div className="bg-mantle rounded-xl border border-surface0 p-4 space-y-3">
            <p className="text-xs font-medium text-overlay0 uppercase tracking-wider">Password</p>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter or generate"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pr-10 bg-base border-surface0"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-overlay0 hover:text-foreground transition-colors cursor-pointer"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary hover:bg-primary/20 transition-colors shrink-0 cursor-pointer"
                title="Generate password"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {strength && (
              <div className="space-y-1.5">
                <div className="flex gap-1">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-1 flex-1 rounded-full transition-colors duration-300"
                      style={{
                        backgroundColor: i < strength.score ? strength.color : '#414559'
                      }}
                    />
                  ))}
                </div>
                <p className="text-xs font-medium" style={{ color: strength.color }}>
                  {strength.label}
                </p>
              </div>
            )}
          </div>

          {/* Save */}
          <button
            type="submit"
            disabled={saved}
            className="w-full h-11 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:brightness-110 transition-all disabled:opacity-70 cursor-pointer"
          >
            {saved ? (
              <>
                <Check className="w-4 h-4" />
                Saved
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Credential
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
