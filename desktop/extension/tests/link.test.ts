import { describe, expect, it } from 'vitest'
import { BridgeClient, type NativePort } from '../lib/bridge-client'
import { fromBase64, toBase64, toHex, utf8, type Bytes } from '../lib/bytes'
import { encodeRequest } from '../lib/inner'
import { MemoryStore } from '../lib/keys'
import { Link, MAX_IN_FLIGHT, Session, identify, versionNeed, type LinkState } from '../lib/link'
import { PROTOCOL, type ErrorCode, type Incoming, type Need, type Outgoing, type VaultState } from '../lib/messages'
import { clientId, generateKeyPair, pairingCode, respond, type KeyPair, type Transport } from '../lib/noise'

/**
 * The bridge and VaultKey behind the native port, speaking the real outer protocol with
 * the TypeScript Noise responder (checked against snow in noise.test.ts). Every message
 * goes through JSON, as it does through the browser.
 */
class FakeVaultKey implements NativePort {
  vault: VaultState = 'unlocked'
  /** What the user answers in the pairing dialog; 'wait' leaves it open. */
  answer: 'approve' | 'decline' | 'wait' = 'approve'
  /** Answers hs1 with this error instead (then closes, and the bridge reconnects). */
  refuseHandshake: ErrorCode | null = null
  /** Answers pair.request with this error instead. */
  refusePairing: { code: ErrorCode; need?: Need } | null = null
  /** The version the app says it speaks. */
  protocol = PROTOCOL
  paired = new Map<string, Bytes>()
  sent: Outgoing[] = []
  appKey!: KeyPair
  private connected = false
  private session: Transport | null = null
  private dialog: Bytes | null = null
  private queue: Promise<void> = Promise.resolve()
  private messageListeners: ((message: unknown) => void)[] = []
  private disconnectListeners: (() => void)[] = []

  static async start(): Promise<FakeVaultKey> {
    const fake = new FakeVaultKey()
    fake.appKey = await generateKeyPair()
    return fake
  }

  onMessage = { addListener: (listener: (message: unknown) => void) => void this.messageListeners.push(listener) }
  onDisconnect = { addListener: (listener: () => void) => void this.disconnectListeners.push(listener) }
  disconnect(): void {}

  postMessage(message: Outgoing): void {
    this.sent.push(JSON.parse(JSON.stringify(message)))
    this.queue = this.queue.then(() => this.handle(message))
  }

  /** The browser opened a new port (a restarted service worker): a new bridge, a new app connection. */
  reopen(): FakeVaultKey {
    this.messageListeners = []
    this.disconnectListeners = []
    this.connected = false
    this.session = null
    return this
  }

  /** Waits until everything sent so far was handled. */
  async settled(): Promise<void> {
    let before: Promise<void>
    do {
      before = this.queue
      await before
      await new Promise((resolve) => setTimeout(resolve, 0))
    } while (before !== this.queue)
  }

  private emit(message: Incoming): void {
    const copy = JSON.parse(JSON.stringify(message))
    for (const listener of this.messageListeners) listener(copy)
  }

  private connect(): void {
    if (this.connected) return
    this.connected = true
    this.emit({ t: 'state', state: this.vault, protocol: this.protocol })
  }

  /** The app refuses and closes; the bridge reconnects quietly; the new connection says the state. */
  private refuse(code: ErrorCode, need?: Need): void {
    this.emit(need ? { t: 'err', code, need } : { t: 'err', code })
    this.session = null
    this.dialog = null
    this.emit({ t: 'state', state: this.vault, protocol: this.protocol })
  }

  private async seal(json: string): Promise<void> {
    if (!this.session) return
    this.emit({ t: 'x', c: toBase64(await this.session.encrypt(utf8(json))) })
  }

