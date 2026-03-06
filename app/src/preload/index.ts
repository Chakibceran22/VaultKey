import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  verifyMasterPassword: (password: string) => ipcRenderer.invoke('verify-master', password),
  checkAuthStatus: () => ipcRenderer.invoke('auth-status'),
  registerAuthKey: (authKey: string) => ipcRenderer.invoke('register-auth-key', authKey),
  fetchDomains: (token: string) => ipcRenderer.invoke('fetch-domains', token),
  registerDomain: (token: string, domainName: string) => ipcRenderer.invoke('register-domain', token, domainName),
  fetchCredentials: (token: string, domainId: number) => ipcRenderer.invoke('fetch-credentials', token, domainId)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
