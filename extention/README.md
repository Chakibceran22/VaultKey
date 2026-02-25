# VaultKey — Chrome Extension Architecture Guide

## Table of Contents

1. [What is a Chrome Extension?](#1-what-is-a-chrome-extension)
2. [The 5 Building Blocks](#2-the-5-building-blocks)
3. [Block 1: manifest.json — The Brain](#3-block-1-manifestjson--the-brain)
4. [Block 2: Background Service Worker — The Engine](#4-block-2-background-service-worker--the-engine)
5. [Block 3: Content Scripts — The Spies](#5-block-3-content-scripts--the-spies)
6. [Block 4: Popup — The Main UI](#6-block-4-popup--the-main-ui)
7. [Block 5: Side Panel — The Persistent UI](#7-block-5-side-panel--the-persistent-ui)
8. [Communication Between Parts (Message Passing)](#8-communication-between-parts-message-passing)
9. [State Management](#9-state-management)
10. [Error Handling](#10-error-handling)
11. [Chrome APIs — The Full Toolbox](#11-chrome-apis--the-full-toolbox)
12. [Extension Lifecycle](#12-extension-lifecycle)
13. [Security Model — How Chrome Isolates Everything](#13-security-model--how-chrome-isolates-everything)
14. [Build Tooling (Vite + CRXJS)](#14-build-tooling-vite--crxjs)
15. [Debugging](#15-debugging)
16. [Project Structure](#16-project-structure)
17. [Quick Reference Tables](#17-quick-reference-tables)

---

## 1. What is a Chrome Extension?

A Chrome extension is a **mini web app that runs inside your browser** with special powers. It's built with the same tools you know — HTML, CSS, TypeScript/JavaScript — but it has access to browser APIs (`chrome.*`) that normal websites don't.

What makes it special:
- It can **read and modify any webpage** you visit (content scripts)
- It can **run code in the background** even when no tab is focused (service worker)
- It can **store data locally** in the browser (chrome.storage)
- It can **intercept network requests** (webRequest API)
- It can **communicate with your own backend** (fetch from background)
- It can **show UI** via popups, side panels, or injected elements

**Key mental model**: An extension is NOT one program. It's **multiple isolated programs** that run in different contexts and talk to each other through **message passing**. This is the most important thing to understand.

```
┌──────────────────────────────────────────────────────────────────┐
│                         BROWSER                                  │
│                                                                  │
│  ┌─────────────┐    messages     ┌─────────────────────────┐    │
│  │   POPUP     │◄──────────────►│   BACKGROUND            │    │
│  │  (React UI) │                │   (Service Worker)      │    │
│  └─────────────┘                └──────────┬──────────────┘    │
│                                            │                    │
│  ┌─────────────┐    messages              │ messages           │
│  │  SIDEPANEL  │◄─────────────────────────┤                    │
│  │  (React UI) │                          │                    │
│  └─────────────┘                          │                    │
│                                            ▼                    │
│  ┌────────────────────────────────────────────────────────┐    │
│  │              CONTENT SCRIPT                            │    │
│  │         (runs inside every webpage)                    │    │
│  │                                                        │    │
│  │  Has access to the webpage's DOM but is isolated       │    │
│  │  from the webpage's JavaScript                         │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────┐              │
│  │           manifest.json                       │              │
│  │    (config file — defines everything)         │              │
│  └──────────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────────┘
                           │
                           │ fetch() / HTTP
                           ▼
                ┌────────────────────┐
                │   YOUR BACKEND     │
                │   (NestJS API)     │
                └────────────────────┘
```

---

## 2. The 5 Building Blocks

Every Chrome extension can have up to 5 core building blocks. Not all are required — you pick what you need.

| Block | File(s) | Where it runs | Lifetime | Can see DOM? |
|---|---|---|---|---|
| **Manifest** | `manifest.config.ts` | N/A (config only) | N/A | N/A |
| **Background** | `src/background.ts` | Its own isolated thread | Persistent (with idle sleep) | No |
| **Content Script** | `src/content/main.tsx` | Inside every matching webpage | Per page load | Yes |
| **Popup** | `src/popup/` | Its own window when icon is clicked | Only while open | No (own DOM) |
| **Side Panel** | `src/sidepanel/` | Browser side panel | While panel is open | No (own DOM) |

**Critical insight**: Each block runs in a **completely separate JavaScript context**. They do NOT share variables, memory, or DOM. The ONLY way they communicate is through Chrome's message passing APIs.

---

## 3. Block 1: manifest.json — The Brain

The manifest is the **configuration file** that tells Chrome everything about your extension. Without it, Chrome doesn't know what your extension is.

In this project we use `manifest.config.ts` (TypeScript) which CRXJS compiles into the final `manifest.json`.

### What the manifest defines:

```ts
// manifest.config.ts — ANNOTATED
import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  // REQUIRED: Must be 3 for modern extensions (Manifest V2 is deprecated)
  manifest_version: 3,

  // REQUIRED: Extension name shown in chrome://extensions
  name: 'vault-key',
  version: '0.0.1',

  // ICONS: Shown in toolbar, extensions page, Chrome Web Store
  icons: {
    48: 'public/logo.png',    // 48x48 for extensions page
    // 16: 'icons/16.png',    // 16x16 for favicon (optional)
    // 128: 'icons/128.png',  // 128x128 for Chrome Web Store (optional)
  },

  // ACTION: Defines the toolbar button behavior
  action: {
    default_icon: { 48: 'public/logo.png' },
    default_popup: 'src/popup/index.html',  // what opens when you click the icon
    // default_title: 'VaultKey',            // tooltip on hover (optional)
  },

  // PERMISSIONS: What Chrome APIs your extension can use
  // Each permission you add is shown to the user during install
  permissions: [
    'sidePanel',        // use the side panel API
    'contentSettings',  // read/write content settings
    // 'storage',       // use chrome.storage (local/sync)
    // 'activeTab',     // access the current tab temporarily
    // 'tabs',          // access all tabs
    // 'alarms',        // schedule periodic tasks
    // 'notifications', // show desktop notifications
    // 'clipboardWrite',// write to clipboard
    // 'clipboardRead', // read from clipboard
  ],

  // CONTENT SCRIPTS: Scripts injected into webpages
  content_scripts: [{
    js: ['src/content/main.tsx'],   // the script to inject
    matches: ['https://*/*'],       // URL patterns to match
    // run_at: 'document_idle',     // when to inject (default: document_idle)
    // css: ['content.css'],        // optional CSS to inject
  }],

  // SIDE PANEL: Persistent panel on the right side of the browser
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },

  // BACKGROUND: The service worker
  background: {
    service_worker: 'src/background.ts',
  },

  // HOST PERMISSIONS: Which websites your extension can access
  // host_permissions: [
  //   'https://*.google.com/*',  // only Google domains
  //   '<all_urls>',              // ALL websites
  // ],
})
```

### Permissions explained

Permissions are critical — they determine what your extension CAN and CANNOT do. Chrome shows users what permissions you request during installation.

| Permission | What it gives you | When you need it |
|---|---|---|
| `storage` | `chrome.storage.local` and `chrome.storage.sync` | Persisting data between sessions |
| `activeTab` | Temporary access to the current tab when user clicks your icon | Reading the current page on demand |
| `tabs` | `chrome.tabs.query()`, `chrome.tabs.sendMessage()` | Sending messages to content scripts, reading tab URLs |
| `sidePanel` | `chrome.sidePanel.open()` | Opening and controlling the side panel |
| `alarms` | `chrome.alarms.create()` | Scheduling periodic background tasks |
| `notifications` | `chrome.notifications.create()` | Desktop notifications |
| `clipboardWrite` | `navigator.clipboard.writeText()` | Copying passwords to clipboard |
| `clipboardRead` | `navigator.clipboard.readText()` | Reading from clipboard |
| `webRequest` | `chrome.webRequest.onBeforeRequest` | Intercepting/modifying network requests |
| `identity` | `chrome.identity.getAuthToken()` | OAuth2 authentication flows |

### Match patterns for content scripts

```
'<all_urls>'           → every website
'https://*/*'          → all HTTPS sites
'https://*.google.com/*' → only Google subdomains
'https://github.com/*' → only GitHub
'*://*.example.com/*'  → HTTP and HTTPS for example.com
```

---

## 4. Block 2: Background Service Worker — The Engine

The background service worker is the **central hub** of your extension. It's the only part that:
- Runs persistently (though Chrome can suspend it to save memory)
- Can hold in-memory state
- Acts as a router between all other parts
- Should handle all backend communication

### Mental Model

Think of the background as a **Node.js server running inside the browser**. It has no UI, no DOM — it just processes messages, stores data, and makes HTTP calls.

```
                    ┌──────────────────────────────┐
                    │     BACKGROUND SERVICE        │
                    │         WORKER                │
                    │                              │
  Popup ──msg──►   │  chrome.runtime.onMessage     │
  Content ─msg──►  │       ├── route messages      │
  SidePanel ─msg─► │       ├── fetch() to backend  │
                    │       ├── chrome.storage      │
                    │       └── in-memory cache     │
                    │                              │
                    │  chrome.runtime.onInstalled   │
                    │  chrome.alarms.onAlarm        │
                    │  chrome.tabs.onUpdated        │
                    └──────────────────────────────┘
```

### Lifecycle Events

```ts
// ═══════════════════════════════════════════════════════
// EVENT: Extension first installed or updated
// ═══════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // First time install — set defaults
    chrome.storage.local.set({ backendUrl: 'http://localhost:3000' })
    console.log('[VaultKey] Extension installed!')
  }

  if (details.reason === 'update') {
    // Extension was updated to a new version
    console.log('[VaultKey] Updated to', chrome.runtime.getManifest().version)
  }
})

// ═══════════════════════════════════════════════════════
// EVENT: Browser starts / extension loads
// ═══════════════════════════════════════════════════════
chrome.runtime.onStartup.addListener(() => {
  console.log('[VaultKey] Browser started, extension loaded')
})

// ═══════════════════════════════════════════════════════
// EVENT: Service worker wakes up from suspension
// ═══════════════════════════════════════════════════════
// NOTE: Chrome can suspend your service worker after ~30s of inactivity.
// When a message arrives, it wakes back up. This means:
//   - In-memory variables might be LOST
//   - Always use chrome.storage for important data
//   - Re-initialize state when the worker wakes up
```

### Message Router Pattern

The background should act as a **central message router**. This is the pattern you should follow:

```ts
// background.ts — Message Router Pattern

// ─── In-memory cache (WARNING: lost on suspension) ───
let sessionCache: {
  masterKey: string | null
  isUnlocked: boolean
} = {
  masterKey: null,
  isUnlocked: false,
}

// ─── Central message handler ───
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // message: the data sent by the caller
  // sender: who sent it (has sender.tab if from content script)
  // sendResponse: callback to reply to the sender

  const { type, payload } = message

  switch (type) {
    case 'UNLOCK':
      handleUnlock(payload, sendResponse)
      return true  // ← CRITICAL: return true for async responses

    case 'LOCK':
      handleLock(sendResponse)
      return true

    case 'GET_STATUS':
      // Synchronous response — no need to return true
      sendResponse({ isUnlocked: sessionCache.isUnlocked })
      break

    case 'SAVE_PASSWORD':
      handleSavePassword(payload, sendResponse)
      return true

    case 'GET_PASSWORDS':
      handleGetPasswords(payload, sendResponse)
      return true

    default:
      sendResponse({ error: `Unknown message type: ${type}` })
  }
})

// ─── Handler functions ───
async function handleUnlock(
  payload: { masterPassword: string },
  sendResponse: (response: unknown) => void
) {
  try {
    const res = await fetch('http://localhost:3000/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: payload.masterPassword }),
    })

    if (!res.ok) {
      sendResponse({ success: false, error: 'Invalid master password' })
      return
    }

    const data = await res.json()
    sessionCache.masterKey = data.derivedKey
    sessionCache.isUnlocked = true

    // Auto-lock after 30 minutes
    chrome.alarms.create('auto-lock', { delayInMinutes: 30 })

    sendResponse({ success: true })
  } catch (err) {
    sendResponse({ success: false, error: 'Backend unreachable' })
  }
}

async function handleLock(sendResponse: (response: unknown) => void) {
  sessionCache.masterKey = null
  sessionCache.isUnlocked = false
  chrome.alarms.clear('auto-lock')
  sendResponse({ success: true })
}

async function handleSavePassword(
  payload: { domain: string; username: string; password: string },
  sendResponse: (response: unknown) => void
) {
  try {
    const res = await fetch('http://localhost:3000/passwords', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionCache.masterKey}`,
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    sendResponse({ success: true, data })
  } catch (err) {
    sendResponse({ success: false, error: 'Failed to save password' })
  }
}

async function handleGetPasswords(
  payload: { domain: string },
  sendResponse: (response: unknown) => void
) {
  try {
    const res = await fetch(
      `http://localhost:3000/passwords?domain=${payload.domain}`,
      {
        headers: { 'Authorization': `Bearer ${sessionCache.masterKey}` },
      }
    )
    const data = await res.json()
    sendResponse({ success: true, passwords: data })
  } catch (err) {
    sendResponse({ success: false, error: 'Failed to fetch passwords' })
  }
}

// ─── Alarm handler (for auto-lock) ───
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-lock') {
    sessionCache.masterKey = null
    sessionCache.isUnlocked = false
    console.log('[VaultKey] Auto-locked after timeout')
  }
})
```

### Key rules for the background:

1. **NO DOM access** — `document`, `window.location`, `querySelector` do NOT exist here
2. **Can be suspended** — Chrome kills idle service workers after ~30 seconds. In-memory data is lost. Always persist important data to `chrome.storage`
3. **Must return `true`** from `onMessage` listener if you use `sendResponse` asynchronously (after an `await` or in a callback)
4. **Single instance** — only one background worker runs for your extension
5. **Can use `fetch()`** — this is where you make all HTTP calls to your backend
6. **Can use `chrome.storage`** — for persistent data that survives suspension

---

## 5. Block 3: Content Scripts — The Spies

Content scripts are injected into **every webpage that matches your URL pattern**. They run in the context of the webpage, meaning they can read and modify the DOM.

### How injection works

```
User visits https://github.com/login
         │
         ▼
Chrome checks manifest.content_scripts.matches
         │
         ▼
"https://*/*" matches → inject src/content/main.tsx
         │
         ▼
Content script runs inside the page
  ├── Can read: document.querySelector('input[type="password"]')
  ├── Can modify: inject autofill buttons
  ├── Can listen: chrome.runtime.onMessage
  └── Can send: chrome.runtime.sendMessage()
```

### Important: Isolated World

Content scripts run in an **isolated world**. This means:

```
┌─────────────────────────────────────────────┐
│               WEBPAGE                        │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  Page's JavaScript                    │   │
│  │  (React, Angular, etc.)               │   │
│  │  window.myVar = 'hello'               │   │
│  │                                        │   │
│  │  CAN'T see content script variables   │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  Content Script (ISOLATED WORLD)      │   │
│  │                                        │   │
│  │  CAN read/write the DOM (shared)      │   │
│  │  CAN'T access page's JS variables     │   │
│  │  CAN use chrome.runtime.sendMessage   │   │
│  │  CAN'T use most chrome.* APIs         │   │
│  └──────────────────────────────────────┘   │
│                                              │
│         ┌──────────────┐                    │
│         │   SHARED DOM │ ← both can access  │
│         └──────────────┘                    │
└─────────────────────────────────────────────┘
```

**They share the DOM** but have completely separate JavaScript scopes. Your content script cannot read `window.someVar` set by the page's JS, and the page cannot read your extension's variables.

### Content script patterns for a password manager

```tsx
// content/main.tsx

// ─── PATTERN 1: Detect login forms ───
function detectLoginForm(): { email: HTMLInputElement | null; password: HTMLInputElement | null } {
  const password = document.querySelector('input[type="password"]') as HTMLInputElement | null
  if (!password) return { email: null, password: null }

  // Look for email/username near the password field
  const form = password.closest('form')
  const email = form?.querySelector(
    'input[type="email"], input[type="text"], input[name*="user"], input[name*="email"]'
  ) as HTMLInputElement | null

  return { email, password }
}

// ─── PATTERN 2: Inject UI into the page ───
function injectAutofillButton(anchor: HTMLElement) {
  const container = document.createElement('div')
  container.id = 'vaultkey-root'
  anchor.parentElement?.appendChild(container)

  // You can mount a full React component here
  createRoot(container).render(<AutofillButton />)
}

// ─── PATTERN 3: Listen for commands from popup/background ───
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FILL_FIELDS') {
    const { email, password } = detectLoginForm()
    if (email) {
      email.value = msg.email
      email.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (password) {
      password.value = msg.password
      password.dispatchEvent(new Event('input', { bubbles: true }))
    }
    sendResponse({ success: true })
  }

  if (msg.type === 'DETECT_FORM') {
    const { email, password } = detectLoginForm()
    sendResponse({
      hasForm: !!password,
      domain: window.location.hostname,
      hasEmail: !!email,
    })
  }
})

// ─── PATTERN 4: Notify background on page load ───
const { password } = detectLoginForm()
if (password) {
  chrome.runtime.sendMessage({
    type: 'LOGIN_FORM_DETECTED',
    payload: { domain: window.location.hostname },
  })
}
```

### `run_at` — When the content script injects

You can control when your content script runs:

```ts
content_scripts: [{
  js: ['src/content/main.tsx'],
  matches: ['https://*/*'],
  run_at: 'document_idle',     // DEFAULT: after page fully loads
  // run_at: 'document_start', // before any page JS runs (DOM not ready yet)
  // run_at: 'document_end',   // after DOM is ready but before images/subframes
}]
```

For a password manager, `document_idle` (the default) is best — the login forms will be rendered by then.

### `dispatchEvent` — Why you need it

Modern websites (React, Angular, Vue) don't watch for `input.value` changes directly. They listen for events. When you set `input.value = 'hello'`, the site's framework doesn't know the value changed. You must fire the event manually:

```ts
input.value = 'newvalue'
input.dispatchEvent(new Event('input', { bubbles: true }))
// Some sites also need:
input.dispatchEvent(new Event('change', { bubbles: true }))
```

### Key rules for content scripts:

1. **CAN access webpage DOM** — `document.querySelector`, create elements, read forms
2. **CANNOT access page's JS** — isolated world, no shared variables
3. **Limited chrome APIs** — only `chrome.runtime.sendMessage`, `chrome.runtime.onMessage`, `chrome.storage`, and a few others
4. **One instance per tab** — each tab gets its own content script instance
5. **Destroyed on navigation** — when user navigates to a new page, old content script dies and a new one injects

---

## 6. Block 4: Popup — The Main UI

The popup is a **normal React app** that opens when the user clicks the extension icon. It lives in its own window.

### Structure

```
popup/
  index.html    ← HTML shell (like public/index.html in Create React App)
  main.tsx      ← React entry point (ReactDOM.createRoot)
  App.tsx       ← Your main component
  App.css       ← Styles
  index.css     ← Global styles
```

### Key behaviors

1. **Short-lived** — The popup is DESTROYED every time the user clicks away. All React state is lost. If you have `useState('hello')`, it resets to `'hello'` next time the popup opens.

2. **Fixed size** — The popup auto-sizes to its content but has a max width of 800px and max height of 600px. Set explicit dimensions:
   ```css
   body {
     min-width: 350px;
     min-height: 500px;
   }
   ```

3. **Own DOM** — The popup has its own `document`. It cannot see the webpage DOM. To interact with the webpage, you must send a message to the content script.

4. **Can use chrome APIs** — The popup can use `chrome.runtime.sendMessage`, `chrome.storage`, `chrome.tabs`, etc.

### Communication from Popup

```tsx
// popup/App.tsx

// ─── Talk to Background ───
function sendToBackground(type: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      resolve(response)
    })
  })
}

// Usage:
const status = await sendToBackground('GET_STATUS')
// → { isUnlocked: true }

// ─── Talk to Content Script (current tab) ───
async function sendToContentScript(type: string, payload?: unknown): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab.id) throw new Error('No active tab')

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id!, { type, payload }, (response) => {
      resolve(response)
    })
  })
}

// Usage:
const formInfo = await sendToContentScript('DETECT_FORM')
// → { hasForm: true, domain: 'github.com', hasEmail: true }
```

### Full Popup example for VaultKey

```tsx
// popup/App.tsx
import { useState, useEffect } from 'react'

type Status = { isUnlocked: boolean }

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [masterPassword, setMasterPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // On popup open: check if already unlocked
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res: Status) => {
      setStatus(res)
    })
  }, [])

  const handleUnlock = async () => {
    setLoading(true)
    setError('')
    chrome.runtime.sendMessage(
      { type: 'UNLOCK', payload: { masterPassword } },
      (res) => {
        setLoading(false)
        if (res.success) {
          setStatus({ isUnlocked: true })
        } else {
          setError(res.error || 'Failed to unlock')
        }
      }
    )
  }

  const handleAutofill = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab.id) return
      chrome.tabs.sendMessage(tab.id, {
        type: 'FILL_FIELDS',
        email: 'user@example.com',
        password: 'secret123',
      })
    })
  }

  if (!status) return <div>Loading...</div>

  if (status.isUnlocked) {
    return (
      <div style={{ width: 300, padding: 16 }}>
        <h2>VaultKey Unlocked</h2>
        <button onClick={handleAutofill}>Autofill Current Page</button>
        <button onClick={() => {
          chrome.runtime.sendMessage({ type: 'LOCK' }, () => {
            setStatus({ isUnlocked: false })
          })
        }}>Lock</button>
      </div>
    )
  }

  return (
    <div style={{ width: 300, padding: 16 }}>
      <h2>VaultKey</h2>
      <input
        type="password"
        placeholder="Master password"
        value={masterPassword}
        onChange={(e) => setMasterPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
      />
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button onClick={handleUnlock} disabled={loading}>
        {loading ? 'Unlocking...' : 'Unlock'}
      </button>
    </div>
  )
}
```

---

## 7. Block 5: Side Panel — The Persistent UI

The side panel is like the popup but **stays open** while you browse. It's a full React app that opens on the right side of the browser.

### Popup vs Side Panel

| Feature | Popup | Side Panel |
|---|---|---|
| Opens when | User clicks extension icon | Programmatically or via right-click |
| Closes when | User clicks anywhere else | User explicitly closes it |
| State persistence | Lost on every close | Survives while open |
| Size | Small (800x600 max) | Full browser height, ~400px wide |
| Best for | Quick actions, status checks | Complex UIs, password lists, forms |

### Opening the side panel programmatically

```ts
// In background.ts
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id! })
})

