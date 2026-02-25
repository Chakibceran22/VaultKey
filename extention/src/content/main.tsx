import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './views/App.tsx'

console.log('[CRXJS] Hello world from content script!')

const container = document.createElement('div')
container.id = 'crxjs-app'
console.log("yaaaay its loaded")
document.body.appendChild(container)
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
