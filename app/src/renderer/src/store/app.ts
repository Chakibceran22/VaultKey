import { create } from 'zustand'
import axios from 'axios'

const API_URL = 'http://localhost:3000'

type AppStatus = 'loading' | 'needs_signup' | 'needs_login' | 'error'

interface AppState {
  status: AppStatus
  setStatus: (status: AppStatus) => void
}

export const useAppStore = create<AppState>((set) => ({
  status: 'loading',
  setStatus: (status) => set({ status }),
}))

/**
 * Checks the auth status from the backend.
 * Returns 'needs_signup' if no auth key exists, 'needs_login' if one does.
 * Throws on server error.
 */
async function checkAuthStatus(): Promise<'needs_signup' | 'needs_login'> {
  const response = await axios.get(`${API_URL}/auth/status`)
  // Expected response: { exists: boolean }
  return response.data.exists ? 'needs_login' : 'needs_signup'
}

/**
 * Hook to expose the checkAuthStatus + init logic for components.
 */
export function useAppInit() {
  const setStatus = useAppStore((s) => s.setStatus)

  const init = async () => {
    try {
      const result = await checkAuthStatus()
      setStatus(result)
      return result
    } catch {
      setStatus('error')
      throw new Error('Server unreachable')
    }
  }

  return { checkAuthStatus: init }
}
