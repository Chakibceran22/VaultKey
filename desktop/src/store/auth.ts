import { create } from 'zustand'
import { queryClient } from '@renderer/lib/queryClient'
import { api } from '@renderer/lib/api'
import { domainService } from '@renderer/lib/domainsService'
import { unwrap } from '@renderer/lib/ipc'

interface AuthState {
  isAuthenticated: boolean
  /**
   * Key derivation + verification run in Rust; the encryption key never reaches
   * JS. `beforeEnter` runs after a correct password and before the vault opens
   * (the lock screen's unlock animation); the domains load meanwhile.
   */
  login: (masterPassword: string, beforeEnter?: () => Promise<void>) => Promise<boolean>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  isAuthenticated: false,
  login: async (masterPassword, beforeEnter) => {
    try {
      const response = unwrap(await api.unlockVault(masterPassword))
      if (!response.valid) return false
      queryClient.clear()
      void queryClient.prefetchQuery({ queryKey: ['domains'], queryFn: () => domainService.getDomains() })
      await beforeEnter?.().catch(() => {})
      set({ isAuthenticated: true })
      return true
    } catch {
      return false
    }
  },
  logout: async () => {
    try {
      unwrap(await api.lockVault())
    } finally {
      queryClient.clear()
      set({ isAuthenticated: false })
    }
  }
}))
