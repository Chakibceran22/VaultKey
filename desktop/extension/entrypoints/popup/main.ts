import type { CardsResult, SearchResult } from '@/lib/actions'
import type { Card } from '@/lib/inner'
import { cardName, cardWhere, savedFor } from '@/lib/labels'
import type { LinkState } from '@/lib/link'
import { POPUP_PORT, type PopupRequest, type PopupUpdate } from '@/lib/popup-messages'

type Tone = 'muted' | 'good' | 'warn' | 'bad'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`#${id} is missing from popup/index.html`)
  return found as T
}

const badge = element('badge')
const rows = ['bridge', 'app', 'vault', 'browser'].map((id) => element(id))
const pair = element('pair')
const pairText = element('pair-text')
const code = element('code')
const connect = element<HTMLButtonElement>('connect')
const openApp = element<HTMLButtonElement>('open-app')
const hint = element('hint')
const check = element<HTMLButtonElement>('check')
const logins = element('logins')
const site = element('site')
const cardList = element<HTMLUListElement>('cards')
const loginsNote = element('logins-note')
const searchBox = element<HTMLInputElement>('search')
const otherList = element<HTMLUListElement>('others')

/** Developer instructions only in the dev build; the release popup speaks to users. */
const DEV = import.meta.env.MODE === 'development'

