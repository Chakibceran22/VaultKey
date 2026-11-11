import { create } from 'zustand'
import { queryClient } from '@renderer/lib/queryClient'
import { api } from '@renderer/lib/api'
import { domainService } from '@renderer/lib/domainsService'
import { unwrap } from '@renderer/lib/ipc'
import { toast } from '@renderer/lib/toast'

interface AuthState {
  isAuthenticated: boolean
  /** Just recovered with the recovery code: the app asks for a new one right away. */
  newCodeAfterRecovery: boolean
  /**
   * Key derivation + verification run in Rust; the encryption key never reaches
   * JS. `beforeEnter` runs after a correct password and before the vault opens
   * (the lock screen's unlock animation); the domains load meanwhile.
   */
  login: (masterPassword: string, beforeEnter?: () => Promise<void>) => Promise<boolean>
  /** A forgotten master password: the recovery code sets a new one, and the vault opens. */
  recover: (recoveryCode: string, newPassword: string) => Promise<void>
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  isAuthenticated: false,
  newCodeAfterRecovery: false,
  // A wrong password is `false`; anything else that fails (the vault open in another
  // window, a failed move to the vault key) throws, with its own message.
  login: async (masterPassword, beforeEnter) => {
    const response = unwrap(await api.unlockVault(masterPassword))
    if (!response.valid) return false
    queryClient.clear()
    void queryClient.prefetchQuery({ queryKey: ['domains'], queryFn: () => domainService.getDomains() })
    await beforeEnter?.().catch(() => {})
    set({ isAuthenticated: true })
    if (response.upgradedBackup) {
      toast.success('Your vault moved to its new, stronger encryption. A backup of it as it was is in the backups folder.')
    }
    return true
  },
  recover: async (recoveryCode, newPassword) => {
    unwrap(await api.recoverVault(recoveryCode, newPassword))
    queryClient.clear()
    set({ isAuthenticated: true, newCodeAfterRecovery: true })
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
