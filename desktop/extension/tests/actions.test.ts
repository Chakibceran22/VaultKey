import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Actions, explain, type ActiveTab, type Caller, type Tabs } from '../lib/actions'
import type { FillRequest } from '../lib/content-messages'
import { parseCode, parseMatches, parseRevealed, parseSearch, type InnerMethod } from '../lib/inner'
import type { InnerReply } from '../lib/link'
import { isPopupRequest } from '../lib/popup-messages'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/protocol/inner.json', import.meta.url), 'utf8')) as {
  samples: { match: Record<string, unknown>; search: Record<string, unknown>; reveal: Record<string, unknown>; totp: Record<string, unknown> }
  errorCodes: string[]
}
const samples = fixture.samples

const card = (h: string, method = 'password'): Record<string, unknown> => ({ ...(samples.match.cards as Record<string, unknown>[])[0], h, method })
const found = (h: string, extra: Record<string, unknown> = {}) => ({ ...(samples.search.cards as Record<string, unknown>[])[0], h, ...extra })

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
    expect(await actions.fill('H', 'popup', { insecure: true })).toEqual({ ok: true, message: 'Filled' })
    // A code is still given for the clipboard, but not typed into the http page.
    expect(await actions.code('H')).toMatchObject({ ok: true, code: '123456' })
    expect(browser.sent).toHaveLength(1)
  })

  it('searches from the active tab’s address, at most 20 results', async () => {
    const vault = new Vault({ search: ok({ cards: [found('S1'), found('S2', { title: 'GitLab', host: '' })] }) })
    const result = await new Actions(vault, new Browser(github)).search('  git ')
    expect(result).toMatchObject({ kind: 'found', q: 'git', site: 'github.com' })
    expect(result.kind === 'found' && result.cards.map((each) => each.h)).toEqual(['S1', 'S2'])
    expect(vault.asked).toEqual([{ method: 'search', params: { q: 'git', tabUrl: github.url, limit: 20 } }])
    // Nothing to ask about: nothing asked.
    const quiet = new Vault({})
    expect(await new Actions(quiet, new Browser(github)).search('   ')).toEqual({ kind: 'found', q: '', site: 'github.com', origin: 'https://github.com', cards: [] })
    expect(await new Actions(quiet, new Browser(github)).search('x'.repeat(201))).toMatchObject({ kind: 'found', cards: [] })
    expect(await new Actions(quiet, new Browser({ id: 1, url: 'chrome://newtab/' })).search('git')).toEqual({ kind: 'no_site' })
    expect(quiet.asked).toEqual([])
  })

  it('refuses a search answer with a card that claims to match the page', async () => {
    const vault = new Vault({ search: ok({ cards: [found('S1', { tier: 'exact' })] }) })
    expect(await new Actions(vault, new Browser(github)).search('git')).toMatchObject({ kind: 'error', message: expect.stringContaining('Update both') })
    expect(await new Actions(new Vault({ search: no('RATE_LIMITED') }), new Browser(github)).search('git')).toMatchObject({ kind: 'error' })
  })

  it('fills or gives a code for another site’s login only with the user’s confirmation', async () => {
    const vault = new Vault({ reveal: ok(samples.reveal), totp: ok(samples.totp) })
    const actions = new Actions(vault, new Browser(github))
    const confirmed = { crossSite: true, origin: 'https://github.com' }
    expect(await actions.fill('S', 'popup', confirmed)).toEqual({ ok: true, message: 'Filled' })
    expect(vault.asked.at(-1)).toEqual({
      method: 'reveal',
      params: { h: 'S', tabUrl: github.url, frameUrl: github.url, via: 'popup', confirmedCrossSite: true },
    })
    await actions.code('S', confirmed)
    expect(vault.asked.at(-1)?.params).toEqual({ h: 'S', tabUrl: github.url, frameUrl: github.url, confirmedCrossSite: true })
    // A page's own logins: the parameter isn't sent at all.
    await actions.code('H')
    expect(vault.asked.at(-1)?.params).toEqual({ h: 'H', tabUrl: github.url, frameUrl: github.url })
    // VaultKey's refusal of an unconfirmed one, in words.
    expect(await new Actions(new Vault({ reveal: no('CONFIRM_REQUIRED') }), new Browser(github)).fill('S', 'popup')).toEqual({
      ok: false,
      message: explain('CONFIRM_REQUIRED'),
    })
    // Search fills have their own, tighter limit: said as such.
    const limited = new Actions(new Vault({ reveal: no('RATE_LIMITED'), totp: no('RATE_LIMITED') }), new Browser(github))
    expect(await limited.fill('S', 'popup', confirmed)).toEqual({ ok: false, message: 'Too many fills from search. Try again in a few minutes.' })
    expect(await limited.code('S', confirmed)).toMatchObject({ ok: false, message: expect.stringContaining('from search') })
    expect(await limited.fill('H', 'popup')).toEqual({ ok: false, message: explain('RATE_LIMITED') })
  })

  it('releases nothing when the tab left the page the popup asked about', async () => {
    // "Fill gitlab.com's login on example.org?" was answered; meanwhile the tab went elsewhere.
    const vault = new Vault({ reveal: ok(samples.reveal), totp: ok(samples.totp) })
    const browser = new Browser({ id: 7, url: 'https://attacker.example/login' })
    const actions = new Actions(vault, browser)
    const asked = { crossSite: true, origin: 'https://example.org' }
    for (const outcome of [await actions.fill('S', 'popup', asked), await actions.code('S', asked)]) {
      expect(outcome).toEqual({ ok: false, message: expect.stringContaining('another page') })
    }
    // A cross-site confirmation always names its page; a page's own login checks it too.
    expect(await actions.fill('S', 'popup', { crossSite: true })).toMatchObject({ ok: false, message: expect.stringContaining('another page') })
    expect(await actions.fill('H', 'popup', { origin: 'https://github.com' })).toMatchObject({ ok: false })
    expect(vault.asked).toEqual([])
    expect(browser.sent).toEqual([])
    // Still there: it goes ahead (same origin, any path).
    expect(await actions.fill('S', 'popup', { crossSite: true, origin: 'https://attacker.example' })).toEqual({ ok: true, message: 'Filled' })
  })

  it('explains every refusal VaultKey can send', () => {
    const generic = explain('SOMETHING_NEW')
    for (const code of fixture.errorCodes) {
      if (code === 'BAD_REQUEST' || code === 'INTERNAL') expect(explain(code)).toBe(generic)
      else expect(explain(code), code).not.toBe(generic)
    }
    expect(explain('CONFIRM_REQUIRED')).toContain('another site')
  })

  it('says whether the page is secure', async () => {
    const vault = new Vault({ match: ok(samples.match) })
    expect(await new Actions(vault, new Browser(github)).cards()).toMatchObject({ secure: true })
    expect(await new Actions(vault, new Browser({ id: 7, url: 'http://github.com/' })).cards()).toMatchObject({ secure: false })
  })
})