// Or from popup:
chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' })
```

**For VaultKey**: Use the side panel for browsing/managing all saved passwords. Use the popup for quick unlock + autofill.

---

## 8. Communication Between Parts (Message Passing)

This is the **most important concept** in extension development. Since each part runs in isolation, the ONLY way they talk is through Chrome's messaging system.

### The 3 Communication Channels

```
┌─────────────────────────────────────────────────────────────┐
│                                                              │
│  CHANNEL 1: Any part → Background                           │
│  ─────────────────────────────────────                      │
│  chrome.runtime.sendMessage({ type, payload }, callback)    │
│                                                              │
│  CHANNEL 2: Background → Specific Tab (Content Script)      │
│  ─────────────────────────────────────                      │
│  chrome.tabs.sendMessage(tabId, { type, payload }, callback)│
│                                                              │
│  CHANNEL 3: Long-lived connections (Ports)                  │
│  ─────────────────────────────────────                      │
│  chrome.runtime.connect({ name: 'my-channel' })            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Channel 1: One-shot messages (most common)

```ts
// ═══ SENDER (popup, content, or sidepanel) ═══
chrome.runtime.sendMessage(
  { type: 'SAVE_PASSWORD', payload: { domain: 'github.com', user: 'me' } },
  (response) => {
    // response comes from the background's sendResponse
    console.log(response) // { success: true }
  }
)

// ═══ RECEIVER (background.ts) ═══
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // message = { type: 'SAVE_PASSWORD', payload: { domain: 'github.com', user: 'me' } }
  // sender.tab = the tab that sent it (if from content script)
  // sender.id = the extension ID

  if (message.type === 'SAVE_PASSWORD') {
    // Do async work...
    saveToBackend(message.payload).then((result) => {
      sendResponse({ success: true, data: result })
    })

    return true // ← MUST return true for async sendResponse
  }
})
```

