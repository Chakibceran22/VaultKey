import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Caller } from '../lib/actions'
import type { FillRequest } from '../lib/content-messages'
import type { InnerMethod } from '../lib/inner'
import { Inline, MIN_SHOWN_MS, TAB_MATCHES_PER_MINUTE, type Frame, type InlineBrowser, type MenuPort } from '../lib/inline'
import { isContentCommand, isContentRequest, isMenuRequest, type MenuUpdate } from '../lib/inline-messages'
import type { InnerReply, LinkState } from '../lib/link'

const samples = (
  JSON.parse(readFileSync(new URL('./fixtures/protocol/inner.json', import.meta.url), 'utf8')) as {
    samples: { match: Record<string, unknown>; reveal: Record<string, unknown>; totp: Record<string, unknown> }
  }
).samples
const base = (samples.match.cards as Record<string, unknown>[])[0]!
const card = (h: string, extra: Record<string, unknown> = {}) => ({ ...base, h, ...extra })
const ok = (r: Record<string, unknown>): InnerReply => ({ kind: 'reply', id: 1, ok: true, r })
const no = (code: string): InnerReply => ({ kind: 'reply', id: 1, ok: false, e: { code, msg: '' } })

class Vault implements Caller {
  asked: { method: InnerMethod; params?: Record<string, unknown> }[] = []
  constructor(public answers: Partial<Record<InnerMethod, InnerReply>>) {}
  async call(method: InnerMethod, params?: Record<string, unknown>): Promise<InnerReply> {
    this.asked.push({ method, params })
    const answer = this.answers[method]
    if (!answer) throw new Error('Not connected to VaultKey.')
    return answer
  }
}

class Browser implements InlineBrowser {
  visible = true
  /** How long the menu has stayed put, as the page's frame reports it. */
  stableMs = 1000
  fills: { frame: Frame; request: FillRequest }[] = []
  closed: Frame[] = []
  badges: [number, number][] = []
  popups = 0
  shown = 0
  readied: Frame[] = []
  ready(frame: Frame) {
    this.readied.push(frame)
  }
  async verify() {
    return { visible: this.visible, stableMs: this.stableMs }
  }
  showApp() {
    this.shown++
  }
  close(frame: Frame) {
    this.closed.push(frame)
  }
  async fill(frame: Frame, request: FillRequest) {
    this.fills.push({ frame, request })
    return { filled: 2 }
  }
  badge(tabId: number, count: number) {
    this.badges.push([tabId, count])
  }
  openPopup() {
    this.popups++
  }
}

class Port implements MenuPort {
  updates: MenuUpdate[] = []
  post(update: MenuUpdate) {
    this.updates.push(update)
  }
  get last() {
    return this.updates.at(-1)
  }
}

const top: Frame = { tabId: 3, frameId: 0, url: 'https://github.com/login', tabUrl: 'https://github.com/login' }
const inner: Frame = { tabId: 3, frameId: 7, url: 'https://auth.example.net/frame', tabUrl: 'https://github.com/login' }

function setup(state: LinkState['kind'] = 'ready', cards: Record<string, unknown>[] = [card('A'), card('B', { email: 'b@x.com' })]) {
  const vault = new Vault({ match: ok({ ...samples.match, cards }), reveal: ok(samples.reveal), totp: ok(samples.totp) })
  const browser = new Browser()
  let clock = 1_000_000
  const now = () => clock
  const inline = new Inline(vault, () => ({ kind: state }) as LinkState, browser, now)
  const advance = (ms: number) => (clock += ms)
  return { vault, browser, inline, advance }
}

function menu(inline: Inline, frame: Frame) {
  const port = new Port()
  const token = inline.token(frame).token!
  const key = inline.connect(token, frame.tabId, port)!
  return { port, key }
}

const pick = (h: string, extra: Partial<{ code: boolean; trusted: boolean; shownMs: number; visible: boolean | null }> = {}) => ({
  type: 'pick' as const,
  h,
  code: false,
  trusted: true,
  shownMs: MIN_SHOWN_MS + 50,
  visible: true,
  ...extra,
})

