export interface Credential {
  id: string
  domain: string
  username: string
  email: string
  password: string
  notes?: string
  createdAt: string
  lastUsed: string
}

export interface DomainGroup {
  domain: string
  credentials: Credential[]
  totalAccounts: number
  lastUsed: string
}