### Channel 2: Background → Content Script

```ts
// ═══ SENDER (background or popup) ═══
// First, get the tab ID
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.tabs.sendMessage(
    tab.id!,
    { type: 'FILL_FIELDS', email: 'user@test.com', password: '123' },
    (response) => {
      console.log(response) // { success: true }
    }
  )
})

// ═══ RECEIVER (content script) ═══
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FILL_FIELDS') {
    // Fill the form...
    sendResponse({ success: true })
  }
})
```

### Channel 3: Long-lived connections (Ports)

For ongoing bidirectional communication (like streaming updates):

```ts
// ═══ In popup or content script ═══
const port = chrome.runtime.connect({ name: 'password-stream' })

// Send messages through the port
port.postMessage({ type: 'SUBSCRIBE', domain: 'github.com' })

// Receive messages
port.onMessage.addListener((msg) => {
  console.log('Got update:', msg)
})

// Clean up when done
port.onDisconnect.addListener(() => {
  console.log('Port disconnected')
})

// ═══ In background.ts ═══
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'password-stream') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'SUBSCRIBE') {
        // Send data back through the port
        port.postMessage({ passwords: [...] })
      }
    })
  }
})
```

### The `return true` rule

This is the #1 source of bugs in extension development:

```ts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // SYNC response — works without return true
  if (msg.type === 'PING') {
    sendResponse({ pong: true })
    // no return needed
  }

  // ASYNC response — MUST return true
  if (msg.type === 'FETCH_DATA') {
    fetch('http://localhost:3000/data')
      .then(res => res.json())
      .then(data => sendResponse({ data }))

    return true // ← Without this, sendResponse is ALREADY DEAD
    // Chrome closes the message channel immediately unless you return true
  }
})
```

