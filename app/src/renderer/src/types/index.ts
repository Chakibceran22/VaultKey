export enum AuthStatus {
  NEEDS_SIGNUP = 'NEEDS_SIGNUP',
  NEEDS_LOGIN = 'NEEDS_LOGIN',
  ERROR = 'ERROR',
}

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

export interface CredentialDTO {
  domainId: number,
  username?: string,
  emai: string,
  password: string,
  
}

export interface DomainGroup {
  domain: string
  credentials: Credential[]
  totalAccounts: number
  lastUsed: string
}