describe('the inner results', () => {
  it('accepts what the app sends (the shared samples)', () => {
    const matches = parseMatches(samples.match)
    expect(matches?.cards[0]).toMatchObject({ h: 'AAAAAAAAAAAAAAAAAAAAAA==', kind: 'account', forSite: null })
    expect(matches?.cards[0]?.signsInWith).toEqual([{ provider: 'google', label: 'me@gmail.com' }])
    expect(matches?.ssoHints).toEqual([{ provider: 'google', label: 'me@gmail.com' }])
    expect(parseMatches({ site: null, cards: [], insecure: 0, ssoHints: [] })).toEqual({ site: null, cards: [], insecure: 0, ssoHints: [] })
    expect(parseSearch(samples.search)?.map((each) => each.tier)).toEqual(['search'])
    // Every kind, method and page tier the contract names.
    for (const extra of [
      { kind: 'service_login', username: null },
      { method: 'linked' },
      { method: 'none' },
      { tier: 'subdomain' },
      { tier: 'related' },
      { forSite: 'vercel.com' },
      { signsInWith: [] },
      { signsInWith: [{ provider: 'okta.com', label: '' }] },
    ]) {
      expect(parseMatches({ ...samples.match, cards: [{ ...card('A'), ...extra }] }), JSON.stringify(extra)).not.toBeNull()
    }
    expect(parseRevealed(samples.reveal)).toEqual({ email: 'me@x.com', username: 'me', password: 'password-1' })
    expect(parseCode(samples.totp)).toEqual({ code: '123456', expiresAt: 1700000030000 })
  })

  it('refuses anything else', () => {
    const { forSite: _, ...withoutForSite } = card('A')
    const badCards = [
      { ...card('A'), extra: 1 },
      withoutForSite,
      // `search` cards come only from `search`, and `linked` is a method, not a tier.
      { ...card('A'), tier: 'search' },
      { ...card('A'), tier: 'linked' },
      { ...card('A'), kind: 'note' },
      { ...card('A'), method: 'passkey' },
      { ...card('A'), h: 7 },
      { ...card('A'), username: 3 },
      { ...card('A'), forSite: 1 },
      { ...card('A'), signsInWith: null },
      { ...card('A'), signsInWith: ['google'] },
      { ...card('A'), signsInWith: [{ provider: 'google' }] },
      { ...card('A'), signsInWith: [{ provider: '', label: 'me@gmail.com' }] },
      { ...card('A'), signsInWith: [{ provider: 'google', label: 'me@gmail.com', h: 'H' }] },
    ]
    for (const bad of badCards) expect(parseMatches({ ...samples.match, cards: [bad] }), JSON.stringify(bad)).toBeNull()
    expect(parseMatches({ ...samples.match, extra: true })).toBeNull()
    expect(parseMatches({ ...samples.match, insecure: -1 })).toBeNull()
    const { ssoHints: __, ...withoutHints } = samples.match
    expect(parseMatches(withoutHints)).toBeNull()
    expect(parseMatches({ ...samples.match, ssoHints: [{ provider: 'google' }] })).toBeNull()
    expect(parseMatches({ ...samples.match, ssoHints: null })).toBeNull()
    // Search results: every card tier `search`, and nothing else in the result.
    for (const tier of ['exact', 'subdomain', 'related']) expect(parseSearch({ cards: [found('S', { tier })] }), tier).toBeNull()
    expect(parseSearch({ cards: [found('S')], site: null })).toBeNull()
    expect(parseSearch({ cards: [{ ...found('S'), extra: 1 }] })).toBeNull()
    expect(parseSearch({})).toBeNull()
    expect(parseRevealed({ ...samples.reveal, extra: 1 })).toBeNull()
    expect(parseRevealed({ email: 'a', username: null })).toBeNull()
    expect(parseCode({ code: '12345', expiresAt: 1 })).toBeNull()
    expect(parseCode({ code: '123456', expiresAt: '1' })).toBeNull()
  })
})