**Rule**: If `sendResponse` is called inside a `.then()`, `await`, `setTimeout`, or any async callback, you MUST `return true` from the listener.

### Complete message flow example

```
User clicks "Autofill" in Popup
         │
         ▼
┌─── POPUP ──────────────────────────────────────────────────┐
│ chrome.runtime.sendMessage(                                │
│   { type: 'GET_PASSWORDS', payload: { domain } },         │
│   (response) => { /* got passwords */ }                    │
│ )                                                          │
└────────────────────────────────┬───────────────────────────┘
                                 │
                                 ▼
┌─── BACKGROUND ─────────────────────────────────────────────┐
│ onMessage: type === 'GET_PASSWORDS'                        │
│   → fetch('http://localhost:3000/passwords?domain=...')     │
│   → sendResponse({ passwords: [...] })                     │
│   → return true                                            │
└────────────────────────────────┬───────────────────────────┘
                                 │
                                 │ (popup receives passwords,
                                 │  then sends to content script)
                                 ▼
┌─── POPUP ──────────────────────────────────────────────────┐
│ chrome.tabs.sendMessage(tab.id, {                          │
│   type: 'FILL_FIELDS',                                     │
│   email: passwords[0].email,                               │
│   password: passwords[0].password                          │
│ })                                                          │
└────────────────────────────────┬───────────────────────────┘
                                 │
                                 ▼
┌─── CONTENT SCRIPT (in the webpage) ────────────────────────┐
│ onMessage: type === 'FILL_FIELDS'                          │
│   → emailInput.value = msg.email                           │
│   → passwordInput.value = msg.password                     │
│   → dispatchEvent(new Event('input', { bubbles: true }))   │
│   → sendResponse({ success: true })                        │
└────────────────────────────────────────────────────────────┘
```

