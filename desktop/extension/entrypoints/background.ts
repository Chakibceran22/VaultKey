import { Actions, type Tabs } from '@/lib/actions'
import { BridgeClient, type NativePort } from '@/lib/bridge-client'
import { hostName } from '@/lib/host'
import { Inline, type Frame, type MenuPort } from '@/lib/inline'
import { MENU_PORT, isContentRequest, isMenuRequest, type MenuUpdate, type VerifyReply } from '@/lib/inline-messages'
import { IndexedDbStore } from '@/lib/keys'
import { Link, identify } from '@/lib/link'
import { POPUP_PORT, isPopupRequest, type PopupUpdate } from '@/lib/popup-messages'

const HOST = hostName(import.meta.env.MODE)

export default defineBackground(() => {
  const bridge = new BridgeClient(
    () => browser.runtime.connectNative(HOST) as unknown as NativePort,
    () => browser.runtime.lastError?.message,
  )
  const link = new Link(bridge, new IndexedDbStore(), async () =>
    identify(navigator as unknown as Parameters<typeof identify>[0], (await browser.runtime.getPlatformInfo()).os),
  )
  const tabs: Tabs = {
    async active() {
      // The tab the user is looking at, as the browser reports it.
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true })
      return tab?.id !== undefined && tab.url ? { id: tab.id, url: tab.url } : null
    },
    // The top frame only (M2): frames get their own matches in M3.
    send: (tabId, request) => browser.tabs.sendMessage(tabId, request, { frameId: 0 }),
  }
  const actions = new Actions(link, tabs)
  const popup = browser.runtime.getURL('/popup.html')

  const inline = new Inline(link, () => link.current(), {
    async verify(frame) {
      const answer = (await browser.tabs.sendMessage(frame.tabId, { type: 'vk.verify' }, { frameId: frame.frameId }).catch(() => undefined)) as
        | VerifyReply
        | undefined
      return { visible: answer?.visible === true, stableMs: typeof answer?.stableMs === 'number' ? answer.stableMs : 0 }
    },
    close(frame) {
      void browser.tabs.sendMessage(frame.tabId, { type: 'vk.close' }, { frameId: frame.frameId }).catch(() => undefined)
    },
    fill: (frame, request) => browser.tabs.sendMessage(frame.tabId, request, { frameId: frame.frameId }),
    badge(tabId, count) {
      void browser.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => undefined)
    },
    openPopup() {
      void browser.action.openPopup().catch(() => undefined)
    },
    showApp() {
      link.showApp()
    },
    ready(frame, token) {
      void browser.tabs.sendMessage(frame.tabId, { type: 'vk.ready', token }, { frameId: frame.frameId }).catch(() => undefined)
    },
  })
  void browser.action.setBadgeBackgroundColor({ color: '#4f5bd5' }).catch(() => undefined)
  // Cached cards hold this session's handles: a new session (or none) drops them.
  let wasReady = false
  link.onChange((state) => {
    const ready = state.kind === 'ready'
    if (!ready || !wasReady) inline.forget()
    wasReady = ready
    // Badges go only when VaultKey is really out of reach, not on a reconnect's brief states.
    if (!['ready', 'connecting', 'checking'].includes(state.kind)) inline.clearBadges()
  })
  browser.tabs.onRemoved.addListener((tabId) => inline.forgetTab(tabId))

  // A page asked before anything connected (the service worker just started): connect once.
  let warming: Promise<unknown> | null = null
  const warm = async (): Promise<void> => {
    if (link.current().kind !== 'checking') return
    warming ??= link.refresh().finally(() => (warming = null))
    await warming
  }

  // Content scripts: the frame is what the browser says sent the message.
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const tabId = sender.tab?.id
    if (sender.id !== browser.runtime.id || tabId === undefined || sender.frameId === undefined || !sender.url) return
    if (!isContentRequest(message)) return
    const frame: Frame = { tabId, frameId: sender.frameId, url: sender.url, tabUrl: sender.tab?.url ?? sender.url }
    switch (message.type) {
      case 'vk.found':
        void warm()
          .then(() => inline.found(frame))
          .then(sendResponse)
        return true
      case 'vk.token':
        sendResponse(inline.token(frame))
        return
      case 'vk.sso':
        void warm()
          .then(() => inline.sso(frame))
          .then(sendResponse)
        return true
      case 'vk.open':
        void inline.open(frame, message.kind, message.above).then(sendResponse)
        return true
      case 'vk.key':
        inline.key(frame, message.key)
        return
      case 'vk.closed':
        inline.closed(frame)
    }
  })

  browser.runtime.onConnect.addListener((port) => {
    // The inline menu: our menu page, in a tab, with the token its content script got.
    if (port.name.startsWith(`${MENU_PORT}:`)) {
      const sender = port.sender
      const isMenu = (() => {
        try {
          return sender?.id === browser.runtime.id && new URL(sender.url ?? '').pathname === '/menu.html'
        } catch {
          return false
        }
      })()
      const menuPort: MenuPort = { post: (update: MenuUpdate) => port.postMessage(update) }
      const key = isMenu ? inline.connect(port.name.slice(MENU_PORT.length + 1), sender?.tab?.id, menuPort) : null
      if (!key) {
        port.disconnect()
        return
      }
      port.onMessage.addListener((message: unknown) => {
        if (isMenuRequest(message)) void inline.request(key, message)
      })
      port.onDisconnect.addListener(() => inline.disconnect(key, menuPort))
      return
    }
    // The extension's own popup only: never a content script, a web page or another
    // extension (there's no `externally_connectable`, and it's checked here as well).
    const sender = port.sender
    if (port.name !== POPUP_PORT || sender?.id !== browser.runtime.id || sender.tab !== undefined || sender.url !== popup) {
      port.disconnect()
      return
    }
    let open = true
    const send = (update: PopupUpdate) => {
      if (open) port.postMessage(update)
    }
    const off = link.onChange((state) => send({ type: 'state', state }))
    port.onDisconnect.addListener(() => {
      open = false
      off()
    })
    port.onMessage.addListener((message: unknown) => {
      if (!isPopupRequest(message)) return
      switch (message.type) {
        case 'refresh':
          void link.refresh()
          return
        case 'pair':
          void link.pair()
          return
        case 'show-app':
          link.showApp()
          return
        case 'cards':
          void actions.cards().then((result) => send({ type: 'cards', result }))
          return
        case 'search':
          // Here only: content scripts and the inline menu have no way to ask for a search.
          void actions.search(message.q).then((result) => send({ type: 'search', result }))
          return
        case 'fill':
          void actions
            .fill(message.h, 'popup', { insecure: message.confirmedInsecure, crossSite: message.confirmedCrossSite, origin: message.origin })
            .then((outcome) => send({ type: 'filled', outcome }))
          return
        case 'code':
          void actions
            .code(message.h, { crossSite: message.confirmedCrossSite, origin: message.origin })
            .then((result) => send({ type: 'code', result }))
      }
    })
    send({ type: 'state', state: link.current() })
    void link.refresh()
  })

  browser.commands.onCommand.addListener((command) => {
    if (command !== 'fill') return
    void (async () => {
      if (link.current().kind !== 'ready') await link.refresh()
      const outcome = link.current().kind === 'ready' ? await actions.shortcut() : 'open_popup'
      // Several logins, none, or not connected: the popup shows why and lets you choose.
      if (outcome === 'open_popup' || !outcome.ok) await browser.action.openPopup().catch(() => {})
    })()
  })
})
