import { create } from 'zustand'
import { useCallback } from 'react'
import type { AuthStatus } from '@renderer/shared/contracts'
import { api } from '@renderer/lib/api'
import { unwrap } from '@renderer/lib/ipc'

type AppStatus = AuthStatus | 'ERROR' | 'loading'

interface AppState {
  status: AppStatus
  setStatus: (status: AppStatus) => void
}

export const useAppStore = create<AppState>((set) => ({
  status: 'loading',
  setStatus: (status) => set({ status })
}))

async function checkVaultStatus(): Promise<AuthStatus> {
  const response = unwrap(await api.getVaultStatus())
  useAppStore.getState().setStatus(response.status)
  return response.status
}

export function useAppInit(): { checkAuthStatus: () => Promise<AuthStatus> } {
  const setStatus = useAppStore((state) => state.setStatus)

  const init = useCallback(async (): Promise<AuthStatus> => {
    try {
      return await checkVaultStatus()
    } catch (error) {
      console.error('[vault] status check failed', error)
      setStatus('ERROR')
      throw new Error('The local vault is unavailable.')
    }
  }, [setStatus])

  return { checkAuthStatus: init }
}