---

## 9. State Management

Extensions have **4 layers of state**, each with different lifetimes and access patterns.

### Layer 1: React State (component-level)

```ts
const [count, setCount] = useState(0)
```

- **Lifetime**: Dies when the popup/sidepanel closes
- **Scope**: Single component
- **Use for**: UI state only (loading spinners, form inputs, toggles)

### Layer 2: In-Memory Variables (background)

```ts
// background.ts
let masterKey: string | null = null
```

- **Lifetime**: Dies when Chrome suspends the service worker (~30s idle)
- **Scope**: Background script only
- **Use for**: Short-lived sensitive data (session keys, cached tokens)
- **Danger**: Chrome CAN kill this at any time. Don't rely on it for persistence.

### Layer 3: chrome.storage.local (persistent, local)

```ts
// SET — from any part of the extension
chrome.storage.local.set({ savedPasswords: [...] })

// GET — from any part of the extension
chrome.storage.local.get(['savedPasswords'], (result) => {
  console.log(result.savedPasswords)
})

// REMOVE
chrome.storage.local.remove(['savedPasswords'])

// LISTEN for changes (from ANY part)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.savedPasswords) {
    console.log('Old:', changes.savedPasswords.oldValue)
    console.log('New:', changes.savedPasswords.newValue)
  }
})
```

- **Lifetime**: Persists forever (survives browser restart, extension update)
- **Scope**: Accessible from ALL parts (background, popup, content, sidepanel)
- **Limit**: 10MB total
- **Use for**: User settings, cached data, non-sensitive preferences
- **NEVER store**: Plain-text passwords, master keys, tokens

### Layer 4: chrome.storage.session (persistent within session)

```ts
// Only available in background (Manifest V3)
chrome.storage.session.set({ sessionToken: 'abc123' })
chrome.storage.session.get(['sessionToken'], (result) => {
  console.log(result.sessionToken)
})
```

- **Lifetime**: Dies when browser closes (NOT when service worker suspends)
- **Scope**: Background script only (by default)
- **Limit**: 10MB
- **Use for**: Session tokens, temporary auth state — survives service worker suspension but not browser restart

### State strategy for VaultKey

```
┌──────────────────────────────────────────────────────────────┐
│                   STATE STRATEGY                              │
│                                                              │
│  React State (popup/sidepanel)                               │
│  └── UI state: loading, errors, form inputs                  │
│                                                              │
│  chrome.storage.session (background)                         │
│  └── Session auth: master key hash, JWT token                │
│  └── Survives service worker suspension                      │
│  └── Dies when browser closes (good for security)            │
│                                                              │
│  chrome.storage.local                                        │
│  └── User preferences: theme, auto-lock timeout              │
│  └── Backend URL configuration                               │
│  └── Last used accounts (non-sensitive metadata)             │
│                                                              │
│  BACKEND DATABASE (via API calls)                            │
│  └── All encrypted passwords                                 │
│  └── User accounts                                           │
│  └── Encryption happens server-side                          │
└──────────────────────────────────────────────────────────────┘
```

### Using storage.onChanged for reactive state

`chrome.storage.onChanged` is like a **global event bus** — any part of the extension can listen for storage changes made by any other part:

```ts
// In popup — react to background changing the lock status
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.isLocked) {
    // Background locked the extension → update UI
    setIsLocked(changes.isLocked.newValue)
  }
})

// In background — set the value
chrome.storage.local.set({ isLocked: true })
// → popup's listener fires automatically
```

This is a powerful pattern for keeping all parts of your extension in sync without explicit messages.

---

## 10. Error Handling

Extensions fail silently by default. You need to handle errors explicitly.

