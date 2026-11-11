import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, type NativePort } from '../lib/bridge-client'
import type { Incoming, Outgoing } from '../lib/messages'

/** Stands in for the browser's native port and the bridge behind it. */
class FakePort implements NativePort {
  sent: Outgoing[] = []
  disconnected = false
  private messageListeners: ((message: unknown) => void)[] = []
  private disconnectListeners: (() => void)[] = []
  /** Decides what "the bridge" answers to each message. */
  answer: (message: Outgoing) => unknown[] = () => []

  onMessage = { addListener: (listener: (message: unknown) => void) => void this.messageListeners.push(listener) }
  onDisconnect = { addListener: (listener: () => void) => void this.disconnectListeners.push(listener) }

  postMessage(message: Outgoing): void {
    this.sent.push(message)
    for (const reply of this.answer(message)) queueMicrotask(() => this.emit(reply))
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  /** Called by the client (the browser fires no onDisconnect for that side). */
  disconnect(): void {
    this.disconnected = true
  }

  /** The browser closing the port (bridge exited, or never started). */
  close(): void {
    for (const listener of this.disconnectListeners) listener()
  }
}

/**
 * A running app, as the real bridge reports it: `running` first (the bridge answers
 * itself), then the app's `state` relayed on a new connection; pongs to pings.
 */
function runningApp(port: FakePort, vault: 'locked' | 'unlocked' = 'unlocked'): void {
  let connected = false
  port.answer = (message) => {
    if (message.t === 'bridge.status') {
      const replies: Incoming[] = [{ t: 'bridge.state', app: 'running' }]
      if (!connected) replies.push({ t: 'state', state: vault, protocol: 1 })
      connected = true
      return replies
    }
    return message.t === 'ping' ? [{ t: 'pong', n: message.n }] : []
  }
}

describe('BridgeClient', () => {
  let clock = 0
  const now = () => clock

  beforeEach(() => {
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a connected, unlocked vault and the median round trip', async () => {
    const port = new FakePort()
    runningApp(port)
    // Each ping "takes" 1, 2, 3, 4, 5 ms: the median is 3.
    let tick = 0
    const timed = port.answer
    port.answer = (message) => {
      if (message.t === 'ping') clock += ++tick
      return timed(message)
    }
    const client = new BridgeClient(() => port, () => undefined, now)
    const status = await client.check({ pings: 5 })
    expect(status).toEqual({ kind: 'connected', vault: 'unlocked', protocol: 1, rttMs: 3 })
    expect(port.sent.map((m) => m.t)).toEqual(['bridge.status', 'ping', 'ping', 'ping', 'ping', 'ping'])
    const ns = port.sent.flatMap((m) => (m.t === 'ping' ? [m.n] : []))
    expect(new Set(ns).size).toBe(5)
  })

  it('also reads the state when it arrives before running', async () => {
    const port = new FakePort()
    port.answer = (message) =>
      message.t === 'bridge.status'
        ? [{ t: 'state', state: 'locked', protocol: 1 }, { t: 'bridge.state', app: 'running' }]
        : message.t === 'ping'
          ? [{ t: 'pong', n: message.n }]
          : []
    const client = new BridgeClient(() => port, () => undefined, now)
    expect(await client.check()).toMatchObject({ kind: 'connected', vault: 'locked' })
  })

  it('reuses one port across checks', async () => {
    const port = new FakePort()
    runningApp(port, 'locked')
    const open = vi.fn(() => port)
    const client = new BridgeClient(open, () => undefined, now)
    expect((await client.check()).kind).toBe('connected')
    expect(await client.check()).toMatchObject({ kind: 'connected', vault: 'locked' })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("says when VaultKey isn't open", async () => {
    const port = new FakePort()
    port.answer = () => [{ t: 'bridge.state', app: 'not_running' }]
    const client = new BridgeClient(() => port, () => undefined, now)
    expect(await client.check()).toEqual({ kind: 'app_not_running' })
  })

  it('treats the app going away mid-check as not running', async () => {
    const port = new FakePort()
    port.answer = (message) =>
      message.t === 'bridge.status'
        ? [{ t: 'bridge.state', app: 'running' }, { t: 'state', state: 'unlocked', protocol: 1 }]
        : [{ t: 'bridge.state', app: 'not_running' }]
    const client = new BridgeClient(() => port, () => undefined, now)
    expect(await client.check()).toEqual({ kind: 'app_not_running' })
  })

  it('passes on why the browser could not start the bridge, then retries with a new port', async () => {
    const missing = new FakePort()
    missing.answer = () => {
      queueMicrotask(() => missing.close())
      return []
    }
    const working = new FakePort()
    runningApp(working)
    const ports = [missing, working]
    const client = new BridgeClient(
      () => ports.shift()!,
      () => 'Specified native messaging host not found.',
      now,
    )
    expect(await client.check()).toEqual({ kind: 'no_bridge', detail: 'Specified native messaging host not found.' })
    expect((await client.check()).kind).toBe('connected')
  })

  it('reports the bridge exiting in the middle of the pings', async () => {
    const port = new FakePort()
    runningApp(port)
    const honest = port.answer
    let pings = 0
    port.answer = (message) => {
      if (message.t === 'ping' && ++pings === 3) {
        queueMicrotask(() => port.close())
        return []
      }
      return honest(message)
    }
    const client = new BridgeClient(() => port, () => 'Native host has exited.', now)
    expect(await client.check()).toEqual({ kind: 'no_bridge', detail: 'Native host has exited.' })
  })

  it('says "refused" when the bridge or the app refuses, not "not answering"', async () => {
    const bridgeRefuses = new FakePort()
    bridgeRefuses.answer = () => [{ t: 'err', code: 'BAD_FRAME' }]
    expect(await new BridgeClient(() => bridgeRefuses, () => undefined, now).check()).toEqual({ kind: 'refused' })

    const appRefuses = new FakePort()
    runningApp(appRefuses)
    const honest = appRefuses.answer
    appRefuses.answer = (message) => (message.t === 'ping' ? [{ t: 'err', code: 'BAD_FRAME' }] : honest(message))
    expect(await new BridgeClient(() => appRefuses, () => undefined, now).check()).toEqual({ kind: 'refused' })
  })

  it('tells a silent bridge from a busy app, and starts over with a new port', async () => {
    vi.useFakeTimers()

    const silent = new FakePort()
    const fresh = new FakePort()
    runningApp(fresh)
    const ports = [silent, fresh]
    const client = new BridgeClient(() => ports.shift()!, () => undefined, now)
    const pending = client.check({ timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ kind: 'bridge_not_answering' })
    expect(silent.disconnected).toBe(true)
    const next = client.check({ timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect((await next).kind).toBe('connected')

    const busy = new FakePort()
    busy.answer = (message) => (message.t === 'bridge.status' ? [{ t: 'bridge.state', app: 'running' }] : [])
    const busyClient = new BridgeClient(() => busy, () => undefined, now)
    const waiting = busyClient.check({ timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await waiting).toEqual({ kind: 'app_not_answering' })
    expect(busy.disconnected).toBe(true)
  })

  it('ends checks running at the same time as timed out too, without an old error', async () => {
    vi.useFakeTimers()
    // A first port the browser couldn't start leaves an error behind...
    const missing = new FakePort()
    missing.answer = () => {
      queueMicrotask(() => missing.close())
      return []
    }
    const silent = new FakePort()
    const ports = [missing, silent]
    const client = new BridgeClient(() => ports.shift()!, () => 'Specified native messaging host not found.', now)
    const first = client.check({ timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect((await first).kind).toBe('no_bridge')

    // ...then two popups check at once on a bridge that never answers.
    const quick = client.check({ timeoutMs: 1000 })
    const slow = client.check({ timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await quick).toEqual({ kind: 'bridge_not_answering' })
    expect(await slow).toEqual({ kind: 'bridge_not_answering' })
  })

  it('ignores malformed messages and pongs for other pings', async () => {
    const port = new FakePort()
    runningApp(port)
    const honest = port.answer
    port.answer = (message) =>
      message.t === 'ping'
        ? [{ t: 'pong', n: message.n + 1000 }, { t: 'pong', n: message.n, extra: 1 }, ['pong', message.n], 'junk', ...honest(message)]
        : honest(message)
    const client = new BridgeClient(() => port, () => undefined, now)
    expect((await client.check({ pings: 2 })).kind).toBe('connected')
  })

  it('reports a port the browser refused to open', async () => {
    const client = new BridgeClient(
      () => {
        throw new Error('Access to the specified native messaging host is forbidden.')
      },
      () => undefined,
      now,
    )
    expect(await client.check()).toEqual({
      kind: 'no_bridge',
      detail: 'Access to the specified native messaging host is forbidden.',
    })
  })
})
