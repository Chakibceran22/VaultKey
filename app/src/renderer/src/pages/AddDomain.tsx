import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Globe, Check } from 'lucide-react'
import { Input } from '../components/ui/input'
import { toast } from 'sonner'
import { domainService } from '@renderer/lib/domainsService'
import { useAuth } from '@renderer/store/auth'
import { useMutation, useQueryClient } from '@tanstack/react-query'

export default function AddDomain() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const { token } = useAuth()
  const queryClient = useQueryClient()

  const { mutate: registerDomain, isPending: isLoading } = useMutation({
    mutationFn: (name: string) => domainService.registerDomain(token!, name),
    onSuccess: (result) => {
      if (result) {
        setSaved(true);
        toast.success("Domain added successfully!")
        queryClient.invalidateQueries({ queryKey: ['domains'] })
      }
      else {
        toast.error('Failed to add domain. This Domain Already Exists.')
      }

    },
    onError: (error: any) => {
      console.log("Error saving domain:", error.message)
      toast.error(error.message)
    },

  })


  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) {
      toast.error('You must be logged in to add a domain')
      return
    }
    registerDomain(name)
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
        <h1 className="text-sm font-semibold text-foreground">New Domain</h1>
      </header>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-5 py-5 flex justify-center">
        <form onSubmit={handleSave} className="w-full max-w-lg space-y-4">
          <div className="bg-mantle rounded-xl border border-surface0 p-4 space-y-4">
            <p className="text-xs font-medium text-overlay0 uppercase tracking-wider">Domain</p>
            <div className="space-y-1.5">
              <label className="text-xs text-subtext0">Domain name</label>
              <Input
                placeholder="youtube.com"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-base border-surface0"
                autoFocus
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading || saved}
            className="w-full h-11 bg-primary text-primary-foreground rounded-lg font-medium flex items-center justify-center gap-2 hover:brightness-110 transition-all disabled:opacity-70 cursor-pointer"
          >
            {saved ? (
              <>
                <Check className="w-4 h-4" />
                Saved
              </>
            ) : isLoading ? (
              <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <>
                <Globe className="w-4 h-4" />
                Add Domain
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