### Error Pattern 1: Message sending errors

```ts
// The receiver might not exist (content script not injected yet)
chrome.tabs.sendMessage(tabId, { type: 'FILL' }, (response) => {
  if (chrome.runtime.lastError) {
    // This happens when:
    // - Content script hasn't loaded yet
    // - Tab was closed
    // - Extension was reloaded
    console.error('Message failed:', chrome.runtime.lastError.message)
    return
  }
  // Handle response normally
  console.log(response)
})
```

**ALWAYS check `chrome.runtime.lastError`** in message callbacks. If you don't, Chrome logs a noisy error to the console.

### Error Pattern 2: Async errors in background

```ts
// background.ts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_DATA') {
    fetchFromBackend(msg.payload)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }))

    return true
  }
})

// In popup — always handle both cases
chrome.runtime.sendMessage({ type: 'FETCH_DATA', payload }, (res) => {
  if (chrome.runtime.lastError) {
    setError('Extension error: ' + chrome.runtime.lastError.message)
    return
  }
  if (!res.success) {
    setError('Backend error: ' + res.error)
    return
  }
  setData(res.data)
})
```

### Error Pattern 3: Content script not ready

A common race condition: the popup tries to message the content script before it has loaded.

```ts
// popup/App.tsx — retry pattern
async function sendToContentWithRetry(
  tabId: number,
  message: unknown,
  retries = 3
): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message))
          } else {
            resolve(res)
          }
        })
      })
      return response
    } catch {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 500)) // wait 500ms before retry
      }
    }
  }
  throw new Error('Content script not responding after retries')
}
```

### Error Pattern 4: Backend unreachable

```ts
// background.ts — wrapper for all backend calls
async function callBackend(
  path: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const { backendUrl } = await chrome.storage.local.get('backendUrl')
    const res = await fetch(`${backendUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!res.ok) {
      const body = await res.text()
      return { success: false, error: `HTTP ${res.status}: ${body}` }
    }

    const data = await res.json()
    return { success: true, data }
  } catch (err) {
    // Network error — backend is down or unreachable
    return { success: false, error: 'Backend unreachable. Is the server running?' }
  }
}
```

### Error Pattern 5: Storage errors

```ts
// chrome.storage can fail (quota exceeded, etc.)
chrome.storage.local.set({ key: value }, () => {
  if (chrome.runtime.lastError) {
    console.error('Storage write failed:', chrome.runtime.lastError.message)
  }
})
```

### Summary: Error handling checklist

| Where | What to check |
|---|---|
| **Every `sendMessage` callback** | `chrome.runtime.lastError` |
| **Every `tabs.sendMessage` callback** | `chrome.runtime.lastError` (content script might not exist) |
| **Every `fetch()` in background** | Wrap in try/catch, handle network errors |
| **Every `chrome.storage` callback** | `chrome.runtime.lastError` |
| **Every async `sendResponse`** | `return true` from the listener |

---

## 11. Chrome APIs — The Full Toolbox

Here's every Chrome API you'll likely need for VaultKey, grouped by purpose.

### Messaging

```ts
// Send to background (from popup, content, sidepanel)
chrome.runtime.sendMessage({ type: 'MSG', payload: {} }, (response) => {})

// Listen for messages (in any part)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  return true // for async
})

// Send to a specific tab's content script (from background or popup)
chrome.tabs.sendMessage(tabId, { type: 'MSG' }, (response) => {})

// Long-lived connection
const port = chrome.runtime.connect({ name: 'channel' })
port.postMessage({ data: 'hello' })
port.onMessage.addListener((msg) => {})
port.onDisconnect.addListener(() => {})
```

### Storage

```ts
// Local storage (persists forever, 10MB limit)
chrome.storage.local.set({ key: value })
chrome.storage.local.get(['key'], (result) => result.key)
chrome.storage.local.remove(['key'])
chrome.storage.local.clear() // remove everything

// Session storage (dies on browser close, background only)
chrome.storage.session.set({ key: value })
chrome.storage.session.get(['key'], (result) => result.key)

// Sync storage (syncs across devices, 100KB limit)
chrome.storage.sync.set({ key: value })
chrome.storage.sync.get(['key'], (result) => result.key)

// Listen for changes (works from any part)
chrome.storage.onChanged.addListener((changes, areaName) => {
  // changes.key.oldValue, changes.key.newValue
  // areaName: 'local', 'sync', or 'session'
})
```

### Tabs

```ts
// Get the current active tab
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  console.log(tab.id, tab.url, tab.title)
})

// Get all tabs
chrome.tabs.query({}, (tabs) => {})

// Listen for tab URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    console.log('Tab navigated to:', changeInfo.url)
  }
})

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  console.log('User switched to tab:', tabId)
})
```

### Alarms (scheduled tasks)

```ts
// Requires "alarms" permission

// Create a one-time alarm (fires after 30 minutes)
chrome.alarms.create('auto-lock', { delayInMinutes: 30 })

// Create a repeating alarm (fires every 5 minutes)
chrome.alarms.create('sync-passwords', { periodInMinutes: 5 })

// Listen for alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-lock') {
    // Lock the extension
  }
  if (alarm.name === 'sync-passwords') {
    // Sync with backend
  }
})

// Cancel an alarm
chrome.alarms.clear('auto-lock')
```

### Notifications

```ts
// Requires "notifications" permission

chrome.notifications.create('password-copied', {
  type: 'basic',
  iconUrl: 'public/logo.png',
  title: 'VaultKey',
  message: 'Password copied to clipboard!',
})

// Auto-dismiss after 3 seconds
setTimeout(() => chrome.notifications.clear('password-copied'), 3000)
```

### Clipboard

```ts
// Requires "clipboardWrite" permission
// Must be called from popup or background (not content script)

navigator.clipboard.writeText('the-password').then(() => {
  console.log('Password copied!')
  // Auto-clear after 30 seconds for security
  setTimeout(() => navigator.clipboard.writeText(''), 30000)
})
```

### Side Panel

```ts
// Requires "sidePanel" permission

// Open the side panel for a specific tab
chrome.sidePanel.open({ tabId: tab.id })

// Set the side panel page dynamically
chrome.sidePanel.setOptions({
  tabId: tab.id,
  path: 'src/sidepanel/index.html',
  enabled: true,
})
```

### Context Menus (right-click menu)

```ts
// Requires "contextMenus" permission

