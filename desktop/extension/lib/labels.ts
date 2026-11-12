// What a card says, the same in the popup and the inline menu (plans/04, "Match tiers",
// "Signs in with"). No DOM: the service worker uses it to build the menu's rows.

import type { Card, SignIn } from './inner'

const PROVIDERS: Record<string, string> = {
  google: 'Google',
  apple: 'Apple',
  microsoft: 'Microsoft',
  github: 'GitHub',
  facebook: 'Facebook',
  x: 'X',
  linkedin: 'LinkedIn',
  gitlab: 'GitLab',
  slack: 'Slack',
  discord: 'Discord',
  amazon: 'Amazon',
}

/** "Google" for `google`; a provider VaultKey has no name for is its domain ("okta.com"). */
export function providerName(provider: string): string {
  return PROVIDERS[provider] ?? provider
}

/** The site a card was saved for: its address, or the name it was saved under ("GitHub"). */
export function savedFor(card: Pick<Card, 'host' | 'title'>): string {
  return card.host || card.title
}

/** The row's first line: who you sign in as. Some accounts have neither a username nor an
 * email (a passkey-only one): the site, then. */
export function cardName(card: Card): string {
  return card.username || card.email || card.title
}

/** "Signs in with Google · you@gmail.com" (every account it signs in with). */
export function signsInText(card: Card): string {
  const each = card.signsInWith.map((link) => (link.label ? `${providerName(link.provider)} · ${link.label}` : providerName(link.provider)))
  return each.length ? `Signs in with ${each.join(', ')}` : 'Signs in with another account'
}

/** The row's second line: where the login is from, or how it signs in. */
export function cardWhere(card: Card): string {
  if (card.method === 'linked') return signsInText(card)
  if (card.forSite) return `You use this one for ${card.forSite}`
  const site = savedFor(card)
  const saved =
    card.tier === 'exact' ? '' : card.tier === 'related' ? `Saved for ${site} (shared login)` : `Saved for ${site}`
  // A service's own login: the service's name says what it is.
  if (card.kind === 'service_login') return saved ? `${card.title} · ${saved}` : card.title
  return saved || (card.username ? card.email : site)
}

/** The letter on the row's tile: the service's or the site's. */
export function cardTile(card: Card): string {
  const source = card.kind === 'service_login' ? card.title : savedFor(card)
  return source.trim().charAt(0).toUpperCase() || '?'
}

/** The badge by a "Continue with Google" button: "You use Google here — you@gmail.com". */
export function ssoText(hint: SignIn): string {
  const name = providerName(hint.provider)
  return hint.label ? `You use ${name} here — ${hint.label}` : `You use ${name} here`
}
