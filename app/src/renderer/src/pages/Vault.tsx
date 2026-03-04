import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, LogOut, ChevronRight, Globe, Key, Shield } from 'lucide-react'
import { useAuth } from '@renderer/store/auth'
import { Input } from '../components/ui/input'
import { getDomainColor, formatRelativeTime } from '../data/mock'
import { domainService } from '@renderer/lib/domainsService'
import { useQuery } from '@tanstack/react-query'

interface Domain {
  id: number
  name: string
  totalAccounts: number
  createdAt: string
  updatedAt: string
}

export default function Vault() {
  const [search, setSearch] = useState('')
  const { logout, token } = useAuth()
  const navigate = useNavigate()

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => domainService.getDomains(token!),
    enabled: !!token,
  })

  const filtered = useMemo(() => {
    if (!search) return domains
    const q = search.toLowerCase()
    return domains.filter((d) => d.name.toLowerCase().includes(q))
  }, [search, domains])

  const totalCredentials = domains.reduce((sum, d) => sum + d.totalAccounts, 0)

  return (
    <div className="flex flex-col h-full bg-base">
      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-5 py-3.5 bg-mantle border-b border-surface0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-base font-semibold text-foreground">Vault</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => navigate('/add-domain')}
            className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary hover:bg-primary/20 transition-colors cursor-pointer"
            title="Add domain"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              logout()
              navigate('/login')
            }}
            className="w-8 h-8 rounded-lg bg-surface0 flex items-center justify-center text-overlay1 hover:text-red hover:bg-red/10 transition-colors cursor-pointer"
            title="Lock vault"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Search & Stats */}
      <div className="shrink-0 px-5 pt-4 pb-2 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-overlay0" />
          <Input
            placeholder="Search domains, usernames..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-mantle border-surface0"
          />
        </div>
        <div className="flex items-center gap-4 text-xs text-overlay0">
          <span className="flex items-center gap-1.5">
            <Globe className="w-3 h-3" />
            {filtered.length} domain{filtered.length !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1.5">
            <Key className="w-3 h-3" />
            {totalCredentials} credential{totalCredentials !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Domain Grid */}
      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2">
        {filtered.length > 0 ? (
          <div className="grid grid-cols-2 gap-2.5">
            {filtered.map((domain) => {
              const color = getDomainColor(domain.name)
              return (
                <button
                  key={domain.id}
                  onClick={() => navigate(`/vault/${encodeURIComponent(domain.name)}`)}
                  className="group flex flex-col p-3.5 bg-mantle rounded-xl border border-surface0 hover:border-surface1 transition-all text-left cursor-pointer"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold"
                      style={{ backgroundColor: color, color: '#232634' }}
                    >
                      {domain.name[0].toUpperCase()}
                    </div>
                    <ChevronRight className="w-4 h-4 text-surface2 opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                  </div>
                  <p className="text-sm font-medium text-foreground truncate">{domain.name}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-xs text-overlay0">
                      {domain.totalAccounts} account{domain.totalAccounts !== 1 ? 's' : ''}
                    </span>
                    <span className="text-xs text-surface2">·</span>
                    <span className="text-xs text-overlay0">
                      {formatRelativeTime(domain.updatedAt)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Globe className="w-12 h-12 text-surface2 mb-3" />
            <p className="text-sm text-overlay0">No domains found</p>
            <p className="text-xs text-surface2 mt-1">Try a different search term</p>
          </div>
        )}
      </div>
    </div>
  )
}
