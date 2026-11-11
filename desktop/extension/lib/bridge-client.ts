// The service worker's line to VaultKey: one native-messaging port to vaultkey-bridge,
// opened when first needed and kept open (an open native port also keeps the Chrome
// service worker alive, plans/05). `check` says whether the app is there and how fast it
// answers; `post` and `subscribe` carry everything else (pairing and the session: link.ts).

import { parseIncoming, type Incoming, type Outgoing, type VaultState } from './messages'

/** The parts of `runtime.Port` used here, so tests can stand in for the browser. */
export interface NativePort {
  postMessage(message: Outgoing): void
  disconnect(): void
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

export type BridgeStatus =
  /** The browser couldn't start the bridge (not registered), or it exited. */
  | { kind: 'no_bridge'; detail: string }
  /** The bridge started but didn't answer `bridge.status` in time. */
  | { kind: 'bridge_not_answering' }
  | { kind: 'app_not_running' }
  /** Connected to the app, but it didn't answer a ping in time (busy, or paused in a debugger). */
  | { kind: 'app_not_answering' }
  /** The bridge or the app refused the request: the extension and app are out of step. */
  | { kind: 'refused' }
  | { kind: 'connected'; vault: VaultState | 'unknown'; protocol: number | null; rttMs: number }

type Listener<T> = (value: T) => void

type Answer = Incoming | 'timeout' | 'closed'

interface Waiter {
  matches(message: Incoming): boolean
  settle(answer: Answer): void
}

const MAX_U32 = 0xffff_ffff

export class BridgeClient {
  private port: NativePort | null = null
  private waiters: Waiter[] = []
  private vault: VaultState | null = null
  private protocol: number | null = null
  private lastError = ''
  private sequence = 0
  private subscribers = new Set<Listener<Incoming>>()
  private closeListeners = new Set<Listener<string>>()

  constructor(
    private readonly open: () => NativePort,
    /** Why the browser closed the port (`runtime.lastError`); read inside onDisconnect. */
    private readonly closeReason: () => string | undefined,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Every well-formed message from the bridge or the app, as it arrives. */
  subscribe(listener: Listener<Incoming>): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  /** The port closed (the bridge exited, or was never there), with the browser's reason. */
  onClose(listener: Listener<string>): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Sends one message, opening the port if needed. False if it couldn't be sent. */
  post(message: Outgoing): boolean {
    const port = this.connect()
    if (!port) return false
    try {
      port.postMessage(message)
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      if (this.port === port) this.drop('closed')
      return false
    }
  }

  /** Is VaultKey there, is the vault locked, and the median of `pings` round trips. */
  async check({ pings = 5, timeoutMs = 3000 }: { pings?: number; timeoutMs?: number } = {}): Promise<BridgeStatus> {
    if (!this.connect()) return { kind: 'no_bridge', detail: this.lastError }

    const presence = await this.request(
      { t: 'bridge.status' },
      (m) => m.t === 'bridge.state' || (m.t === 'err' && m.code === 'BAD_FRAME'),
      timeoutMs,
    )
    if (presence === 'closed') return this.closed()
    if (presence === 'timeout') {
      this.reset()
      return { kind: 'bridge_not_answering' }
    }
    if (presence.t === 'err') return { kind: 'refused' }
    if (presence.t === 'bridge.state' && presence.app === 'not_running') return { kind: 'app_not_running' }

    const times: number[] = []
    for (let i = 0; i < Math.max(1, pings); i++) {
      const n = this.nextSequence()
      const started = this.now()
      const answer = await this.request(
        { t: 'ping', n },
        // Only BAD_FRAME refuses a ping; other errors answer a pairing or a handshake.
        (m) => (m.t === 'pong' && m.n === n) || (m.t === 'bridge.state' && m.app === 'not_running') || (m.t === 'err' && m.code === 'BAD_FRAME'),
        timeoutMs,
      )
      if (answer === 'closed') return this.closed()
      if (answer === 'timeout') {
        // Start clean next time: a new port means a new bridge and a new connection.
        this.reset()
        return { kind: 'app_not_answering' }
      }
      if (answer.t === 'err') return { kind: 'refused' }
      if (answer.t !== 'pong') return { kind: 'app_not_running' }
      times.push(this.now() - started)
    }
    times.sort((a, b) => a - b)
    return {
      kind: 'connected',
      vault: this.vault ?? 'unknown',
      protocol: this.protocol,
      rttMs: times[Math.floor(times.length / 2)] ?? 0,
    }
  }

  private connect(): NativePort | null {
    if (this.port) return this.port
    let port: NativePort
    try {
      port = this.open()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
    this.port = port
    // A new port: whatever went wrong with the last one no longer applies.
    this.lastError = ''
    port.onMessage.addListener((raw) => {
      if (this.port === port) this.receive(raw)
    })
    port.onDisconnect.addListener(() => {
      // Reading lastError here is what marks it handled for the browser.
      const reason = this.closeReason()
      if (this.port !== port) return
      this.lastError = reason ?? 'The bridge closed the connection.'
      this.drop('closed')
    })
    return port
  }

  /**
   * After a timeout: closes the port ourselves (the browser then stops the bridge) and
   * starts over next time. Other checks waiting on it end as timed out too, which is
   * what happened, rather than as "closed" with some older error.
   */
  private reset(): void {
    const port = this.port
    this.drop('timeout')
    try {
      port?.disconnect()
    } catch {
      // Already gone.
    }
  }

  private drop(answer: Answer): void {
    this.port = null
    this.vault = null
    this.protocol = null
    const waiting = this.waiters
    this.waiters = []
    for (const waiter of waiting) waiter.settle(answer)
    const reason = this.lastError || 'The bridge closed the connection.'
    for (const listener of this.closeListeners) listener(reason)
  }

  private receive(raw: unknown): void {
    const message = parseIncoming(raw)
    // Our own bridge never sends anything else; a malformed message is dropped unread.
    if (!message) return
    if (message.t === 'state') {
      this.vault = message.state
      this.protocol = message.protocol
    } else if (message.t === 'bridge.state' && message.app === 'not_running') {
      this.vault = null
      this.protocol = null
    }
    for (const subscriber of this.subscribers) subscriber(message)
    const matched = this.waiters.filter((waiter) => waiter.matches(message))
    this.waiters = this.waiters.filter((waiter) => !matched.includes(waiter))
    for (const waiter of matched) waiter.settle(message)
  }

  private request(message: Outgoing, matches: (m: Incoming) => boolean, timeoutMs: number): Promise<Answer> {
    const port = this.port
    if (!port) return Promise.resolve('closed')
    return new Promise((resolve) => {
      const waiter: Waiter = {
        matches,
        settle: (answer) => {
          clearTimeout(timer)
          resolve(answer)
        },
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((other) => other !== waiter)
        resolve('timeout')
      }, timeoutMs)
      this.waiters.push(waiter)
      try {
        port.postMessage(message)
      } catch (error) {
        // Posting on a port the browser already closed.
        this.waiters = this.waiters.filter((other) => other !== waiter)
        this.lastError = error instanceof Error ? error.message : String(error)
        if (this.port === port) this.drop('closed')
        waiter.settle('closed')
      }
    })
  }

  private closed(): BridgeStatus {
    return { kind: 'no_bridge', detail: this.lastError || 'The bridge closed the connection.' }
  }

  private nextSequence(): number {
    this.sequence = this.sequence >= MAX_U32 ? 1 : this.sequence + 1
    return this.sequence
  }
}
