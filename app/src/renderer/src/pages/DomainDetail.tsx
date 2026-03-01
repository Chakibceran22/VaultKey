import { useState, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, Eye, EyeOff, Check, User, Mail, KeyRound } from 'lucide-react'
import { mockCredentials, getDomainColor, formatRelativeTime } from '../data/mock'
import type { Credential } from '../types'

export default function DomainDetail() {
  const { domain } = useParams<{ domain: string }>()
  const navigate = useNavigate()
  const decodedDomain = decodeURIComponent(domain || '')

  const credentials = useMemo(
    () => mockCredentials.filter((c) => c.domain === decodedDomain),
    [decodedDomain]
  )

  const color = getDomainColor(decodedDomain)

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
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
            style={{ backgroundColor: color, color: '#232634' }}
          >
            {decodedDomain[0]?.toUpperCase()}
          </div>
          <div>
            <h1 className="text-sm font-semibold text-foreground leading-tight">
              {decodedDomain}
            </h1>
            <p className="text-xs text-overlay0">
              {credentials.length} credential{credentials.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </header>

      {/* Credential Cards */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
        {credentials.map((cred) => (
          <CredentialCard key={cred.id} credential={cred} />
        ))}
      </div>
    </div>
  )
}

function CredentialCard({ credential }: { credential: Credential }) {
  const [showPassword, setShowPassword] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 1500)
  }

  return (
    <div className="p-4 bg-mantle rounded-xl border border-surface0">
      {/* Username */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <User className="w-3.5 h-3.5 text-overlay0 shrink-0" />
          <span className="text-sm text-foreground truncate">{credential.username}</span>
        </div>
        <CopyButton
          onClick={() => copyToClipboard(credential.username, `user-${credential.id}`)}
          copied={copiedField === `user-${credential.id}`}
        />
      </div>

      {/* Email */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Mail className="w-3.5 h-3.5 text-overlay0 shrink-0" />
          <span className="text-sm text-subtext0 truncate">{credential.email}</span>
        </div>
        <CopyButton
          onClick={() => copyToClipboard(credential.email, `email-${credential.id}`)}
          copied={copiedField === `email-${credential.id}`}
        />
      </div>

      {/* Password */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <KeyRound className="w-3.5 h-3.5 text-overlay0 shrink-0" />
          <span className="text-sm font-mono text-subtext0 truncate">
            {showPassword
              ? credential.password
              : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="w-7 h-7 rounded-md flex items-center justify-center text-overlay0 hover:text-foreground hover:bg-surface0 transition-colors cursor-pointer"
          >
            {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <CopyButton
            onClick={() => copyToClipboard(credential.password, `pass-${credential.id}`)}
            copied={copiedField === `pass-${credential.id}`}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="pt-2.5 border-t border-surface0">
        <p className="text-xs text-surface2">
          Last used {formatRelativeTime(credential.lastUsed)}
        </p>
      </div>
    </div>
  )
}

function CopyButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  return (
    <button
      onClick={onClick}
      className="w-7 h-7 rounded-md flex items-center justify-center text-overlay0 hover:text-foreground hover:bg-surface0 transition-colors shrink-0 cursor-pointer"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  )
}
