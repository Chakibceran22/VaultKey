import { create } from 'zustand'
import { AuthStatus } from '@renderer/types'

type AppStatus = AuthStatus | 'loading'

interface AppState {
  status: AppStatus
  setStatus: (status: AppStatus) => void
}

export const useAppStore = create<AppState>((set) => ({
  status: 'loading',
  setStatus: (status) => set({ status }),
}))

/**
 * Checks the auth status from the backend via IPC.
 * Backend returns { status: AuthStatus.NEEDS_SIGNUP | AuthStatus.NEEDS_LOGIN }
 */
async function checkAuthStatus(): Promise<AuthStatus> {
  const response = await window.api.checkAuthStatus()
  if ('error' in response) {
    throw new Error('Server unreachable')
  }
  const status = response.status as AuthStatus
  if (status === AuthStatus.ERROR) {
    throw new Error('Backend error')
  }
  return status
}

export function useAppInit() {
  const setStatus = useAppStore((s) => s.setStatus)

  const init = async () => {
    try {
      const result = await checkAuthStatus()
      setStatus(result)
      return result
    } catch {
      setStatus(AuthStatus.ERROR)
      throw new Error('Server unreachable')
    }
  }

  return { checkAuthStatus: init }
}
