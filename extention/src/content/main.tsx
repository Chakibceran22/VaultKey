import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './views/App.tsx'
import { shouldActivate } from './utils/shouldActivate.ts'
import { MessageType } from '@/types/MessageTypes.ts'
import { fillFields } from './utils/fillFields.ts'


const mount = () => {
  const container = document.createElement('div')
  container.id = 'valutkey-app'
  document.body.appendChild(container)
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  console.log('[VaultKey] Mounted on:', window.location.hostname)


}

if(shouldActivate()) mount()

  setTimeout(() => {
  if (shouldActivate()) {
    mount()
  }
}, 2000)

// observe DOM changes for SPAs (React/Vue/Angular apps)
const observer = new MutationObserver(() => {
  if (shouldActivate()) {
    mount()
    observer.disconnect() // stop observing once mounted
  }
})

observer.observe(document.body, {
  childList: true,
  subtree: true,
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MessageType.FILL_FIELDS) {
    fillFields(msg.payload.email, msg.payload.password)
  }
})