function formatMs(ms: number): string {
  if (ms < 0.1) return '< 0.1 ms'
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

interface View {
  tone: Tone
  label: string
  rows: [string, string, string, string]
  help?: string
  /** The pairing panel: its text, the code, and whether Connect shows (and works). */
  pairing?: { text: string; code?: string; connect?: 'enabled' | 'disabled'; open?: boolean }
}

const RUNNING: [string, string] = ['Installed', 'Running']

function view(state: LinkState): View {
  switch (state.kind) {
    case 'checking':
      return { tone: 'muted', label: 'Checking…', rows: ['…', '…', '…', '…'] }
    case 'no_bridge':
      return {
        tone: 'bad',
        label: 'Bridge not found',
        rows: [state.detail || 'Not reachable', '—', '—', '—'],
        help: DEV
          ? 'Build and register the dev bridge (desktop/extension/README.md), then reload the extension.'
          : 'Install or update VaultKey, then turn on Browser extension in it.',
      }
    case 'bridge_not_answering':
      return { tone: 'bad', label: 'Bridge not answering', rows: ['Not answering', '—', '—', '—'], help: 'Check again to restart it.' }
    case 'app_not_running':
      return {
        tone: 'warn',
        label: 'VaultKey isn’t open',
        rows: ['Installed', 'Not running', '—', '—'],
        help: DEV
          ? 'Open VaultKey (pnpm tauri dev, in desktop/) and turn on Browser extension in it: Settings (the gear button) → Browser extension.'
          : 'Open VaultKey, and check that Browser extension is on in it: Settings (the gear button) → Browser extension.',
      }
    case 'app_not_answering':
      return {
        tone: 'warn',
        label: 'VaultKey is busy',
        rows: ['Installed', 'Not answering', '—', '—'],
        help: 'VaultKey is open but did not answer in time. Check again in a moment.',
      }
    case 'disabled':
      return {
        tone: 'warn',
        label: 'Turned off in VaultKey',
        rows: [...RUNNING, '—', '—'],
        help: 'In VaultKey, open Settings (the gear button) → Browser extension, and turn it on.',
      }
    case 'not_paired':
      return {
        tone: 'warn',
        label: 'Not connected',
        rows: [...RUNNING, state.vault === 'unlocked' ? 'Unlocked' : 'Locked', 'Not paired'],
        help: state.notice ?? undefined,
        pairing:
          state.vault === 'unlocked'
            ? { text: 'Connect this browser to VaultKey. You’ll confirm a code in the app.', connect: 'enabled' }
            : { text: 'Unlock VaultKey, then connect this browser to it.', connect: 'disabled' },
      }
    case 'pairing':
      return {
        tone: 'muted',
        label: 'Waiting for VaultKey',
        rows: [...RUNNING, 'Unlocked', 'Waiting for approval'],
        pairing: state.code
          ? {
              text: 'In VaultKey, check that it shows this same code, then click Connect browser.',
              code: `${state.code.slice(0, 3)} ${state.code.slice(3)}`,
            }
          : { text: 'Asking VaultKey…' },
      }
    case 'locked':
      return {
        tone: 'warn',
        label: 'Locked',
        rows: [...RUNNING, 'Locked', 'Paired'],
        pairing: { text: 'Unlock VaultKey to fill your logins here.', open: true },
      }
    case 'connecting':
      return { tone: 'muted', label: 'Connecting…', rows: [...RUNNING, 'Unlocked', 'Connecting…'] }
    case 'ready':
      return {
        tone: 'good',
        label: 'Connected',
        rows: [...RUNNING, 'Unlocked', state.rttMs === null ? 'Encrypted' : `Encrypted · ${formatMs(state.rttMs)}`],
      }
    case 'update':
      return {
        tone: 'bad',
        label: 'Update needed',
        rows: [...RUNNING, '—', '—'],
        help:
          state.need === 'update_app'
            ? 'This extension is newer than VaultKey. Update VaultKey, then check again.'
            : 'VaultKey is newer than this extension. Update the extension, then check again.',
      }
    case 'failed':
      return { tone: 'bad', label: 'Something went wrong', rows: [...RUNNING, '—', '—'], help: state.message }
  }
}

function render(state: LinkState): void {
  const shown = view(state)
  badge.dataset.tone = shown.tone
  badge.textContent = shown.label
  shown.rows.forEach((text, i) => {
    const row = rows[i]
    if (row) row.textContent = text
  })
  hint.textContent = shown.help ?? ''
  hint.hidden = !shown.help
  pair.hidden = !shown.pairing
  pairText.textContent = shown.pairing?.text ?? ''
  code.textContent = shown.pairing?.code ?? ''
  code.hidden = !shown.pairing?.code
  connect.hidden = !shown.pairing?.connect
  connect.disabled = shown.pairing?.connect !== 'enabled'
  openApp.hidden = !shown.pairing?.open
  check.disabled = state.kind === 'checking'
  // Connected: this page's logins replace the status rows.
  const ready = state.kind === 'ready'
  logins.hidden = !ready
  document.querySelector<HTMLElement>('.rows')!.hidden = ready
  if (ready && !askedForCards) {
    askedForCards = true
    site.textContent = 'Looking for logins…'
    ask({ type: 'cards' })
  }
  if (!ready) {
    askedForCards = false
    searchBox.value = ''
    otherList.replaceChildren()
  }
}

let askedForCards = false

function note(text: string): void {
  loginsNote.textContent = text
  loginsNote.hidden = !text
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const made = document.createElement('button')
  made.type = 'button'
  made.className = primary ? 'button small' : 'button secondary small'
  made.textContent = label
  made.addEventListener('click', onClick)
  return made
}

function setBusy(busy: boolean): void {
  for (const each of document.querySelectorAll<HTMLButtonElement>('#cards button, #others button')) each.disabled = busy
}

/** The page is http: a fill needs a second, deliberate click. */
let insecurePage = false
/** This page's site, as the browser reports it: "Fill gitlab.com's login on example.org?";
 * and its origin, sent back with each fill: nothing is filled if the tab has moved on. */
let pageSite = ''
let pageOrigin = ''

const INSECURE = 'This page isn’t secure (http): anyone on this network can read what’s sent.'

/**
 * A button that may need a second, deliberate click (`why` says why; null: one click does).
 * The second isn't clickable at once, so a double-click can't confirm it.
 */
function guarded(label: string, again: string, why: string | null, act: () => void, primary = false): HTMLButtonElement {
  let armed = why === null
  const made = button(
    label,
    () => {
      if (!armed && why) {
        armed = true
        made.textContent = again
        made.disabled = true
        setTimeout(() => (made.disabled = false), 600)
        note(why)
        return
      }
      setBusy(true)
      note('')
      act()
    },
    primary,
  )
  return made
}

function cardRow(card: Card): HTMLLIElement {
  const row = document.createElement('li')
  row.className = 'card'
  const text = document.createElement('div')
  text.className = 'card-text'
  const name = document.createElement('p')
  name.className = 'card-name'
  name.textContent = cardName(card)
  const where = document.createElement('p')
  where.className = 'card-where'
  where.textContent = cardWhere(card)
  text.append(name, where)
  row.append(text)
  // A search result is for another site: using it here takes a confirmation, which is what
  // VaultKey asks for (`confirmedCrossSite`).
  const other = card.tier === 'search'
  const site = savedFor(card)
  // The page this row's question names: the answer holds for it only.
  const origin = pageOrigin
  if (card.hasTotp) {
    row.append(
      guarded('Copy code', 'Copy anyway', other ? `Use ${site}’s code on ${pageSite}?` : null, () =>
        ask({ type: 'code', h: card.h, confirmedCrossSite: other, origin }),
      ),
    )
  }
  // `linked`: it signs in with another account (its second line says which): nothing to fill.
  if (card.method === 'password') {
    const why = [other ? `Fill ${site}’s login on ${pageSite}?` : '', insecurePage ? `${INSECURE} Click Fill anyway only if you trust it.` : '']
      .filter(Boolean)
      .join(' ')
    row.append(
      guarded('Fill', 'Fill anyway', why || null, () => ask({ type: 'fill', h: card.h, confirmedInsecure: insecurePage, confirmedCrossSite: other, origin }), true),
    )
  }
  return row
}

/** Something the list says instead of rows ("Nothing matches…"). */
function listNote(text: string): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'card card-where'
  item.textContent = text
  return item
}

