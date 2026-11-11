// The service worker's connection to VaultKey, end to end (plans/01, plans/02):
//
//   not paired ──Connect──► pairing (both sides show a code) ──approved in VaultKey──►
//   paired ──vault unlocked──► handshake (Noise KK) ──► ready: an encrypted session
//
// The vault locking ends the session (`locked`), and so does VaultKey removing this
// browser (`revoked`, or NOT_PAIRED), which also deletes this browser's keys. Every
// message from the app is handled in arrival order: the session's frames must be
// decrypted in the order they were sent.

import type { BridgeClient, BridgeStatus } from './bridge-client'
import { fromBase64, toBase64, utf8, type Bytes } from './bytes'
import { encodeRequest, parseInner, type InnerMessage, type InnerMethod } from './inner'
import { newPairing, type Pairing, type PairingStore } from './keys'
import { PROTOCOL, type BrowserKind, type Incoming, type Need, type VaultState } from './messages'
import { clientId, initiate, pairingCode, type Transport } from './noise'

export type LinkState =
  | { kind: 'checking' }
  /** The browser couldn't start the bridge (not registered), or it exited. */
  | { kind: 'no_bridge'; detail: string }
  | { kind: 'bridge_not_answering' }
  | { kind: 'app_not_running' }
  | { kind: 'app_not_answering' }
  /** "Browser extension" is off in VaultKey's settings. */
  | { kind: 'disabled' }
  | { kind: 'not_paired'; vault: 'locked' | 'unlocked'; notice: string | null }
  /** Waiting for the user in VaultKey; `code` once VaultKey answered with its key. */
  | { kind: 'pairing'; code: string | null }
  /** Paired; the vault is locked. */
  | { kind: 'locked' }
  | { kind: 'connecting' }
  /** An encrypted session is up; `rttMs`: an encrypted round trip. */
  | { kind: 'ready'; rttMs: number | null }
  | { kind: 'update'; need: Need }
  | { kind: 'failed'; message: string }

export interface Identity {
  /** "Brave on macOS": what VaultKey's dialog and Settings show. */
  name: string
  browser: BrowserKind
}

export type InnerReply = Extract<InnerMessage, { kind: 'reply' }>

/** At most this many requests waiting for an answer in one session (plans/03). */
export const MAX_IN_FLIGHT = 8
const REQUEST_TIMEOUT_MS = 3000
/** Automatic handshakes that may fail in a row before waiting for the popup or an unlock. */
const MAX_AUTO_FAILURES = 2

/**
 * Can this extension talk to an app that says it speaks `app`? The app accepts its own
 * version and the previous one (plans/03, Versioning).
 */
export function versionNeed(app: number): Need | null {
  if (app === PROTOCOL || app === PROTOCOL + 1) return null
  return app < PROTOCOL ? 'update_app' : 'update_extension'
}

interface Waiting {
  resolve(reply: InnerReply): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** One encrypted session: requests out, replies matched by id. */
export class Session {
  private next = 0
  private waiting = new Map<number, Waiting>()
  private sending: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    readonly transport: Transport,
    private readonly post: (sealed: string) => boolean,
  ) {}

  request(m: InnerMethod, p?: Record<string, unknown>): Promise<InnerReply> {
    if (this.closed) return Promise.reject(new Error('The session with VaultKey has ended.'))
    if (this.waiting.size >= MAX_IN_FLIGHT) return Promise.reject(new Error('Too many requests to VaultKey at once.'))
    this.next = this.next >= 0xffff_ffff ? 1 : this.next + 1
    const id = this.next
    return new Promise<InnerReply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, new Error('VaultKey did not answer in time.')), REQUEST_TIMEOUT_MS)
      this.waiting.set(id, { resolve, reject, timer })
      // Encrypted and posted one after another: each frame's nonce is its place in the session.
      this.sending = this.sending
        .then(async () => {
          const sealed = await this.transport.encrypt(utf8(encodeRequest({ id, m, p })))
          if (this.closed || !this.post(toBase64(sealed))) throw new Error('The connection to VaultKey closed.')
        })
        .catch((error: unknown) => this.fail(id, error instanceof Error ? error : new Error(String(error))))
    })
  }

  settle(reply: InnerReply): void {
    const waiting = this.waiting.get(reply.id)
    if (!waiting) return
    this.waiting.delete(reply.id)
    clearTimeout(waiting.timer)
    waiting.resolve(reply)
  }

  close(reason: string): void {
    this.closed = true
    for (const id of [...this.waiting.keys()]) this.fail(id, new Error(reason))
  }

  private fail(id: number, error: Error): void {
    const waiting = this.waiting.get(id)
    if (!waiting) return
    this.waiting.delete(id)
    clearTimeout(waiting.timer)
    waiting.reject(error)
  }
}

