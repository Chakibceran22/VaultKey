import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

async function boot(): Promise<void> {
  // In a plain browser during development, answer IPC from an in-memory mock so
  // the UI can be previewed without the Tauri shell. Never in the app: Tauri
  // injects its IPC before this runs, and production builds drop this branch.
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
    const { installMockBackend } = await import('./dev/mock-backend')
    installMockBackend()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