describe('Inline', () => {
  it('matches each frame against its own address, and badges the top frame', async () => {
    const { vault, browser, inline } = setup()
    expect(await inline.found(top)).toEqual({ show: 'icon', auto: true })
    expect(vault.asked[0]).toEqual({ method: 'match', params: { tabUrl: top.url, frameUrl: top.url } })
    expect(browser.badges).toEqual([[3, 2]])
    await inline.found(inner)
    expect(vault.asked[1]?.params).toEqual({ tabUrl: inner.tabUrl, frameUrl: inner.url })
    expect(browser.badges).toHaveLength(1)
    // Cached per origin: another page or frame of github.com asks nothing more.
    await inline.found({ ...top, frameId: 9, url: 'https://github.com/settings?x=1' })
    expect(vault.asked).toHaveLength(2)
  })

  it('shows the icon on every login field once paired: it says nothing about the vault', async () => {
    expect(await setup('locked').inline.found(top)).toEqual({ show: 'icon', auto: false })
    expect(await setup('ready', []).inline.found(top)).toEqual({ show: 'icon', auto: false })
    expect(await setup('not_paired').inline.found(top)).toEqual({ show: 'none', auto: false })
    expect(await setup('app_not_running').inline.found(top)).toEqual({ show: 'none', auto: false })
    // A sibling subdomain's login waits for a click on the icon.
    expect(await setup('ready', [card('A', { tier: 'subdomain' })]).inline.found(top)).toEqual({ show: 'icon', auto: false })
  })

  it('limits the matches one tab can cause', async () => {
    const { vault, inline, advance } = setup()
    for (let i = 0; i < TAB_MATCHES_PER_MINUTE + 10; i++) await inline.found({ ...inner, frameId: 100 + i, url: `https://f${i}.example/` })
    expect(vault.asked).toHaveLength(TAB_MATCHES_PER_MINUTE)
    // Another tab has its own budget; and it comes back after a minute.
    await inline.found({ ...inner, tabId: 4, url: 'https://other.example/' })
    expect(vault.asked).toHaveLength(TAB_MATCHES_PER_MINUTE + 1)
    advance(60_000)
    await inline.found({ ...inner, url: 'https://again.example/' })
    expect(vault.asked).toHaveLength(TAB_MATCHES_PER_MINUTE + 2)
  })

  it('clears the badges when the session ends', async () => {
    const { inline, browser } = setup()
    await inline.found(top)
    // A new session alone keeps the count (a reconnect shouldn't blank it)…
    inline.forget()
    expect(browser.badges.at(-1)).toEqual([3, 2])
    // …VaultKey out of reach clears it.
    inline.clearBadges()
    expect(browser.badges.at(-1)).toEqual([3, 0])
  })

  it('binds a menu to the tab and frame its token was made for, once', () => {
    const { inline, advance, browser } = setup()
    const token = inline.token(top).token!
    expect(inline.connect(token, 99, new Port())).toBeNull()
    expect(inline.connect(token, top.tabId, new Port()), 'used already').toBeNull()
    const late = inline.token(top).token!
    advance(31_000)
    expect(inline.connect(late, top.tabId, new Port()), 'expired').toBeNull()
    expect(inline.connect(inline.token(top).token!, top.tabId, new Port())).toBe('3:0')
    // The frame hears its menu is ready, only for the good connect.
    expect(browser.readied).toEqual([top])
    // The frame hears its menu is ready (and only on a good connect).
    expect(inline.connect('made-up', top.tabId, new Port())).toBeNull()
  })

  it('shows the frame’s cards in the menu, never more than 8', async () => {
    const many = Array.from({ length: 12 }, (_, i) => card(`H${i}`, { email: `${i}@x.com` }))
    const { inline } = setup('ready', many)
    const { port } = menu(inline, top)
    expect(await inline.open(top, 'password')).toEqual({ rows: 8, menu: true, pickable: true })
    expect(port.last).toMatchObject({ type: 'show', state: 'ready', kind: 'password', site: 'github.com' })
    const shown = port.last as Extract<MenuUpdate, { state: 'ready' }>
    expect(shown.cards[0]).toEqual({ h: 'H0', name: '0@x.com', where: 'github.com', hasTotp: true, fillable: true })
    // A code field lists only accounts with an authenticator.
    const { inline: codes } = setup('ready', [card('A', { hasTotp: false }), card('B')])
    const codeMenu = menu(codes, top)
    expect(await codes.open(top, 'code')).toEqual({ rows: 1, menu: true, pickable: true })
    expect((codeMenu.port.last as Extract<MenuUpdate, { state: 'ready' }>).cards.map((each) => each.h)).toEqual(['B'])
    // No menu for that frame (the service worker restarted, or bfcache): the page makes one.
    expect(await inline.open(inner, 'password')).toEqual({ rows: 0, menu: false, pickable: false })
  })

  it('says so when there are no logins for the site', async () => {
    const { inline } = setup('ready', [])
    const { port } = menu(inline, top)
    expect(await inline.open(top, 'username')).toEqual({ rows: 1, menu: true, pickable: false })
    expect(port.last).toEqual({ type: 'show', state: 'empty', above: false, site: 'github.com' })
    await inline.open(top, 'username', true)
    expect(port.last).toMatchObject({ above: true })
  })

  it('says “locked” in the menu while VaultKey is locked, and brings it forward on request (no session needed)', async () => {
    const { inline, vault, browser } = setup('locked')
    const { port, key } = menu(inline, top)
    expect(await inline.open(top, 'username')).toEqual({ rows: 1, menu: true, pickable: false })
    expect(port.last).toEqual({ type: 'show', state: 'locked', above: false })
    await inline.request(key, { type: 'open-app' })
    expect(browser.shown).toBe(1)
    expect(vault.asked).toEqual([])
    expect(browser.closed).toEqual([top])
  })

  it('fills a pick into its frame, for the frame’s own origin, then closes the menu', async () => {
    const { inline, vault, browser } = setup()
    const { port, key } = menu(inline, top)
    await inline.open(top, 'password')
    await inline.request(key, pick('A'))
    expect(vault.asked.at(-1)).toEqual({ method: 'reveal', params: { h: 'A', tabUrl: top.tabUrl, frameUrl: top.url, via: 'menu' } })
    expect(browser.fills).toEqual([
      { frame: top, request: { type: 'vaultkey.fill', origin: 'https://github.com', login: samples.reveal, code: null } },
    ])
    expect(port.last).toEqual({ type: 'result', ok: true, message: 'Filled' })
    expect(browser.closed).toEqual([top])
  })

  it('refuses a pick that wasn’t clearly seen: “open the popup” instead', async () => {
    for (const [why, request, visible, stableMs] of [
      ['untrusted', pick('A', { trusted: false }), true, 1000],
      ['too quick', pick('A', { shownMs: MIN_SHOWN_MS - 1 }), true, 1000],
      ['hidden (IntersectionObserver v2)', pick('A', { visible: false }), true, 1000],
      ['covered on the page', pick('A'), false, 1000],
      ['moved under the cursor a moment ago', pick('A'), true, MIN_SHOWN_MS - 1],
    ] as const) {
      const { inline, vault, browser } = setup()
      browser.visible = visible
      browser.stableMs = stableMs
      const { port, key } = menu(inline, top)
      await inline.open(top, 'password')
      await inline.request(key, request)
      expect(port.last, why).toEqual({ type: 'result', ok: false, message: 'Open the VaultKey popup to fill.' })
      expect(vault.asked.some((asked) => asked.method === 'reveal'), why).toBe(false)
    }
    // Where IntersectionObserver v2 isn't there (null), the page's check decides, in the
    // top frame only: a sub-frame's parent could fade the whole frame, which only the
    // browser sees.
    const { inline, browser } = setup()
    const { key } = menu(inline, top)
    await inline.open(top, 'password')
    await inline.request(key, pick('A', { visible: null }))
    expect(browser.fills).toHaveLength(1)
    const sub = setup()
    const subMenu = menu(sub.inline, inner)
    await sub.inline.open(inner, 'password')
    await sub.inline.request(subMenu.key, pick('A', { visible: null }))
    expect(subMenu.port.last).toEqual({ type: 'result', ok: false, message: 'Open the VaultKey popup to fill.' })
    await sub.inline.request(subMenu.key, pick('A', { visible: true }))
    expect(sub.browser.fills).toHaveLength(1)
  })

  it('refuses a handle that isn’t in the open menu', async () => {
    const { inline, vault } = setup()
    const { port, key } = menu(inline, top)
    await inline.request(key, pick('A'))
    expect(port.last).toMatchObject({ ok: false, message: expect.stringContaining('out of date') })
    await inline.open(top, 'password')
    await inline.request(key, pick('Z'))
    expect(port.last).toMatchObject({ ok: false, message: expect.stringContaining('out of date') })
    // A new session: the cached list (and its handles) is gone.
    inline.forget()
    await inline.request(key, pick('A'))
    expect(port.last).toMatchObject({ ok: false })
    expect(vault.asked.some((asked) => asked.method === 'reveal')).toBe(false)
  })

  it('fills a code where the menu opened on a code field', async () => {
    const { inline, vault, browser } = setup()
    const { key } = menu(inline, top)
    await inline.open(top, 'code')
    await inline.request(key, pick('A', { code: true }))
    expect(vault.asked.at(-1)?.method).toBe('totp')
    expect(browser.fills[0]?.request).toMatchObject({ login: null, code: '123456' })
  })

  it('lists the account just picked first on the next step (email page, then password page)', async () => {
    const { inline, advance } = setup('ready', [card('A', { email: 'a@x.com' }), card('B', { email: 'b@x.com' })])
    const { port, key } = menu(inline, top)
    await inline.open(top, 'username')
    await inline.request(key, pick('B'))
    await inline.open(top, 'password')
    expect((port.last as Extract<MenuUpdate, { state: 'ready' }>).cards.map((each) => each.h)).toEqual(['B', 'A'])
    advance(3 * 60_000 + 1)
    inline.forget()
    await inline.open(top, 'password')
    expect((port.last as Extract<MenuUpdate, { state: 'ready' }>).cards.map((each) => each.h)).toEqual(['A', 'B'])
  })

  it('says why a fill failed, and keeps the menu open', async () => {
    const { inline, vault, browser } = setup()
    vault.answers.reveal = no('RATE_LIMITED')
    const { port, key } = menu(inline, top)
    await inline.open(top, 'password')
    await inline.request(key, pick('A'))
    expect(port.last).toMatchObject({ ok: false, message: expect.stringContaining('Too many') })
    expect(browser.closed).toHaveLength(0)
  })

  it('forgets only the menu whose port closed', () => {
    const { inline } = setup()
    const first = new Port()
    const key = inline.connect(inline.token(top).token!, top.tabId, first)!
    const second = new Port()
    inline.connect(inline.token(top).token!, top.tabId, second)
    inline.disconnect(key, first)
    // The newer menu still answers.
    void inline.open(top, 'password')
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(second.updates).toHaveLength(1)
        resolve()
      }, 0),
    )
  })
})

