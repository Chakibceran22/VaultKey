// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { findTarget } from '../lib/classify'
import { fillField } from '../lib/fill'

// happy-dom doesn't lay pages out: a field is "on screen" unless the fixture marks it
// otherwise (data-size="0": collapsed to nothing, like a hidden-field trap).
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const size = this.closest('[data-size="0"]') || this.closest('[hidden]') ? 0 : 1
    // data-offscreen: pushed far off to the left, as hidden-field traps do.
    const shift = this.closest('[data-offscreen]') ? -10_000 : 0
    return { x: shift, y: 0, top: 0, left: shift, bottom: 20 * size, right: shift + 200 * size, width: 200 * size, height: 20 * size, toJSON() {} } as DOMRect
  }
})

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

const id = (target: HTMLInputElement | null | undefined) => target?.id ?? null

describe('findTarget', () => {
  it('finds the username and password of a plain login form', () => {
    const doc = page(`
      <form><input type="search" id="q" placeholder="Search"></form>
      <form action="/session">
        <input type="text" id="login" name="login" autocomplete="username">
        <input type="password" id="pw" name="password" autocomplete="current-password">
        <button>Sign in</button>
      </form>`)
    const target = findTarget(doc, null)!
    expect([id(target.username), id(target.password), target.wantsEmail]).toEqual(['login', 'pw', false])
  })

  it('works without a <form>, and in French', () => {
    const doc = page(`
      <div class="login">
        <label for="mail">Adresse courriel</label><input id="mail" type="text">
        <label for="mdp">Mot de passe</label><input id="mdp" type="password">
      </div>`)
    const target = findTarget(doc, null)!
    expect([id(target.username), id(target.password), target.wantsEmail]).toEqual(['mail', 'mdp', true])
  })

  it('fills the email step of a two-step login (Google, Microsoft)', () => {
    const doc = page(`<form><input type="email" id="identifier" name="identifier"><button>Next</button></form>`)
    const target = findTarget(doc, null)!
    expect([id(target.username), id(target.password), target.wantsEmail]).toEqual(['identifier', null, true])
  })

  it('prefers the form the user clicked into', () => {
    const doc = page(`
      <form id="a"><input id="u1" name="user"><input id="p1" type="password"></form>
      <form id="b"><input id="u2" name="user"><input id="p2" type="password"></form>`)
    const focused = doc.getElementById('p2') as HTMLInputElement
    const target = findTarget(doc, focused)!
    expect([id(target.username), id(target.password)]).toEqual(['u2', 'p2'])
  })

  it('offers no password on a sign-up or change-password form', () => {
    const doc = page(`
      <form>
        <input id="email" type="email">
        <input id="new1" type="password" autocomplete="new-password">
        <input id="new2" type="password" autocomplete="new-password">
      </form>`)
    expect(id(findTarget(doc, null)?.password)).toBeNull()
  })

  it('takes the current password on a change-password form', () => {
    const doc = page(`
      <form>
        <input id="current" type="password" autocomplete="current-password">
        <input id="next" type="password" autocomplete="new-password">
      </form>`)
    expect(id(findTarget(doc, null)?.password)).toBe('current')
  })

  it('never fills hidden, disabled or read-only fields', () => {
    const doc = page(`
      <form>
        <div data-size="0"><input id="trap-user" name="username"><input id="trap-pw" type="password"></div>
        <input id="disabled" name="username" disabled>
        <input id="readonly" name="username" readonly>
        <input id="user" name="username">
        <input id="hidden" type="hidden" name="password">
        <input id="pw" type="password">
      </form>`)
    const target = findTarget(doc, null)!
    expect([id(target.username), id(target.password)]).toEqual(['user', 'pw'])
  })

  it('treats two unmarked password fields as sign-up: no password', () => {
    const doc = page(`
      <form>
        <input id="user" name="username">
        <input id="pw" type="password" name="password">
        <input id="again" type="password" name="confirm">
      </form>`)
    const target = findTarget(doc, null)
    expect([id(target?.username), id(target?.password)]).toEqual(['user', null])
  })

  it('prefers a login form to a sign-up form earlier on the page', () => {
    const doc = page(`
      <form id="signup"><input name="email" type="email"><input type="password"><input type="password"></form>
      <form id="login"><input id="u" name="email" type="email"><input id="p" type="password"></form>`)
    expect([id(findTarget(doc, null)?.username), id(findTarget(doc, null)?.password)]).toEqual(['u', 'p'])
  })

  it('falls back to the login form when the focused field isn’t part of one', () => {
    const doc = page(`
      <form role="search"><input id="q" type="search" name="q"></form>
      <form><input id="u" name="username"><input id="p" type="password"></form>`)
    const target = findTarget(doc, doc.getElementById('q') as HTMLInputElement)
    expect([id(target?.username), id(target?.password)]).toEqual(['u', 'p'])
  })

  it('doesn’t let a focused newsletter box beat the login form', () => {
    const doc = page(`
      <form id="news"><input id="news-email" type="email" name="email" placeholder="Your email"></form>
      <form><input id="u" name="username"><input id="p" type="password"></form>`)
    const target = findTarget(doc, doc.getElementById('news-email') as HTMLInputElement)
    expect([id(target?.username), id(target?.password)]).toEqual(['u', 'p'])
    // For a code, the focused code field wins.
    const codes = page(`
      <form><input id="u" name="username"><input id="p" type="password"></form>
      <div><input id="otp" autocomplete="one-time-code"></div>`)
    expect(id(findTarget(codes, codes.getElementById('otp') as HTMLInputElement, 'code')?.code)).toBe('otp')
  })

  it('never fills fields pushed off the page or nearly transparent', () => {
    const doc = page(`
      <form>
        <div data-offscreen><input id="trap-user" name="username"><input id="trap-pw" type="password"></div>
        <div style="opacity: 0.05"><input id="faint" name="username"></div>
        <input id="user" name="username">
        <input id="pw" type="password">
      </form>`)
    const target = findTarget(doc, null)!
    expect([id(target.username), id(target.password)]).toEqual(['user', 'pw'])
    // The faint field alone: not taken as the username.
    const faint = page(`<form><div style="opacity: 0.05"><input id="faint" name="username"></div><input id="pw" type="password"></form>`)
    expect([id(findTarget(faint, null)?.username), id(findTarget(faint, null)?.password)]).toEqual([null, 'pw'])
  })

  it('skips search boxes, coupons and postal codes before the password', () => {
    const doc = page(`
      <div>
        <input id="user" name="email" type="email">
        <input id="coupon" name="coupon" placeholder="Promo code">
        <input id="pw" type="password">
      </div>`)
    expect(id(findTarget(doc, null)?.username)).toBe('user')
  })

  it('finds a one-time code field', () => {
    const doc = page(`<form><input id="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></form>`)
    expect(id(findTarget(doc, null)?.code)).toBe('otp')
    const focusedDoc = page(`<form><label for="c">Code de vérification</label><input id="c"></form>`)
    expect(id(findTarget(focusedDoc, focusedDoc.getElementById('c') as HTMLInputElement)?.code)).toBe('c')
  })

  it('finds nothing on a page without a login field', () => {
    expect(findTarget(page(`<form><input type="search" name="q"><textarea></textarea></form>`), null)).toBeNull()
    expect(findTarget(page(`<p>Just reading</p>`), null)).toBeNull()
  })

  it('ignores a focused field that has gone from the page', () => {
    const doc = page(`<form><input id="u" name="user"><input id="p" type="password"></form>`)
    const gone = document.createElement('input')
    expect(id(findTarget(doc, gone)?.password)).toBe('p')
  })
})

describe('fillField', () => {
  it('sets the value and tells the page, as a replacement', async () => {
    const doc = page(`<input id="f">`)
    const field = doc.getElementById('f') as HTMLInputElement
    const seen: string[] = []
    field.addEventListener('input', (event) => seen.push(`input:${(event as InputEvent).inputType}`))
    field.addEventListener('change', () => seen.push('change'))
    expect(await fillField(field, 'me@example.com')).toBe(true)
    expect(field.value).toBe('me@example.com')
    expect(seen).toEqual(['input:insertReplacementText', 'change'])
  })

  it('types the value in when the page puts the old one back', async () => {
    const doc = page(`<input id="f">`)
    const field = doc.getElementById('f') as HTMLInputElement
    // A controlled input that only accepts typed characters.
    field.addEventListener('input', (event) => {
      if ((event as InputEvent).inputType === 'insertReplacementText') queueMicrotask(() => (field.value = ''))
    })
    expect(await fillField(field, 'hunter2')).toBe(true)
    expect(field.value).toBe('hunter2')
  })
})
