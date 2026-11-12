// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { BADGE_STYLE, Overlay } from '../lib/overlay'
import { signInButtons } from '../lib/sso'

// happy-dom doesn't lay pages out: an element is a 300×40 box at (10, 10), or wherever its
// inline style puts it (our hosts).
beforeEach(() => {
  // Iframes here (Google's sign-in one, the menu) load nothing: tests never touch the network.
  ;(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true
  document.body.innerHTML = ''
  for (const node of [...document.documentElement.children]) if (node !== document.head && node !== document.body) node.remove()
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const left = Number.parseFloat(this.style.getPropertyValue('left')) || 10
    const top = Number.parseFloat(this.style.getPropertyValue('top')) || 10
    const width = Number.parseFloat(this.style.getPropertyValue('width')) || 300
    const height = Number.parseFloat(this.style.getPropertyValue('height')) || 40
    return { x: left, y: top, top, left, bottom: top + height, right: left + width, width, height, toJSON() {} } as DOMRect
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

/** Which element each provider's badge goes by, as `provider:id` (the badge's text is the
 * provider's id here). */
const found = (providers: string[]) =>
  signInButtons(document, new Map(providers.map((provider) => [provider, provider]))).map(([element, text]) => `${text}:${element.id}`)
/** Is there a sign-in button at all (before asking VaultKey)? */
const hasSignIn = () => signInButtons(document, null).length > 0

describe('signInButtons', () => {
  it('finds “Continue with …” buttons by what they say, in English and French', () => {
    page(`
      <button id="g">Continue with Google</button>
      <a id="a" href="#" role="button">Se connecter avec Apple</a>
      <div id="m" role="button"><span>Continuer avec</span><span>Microsoft</span></div>
      <button id="x" aria-label="Sign in with X"><svg></svg></button>
      <input id="f" type="submit" value="Log in with Facebook">`)
    expect(found(['google', 'apple', 'microsoft', 'x', 'facebook'])).toEqual(['google:g', 'apple:a', 'microsoft:m', 'x:x', 'facebook:f'])
  })

  it('finds them by where they send you: a provider’s OAuth address or the site’s own route', () => {
    page(`
      <a id="gh" href="https://github.com/login/oauth/authorize?client_id=abc"><img alt=""></a>
      <form id="form" action="https://appleid.apple.com/auth/authorize"><button id="ap">Apple</button></form>
      <a id="gl" href="/users/auth/gitlab?origin=login">GitLab</a>
      <a id="ms" href="https://login.microsoftonline.com/common/oauth2/v2.0/authorize">Work account</a>
      <a id="sso" href="https://acme.okta.com/oauth2/v1/authorize">Company login</a>`)
    // A form that posts to the provider: the badge goes by its button.
    expect(found(['github', 'apple', 'gitlab', 'microsoft', 'okta.com'])).toEqual([
      'github:gh',
      'apple:ap',
      'gitlab:gl',
      'microsoft:ms',
      'okta.com:sso',
    ])
  })

  it('finds Google’s sign-in iframe', () => {
    page(`<div><iframe id="gsi" src="https://accounts.google.com/gsi/button?theme=outline&client_id=x"></iframe></div>`)
    expect(found(['google'])).toEqual(['google:gsi'])
    expect(hasSignIn()).toBe(true)
  })

  it('leaves ordinary links and buttons alone', () => {
    page(`
      <footer>
        <a id="a" href="https://github.com/acme">GitHub</a>
        <a id="b" href="https://www.google.com/maps/place/acme">Find us on Google Maps</a>
        <a id="c" href="/blog/google-and-apple">Our news</a>
        <button id="e">Sign in</button>
      </footer>`)
    expect(hasSignIn()).toBe(false)
    expect(found(['github', 'google', 'apple', 'x'])).toEqual([])
    // Worth asking VaultKey about (it's a sign-in page), but no provider's button.
    document.body.insertAdjacentHTML('beforeend', '<button id="d">Continue with your email</button>')
    expect(found(['github', 'google', 'apple', 'x'])).toEqual([])
  })

  it('gives only the providers asked for, one button each', () => {
    page(`
      <button id="g1">Continue with Google</button>
      <button id="g2">Sign up with Google</button>
      <button id="gh">Continue with GitHub</button>`)
    expect(found(['google'])).toEqual(['google:g1'])
    expect(found([])).toEqual([])
    // Nothing usable in a provider id: nothing matched (not "everything").
    expect(found(['.'])).toEqual([])
    expect(hasSignIn()).toBe(true)
  })
})

describe('Overlay badges', () => {
  const EMAIL = 'me@gmail.com'

  function badgeHosts(overlay: Overlay): HTMLElement[] {
    return [...document.documentElement.children].filter((node): node is HTMLElement => node.tagName === 'DIV' && overlay.owns(node) === false && node.getAttribute('popover') === 'manual')
  }

  it('draws a display-only badge on <html>, where the page can’t read the account', () => {
    page('<button id="g">Continue with Google</button>')
    const overlay = new Overlay(() => {})
    const button = document.getElementById('g')!
    overlay.showBadges([[button, `You use Google here — ${EMAIL}`]])
    const [host] = badgeHosts(overlay)
    expect(host?.parentElement).toBe(document.documentElement)
    expect(host?.style.getPropertyValue('pointer-events')).toBe('none')
    expect(host?.style.getPropertyValue('display')).toBe('block')
    // A fixed size whatever it says, and its words aren't in the page's DOM.
    expect(host?.style.getPropertyValue('width')).toBe('300px')
    expect(document.documentElement.outerHTML).not.toContain(EMAIL)
    // The same badges again: nothing redrawn.
    overlay.showBadges([[button, `You use Google here — ${EMAIL}`]])
    expect(badgeHosts(overlay)).toEqual([host])
    overlay.showBadges([])
    expect(badgeHosts(overlay)).toEqual([])
  })

  it('takes no clicks and no hit tests, inside as well: the page can’t measure the pill', () => {
    // The badge's shadow root is closed: catch it as it's made.
    const roots: ShadowRoot[] = []
    const attach = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = attach.call(this, init)
      roots.push(root)
      return root
    }
    try {
      page('<button id="g">Continue with Google</button>')
      new Overlay(() => {}).showBadges([[document.getElementById('g')!, 'You use Google here']])
    } finally {
      Element.prototype.attachShadow = attach
    }
    const root = roots.at(-1)!
    expect(root.querySelector('style')?.textContent).toBe(BADGE_STYLE)
    // One rule sets pointer-events, for every element (`*`), first and !important: it beats
    // the pill's `all:initial` (which would put it back to `auto`). happy-dom computes
    // neither `all` nor this inheritance, so the rule itself is what's checked.
    expect(BADGE_STYLE.startsWith('*{pointer-events:none!important}')).toBe(true)
    expect(BADGE_STYLE.match(/pointer-events/g)).toHaveLength(1)
    const drawn = [...root.querySelectorAll('b, b *')]
    expect(drawn.map((element) => element.tagName.toLowerCase())).toEqual(['b', 'svg', 'rect', 'circle', 'path', 'path'])
    // No inline style in the tree undoes it.
    for (const element of drawn) expect(element.getAttribute('style') ?? '').not.toContain('pointer-events')
  })

  it('stays out of the way of the menu, and goes for good when the page touches it', async () => {
    page('<button id="g">Continue with Google</button><form><input id="pw" type="password"></form>')
    const overlay = new Overlay(() => {})
    overlay.showBadges([[document.getElementById('g')!, 'You use Google here']])
    const [host] = badgeHosts(overlay)
    await overlay.ensureMenu(async () => 'chrome-extension://abc/menu.html#token')
    overlay.showMenu(document.getElementById('pw') as HTMLInputElement, 2, false)
    expect(host?.style.getPropertyValue('display')).toBe('none')
    overlay.hideMenu()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(host?.style.getPropertyValue('display')).toBe('block')
    host?.style.setProperty('left', '0px', 'important')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host?.isConnected).toBe(false)
    overlay.showBadges([[document.getElementById('g')!, 'You use Google here']])
    expect(badgeHosts(overlay)).toEqual([])
  })
})
