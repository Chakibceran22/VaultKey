import { useState } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { ArrowLeft, Eye, EyeOff, Save, Check, Loader2 } from 'lucide-react'
import { Input } from '../components/ui/input'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { credentialsService, type CredentialResponse } from '@renderer/lib/credentialsService'
import { useAuth } from '@renderer/store/auth'
import { toast } from 'sonner'

export default function EditCredential() {
  const navigate = useNavigate()
  const location = useLocation()
  const { domain } = useParams<{ domain: string }>()
  const decodedDomain = decodeURIComponent(domain || '')
  const domainId = (location.state as { domainId?: number })?.domainId
  const credential = (location.state as { credential?: CredentialResponse })?.credential
  const { token, encryptedKey } = useAuth()
  const queryClient = useQueryClient()

  const [username, setUsername] = useState(credential?.username || '')
  const [email, setEmail] = useState(credential?.email || '')
  const [password, setPassword] = useState(credential?.password || '')
  const [showPassword, setShowPassword] = useState(false)

  const { mutate: updateCredential, isPending, isSuccess } = useMutation({
    mutationFn: (fields: { username?: string; email: string; password: string }) =>
      credentialsService.updateCredential(token!, credential!.id, fields, encryptedKey!),
    onSuccess: () => {
      toast.success('Credential updated successfully')
      queryClient.invalidateQueries({ queryKey: ['credentials', domainId] })
      setTimeout(() => navigate(`/vault/${encodeURIComponent(decodedDomain)}`, { state: { domainId } }), 800)
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update credential')
    },
  })

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || !encryptedKey || !credential) return
    updateCredential({ username, email, password })
  }

  return (
    <div className="flex flex-col h-full bg-base">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-5 py-3.5 bg-mantle border-b border-surface0">
        <button
          onClick={() => navigate(`/vault/${encodeURIComponent(decodedDomain)}`, { state: { domainId } })}
          className="w-8 h-8 rounded-lg bg-surface0 flex items-center justify-center text-overlay1 hover:text-foreground transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-sm font-semibold text-foreground">Edit Credential — {decodedDomain}</h1>
      </header>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-5 py-5 flex justify-center">
        <form onSubmit={handleSave} className="w-full max-w-lg space-y-4">
          <div className="bg-mantle rounded-xl border border-surface0 p-4 space-y-4">
            <p className="text-xs font-medium text-overlay0 uppercase tracking-wider">Account info</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-subtext0">Username <span className="text-surface2">(optional)</span></label>
                <Input
                  placeholder="john_doe"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-base border-surface0"
                />
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
          </div>

          <div className="bg-mantle rounded-xl border border-surface0 p-4 space-y-3">
            <p className="text-xs font-medium text-overlay0 uppercase tracking-wider">Password</p>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter new password"
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
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isPending || isSuccess}
            className="w-full h-11 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:brightness-110 transition-all disabled:opacity-70 cursor-pointer"
          >
            {isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Updating...
              </>
            ) : isSuccess ? (
              <>
                <Check className="w-4 h-4" />
                Updated
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Update Credential
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