// Create a right-click menu item (in background.ts)
chrome.contextMenus.create({
  id: 'generate-password',
  title: 'Generate Password',
  contexts: ['editable'], // only show on input fields
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'generate-password') {
    const password = generateStrongPassword()
    chrome.tabs.sendMessage(tab!.id!, {
      type: 'FILL_PASSWORD',
      password,
    })
  }
})
```

### Runtime info

```ts
// Get extension ID
chrome.runtime.id

// Get extension manifest
chrome.runtime.getManifest()

// Get extension URL (for opening options page, etc.)
chrome.runtime.getURL('src/options/index.html')

// Open extension page in a new tab
chrome.tabs.create({ url: chrome.runtime.getURL('src/options/index.html') })
```

---

## 12. Extension Lifecycle

Understanding when each part starts, runs, and dies:

```
BROWSER STARTS
     │
     ▼
Background Service Worker starts
  ├── chrome.runtime.onStartup fires
  ├── Initializes state from chrome.storage
  └── Starts listening for messages
     │
     ▼
USER VISITS A WEBPAGE (matching content_scripts.matches)
     │
     ▼
Content Script injects into the page
  ├── Reads DOM, detects login forms
  ├── Sends messages to background
  └── Dies when user navigates away
     │
     ▼
USER CLICKS EXTENSION ICON
     │
     ▼
Popup opens (React app mounts)
  ├── useEffect fetches state from background
  ├── User interacts with UI
  ├── Sends messages to background/content
  └── Dies when user clicks away (React unmounts)
     │
     ▼
~30 SECONDS OF INACTIVITY
     │
     ▼
Background Service Worker SUSPENDS
  ├── All in-memory variables are LOST
  ├── chrome.storage data SURVIVES
  ├── Alarms SURVIVE and will wake the worker
  └── Incoming messages will wake the worker
     │
     ▼
MESSAGE ARRIVES or ALARM FIRES
     │
     ▼
Background Service Worker WAKES UP
  ├── Script re-executes from the top
  ├── All listeners re-register
  ├── In-memory state must be rebuilt from chrome.storage
  └── Processes the message/alarm
```

### Service Worker Suspension — The Biggest Gotcha

In Manifest V3, the background is a service worker, not a persistent page. Chrome can kill it at any time.

**What survives suspension:**
- `chrome.storage.local` data
- `chrome.storage.session` data
- Registered alarms
- Registered message listeners (they re-register when the worker wakes)

**What dies on suspension:**
- All `let`/`const` variables
- All `setTimeout`/`setInterval` timers
- Any in-progress `fetch()` calls
- WebSocket connections

**Solution**: Use `chrome.storage.session` for anything that must survive suspension but not browser restart:

```ts
// Instead of this (LOST on suspension):
let masterKey: string | null = null

// Do this (survives suspension):
async function getMasterKey(): Promise<string | null> {
  const result = await chrome.storage.session.get('masterKey')
  return result.masterKey ?? null
}

async function setMasterKey(key: string): Promise<void> {
  await chrome.storage.session.set({ masterKey: key })
}
```

---

## 13. Security Model — How Chrome Isolates Everything

Chrome enforces strict isolation between extension parts:

```
┌──────────────────────────────────────────────────────────────┐
│ ISOLATION BOUNDARIES                                         │
│                                                              │
│  ┌─────────────────┐     ┌─────────────────┐               │
│  │ Extension Origin │     │ Webpage Origin  │               │
│  │ chrome-ext://id  │     │ github.com      │               │
│  │                  │     │                  │               │
│  │ - popup          │     │ - page JS        │               │
│  │ - sidepanel      │     │ - page DOM       │               │
│  │ - background     │     │                  │               │
│  │ - options        │     │                  │               │
│  └─────────────────┘     └─────────────────┘               │
│           │                       │                          │
│           │   BRIDGE              │                          │
│           └───────┐   ┌──────────┘                          │
│                   ▼   ▼                                      │
│           ┌─────────────────┐                               │
│           │ Content Script   │                               │
│           │ (isolated world) │                               │
│           │                  │                               │
│           │ Sees page DOM ✅ │                               │
│           │ Sees page JS  ❌ │                               │
│           │ Has chrome.* ✅  │                               │
│           └─────────────────┘                               │
└──────────────────────────────────────────────────────────────┘
```

### Content Security Policy (CSP)

Extensions have a strict CSP by default:
- **No inline scripts** — you can't use `<script>alert('hi')</script>` in popup HTML
- **No `eval()`** — dynamic code execution is blocked
- **No remote scripts** — you can't load `<script src="https://cdn.com/lib.js">` in extension pages

This is why we use Vite + CRXJS — they bundle everything into local files.

### Cross-Origin Requests

- **Popup and Background** can `fetch()` any URL (they're in the extension origin)
- **Content scripts** are subject to the **webpage's CORS policy** — they can't freely fetch
- Best practice: **Always make HTTP calls from the background**, never from content scripts

```ts
// BAD — content script can't fetch freely
// content.ts
fetch('http://localhost:3000/api/passwords') // ← blocked by CORS

// GOOD — delegate to background
// content.ts
chrome.runtime.sendMessage({ type: 'GET_PASSWORDS', payload: { domain } })

// background.ts — can fetch anything
fetch('http://localhost:3000/api/passwords') // ← works fine
```

---

## 14. Build Tooling (Vite + CRXJS)

This project uses **Vite** (fast build tool) + **CRXJS** (Vite plugin for Chrome extensions) + **React** + **TypeScript**.

### How the build works

```
manifest.config.ts (TypeScript manifest definition)
     │
     ▼
CRXJS reads it and tells Vite what to build:
     ├── popup/index.html     → React app bundle
     ├── sidepanel/index.html → React app bundle
     ├── background.ts        → Service worker bundle
     ├── content/main.tsx     → Content script bundle
     └── manifest.json        → Generated from config
     │
     ▼
Vite outputs everything to /dist/
     │
     ▼
You load /dist/ as an unpacked extension in Chrome
```

### Dev mode (`npm run dev`)

```bash
cd extention
npm run dev
```

CRXJS gives you **Hot Module Replacement (HMR)**:
- Edit popup React components → instant update (no reload)
- Edit content script → refresh the webpage
- Edit background script → click reload on `chrome://extensions`
- Edit manifest → reload extension on `chrome://extensions`

### Build for production (`npm run build`)

```bash
cd extention
npm run build
```