describe('popup requests', () => {
  it('takes only known requests, with a handle where one is needed', () => {
    const fill = { type: 'fill', h: 'H', confirmedInsecure: false, confirmedCrossSite: false, origin: 'https://github.com' }
    const code = { type: 'code', h: 'H', confirmedCrossSite: false, origin: 'http://192.168.1.10:8000' }
    for (const good of [
      { type: 'refresh' },
      { type: 'pair' },
      { type: 'cards' },
      fill,
      { ...fill, confirmedCrossSite: true },
      code,
      { type: 'search', q: 'git' },
      { type: 'search', q: 'x'.repeat(200) },
    ]) {
      expect(isPopupRequest(good), JSON.stringify(good)).toBe(true)
    }
    for (const bad of [
      { type: 'fill' },
      { type: 'fill', h: 'H' },
      { type: 'fill', h: 'H', confirmedInsecure: false },
      // Without the page it was about.
      { type: 'fill', h: 'H', confirmedInsecure: false, confirmedCrossSite: true },
      { ...fill, confirmedInsecure: 'yes' },
      { ...fill, confirmedCrossSite: 1 },
      { ...fill, h: '' },
      { ...fill, h: 'x'.repeat(65) },
      { type: 'code', h: 'H' },
      { type: 'code', h: 'H', confirmedCrossSite: false },
      { ...code, origin: 'https://github.com/login' },
      { ...fill, origin: undefined },
      { ...fill, origin: '' },
      { ...fill, origin: 'javascript:alert(1)' },
      { ...fill, origin: 'https://github.com x' },
      { type: 'search' },
      { type: 'search', q: 7 },
      { type: 'search', q: 'x'.repeat(201) },
      { type: 'search', q: 'git', limit: 100 },
      { type: 'reveal', h: 'H' },
      { type: 'cards', h: 'H' },
      ['fill'],
      null,
    ]) {
      expect(isPopupRequest(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})