export class Link {
  private state: LinkState = { kind: 'checking' }
  private listeners = new Set<(state: LinkState) => void>()
  /** What the app last said (null: no connection to it). */
  private vault: VaultState | null = null
  private pairing: Pairing | null = null
  private loaded = false
  private session: Session | null = null
  /** A handshake on its way: `hs1` sent, `hs2` awaited. */
  private handshake: Awaited<ReturnType<typeof initiate>> | null = null
  private starting = false
  /** The keys of an open pairing request, and VaultKey's key once it answered. */
  private request: { pairing: Pairing; appKey: Bytes | null } | null = null
  private notice: string | null = null
  /** The app speaks a version this extension can't (from its `state`). */
  private versionGap: Need | null = null
  /** The app refused a request for its version; holds until the popup checks again. */
  private refusedVersion: Need | null = null
  /** Why the last automatic handshake failed, shown once retrying stops. */
  private failure: string | null = null
  private checking = false
  private autoFailures = 0
  private incoming: Promise<void> = Promise.resolve()

  constructor(
    private readonly bridge: BridgeClient,
    private readonly store: PairingStore,
    private readonly identity: () => Promise<Identity>,
    private readonly now: () => number = () => performance.now(),
  ) {
    bridge.subscribe((message) => {
      this.incoming = this.incoming
        .then(() => this.receive(message))
        .catch((error: unknown) => console.error('[vaultkey] handling a message failed', error))
    })
    bridge.onClose((detail) => this.closed(detail))
  }

  current(): LinkState {
    return this.state
  }

