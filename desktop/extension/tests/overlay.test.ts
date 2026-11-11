// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fieldKind } from '../lib/classify'
import { MENU_HEIGHT, Overlay } from '../lib/overlay'

// happy-dom doesn't lay pages out: an element is a 300×40 box at (10, 10), or wherever its
// inline style puts it (our hosts).
beforeEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
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

async function opened() {
  document.body.innerHTML = '<form><input id="user" name="username"><input id="pw" type="password"></form>'
  const field = document.getElementById('pw') as HTMLInputElement
  const overlay = new Overlay(() => {})
  await overlay.ensureMenu(async () => 'chrome-extension://abc/menu.html#token')
  overlay.showMenu(field, 3, false)
  const host = [...document.documentElement.children].find((node) => node.tagName === 'DIV' && overlay.owns(node)) as HTMLElement
  return { overlay, host, field }
}

describe('Overlay.verify', () => {
  it('trusts a menu that is open, on top and unfaded, and says how long it has stayed put', async () => {
    const { overlay, host } = await opened()
    document.elementFromPoint = () => host
    expect(overlay.verify()).toMatchObject({ visible: true })
    expect(overlay.verify().stableMs).toBeGreaterThanOrEqual(0)
  })

  it('restarts the clock when the menu moves (a quick swap under the cursor)', async () => {
    const { overlay, host, field } = await opened()
    document.elementFromPoint = () => host
    await new Promise((resolve) => setTimeout(resolve, 30))
    const before = overlay.verify().stableMs
    expect(before).toBeGreaterThanOrEqual(25)
    // The page moves its field; a resize makes the menu follow.
    field.style.setProperty('left', '400px')
    dispatchEvent(new Event('resize'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(overlay.verify().stableMs).toBeLessThan(before)
  })

  it('closes when the page touches the menu’s host', async () => {
    const { overlay, host } = await opened()
    document.elementFromPoint = () => host
    host.style.setProperty('top', '0px', 'important')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(overlay.isMenuOpen).toBe(false)
    expect(overlay.verify().visible).toBe(false)
    expect(host.isConnected).toBe(false)
  })

  it('ignores custom properties other extensions add (dark-mode ones do), not real ones', async () => {
    const { overlay, host } = await opened()
    document.elementFromPoint = () => host
    host.style.setProperty('--darkreader-inline-bgcolor', '#000')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(overlay.isMenuOpen).toBe(true)
    expect(overlay.verify().visible).toBe(true)
    host.style.setProperty('rotate', '1deg')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(overlay.isMenuOpen).toBe(false)
  })

  it('keeps the same height whatever it shows: the page can’t count accounts', async () => {
    const { host } = await opened()
    expect(host.style.getPropertyValue('height')).toBe(`${MENU_HEIGHT}px`)
  })

  it('refuses a closed menu, a covered one, and a faded page', async () => {
    const { overlay, host } = await opened()
    // Something laid over the menu.
    document.elementFromPoint = () => document.body
    expect(overlay.verify().visible).toBe(false)
    document.elementFromPoint = () => host
    // The page fades everything.
    document.body.style.opacity = '0.1'
    expect(overlay.verify().visible).toBe(false)
    document.body.style.opacity = ''
    expect(overlay.verify().visible).toBe(true)
    overlay.hideMenu()
    expect(overlay.verify().visible).toBe(false)
  })

  it('draws nothing until asked, and only on <html>', async () => {
    const overlay = new Overlay(() => {})
    expect(document.documentElement.querySelectorAll(':scope > div')).toHaveLength(0)
    expect(overlay.verify().visible).toBe(false)
    const { host } = await opened()
    expect(host.parentElement).toBe(document.documentElement)
    expect(host.getAttribute('popover')).toBe('manual')
  })
})

describe('fieldKind', () => {
  it('tells login fields from everything else', () => {
    document.body.innerHTML = `
      <input id="user" name="username">
      <input id="email" type="email">
      <input id="pw" type="password">
      <input id="new" type="password" autocomplete="new-password">
      <input id="otp" autocomplete="one-time-code">
      <input id="q" type="search" name="q">
      <input id="city" name="city">`
    const kind = (id: string) => fieldKind(document.getElementById(id) as HTMLInputElement)
    expect(['user', 'email', 'pw', 'new', 'otp', 'q', 'city'].map(kind)).toEqual(['username', 'username', 'password', null, 'code', null, null])
  })
})
