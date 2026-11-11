// The plaintext messages between the extension, the bridge and the app
// (src-tauri/bridge/src/message.rs; plans/03-protocol.md, outer layer). None carry vault
// data: requests travel encrypted inside `x` (lib/inner.ts). tests/fixtures/protocol/
// outer.json holds the exact JSON both sides must agree on.

export const PROTOCOL = 1

export type AppPresence = 'running' | 'not_running'
/** `disabled`: "Browser extension" is off in VaultKey's settings. */
export type VaultState = 'locked' | 'unlocked' | 'disabled'
export type BrowserKind = 'chrome' | 'brave' | 'edge' | 'chromium' | 'vivaldi' | 'arc' | 'firefox' | 'other'
export type ErrorCode = 'BAD_FRAME' | 'NOT_PAIRED' | 'LOCKED' | 'DISABLED' | 'PROTOCOL_VERSION' | 'BUSY' | 'INTERNAL'
export type Need = 'update_app' | 'update_extension'

/** What the extension sends. */
export type Outgoing =
  | { t: 'bridge.status' }
  | { t: 'ping'; n: number }
  /** Bring VaultKey's window forward (to unlock it): no session, no data. */
  | { t: 'app.show' }
  | { t: 'pair.request'; pub: string; name: string; browser: BrowserKind; protocol: number }
  | { t: 'hs1'; client: string; msg: string; protocol: number }
  | { t: 'x'; c: string }

/** What the bridge and the app send back. */
export type Incoming =
  | { t: 'bridge.state'; app: AppPresence }
  | { t: 'state'; state: VaultState; protocol: number }
  | { t: 'pong'; n: number }
  | { t: 'pair.pending'; pub: string }
  | { t: 'pair.result'; approved: boolean }
  | { t: 'hs2'; msg: string }
  | { t: 'x'; c: string }
  | { t: 'err'; code: ErrorCode; need?: Need }

const VAULT_STATES: readonly string[] = ['locked', 'unlocked', 'disabled']
const ERROR_CODES: readonly string[] = ['BAD_FRAME', 'NOT_PAIRED', 'LOCKED', 'DISABLED', 'PROTOCOL_VERSION', 'BUSY', 'INTERNAL']
/** Longer than any frame could carry (64 KiB): refused before anything decodes it. */
const MAX_TEXT = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && own.every((key) => keys.includes(key))
}

function isU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT
}

/** Checks a message from the bridge before anything reads it: exact shape or null. */
export function parseIncoming(value: unknown): Incoming | null {
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'bridge.state':
      return hasOnlyKeys(value, ['t', 'app']) && (value.app === 'running' || value.app === 'not_running')
        ? { t: 'bridge.state', app: value.app }
        : null
    case 'state':
      return hasOnlyKeys(value, ['t', 'state', 'protocol']) && VAULT_STATES.includes(value.state as string) && isU32(value.protocol)
        ? { t: 'state', state: value.state as VaultState, protocol: value.protocol }
        : null
    case 'pong':
      return hasOnlyKeys(value, ['t', 'n']) && isU32(value.n) ? { t: 'pong', n: value.n } : null
    case 'pair.pending':
      return hasOnlyKeys(value, ['t', 'pub']) && isText(value.pub) ? { t: 'pair.pending', pub: value.pub } : null
    case 'pair.result':
      return hasOnlyKeys(value, ['t', 'approved']) && typeof value.approved === 'boolean'
        ? { t: 'pair.result', approved: value.approved }
        : null
    case 'hs2':
      return hasOnlyKeys(value, ['t', 'msg']) && isText(value.msg) ? { t: 'hs2', msg: value.msg } : null
    case 'x':
      return hasOnlyKeys(value, ['t', 'c']) && isText(value.c) ? { t: 'x', c: value.c } : null
    case 'err': {
      if (!ERROR_CODES.includes(value.code as string)) return null
      const code = value.code as ErrorCode
      if (hasOnlyKeys(value, ['t', 'code'])) return { t: 'err', code }
      // `need` comes with PROTOCOL_VERSION, and only with it.
      return code === 'PROTOCOL_VERSION' &&
        hasOnlyKeys(value, ['t', 'code', 'need']) &&
        (value.need === 'update_app' || value.need === 'update_extension')
        ? { t: 'err', code, need: value.need }
        : null
    }
    default:
      return null
  }
}
