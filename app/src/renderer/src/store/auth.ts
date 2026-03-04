import { create } from 'zustand'

interface AuthState {
  isAuthenticated: boolean
  login: (masterPassword: string) => boolean
  logout: () => void
}

export const useAuth = create<AuthState>((set) => ({
  isAuthenticated: false,
  login: (masterPassword: string) => {
    if (masterPassword.length > 0) {
      try {
        const response= window.api.verifyMasterPassword(masterPassword)
        if(!response) {
          return false
        }
      } catch (error) {
        console.error("Error verifying master password:", error)
        return false
      }

      set({ isAuthenticated: true })
      return true
    }
    return false
  },
  logout: () => set({ isAuthenticated: false }),
}))
