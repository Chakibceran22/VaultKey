import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Windows renders Inter (no SF Pro), which is wider, and WebView2's own scrollbars:
// the `windows:` variant and rules in main.css adjust for both there only.
if (/Windows/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'windows'

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
