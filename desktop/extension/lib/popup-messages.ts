// The popup ↔ service worker channel: a runtime port the popup opens. The popup asks
// (check again, connect, this page's logins, fill, a code); the service worker pushes every
// change of state, so lock and unlock show live.

import type { CardsResult, CodeResult, Outcome } from './actions'
import type { LinkState } from './link'

export const POPUP_PORT = 'vaultkey-popup'

export type PopupRequest =
  | { type: 'refresh' }
  | { type: 'pair' }
  /** Bring VaultKey's window forward, to unlock it. */
  | { type: 'show-app' }
  | { type: 'cards' }
  /** `confirmedInsecure`: the user clicked "Fill anyway" on an http page. */
  | { type: 'fill'; h: string; confirmedInsecure: boolean }
  | { type: 'code'; h: string }

export type PopupUpdate =
  | { type: 'state'; state: LinkState }
  | { type: 'cards'; result: CardsResult }
  | { type: 'filled'; outcome: Outcome }
  | { type: 'code'; result: CodeResult }

const isHandle = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64

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
    case 'fill':
      return keys === 'confirmedInsecure,h,type' && isHandle(record.h) && typeof record.confirmedInsecure === 'boolean'
    case 'code':
      return keys === 'h,type' && isHandle(record.h)
    default:
      return false
  }
}