  onChange(listener: (state: LinkState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Is VaultKey there and unlocked, is this browser paired: then a session. */
  async refresh(): Promise<LinkState> {
    await this.load()
    this.autoFailures = 0
    this.refusedVersion = null
    if (this.state.kind !== 'pairing' && this.state.kind !== 'ready') this.set({ kind: 'checking' })
    this.checking = true
    let status: BridgeStatus
    try {
      status = await this.bridge.check({ pings: 3 })
    } finally {
      this.checking = false
    }
    // The app's `state`, received during the check, is handled first.
    await this.incoming
    switch (status.kind) {
      case 'connected':
        if (this.vault === null && status.vault !== 'unknown') this.vault = status.vault
        await this.settle()
        if (this.session) await this.measure()
        break
      case 'no_bridge':
        this.set({ kind: 'no_bridge', detail: status.detail })
        break
      case 'refused':
        this.set({ kind: 'failed', message: 'VaultKey refused the request. Update VaultKey and the extension.' })
        break
      default:
        this.set({ kind: status.kind })
    }
    return this.state
  }

  /**
   * The user clicked Connect: VaultKey shows a dialog with the code this popup shows too.
   * New keys for each request; they're kept only once VaultKey approved them.
   */
  async pair(): Promise<void> {
    if (this.state.kind === 'pairing') return
    await this.load()
    const need = this.versionGap ?? this.refusedVersion
    if (need) return this.set({ kind: 'update', need })
    const keys = await newPairing()
    const { name, browser } = await this.identity()
    this.request = { pairing: keys, appKey: null }
    this.notice = null
    this.set({ kind: 'pairing', code: null })
    if (!this.bridge.post({ t: 'pair.request', pub: toBase64(keys.publicKey), name, browser, protocol: PROTOCOL })) {
      this.request = null
      await this.refresh()
    }
  }

  /** Brings VaultKey's window forward, to unlock it there (works without a session). */
  showApp(): boolean {
    return this.bridge.post({ t: 'app.show' })
  }

  /** An encrypted request. */
  async call(method: InnerMethod, params?: Record<string, unknown>): Promise<InnerReply> {
    if (!this.session) throw new Error('Not connected to VaultKey.')
    return this.session.request(method, params)
  }

  private set(state: LinkState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.pairing = await this.store.load()
    this.loaded = true
  }

  private notPaired(): LinkState {
    return { kind: 'not_paired', vault: this.vault === 'unlocked' ? 'unlocked' : 'locked', notice: this.notice }
  }

  /** Ends the session and any handshake on its way. */
  private drop(): void {
    this.session?.close('The session with VaultKey has ended.')
    this.session = null
    this.handshake = null
  }

  /** A pairing request that can't go on (the app went away, the vault locked). */
  private abandonPairing(): void {
    if (!this.request && this.state.kind !== 'pairing') return
    this.request = null
    if (this.state.kind === 'pairing') this.set(this.notPaired())
  }

  /** Decides what comes next from what's known. */
  private async settle(): Promise<void> {
    if (this.checking || this.state.kind === 'pairing' || this.vault === null) return
    const need = this.versionGap ?? this.refusedVersion
    if (need) {
      this.drop()
      return this.set({ kind: 'update', need })
    }
    if (this.vault === 'disabled') {
      this.drop()
      return this.set({ kind: 'disabled' })
    }
    if (!this.pairing?.appKey) return this.set(this.notPaired())
    if (this.vault === 'locked') {
      this.drop()
      return this.set({ kind: 'locked' })
    }
    if (this.session) {
      if (this.state.kind !== 'ready') this.set({ kind: 'ready', rttMs: null })
      return
    }
    if (this.handshake || this.starting) return
    if (this.autoFailures >= MAX_AUTO_FAILURES) {
      return this.set({ kind: 'failed', message: this.failure ?? 'Couldn’t connect to VaultKey. Check again.' })
    }
    await this.startHandshake(this.pairing)
  }

  private async startHandshake(pairing: Pairing): Promise<void> {
    if (!pairing.appKey) return
    this.starting = true
    this.set({ kind: 'connecting' })
    try {
      const started = await initiate({ local: pairing, remote: pairing.appKey })
      const client = toBase64(await clientId(pairing.publicKey))
      this.handshake = started
      if (!this.bridge.post({ t: 'hs1', client, msg: toBase64(started.message), protocol: PROTOCOL })) {
        this.handshake = null
        this.autoFailures++
      }
    } finally {
      this.starting = false
    }
  }

  /** Times one encrypted round trip, for the popup. */
  private async measure(): Promise<void> {
    const session = this.session
    if (!session) return
    const started = this.now()
    try {
      const reply = await session.request('ping')
      if (reply.ok && this.session === session) this.set({ kind: 'ready', rttMs: this.now() - started })
    } catch {
      // The session ended meanwhile; whatever ended it has said so.
    }
  }

  private async forget(notice: string): Promise<void> {
    this.drop()
    this.pairing = null
    this.loaded = true
    await this.store.clear()
    this.notice = notice
    this.set(this.notPaired())
  }

  private closed(detail: string): void {
    this.vault = null
    this.drop()
    this.request = null
    if (!this.checking) this.set({ kind: 'no_bridge', detail })
  }

  private async receive(message: Incoming): Promise<void> {
    switch (message.t) {
      case 'bridge.state':
        if (message.app === 'not_running') {
          this.vault = null
          this.drop()
          this.request = null
          if (!this.checking) this.set({ kind: 'app_not_running' })
        }
        return
      case 'state': {
        // Sent on every new connection to the app and on every change: either way, a
        // session this browser had is gone.
        if (this.vault !== 'unlocked' && message.state === 'unlocked') this.autoFailures = 0
        this.vault = message.state
        this.versionGap = versionNeed(message.protocol)
        this.drop()
        if (message.state !== 'unlocked') this.abandonPairing()
        return this.settle()
      }
      case 'pair.pending': {
        const open = this.request
        const appKey = fromBase64(message.pub, 32)
        if (!open || !appKey || appKey.length !== 32) return
        open.appKey = appKey
        return this.set({ kind: 'pairing', code: await pairingCode(open.pairing.publicKey, appKey) })
      }
      case 'pair.result': {
        const open = this.request
        this.request = null
        if (!open) return
        if (message.approved && open.appKey) {
          this.drop()
          const pairing = { ...open.pairing, appKey: open.appKey }
          try {
            await this.store.save(pairing)
          } catch {
            this.notice = 'This browser couldn’t keep its pairing (its storage refused). Try again.'
            return this.set(this.notPaired())
          }
          this.pairing = pairing
          this.notice = null
          this.autoFailures = 0
          this.set({ kind: 'connecting' })
          return this.settle()
        }
        this.notice = 'VaultKey didn’t connect this browser.'
        return this.set(this.notPaired())
      }
      case 'hs2': {
        const pending = this.handshake
        this.handshake = null
        const reply = fromBase64(message.msg, 256)
        if (!pending || !reply) return
        try {
          const transport = await pending.finish(reply)
          this.session = new Session(transport, (c) => this.bridge.post({ t: 'x', c }))
          this.autoFailures = 0
          this.failure = null
          this.set({ kind: 'ready', rttMs: null })
          void this.measure()
        } catch {
          this.autoFailures++
          this.failure = 'The secure connection to VaultKey failed.'
          this.set({ kind: 'failed', message: this.failure })
        }
        return
      }
      case 'x':
        return this.inner(message.c)
      case 'err':
        return this.refused(message)
      case 'pong':
        return
    }
  }

  private async inner(c: string): Promise<void> {
    const session = this.session
    const sealed = fromBase64(c, 64 * 1024)
    if (!session || !sealed) return
    let inner: InnerMessage | null = null
    try {
      const plain = await session.transport.decrypt(sealed)
      try {
        inner = parseInner(new TextDecoder().decode(plain))
      } finally {
        // A reveal's password was in these bytes: don't leave them for the garbage collector.
        plain.fill(0)
      }
    } catch {
      inner = null
    }
    if (this.session !== session) return
    if (!inner) {
      // Altered, replayed or unreadable: this session can't be trusted any more.
      this.drop()
      return this.set({ kind: 'failed', message: 'The secure connection to VaultKey broke. Check again.' })
    }
    if (inner.kind === 'reply') return session.settle(inner)
    if (inner.ev === 'locked') {
      this.drop()
      this.vault = 'locked'
      return this.set({ kind: 'locked' })
    }
    return this.forget('VaultKey disconnected this browser. Connect it again to use it.')
  }

  private async refused(message: Extract<Incoming, { t: 'err' }>): Promise<void> {
    const handshaking = this.handshake !== null
    this.drop()
    switch (message.code) {
      case 'NOT_PAIRED':
        this.request = null
        return this.forget('VaultKey doesn’t know this browser any more. Connect it again.')
      case 'LOCKED':
        // The `state` that follows (the app closes; the bridge reconnects) says how the
        // vault really is. A handshake refused as locked counts as a failure, so an app
        // that says "unlocked" and then "locked" can't keep it trying.
        if (handshaking) this.autoFailures++
        this.abandonPairing()
        return
      case 'DISABLED':
        this.vault = 'disabled'
        this.abandonPairing()
        return this.settle()
      case 'PROTOCOL_VERSION':
        this.request = null
        // Stays until the popup checks again: the reconnect that follows says nothing new.
        this.refusedVersion = message.need ?? 'update_extension'
        return this.set({ kind: 'update', need: this.refusedVersion })
      case 'BUSY':
        this.request = null
        this.notice =
          'VaultKey is showing another connection request, or just answered one. If it shows one you didn’t start, click Don’t connect there. Then try again in a few minutes.'
        return this.set(this.notPaired())
      default: {
        const text =
          message.code === 'INTERNAL'
            ? 'VaultKey ran into a problem. Its log has the details.'
            : 'VaultKey refused a message. Update VaultKey and the extension.'
        if (this.request || this.state.kind === 'pairing') {
          // Shown with the Connect button, so it outlasts the reconnect that follows.
          this.request = null
          this.notice = text
          return this.set(this.notPaired())
        }
        if (handshaking) this.autoFailures++
        this.failure = text
        return this.set({ kind: 'failed', message: text })
      }
    }
  }
}

/** What this browser calls itself when it asks to pair. */
export async function identify(
  navigator: { userAgentData?: { brands?: { brand: string }[] }; brave?: { isBrave?: () => Promise<boolean> } },
  os: string,
): Promise<Identity> {
  const brands = (navigator.userAgentData?.brands ?? []).map((entry) => entry.brand)
  const brave = brands.includes('Brave') || (await navigator.brave?.isBrave?.().catch(() => false)) === true
  const [browser, label]: [BrowserKind, string] = brave
    ? ['brave', 'Brave']
    : brands.includes('Microsoft Edge')
      ? ['edge', 'Edge']
      : brands.includes('Google Chrome')
        ? ['chrome', 'Chrome']
        : brands.includes('Vivaldi')
          ? ['vivaldi', 'Vivaldi']
          : brands.includes('Chromium')
            ? ['chromium', 'Chromium']
            : ['other', 'Browser']
  const system: Record<string, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', openbsd: 'OpenBSD' }
  return { browser, name: `${label} on ${system[os] ?? 'this computer'}` }
}
