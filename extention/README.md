# 🧩 Browser Extension — Complete Guide

## What is a Browser Extension?

A browser extension is basically a **mini web app** that runs inside your browser and has special powers — it can read webpages, inject code into them, talk to background processes, and communicate with your own backend.

It's built with the same tools you already know: **HTML, CSS, JavaScript/TypeScript** — but with a special structure and a set of browser APIs (`chrome.*`) that give it superpowers.

---

## The Building Blocks

A browser extension has **4 core pieces**. Each one has a specific job and they all talk to each other.

```
┌─────────────────────────────────────────────────┐
│                   BROWSER                        │
│                                                  │
│  ┌──────────────┐      ┌──────────────────────┐ │
│  │   POPUP      │      │   BACKGROUND         │ │
│  │  (your UI)   │◄────►│  (silent worker)     │ │
│  └──────────────┘      └──────────┬───────────┘ │
│                                   │              │
│  ┌────────────────────────────────▼───────────┐ │
│  │            CONTENT SCRIPT                  │ │
│  │         (runs on every webpage)            │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │           manifest.json / config         │   │
│  │         (the brain — defines everything) │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## 1. `manifest.json` / `manifest.config.ts` — The Brain

This is the **most important file**. It defines everything about your extension:
- What permissions it needs
- Which scripts run where
- What the popup is
- What icon to show

```ts
// manifest.config.ts
export default defineManifest({
  manifest_version: 3,       // always 3 for modern extensions
  name: 'My Extension',
  version: '1.0.0',

  permissions: [
    'activeTab',   // access the current tab
    'storage',     // store data locally
    'tabs',        // interact with browser tabs
  ],

  // the popup UI when user clicks the extension icon
  action: {
    default_popup: 'popup/index.html',
    default_icon: 'icons/icon48.png',
  },

  // script injected into every webpage
  content_scripts: [
    {
      matches: ['<all_urls>'],          // run on ALL websites
      js: ['src/content/main.tsx'],
    }
  ],

  // silent background worker
  background: {
    service_worker: 'src/background.ts',
  }
})
```

**Think of it as the `package.json` of your extension.**

---

## 2. `background.ts` — The Silent Worker

This runs **silently in the background** at all times. The user never sees it.

**What it does:**
- Caches data in memory (like your master password, domain list)
- Listens for messages from popup and content scripts
- Makes API calls on behalf of other scripts
- Manages state across the entire extension

```ts
// background.ts
let masterPasswordCache: string | null = null

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'SET_MASTER') {
    masterPasswordCache = message.password
    // auto clear after 30 minutes
    setTimeout(() => { masterPasswordCache = null }, 30 * 60 * 1000)
    sendResponse({ success: true })
  }

  if (message.type === 'GET_MASTER') {
    sendResponse({ password: masterPasswordCache })
  }

  return true // IMPORTANT: keeps the channel open for async responses
})
```

**Key rules:**
- It has NO access to the webpage DOM
- It CANNOT directly read what's on a website
- It CAN make fetch() calls to your backend
- Data stored here lives in memory only — lost when browser closes

---

## 3. `content/main.tsx` — The Webpage Spy

This script is **injected into every webpage** you visit. It runs in the context of the website itself.

**What it does:**
- Reads the DOM of the current page (inputs, buttons, forms)
- Detects login forms
- Injects UI elements into pages (like an autofill button)
- Sends messages to the background script

```tsx
// content/main.tsx

// This runs on EVERY website you visit
const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement
const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement

if (emailInput && passwordInput) {
  const domain = window.location.hostname // e.g. "github.com"

  // ask background if we have saved passwords for this domain
  chrome.runtime.sendMessage({ type: 'CHECK_DOMAIN', domain }, (response) => {
    if (response.exists) {
      injectAutofillButton(emailInput)
    }
  })
}

// listen for autofill command from popup or background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FILL_FIELDS') {
    emailInput.value = msg.email
    passwordInput.value = msg.password

    // trigger events so React/Angular sites detect the change
    emailInput.dispatchEvent(new Event('input', { bubbles: true }))
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
  }
})

const injectAutofillButton = (input: HTMLInputElement) => {
  const btn = document.createElement('button')
  btn.innerText = '🔑'
  btn.onclick = () => chrome.runtime.sendMessage({ type: 'TRIGGER_AUTOFILL' })
  input.parentElement?.appendChild(btn)
}
```

**Key rules:**
- It CAN read and modify the webpage DOM
- It CANNOT directly access background script memory
- It MUST use `chrome.runtime.sendMessage()` to talk to background
- A new instance runs on EVERY page you visit

---

## 4. `popup/` — The UI (React App)

This is the **small window that appears when you click the extension icon**. In your setup it's a full React app.

```
popup/
  App.tsx       ← your main React component
  main.tsx      ← React entry point (renders App)
  index.html    ← HTML shell
  App.css       ← styles
```

```tsx
// popup/App.tsx
import { useState, useEffect } from 'react'