  private async handle(message: Outgoing): Promise<void> {
    switch (message.t) {
      case 'bridge.status':
        this.emit({ t: 'bridge.state', app: 'running' })
        this.connect()
        return
      case 'ping':
        this.connect()
        this.emit({ t: 'pong', n: message.n })
        return
      case 'pair.request': {
        this.connect()
        if (this.refusePairing) return this.refuse(this.refusePairing.code, this.refusePairing.need)
        if (this.vault !== 'unlocked') return this.refuse(this.vault === 'locked' ? 'LOCKED' : 'DISABLED')
        if (this.dialog) return this.refuse('BUSY')
        const key = fromBase64(message.pub, 32)
        if (!key || key.length !== 32 || message.name !== 'Brave on macOS' || message.browser !== 'brave') return this.refuse('BAD_FRAME')
        this.dialog = key
        this.emit({ t: 'pair.pending', pub: toBase64(this.appKey.publicKey) })
        if (this.answer !== 'wait') this.decide(this.answer === 'approve')
        return
      }
      case 'hs1': {
        this.connect()
        if (message.protocol !== PROTOCOL) return this.refuse('PROTOCOL_VERSION', 'update_app')
        if (this.refuseHandshake) return this.refuse(this.refuseHandshake)
        if (this.vault !== 'unlocked') return this.refuse(this.vault === 'locked' ? 'LOCKED' : 'DISABLED')
        const client = fromBase64(message.client, 16)
        const key = client && this.paired.get(toHex(client))
        const hello = fromBase64(message.msg, 256)
        if (!key || !hello) return this.refuse('NOT_PAIRED')
        try {
          const answered = await respond({ local: this.appKey, remote: key, message: hello })
          this.session = answered.transport
          this.emit({ t: 'hs2', msg: toBase64(answered.message) })
        } catch {
          this.refuse('NOT_PAIRED')
        }
        return
      }
      case 'x': {
        if (!this.session) return this.refuse('BAD_FRAME')
        const request = JSON.parse(new TextDecoder().decode(await this.session.decrypt(fromBase64(message.c, 65536)!))) as { id: number; m: string }
        await this.seal(request.m === 'ping' ? `{"id":${request.id},"ok":true,"r":{}}` : `{"id":${request.id},"ok":false,"e":{"code":"BAD_REQUEST","msg":"Unknown method or parameters."}}`)
        return
      }
    }
  }

  /** The user's answer in the pairing dialog. */
  decide(approve: boolean): void {
    const key = this.dialog
    this.dialog = null
    if (!key) return
    if (approve) void clientId(key).then((id) => this.paired.set(toHex(id), key))
    void (approve ? clientId(key) : Promise.resolve()).then(() => this.emit({ t: 'pair.result', approved: approve }))
  }

  lock(): void {
    this.queue = this.queue.then(async () => {
      this.vault = 'locked'
      await this.seal('{"ev":"locked"}')
      this.session = null
      if (this.dialog) {
        this.dialog = null
        this.emit({ t: 'pair.result', approved: false })
      }
      this.emit({ t: 'state', state: 'locked', protocol: 1 })
    })
  }

  unlock(): void {
    this.queue = this.queue.then(() => {
      this.vault = 'unlocked'
      this.emit({ t: 'state', state: 'unlocked', protocol: 1 })
    })
  }

  revoke(): void {
    this.queue = this.queue.then(async () => {
      this.paired.clear()
      await this.seal('{"ev":"revoked"}')
      this.session = null
    })
  }

  quit(): void {
    this.queue = this.queue.then(() => {
      this.connected = false
      this.session = null
      this.emit({ t: 'bridge.state', app: 'not_running' })
    })
  }

  /** Something on the way altered a frame. */
  async tamper(): Promise<void> {
    await this.queue
    this.emit({ t: 'x', c: toBase64(new Uint8Array(40)) })
  }

  count(kind: Outgoing['t']): number {
    return this.sent.filter((message) => message.t === kind).length
  }
}

const brave = async () => ({ name: 'Brave on macOS', browser: 'brave' as const })

async function setup(store = new MemoryStore()) {
  const app = await FakeVaultKey.start()
  const link = new Link(new BridgeClient(() => app, () => undefined), store, brave)
  return { app, link, store }
}

/** Resolves when the link reaches a state that `accept`s, or fails after 2 s. */
function until(link: Link, accept: (state: LinkState) => boolean): Promise<LinkState> {
  return new Promise((resolve, reject) => {
    if (accept(link.current())) return resolve(link.current())
    const timer = setTimeout(() => {
      off()
      reject(new Error(`still ${JSON.stringify(link.current())}`))
    }, 2000)
    const off = link.onChange((state) => {
      if (!accept(state)) return
      clearTimeout(timer)
      off()
      resolve(state)
    })
  })
}

const is =
  (kind: LinkState['kind']) =>
  (state: LinkState): boolean =>
    state.kind === kind
const measured = (state: LinkState): boolean => state.kind === 'ready' && state.rttMs !== null

async function paired() {
  const context = await setup()
  await context.link.refresh()
  await context.link.pair()
  await until(context.link, measured)
  return context
}

