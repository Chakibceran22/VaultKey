import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Actions, type ActiveTab, type Caller, type Tabs } from '../lib/actions'
import type { FillRequest } from '../lib/content-messages'
import { parseCode, parseMatches, parseRevealed, type InnerMethod } from '../lib/inner'
import type { InnerReply } from '../lib/link'
import { isPopupRequest } from '../lib/popup-messages'

const samples = (
  JSON.parse(readFileSync(new URL('./fixtures/protocol/inner.json', import.meta.url), 'utf8')) as {
    samples: { match: Record<string, unknown>; reveal: Record<string, unknown>; totp: Record<string, unknown> }
  }
).samples

const card = (h: string, method = 'password') => ({ ...(samples.match.cards as Record<string, unknown>[])[0], h, method })

/** VaultKey, answering from a script; records what it was asked. */
class Vault implements Caller {
  asked: { method: InnerMethod; params?: Record<string, unknown> }[] = []
  constructor(private readonly answers: Partial<Record<InnerMethod, InnerReply>>) {}
  async call(method: InnerMethod, params?: Record<string, unknown>): Promise<InnerReply> {
    this.asked.push({ method, params })
    const answer = this.answers[method]
    if (!answer) throw new Error('Not connected to VaultKey.')
    return answer
  }
}

const ok = (r: Record<string, unknown>): InnerReply => ({ kind: 'reply', id: 1, ok: true, r })
const no = (code: string): InnerReply => ({ kind: 'reply', id: 1, ok: false, e: { code, msg: '' } })

class Browser implements Tabs {
  sent: FillRequest[] = []
  constructor(
    private readonly tab: ActiveTab | null,
    private readonly answer: (request: FillRequest) => unknown = () => ({ filled: 2 }),
  ) {}
  async active() {
    return this.tab
  }
  async send(_: number, request: FillRequest) {
    this.sent.push(request)
    return this.answer(request)
  }
}

const github: ActiveTab = { id: 7, url: 'https://github.com/login?return_to=/x' }

describe('Actions', () => {
  it('asks for the active tab’s cards with the address the browser reports', async () => {
    const vault = new Vault({ match: ok(samples.match) })
    const found = await new Actions(vault, new Browser(github)).cards()
    expect(found).toMatchObject({ kind: 'cards', site: 'github.com', insecure: 0 })
    expect(vault.asked).toEqual([{ method: 'match', params: { tabUrl: github.url, frameUrl: github.url } }])
    expect(await new Actions(vault, new Browser({ id: 1, url: 'chrome://newtab/' })).cards()).toEqual({ kind: 'no_site' })
    expect(await new Actions(vault, new Browser(null)).cards()).toEqual({ kind: 'no_site' })
    expect(await new Actions(new Vault({ match: no('LOCKED') }), new Browser(github)).cards()).toEqual({
      kind: 'error',
      message: 'VaultKey is locked. Unlock it, then try again.',
    })
  })

  it('fills one login into the tab, for its origin only', async () => {
    const vault = new Vault({ reveal: ok(samples.reveal) })
    const browser = new Browser(github)
    expect(await new Actions(vault, browser).fill('H', 'popup')).toEqual({ ok: true, message: 'Filled' })
    expect(vault.asked[0]).toEqual({ method: 'reveal', params: { h: 'H', tabUrl: github.url, frameUrl: github.url, via: 'popup' } })
    expect(browser.sent).toEqual([
      { type: 'vaultkey.fill', origin: 'https://github.com', login: { email: 'me@x.com', username: 'me', password: 'password-1' }, code: null },
    ])
  })

  it('says why a fill didn’t happen', async () => {
    const vault = new Vault({ reveal: ok(samples.reveal) })
    const fill = (browser: Browser) => new Actions(vault, browser).fill('H', 'popup')
    expect(await fill(new Browser(github, () => ({ filled: 0, reason: 'no_form' })))).toMatchObject({ ok: false, message: expect.stringContaining('No login form') })
    expect(await fill(new Browser(github, () => ({ filled: 0, reason: 'origin' })))).toMatchObject({ ok: false, message: expect.stringContaining('changed') })
    expect(await fill(new Browser(github, () => undefined))).toMatchObject({ ok: false, message: expect.stringContaining('Reload') })
    expect(await fill(new Browser(github, () => { throw new Error('Could not establish connection.') }))).toMatchObject({ ok: false })
    expect(await new Actions(new Vault({ reveal: no('ORIGIN_MISMATCH') }), new Browser(github)).fill('H', 'popup')).toEqual({
      ok: false,
      message: 'That login isn’t for this page.',
    })
    expect(await new Actions(new Vault({}), new Browser(github)).fill('H', 'popup')).toEqual({ ok: false, message: 'Not connected to VaultKey.' })
  })

  it('gets a code, and fills it where the page has a code field', async () => {
    const browser = new Browser(github)
    const result = await new Actions(new Vault({ totp: ok(samples.totp) }), browser).code('H')
    expect(result).toEqual({ ok: true, code: '123456', expiresAt: 1700000030000 })
    expect(browser.sent[0]).toMatchObject({ login: null, code: '123456', origin: 'https://github.com' })
  })

  it('fills straight away from the shortcut only when there’s one login to fill', async () => {
    const one = new Vault({ match: ok({ ...samples.match, cards: [card('A'), card('B', 'none')] }), reveal: ok(samples.reveal) })
    expect(await new Actions(one, new Browser(github)).shortcut()).toEqual({ ok: true, message: 'Filled' })
    expect(one.asked.at(-1)?.params).toMatchObject({ h: 'A', via: 'shortcut' })
    const two = new Vault({ match: ok({ ...samples.match, cards: [card('A'), card('B')] }) })
    expect(await new Actions(two, new Browser(github)).shortcut()).toBe('open_popup')
    const none = new Vault({ match: ok({ ...samples.match, cards: [] }) })
    expect(await new Actions(none, new Browser(github)).shortcut()).toBe('open_popup')
  })

  it('never fills from the shortcut on an http page or for a sibling subdomain', async () => {
    const answers = { match: ok({ ...samples.match, cards: [card('A')] }), reveal: ok(samples.reveal) }
    const http = new Vault(answers)
    expect(await new Actions(http, new Browser({ id: 7, url: 'http://github.com/login' })).shortcut()).toBe('open_popup')
    expect(http.asked.map((asked) => asked.method)).toEqual(['match'])
    const sibling = new Vault({ ...answers, match: ok({ ...samples.match, cards: [{ ...card('A'), tier: 'subdomain' }] }) })
    expect(await new Actions(sibling, new Browser(github)).shortcut()).toBe('open_popup')
    expect(sibling.asked.map((asked) => asked.method)).toEqual(['match'])
  })

  it('fills or types a code into an http page only once the user confirmed', async () => {
    const http: ActiveTab = { id: 7, url: 'http://intranet.example.com/login' }
    const vault = new Vault({ reveal: ok(samples.reveal), totp: ok(samples.totp) })
    const browser = new Browser(http)
    const actions = new Actions(vault, browser)
    expect(await actions.fill('H', 'popup')).toMatchObject({ ok: false, message: expect.stringContaining('isn’t secure') })
    expect(vault.asked).toEqual([])
    expect(await actions.fill('H', 'popup', true)).toEqual({ ok: true, message: 'Filled' })
    // A code is still given for the clipboard, but not typed into the http page.
    expect(await actions.code('H')).toMatchObject({ ok: true, code: '123456' })
    expect(browser.sent).toHaveLength(1)
  })

  it('says whether the page is secure', async () => {
    const vault = new Vault({ match: ok(samples.match) })
    expect(await new Actions(vault, new Browser(github)).cards()).toMatchObject({ secure: true })
    expect(await new Actions(vault, new Browser({ id: 7, url: 'http://github.com/' })).cards()).toMatchObject({ secure: false })
  })
})

