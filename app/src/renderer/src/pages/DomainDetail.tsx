import { useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { ArrowLeft, Copy, Eye, EyeOff, Check, User, Mail, KeyRound, Plus, Loader2, Trash2, Pencil } from 'lucide-react'
import { getDomainColor } from '../data/mock'
import { useAuth } from '@renderer/store/auth'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { credentialsService, type CredentialResponse } from '@renderer/lib/credentialsService'

export default function DomainDetail() {
  const { domain } = useParams<{ domain: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { token, encryptedKey } = useAuth()
  const decodedDomain = decodeURIComponent(domain || '')
  const domainId = (location.state as { domainId?: number })?.domainId

  const { data: credentials = [], isLoading, isError } = useQuery<CredentialResponse[]>({
    queryKey: ['credentials', domainId],
    queryFn: () => credentialsService.getCredentials(token!, domainId!, encryptedKey!),
    enabled: !!token && !!domainId,
  })

  const color = getDomainColor(decodedDomain)

  return (
    <div className="flex flex-col h-full bg-base">
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-5 py-3.5 bg-mantle border-b border-surface0">
        <div className="flex items-center gap-3">
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
        </div>
        <button
          onClick={() => navigate(`/vault/${encodeURIComponent(decodedDomain)}/add`, { state: { domainId } })}
          className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary hover:bg-primary/20 transition-colors cursor-pointer"
          title="Add credential"
        >
          <Plus className="w-4 h-4" />
        </button>
      </header>

      {/* Credential Cards */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2.5">
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-overlay0 animate-spin" />
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-red">Failed to load credentials</p>
          </div>
        )}
        {!isLoading && !isError && credentials.map((cred) => (
          <CredentialCard key={cred.id} credential={cred} domain={decodedDomain} domainId={domainId} token={token} />
        ))}
        {!isLoading && !isError && credentials.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-overlay0">No credentials yet</p>
          </div>
        )}
      </div>
    </div>
  )
}

function CredentialCard({ credential, domain, domainId, token }: { credential: CredentialResponse; domain: string; domainId?: number; token: string | null }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showPassword, setShowPassword] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const { mutate: deleteCredential, isPending: isDeleting } = useMutation({
    mutationFn: (credentialId: number) => credentialsService.deleteCredential(token!, credentialId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials', domainId] })
    },
  })

  const copyToClipboard = async (text: string, field: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 1500)
  }

  return (
    <div className="p-4 bg-mantle rounded-xl border border-surface0">
      {/* Username */}
      {credential.username && (
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
      )}

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

      {/* Actions */}
      <div className="pt-2.5 border-t border-surface0 flex justify-end gap-1">
        <button
          onClick={() => navigate(`/vault/${encodeURIComponent(domain)}/edit/${credential.id}`, { state: { domainId, credential } })}
          className="w-7 h-7 rounded-md flex items-center justify-center text-overlay0 hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer"
          title="Edit credential"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => deleteCredential(credential.id)}
          disabled={isDeleting}
          className="w-7 h-7 rounded-md flex items-center justify-center text-overlay0 hover:text-red hover:bg-red/10 transition-colors cursor-pointer disabled:opacity-50"
          title="Delete credential"
        >
          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
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
