import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './views/App.tsx'
import { shouldActivate } from './utils/shouldActivate.ts'
import { MessageType } from '@/types/MessageTypes.ts'
import { fillFields } from './utils/fillFields.ts'

let lastUrl = window.location.href

const unmount = () => {
  const existing = document.getElementById('vaultkey-app')
  if (existing) existing.remove()
}

const mount = () => {
  if (document.getElementById('vaultkey-app')) return // avoid duplicates
  const container = document.createElement('div')
  container.id = 'vaultkey-app'
  document.body.appendChild(container)
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  console.log('[VaultKey] Mounted on:', window.location.hostname)
}

const handleNavigation = () => {
  if (window.location.href === lastUrl) return
  lastUrl = window.location.href

  unmount()

  setTimeout(() => {
    if (shouldActivate()) mount()
  }, 500)
}

// initial mount
if (shouldActivate()) mount()

// SPA navigation detection — ONE observer only
const observer = new MutationObserver(handleNavigation)
observer.observe(document.body, { childList: true, subtree: true })

// back/forward navigation
window.addEventListener('popstate', () => {
  unmount()
  setTimeout(() => {
    if (shouldActivate()) mount()
  }, 500)
})

// fill fields listener
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MessageType.FILL_FIELDS) {
    fillFields(msg.payload.email, msg.payload.password)
  }
})