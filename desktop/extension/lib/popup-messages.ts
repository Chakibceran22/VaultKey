// The popup ↔ service worker channel: a runtime port the popup opens. The popup asks
// (check again, connect, this page's logins, search, fill, a code); the service worker
// pushes every change of state, so lock and unlock show live.

import { MAX_QUERY, type CardsResult, type CodeResult, type Outcome, type SearchResult } from './actions'
import type { LinkState } from './link'

export const POPUP_PORT = 'vaultkey-popup'

export type PopupRequest =
  | { type: 'refresh' }
  | { type: 'pair' }
  /** Bring VaultKey's window forward, to unlock it. */
  | { type: 'show-app' }
  | { type: 'cards' }
  /** Logins for any site, by name (the popup only: never a page or the inline menu). */
  | { type: 'search'; q: string }
  /** `confirmedInsecure`: the user clicked "Fill anyway" on an http page.
   * `confirmedCrossSite`: … on a search result, for another site than this page's.
   * `origin`: the page the popup showed (and asked about): nothing is filled if the tab
   * has moved on since. */
  | { type: 'fill'; h: string; confirmedInsecure: boolean; confirmedCrossSite: boolean; origin: string }
  | { type: 'code'; h: string; confirmedCrossSite: boolean; origin: string }

export type PopupUpdate =
  | { type: 'state'; state: LinkState }
  | { type: 'cards'; result: CardsResult }
  | { type: 'search'; result: SearchResult }
  | { type: 'filled'; outcome: Outcome }
  | { type: 'code'; result: CodeResult }

const isHandle = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64
/** An http(s) origin: "https://example.org", "http://192.168.1.10:8000". */
const isOrigin = (value: unknown): value is string => typeof value === 'string' && value.length <= 300 && /^https?:\/\/[^/?#\s]+$/.test(value)

export function isPopupRequest(value: unknown): value is PopupRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  switch (record.type) {
    case 'refresh':
    case 'pair':
    case 'show-app':
    case 'cards':
      return keys === 'type'
    case 'search':
      return keys === 'q,type' && typeof record.q === 'string' && record.q.length <= MAX_QUERY
    case 'fill':
      return (
        keys === 'confirmedCrossSite,confirmedInsecure,h,origin,type' &&
        isHandle(record.h) &&
        typeof record.confirmedInsecure === 'boolean' &&
        typeof record.confirmedCrossSite === 'boolean' &&
        isOrigin(record.origin)
      )
    case 'code':
      return keys === 'confirmedCrossSite,h,origin,type' && isHandle(record.h) && typeof record.confirmedCrossSite === 'boolean' && isOrigin(record.origin)
    default:
      return false
  }
}