describe('Link', () => {
  it('pairs once VaultKey approves, showing the same code, then opens an encrypted session', async () => {
    const { app, link, store } = await setup()
    app.answer = 'wait'
    expect(await link.refresh()).toEqual({ kind: 'not_paired', vault: 'unlocked', notice: null })

    await link.pair()
    const pairing = await until(link, (state) => state.kind === 'pairing' && state.code !== null)
    const request = app.sent.find((message) => message.t === 'pair.request')
    expect(request).toMatchObject({ name: 'Brave on macOS', browser: 'brave', protocol: 1 })
    const browserKey = fromBase64(request?.t === 'pair.request' ? request.pub : '', 32)!
    expect(pairing).toEqual({ kind: 'pairing', code: await pairingCode(browserKey, app.appKey.publicKey) })
    // Nothing is kept until VaultKey approves.
    expect(store.pairing).toBeNull()

    app.decide(true)
    await until(link, measured)
    expect(store.pairing?.appKey).toEqual(app.appKey.publicKey)
    expect(store.pairing?.publicKey).toEqual(browserKey)
    expect(store.pairing?.privateKey.extractable).toBe(false)
    expect((await link.call('ping')).ok).toBe(true)
    // Nothing but the handshake and sealed frames ever carried the session.
    expect(app.sent.filter((message) => message.t === 'x').length).toBeGreaterThanOrEqual(2)
  })

  it('reconnects a paired browser by itself, and shows lock and unlock live', async () => {
    const { app, store } = await paired()
    // The service worker restarted: same store, a new link on a new port.
    const again = new Link(new BridgeClient(() => app.reopen(), () => undefined), store, brave)
    await again.refresh()
    await until(again, measured)

    app.lock()
    await until(again, is('locked'))
    await expect(again.call('ping')).rejects.toThrow()
    app.unlock()
    await until(again, measured)
    expect((await again.call('ping')).ok).toBe(true)
  })

  it('says why it can’t pair: declined, locked, busy', async () => {
    const { app, link, store } = await setup()
    app.answer = 'decline'
    await link.refresh()
    await link.pair()
    expect(await until(link, is('not_paired'))).toEqual({
      kind: 'not_paired',
      vault: 'unlocked',
      notice: 'VaultKey didn’t connect this browser.',
    })
    expect(store.pairing).toBeNull()

    // VaultKey locks while its dialog is open.
    app.answer = 'wait'
    await link.pair()
    await until(link, (state) => state.kind === 'pairing' && state.code !== null)
    app.lock()
    expect(await until(link, (state) => state.kind === 'not_paired' && state.vault === 'locked')).toMatchObject({ kind: 'not_paired' })

    // Another browser's dialog is open in VaultKey.
    app.unlock()
    await until(link, (state) => state.kind === 'not_paired' && state.vault === 'unlocked')
    ;(app as unknown as { dialog: Bytes }).dialog = new Uint8Array(32)
    await link.pair()
    expect(await until(link, (state) => state.kind === 'not_paired' && state.notice !== null)).toMatchObject({
      notice: expect.stringContaining('If it shows one you didn’t start, click Don’t connect there.'),
    })
  })

  it('forgets its keys when VaultKey removes this browser', async () => {
    const { app, link, store } = await paired()
    app.revoke()
    expect(await until(link, is('not_paired'))).toMatchObject({ notice: 'VaultKey disconnected this browser. Connect it again to use it.' })
    expect(store.pairing).toBeNull()
  })

  it('forgets its keys when VaultKey no longer knows them', async () => {
    const { app, link, store } = await paired()
    app.paired.clear()
    // The app restarted meanwhile: a new connection, a new handshake, refused.
    app.quit()
    await until(link, is('app_not_running'))
    await link.refresh()
    expect(await until(link, is('not_paired'))).toMatchObject({ notice: 'VaultKey doesn’t know this browser any more. Connect it again.' })
    expect(store.pairing).toBeNull()
  })

  it('says when the extension is off in VaultKey', async () => {
    const { app, link } = await setup()
    app.vault = 'disabled'
    expect(await link.refresh()).toEqual({ kind: 'disabled' })
  })

  it('says which side to update, and keeps saying it through the reconnect', async () => {
    const { app, link } = await setup()
    app.refusePairing = { code: 'PROTOCOL_VERSION', need: 'update_app' }
    await link.refresh()
    await link.pair()
    await until(link, is('update'))
    // The app closed, the bridge reconnected, the new connection said "unlocked".
    await app.settled()
    expect(link.current()).toEqual({ kind: 'update', need: 'update_app' })

    // An app whose own version this extension can't speak: nothing is even asked.
    const older = await setup()
    older.app.protocol = PROTOCOL - 1
    expect(await older.link.refresh()).toEqual({ kind: 'update', need: 'update_app' })
    await older.link.pair()
    expect(older.app.count('pair.request')).toBe(0)
    const newer = await setup()
    newer.app.protocol = PROTOCOL + 2
    expect(await newer.link.refresh()).toEqual({ kind: 'update', need: 'update_extension' })
  })

  it('keeps a problem during pairing on screen through the reconnect', async () => {
    const { app, link } = await setup()
    app.refusePairing = { code: 'INTERNAL' }
    await link.refresh()
    await link.pair()
    await until(link, (state) => state.kind === 'not_paired' && state.notice !== null)
    await app.settled()
    expect(link.current()).toEqual({
      kind: 'not_paired',
      vault: 'unlocked',
      notice: 'VaultKey ran into a problem. Its log has the details.',
    })
  })

  it('says so when this browser can’t keep its keys', async () => {
    class Refusing extends MemoryStore {
      override async save(): Promise<void> {
        throw new Error('QuotaExceededError')
      }
    }
    const { link } = await setup(new Refusing())
    await link.refresh()
    await link.pair()
    expect(await until(link, (state) => state.kind === 'not_paired' && state.notice !== null)).toMatchObject({
      notice: 'This browser couldn’t keep its pairing (its storage refused). Try again.',
    })
  })

  it('notices VaultKey quitting', async () => {
    const { app, link } = await paired()
    app.quit()
    await until(link, is('app_not_running'))
    await expect(link.call('ping')).rejects.toThrow()
  })

  it('drops a session whose frames were altered', async () => {
    const { app, link } = await paired()
    await app.tamper()
    expect(await until(link, is('failed'))).toMatchObject({ message: 'The secure connection to VaultKey broke. Check again.' })
    await expect(link.call('ping')).rejects.toThrow()
  })

  it('stops a handshake loop between "unlocked" and a refusal as locked', async () => {
    const { app, link } = await paired()
    app.refuseHandshake = 'LOCKED'
    const before = app.count('hs1')
    app.quit()
    await until(link, is('app_not_running'))
    await link.refresh()
    await until(link, is('failed'))
    await app.settled()
    expect(app.count('hs1') - before).toBeLessThanOrEqual(2)
  })

  it('stops retrying a handshake VaultKey keeps refusing, until the popup asks again', async () => {
    const { app, link, store } = await paired()
    app.refuseHandshake = 'INTERNAL'
    const before = app.count('hs1')
    app.quit()
    await until(link, is('app_not_running'))
    await link.refresh()
    await until(link, is('failed'))
    await app.settled()
    expect(app.count('hs1') - before).toBeLessThanOrEqual(2)
    // The keys stay: VaultKey had a problem, it didn't refuse this browser.
    expect(store.pairing).not.toBeNull()
    app.refuseHandshake = null
    await link.refresh()
    await until(link, measured)
  })
})