Produces:
- `/dist/` — the extension ready to load
- `/release/crx-vault-key-0.0.1.zip` — zipped for Chrome Web Store upload

### Key config files

| File | Purpose |
|---|---|
| `manifest.config.ts` | Extension manifest (permissions, scripts, icons) |
| `vite.config.ts` | Build config (plugins, aliases, dev server) |
| `tsconfig.json` | TypeScript project references |
| `tsconfig.app.json` | TS config for source code |
| `tsconfig.node.json` | TS config for build scripts (vite.config.ts) |
| `package.json` | Dependencies and scripts |

### Path aliases

The project has `@/` aliased to `src/`:

```ts
// Instead of:
import HelloWorld from '../../../components/HelloWorld'

// You can write:
import HelloWorld from '@/components/HelloWorld'
```

Configured in both `vite.config.ts` (for Vite) and `tsconfig.app.json` (for TypeScript).

---

## 15. Debugging

### Popup

1. Click the extension icon to open the popup
2. Right-click the popup → **Inspect**
3. DevTools opens for the popup — full React DevTools, console, network, etc.

### Background Service Worker

1. Go to `chrome://extensions` (or `brave://extensions`)
2. Find your extension
3. Click **"Service Worker"** link
4. DevTools opens for the background — check console for logs, network for API calls

### Content Script

1. Open a webpage where your content script runs
2. Press F12 to open DevTools
3. Go to **Console** tab
4. In the dropdown at the top-left (says "top" by default), select your extension
5. Now you see logs from your content script

### Common debugging commands

```ts
// In any part — check what's in storage
chrome.storage.local.get(null, (items) => console.log('Local storage:', items))
chrome.storage.session.get(null, (items) => console.log('Session storage:', items))

// In background — check registered alarms
chrome.alarms.getAll((alarms) => console.log('Alarms:', alarms))

// Check extension info
console.log('Extension ID:', chrome.runtime.id)
console.log('Manifest:', chrome.runtime.getManifest())
```

---

## 16. Project Structure

```
Password_Manager/
├── backend/                          # NestJS API Server
│   ├── src/
│   │   ├── main.ts                   # Server entry (port 3000)
│   │   ├── app.module.ts             # Root module
│   │   ├── app.controller.ts         # Routes
│   │   └── app.service.ts            # Business logic
│   ├── package.json
│   └── tsconfig.json
│
└── extention/                        # Chrome Extension
    ├── src/
    │   ├── background.ts             # SERVICE WORKER — central hub
    │   ├── content/
    │   │   ├── main.tsx              # CONTENT SCRIPT entry — injected into pages
    │   │   └── views/
    │   │       ├── App.tsx           # React UI injected into pages
    │   │       └── App.css
    │   ├── popup/
    │   │   ├── index.html            # HTML shell
    │   │   ├── main.tsx              # React entry
    │   │   ├── App.tsx               # POPUP UI component
    │   │   ├── App.css
    │   │   └── index.css
    │   ├── sidepanel/
    │   │   ├── index.html            # HTML shell
    │   │   ├── main.tsx              # React entry
    │   │   ├── App.tsx               # SIDE PANEL UI component
    │   │   ├── App.css
    │   │   └── index.css
    │   ├── components/
    │   │   └── HelloWorld.tsx         # Shared React component
    │   └── assets/                   # SVG logos
    ├── public/
    │   └── logo.png                  # Extension icon
    ├── dist/                         # Compiled output (load this in Chrome)
    ├── release/                      # Zipped builds
    ├── manifest.config.ts            # THE MANIFEST (brain of the extension)
    ├── vite.config.ts                # Build configuration
    ├── tsconfig.json                 # TypeScript config
    └── package.json                  # Dependencies
```

---

## 17. Quick Reference Tables

### Who can do what

| Capability | Background | Content Script | Popup | Side Panel |
|---|---|---|---|---|
| Read webpage DOM | No | **Yes** | No | No |
| Modify webpage DOM | No | **Yes** | No | No |
| fetch() to backend | **Yes** | No (CORS) | **Yes** | **Yes** |
| chrome.storage.local | **Yes** | **Yes** | **Yes** | **Yes** |
| chrome.storage.session | **Yes** | No | No | No |
| chrome.tabs API | **Yes** | No | **Yes** | **Yes** |
| chrome.alarms | **Yes** | No | No | No |
| In-memory state | **Yes** (until suspension) | **Yes** (until navigation) | **Yes** (until close) | **Yes** (until close) |
| Survives page navigation | **Yes** | No (re-injects) | N/A | **Yes** |
| Has own DOM | No | No (shares page DOM) | **Yes** | **Yes** |

### How to send messages

| From → To | Method |
|---|---|
| Popup → Background | `chrome.runtime.sendMessage()` |
| Content → Background | `chrome.runtime.sendMessage()` |
| SidePanel → Background | `chrome.runtime.sendMessage()` |
| Background → Content | `chrome.tabs.sendMessage(tabId, ...)` |
| Popup → Content | `chrome.tabs.sendMessage(tabId, ...)` |
| Background → Popup | Not directly — use `chrome.storage.onChanged` or ports |
| Background → SidePanel | Not directly — use `chrome.storage.onChanged` or ports |

### Hot Reload behavior

| What you change | What to do |
|---|---|
| Popup React components | Nothing — auto updates |
| Side panel components | Nothing — auto updates |
| Content script | Refresh the webpage |
| Background script | Click reload on `chrome://extensions` |
| manifest.config.ts | Reload extension on `chrome://extensions` |

### Permissions you'll need for VaultKey

| Permission | Why |
|---|---|
| `storage` | Save user preferences, cached metadata |
| `tabs` | Send messages to content scripts, read tab URLs |
| `activeTab` | Access current tab on icon click |
| `alarms` | Auto-lock timer, periodic sync |
| `clipboardWrite` | Copy passwords to clipboard |
| `sidePanel` | Show password manager panel |
| `notifications` | "Password copied" notifications |
| `contextMenus` | Right-click "Generate password" |

---

## Running the Extension

```bash
# Start dev mode with HMR
cd extention
npm run dev

# Build for production
npm run build
```

### Load in Chrome/Brave:

1. Navigate to `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extention/dist/` folder
5. The extension appears in your toolbar

### Debugging shortcuts:

- **Popup**: Right-click extension icon → Inspect
- **Background**: `chrome://extensions` → click "Service Worker" link
- **Content Script**: F12 on any webpage → Console → select extension from dropdown
