import { ElectronAPI } from '@electron-toolkit/preload'
import { DomainGroup } from '@renderer/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      verifyMasterPassword: (password: string) => Promise<{
        valid: boolean,
        token : string | null
      }>
      checkAuthStatus: () => Promise<{ status: string } | { error: true }>
      registerAuthKey: (authKey: string) => Promise<{success: boolean}>
      fetchDomains: (token: string) => Promise<{ domains: Domain[] } | { error: true }>
      registerDomain: (token: string, domainName: string) => Promise<{ success: boolean } | { error: true }>
    }
  }
}