export default function App() {
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [masterPassword, setMasterPassword] = useState('')

  // check if already unlocked when popup opens
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_MASTER' }, (res) => {
      if (res.password) setIsUnlocked(true)
    })
  }, [])

  const unlock = async () => {
    // verify with backend
    const res = await fetch('http://localhost:3000/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword })
    })

    if (res.ok) {
      // store in background memory
      chrome.runtime.sendMessage({ type: 'SET_MASTER', password: masterPassword })
      setIsUnlocked(true)
    }
  }

  if (isUnlocked) {
    return (
      <div style={{ width: 300, padding: 16 }}>
        <h2>✅ Unlocked</h2>
        <button onClick={() => {
          // tell content script to autofill
          chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            chrome.tabs.sendMessage(tab.id!, { type: 'FILL_FIELDS' })
          })
        }}>
          Autofill
        </button>
      </div>
    )
  }

  return (
    <div style={{ width: 300, padding: 16 }}>
      <h2>🔑 Password Manager</h2>
      <input
        type="password"
        placeholder="Master password"
        value={masterPassword}
        onChange={(e) => setMasterPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && unlock()}
      />
      <button onClick={unlock}>Unlock</button>
    </div>
  )
}
```

**Key rules:**
- It's a normal React app — build it exactly like any React component
- It CANNOT directly access content script or webpage DOM
- It CAN send messages to background and content scripts
- It only exists while the popup is open — state is lost when you close it

---

## 5. `sidepanel/` — Optional Side Panel

Same as popup but opens as a **persistent side panel** on the right side of the browser. Good for more complex UIs that need to stay open. You can ignore this for now.

---

## How They All Communicate

The **only way** these pieces talk to each other is through **message passing**:

```
POPUP ──────────────────────► BACKGROUND
       sendMessage()           onMessage listener

CONTENT ────────────────────► BACKGROUND
        sendMessage()          onMessage listener

BACKGROUND ─────────────────► CONTENT (specific tab)
           tabs.sendMessage()  onMessage listener

POPUP ──────────────────────► CONTENT (via tabs API)
      tabs.sendMessage()       onMessage listener
```

**Example — the full autofill message chain:**
```
1. User clicks "Autofill" in popup
2. Popup → Background: "GET_MASTER" → gets cached password
3. Popup → Content: "FILL_FIELDS" with email + password
4. Content script fills the input fields on the webpage
```

---

## How Your Project Compiles

Since you're using **Vite + CRXJS + React + TypeScript**, here's what happens when you run `npm run dev`:

```
Your TypeScript files
        │
        ▼
   Vite compiles
        │
        ▼
   /dist folder
   ├── background.js      ← compiled from background.ts
   ├── content.js         ← compiled from content/main.tsx
   ├── popup/
   │   └── index.html     ← your React popup
   └── manifest.json      ← generated from manifest.config.ts
        │
        ▼
  Brave loads /dist as unpacked extension
```

**CRXJS handles all the wiring automatically** — it reads your `manifest.config.ts`, compiles everything, and puts it in `/dist` ready to load.

---

## Hot Reload Behavior

| What you change | What you need to do |
|---|---|
| Popup (React components) | Nothing — auto updates instantly ✅ |
| Content script | Refresh the webpage you're testing on ✅ |
| Background script | Click refresh on extension in `brave://extensions` ✅ |
| manifest.config.ts | Reload extension in `brave://extensions` ✅ |

---

## Chrome APIs Available to You

```ts
// messaging
chrome.runtime.sendMessage({ type: 'MY_MESSAGE' }, callback)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {})

// tabs
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {})
chrome.tabs.sendMessage(tabId, { type: 'MY_MESSAGE' })

// storage (persists across sessions)
chrome.storage.local.set({ key: 'value' })
chrome.storage.local.get(['key'], (result) => {})

// current tab info (in content script)
window.location.hostname  // current domain
document.querySelector()  // read/modify page DOM
```

---

## Project Structure Summary

```
/extension
  /src
    background.ts         ← silent worker, caches state, talks to backend
    /content
      main.tsx            ← injected into every webpage, reads DOM
    /popup
      App.tsx             ← React UI when clicking extension icon
      main.tsx            ← React entry point
      index.html          ← HTML shell
      App.css             ← styles
    /sidepanel            ← ignore for now
  /public
    /icons                ← extension icons (16, 48, 128px)
  manifest.config.ts      ← THE BRAIN — defines everything
  vite.config.ts          ← build config
  tsconfig.json           ← TypeScript config
  package.json
```

---

## Quick Reference — Who Can Do What

| | Read webpage DOM | Talk to backend | Store in memory | Store persistently |
|---|---|---|---|---|
| **Background** | ❌ | ✅ | ✅ | ✅ (chrome.storage) |
| **Content Script** | ✅ | ✅ | ❌ | ❌ |
| **Popup** | ❌ | ✅ | ❌ (lost on close) | ✅ (chrome.storage) |

---

## Running & Testing

```bash
# start dev server
npm run dev

# build for production
npm run build
```

1. Go to `brave://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `/dist`
4. Done — extension is live 🎉

To debug:
- **Popup**: Right click extension icon → Inspect
- **Background**: `brave://extensions` → click "Service Worker"
- **Content script**: Open any webpage → F12 → Console (select your extension in the dropdown)