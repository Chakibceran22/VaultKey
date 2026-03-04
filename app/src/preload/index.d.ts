import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      verifyMasterPassword: (password: string) => Promise<boolean>
      checkAuthStatus: () => Promise<{ status: string } | { error: true }>
      registerAuthKey: (authKey: string) => Promise<{status: success}>
    }
  }
}