describe('inline message guards', () => {
  it('take exactly the messages of each channel', () => {
    for (const good of [{ type: 'vk.found' }, { type: 'vk.token' }, { type: 'vk.closed' }, { type: 'vk.open', kind: 'password', above: false }, { type: 'vk.key', key: 'Enter' }]) {
      expect(isContentRequest(good), JSON.stringify(good)).toBe(true)
    }
    for (const bad of [{ type: 'vk.open', kind: 'credit-card', above: false }, { type: 'vk.open', kind: 'password' }, { type: 'vk.open', kind: 'password', above: 'yes' }, { type: 'vk.key', key: 'a' }, { type: 'vk.found', url: 'x' }, { type: 'reveal' }, null]) {
      expect(isContentRequest(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(isContentCommand({ type: 'vk.verify' })).toBe(true)
    expect(isContentCommand({ type: 'vk.ready', token: 't' })).toBe(true)
    expect(isContentCommand({ type: 'vk.ready' })).toBe(false)
    expect(isContentCommand({ type: 'vk.verify', x: 1 })).toBe(false)
    expect(isMenuRequest(pick('A'))).toBe(true)
    expect(isMenuRequest({ ...pick('A'), visible: 'yes' })).toBe(false)
    expect(isMenuRequest({ ...pick('A'), shownMs: Number.NaN })).toBe(false)
    expect(isMenuRequest({ ...pick(''), h: '' })).toBe(false)
    expect(isMenuRequest({ type: 'more' })).toBe(true)
    expect(isMenuRequest({ type: 'fill', h: 'A' })).toBe(false)
  })
})