/** This page's own logins, to leave out of the search results (they're already listed). */
let pageCards: Card[] = []
const sameLogin = (a: Card, b: Card) =>
  a.kind === b.kind && a.title === b.title && a.host === b.host && a.email === b.email && a.username === b.username

function showSearch(result: SearchResult): void {
  // An answer to an older query (the person kept typing): the newer one is on its way.
  if (result.kind === 'found' && result.q !== searchBox.value.trim()) return
  otherList.replaceChildren()
  switch (result.kind) {
    case 'no_site':
      otherList.append(listNote('Open a website to fill a login from here.'))
      return
    case 'error':
      otherList.append(listNote(result.message))
      return
    case 'found': {
      if (!result.q) return
      pageSite = result.site
      pageOrigin = result.origin
      const cards = result.cards.filter((card) => !pageCards.some((mine) => sameLogin(card, mine)))
      otherList.append(...(cards.length ? cards.map(cardRow) : [listNote(`No other logins match “${result.q}”.`)]))
    }
  }
}

// Asks once the person stops typing for a moment; VaultKey allows 60 searches a minute.
let searchTimer = 0
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer)
  const q = searchBox.value.trim()
  if (!q) {
    otherList.replaceChildren()
    return
  }
  searchTimer = window.setTimeout(() => ask({ type: 'search', q }), 250)
})

function showCards(result: CardsResult): void {
  cardList.replaceChildren()
  note('')
  switch (result.kind) {
    case 'no_site':
      site.textContent = 'This page isn’t a website VaultKey can fill.'
      return
    case 'error':
      site.textContent = ''
      note(result.message)
      return
    case 'cards':
      insecurePage = !result.secure
      pageSite = result.site
      pageOrigin = result.origin
      pageCards = result.cards
      site.textContent = result.cards.length
        ? `Logins for ${result.site}`
        : `No logins for ${result.site} in VaultKey.`
      cardList.append(...result.cards.map(cardRow))
      if (result.insecure > 0) {
        note(
          `${result.insecure === 1 ? 'A login' : `${result.insecure} logins`} saved for the secure (https) version of this site ${result.insecure === 1 ? 'isn’t' : 'aren’t'} offered here: this page isn’t secure.`,
        )
      }
  }
}

const port = browser.runtime.connect({ name: POPUP_PORT })
port.onMessage.addListener((message: PopupUpdate) => {
  switch (message?.type) {
    case 'state':
      render(message.state)
      return
    case 'cards':
      showCards(message.result)
      return
    case 'search':
      showSearch(message.result)
      return
    case 'filled':
      setBusy(false)
      // Filled: out of the way, focus back on the page.
      if (message.outcome.ok) window.close()
      else note(message.outcome.message)
      return
    case 'code':
      setBusy(false)
      if (!message.result.ok) {
        note(message.result.message)
        return
      }
      {
        const { code, expiresAt } = message.result
        const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
        void navigator.clipboard.writeText(code).then(
          () => note(`Code ${code.slice(0, 3)} ${code.slice(3)} copied. It changes in ${seconds} s.`),
          () => note(`Code: ${code.slice(0, 3)} ${code.slice(3)} (couldn’t copy it). It changes in ${seconds} s.`),
        )
      }
  }
})
port.onDisconnect.addListener(() => {
  render({ kind: 'failed', message: 'The extension stopped answering. Close and reopen this popup.' })
})

const ask = (request: PopupRequest): void => port.postMessage(request)
check.addEventListener('click', () => ask({ type: 'refresh' }))
openApp.addEventListener('click', () => ask({ type: 'show-app' }))
connect.addEventListener('click', () => {
  connect.disabled = true
  ask({ type: 'pair' })
})