describe('Session', () => {
  it('allows at most 8 requests in flight, and times them out', async () => {
    const transport: Transport = { encrypt: async (bytes) => bytes, decrypt: async (bytes) => bytes }
    const posted: string[] = []
    const session = new Session(transport, (sealed) => posted.push(sealed) > 0)
    const waiting = Array.from({ length: MAX_IN_FLIGHT }, () => session.request('ping'))
    await expect(session.request('ping')).rejects.toThrow('Too many')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Sent in order, with ids 1…8.
    expect(posted.map((sealed) => new TextDecoder().decode(fromBase64(sealed, 100)!))).toEqual(
      Array.from({ length: MAX_IN_FLIGHT }, (_, i) => encodeRequest({ id: i + 1, m: 'ping' })),
    )
    session.settle({ kind: 'reply', id: 3, ok: true, r: {} })
    await expect(waiting[2]).resolves.toMatchObject({ id: 3 })
    session.close('gone')
    for (const [i, request] of waiting.entries()) if (i !== 2) await expect(request).rejects.toThrow('gone')
    await expect(session.request('ping')).rejects.toThrow()
  })
})

describe('versionNeed', () => {
  it('accepts an app of this version or the next (which still speaks this one)', () => {
    expect(versionNeed(PROTOCOL)).toBeNull()
    expect(versionNeed(PROTOCOL + 1)).toBeNull()
    expect(versionNeed(PROTOCOL - 1)).toBe('update_app')
    expect(versionNeed(PROTOCOL + 2)).toBe('update_extension')
  })
})

describe('identify', () => {
  it('names the browser and the system', async () => {
    const brands = (...names: string[]) => ({ userAgentData: { brands: names.map((brand) => ({ brand })) } })
    expect(await identify(brands('Brave', 'Chromium'), 'mac')).toEqual({ browser: 'brave', name: 'Brave on macOS' })
    expect(await identify({ ...brands('Chromium'), brave: { isBrave: async () => true } }, 'win')).toEqual({
      browser: 'brave',
      name: 'Brave on Windows',
    })
    expect(await identify(brands('Microsoft Edge', 'Chromium'), 'win')).toEqual({ browser: 'edge', name: 'Edge on Windows' })
    expect(await identify(brands('Google Chrome', 'Chromium'), 'linux')).toEqual({ browser: 'chrome', name: 'Chrome on Linux' })
    expect(await identify(brands('Chromium'), 'cros')).toEqual({ browser: 'chromium', name: 'Chromium on ChromeOS' })
    expect(await identify({}, 'android')).toEqual({ browser: 'other', name: 'Browser on this computer' })
  })
})