describe('the inner results', () => {
  it('accepts what the app sends (the shared samples)', () => {
    expect(parseMatches(samples.match)?.cards[0]?.h).toBe('AAAAAAAAAAAAAAAAAAAAAA==')
    expect(parseMatches({ site: null, cards: [], insecure: 0 })).toEqual({ site: null, cards: [], insecure: 0 })
    expect(parseRevealed(samples.reveal)).toEqual({ email: 'me@x.com', username: 'me', password: 'password-1' })
    expect(parseCode(samples.totp)).toEqual({ code: '123456', expiresAt: 1700000030000 })
  })

  it('refuses anything else', () => {
    const badCards = [
      { ...card('A'), extra: 1 },
      { ...card('A'), tier: 'related' },
      { ...card('A'), h: 7 },
      { ...card('A'), username: 3 },
    ]
    for (const bad of badCards) expect(parseMatches({ ...samples.match, cards: [bad] }), JSON.stringify(bad)).toBeNull()
    expect(parseMatches({ ...samples.match, extra: true })).toBeNull()
    expect(parseMatches({ ...samples.match, insecure: -1 })).toBeNull()
    expect(parseRevealed({ ...samples.reveal, extra: 1 })).toBeNull()
    expect(parseRevealed({ email: 'a', username: null })).toBeNull()
    expect(parseCode({ code: '12345', expiresAt: 1 })).toBeNull()
    expect(parseCode({ code: '123456', expiresAt: '1' })).toBeNull()
  })
})

describe('popup requests', () => {
  it('takes only known requests, with a handle where one is needed', () => {
    for (const good of [{ type: 'refresh' }, { type: 'pair' }, { type: 'cards' }, { type: 'fill', h: 'H', confirmedInsecure: false }, { type: 'code', h: 'H' }]) {
      expect(isPopupRequest(good), JSON.stringify(good)).toBe(true)
    }
    for (const bad of [{ type: 'fill' }, { type: 'fill', h: 'H' }, { type: 'fill', h: 'H', confirmedInsecure: 'yes' }, { type: 'fill', h: '', confirmedInsecure: false }, { type: 'fill', h: 'x'.repeat(65) }, { type: 'reveal', h: 'H' }, { type: 'cards', h: 'H' }, ['fill'], null]) {
      expect(isPopupRequest(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})
