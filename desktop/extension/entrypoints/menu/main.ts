// The inline menu: an extension page in an iframe over the page's login field. The page
// can't read or script it. Cards come from the service worker over this page's own port;
// a pick goes back the same way, with what this page knows about its own visibility
// (plans/02, "Clickjacking defences"). Keys come from the content script, which forwards
// only real key presses from the field.

import { MENU_PORT, type MenuCard, type MenuRequest, type MenuUpdate } from '@/lib/inline-messages'

const list = document.getElementById('list') as HTMLUListElement
const more = document.getElementById('more') as HTMLButtonElement
const panel = document.getElementById('panel') as HTMLElement

let cards: MenuCard[] = []
let code = false
let active = -1
let shownAt = 0
/** What IntersectionObserver v2 last said; null where the browser doesn't support it. */
let visible: boolean | null = null

const port = browser.runtime.connect({ name: `${MENU_PORT}:${location.hash.slice(1)}` })
const send = (request: MenuRequest): void => port.postMessage(request)

// A click in the menu must not take focus from the page's field.
document.addEventListener('mousedown', (event) => event.preventDefault(), true)
// The frame's empty part (the menu is always 8 rows tall): a click there closes it.
document.addEventListener('click', (event) => {
  if (!panel.contains(event.target as Node)) send({ type: 'escape' })
})

const observer = new IntersectionObserver(
  (entries) => {
    const last = entries.at(-1) as (IntersectionObserverEntry & { isVisible?: boolean }) | undefined
    visible = typeof last?.isVisible === 'boolean' ? last.isVisible : null
  },
  { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
)
observer.observe(panel)

function row(card: MenuCard, index: number): HTMLLIElement {
  const item = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row'
  button.setAttribute('role', 'option')
  button.setAttribute('aria-selected', String(index === active))
  const tile = document.createElement('span')
  tile.className = 'tile'
  tile.textContent = (card.where.replace(/^Saved for /, '') || card.name).trim().charAt(0) || '?'
  const text = document.createElement('span')
  text.className = 'text'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = code ? `Fill code · ${card.name}` : card.name
  const where = document.createElement('span')
  where.className = 'where'
  where.textContent = card.where
  text.append(name, where)
  button.append(tile, text)
  button.addEventListener('click', (event) => pick(card, event.isTrusted))
  item.append(button)
  return item
}

function render(): void {
  list.replaceChildren(...cards.map(row))
}

function message(text: string, bad = false): void {
  const item = document.createElement('li')
  item.className = bad ? 'message bad' : 'message'
  item.textContent = text
  list.replaceChildren(item)
}

function pick(card: MenuCard, trusted: boolean): void {
  send({ type: 'pick', h: card.h, code, trusted, shownMs: performance.now() - shownAt, visible })
}

port.onMessage.addListener((update: MenuUpdate) => {
  switch (update.type) {
    case 'show':
      shownAt = performance.now()
      active = -1
      document.body.classList.toggle('above', update.above)
      if (update.state === 'locked') {
        cards = []
        message('VaultKey is locked.')
        const open = document.createElement('button')
        open.className = 'button'
        open.type = 'button'
        open.textContent = 'Open VaultKey'
        open.addEventListener('click', () => send({ type: 'open-app' }))
        list.after(open)
        return
      }
      document.querySelector('.button')?.remove()
      if (update.state === 'empty') {
        cards = []
        message(`No logins for ${update.site} in VaultKey.`)
        return
      }
      cards = update.cards
      code = update.kind === 'code'
      render()
      return
    case 'key':
      if (update.key === 'Enter') {
        // Forwarded only for a real key press in the field (content script).
        const card = cards[active]
        if (card) pick(card, true)
        return
      }
      if (cards.length === 0) return
      active = update.key === 'ArrowDown' ? (active + 1) % cards.length : (active - 1 + cards.length) % cards.length
      render()
      return
    case 'result':
      if (!update.ok) message(update.message, true)
  }
})

more.addEventListener('click', () => send({ type: 'more' }))
