import { create } from 'zustand'

interface AuthState {
  isAuthenticated: boolean,
  login: (authKey: string, encryptKey: string) => Promise<boolean>,
  token: string | null,
  encryptedKey: string | null,
  logout: () => void
}

export const useAuth = create<AuthState>((set) => ({
  isAuthenticated: false,
  token: null,
  encryptedKey: null,
  login: async (authKey: string, encryptKey: string) => {
    if (authKey.length > 0) {
      try {
        const response= await window.api.verifyMasterPassword(authKey)
        console.log("Login response:", response)
        if(!response) {
          return false
        }
        if(!response.valid) {
          return false

        }
        set({ isAuthenticated: true, token: response.token , encryptedKey: encryptKey})
        return true
      } catch (error) {
        console.error("Error verifying master password:", error)
        return false
      }


      
    }
    return false
  },
  logout: () => set({ isAuthenticated: false, token: null, encryptedKey: null }),
}))
