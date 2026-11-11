import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BridgeClient, type NativePort } from '../lib/bridge-client'
import { DEV_HOST, RELEASE_HOST, hostName } from '../lib/host'
import { encodeRequest, parseInner } from '../lib/inner'
import { parseIncoming, type Outgoing } from '../lib/messages'

// The same fixtures src-tauri/bridge/src/{message,inner,address}.rs check: both sides agree
// on every byte.
const outer = JSON.parse(readFileSync(new URL('./fixtures/protocol/outer.json', import.meta.url), 'utf8')) as {
  hostNames: { release: string; dev: string }
  fromExtension: string[]
  toExtension: string[]
  refused: string[]
}
const inner = JSON.parse(readFileSync(new URL('./fixtures/protocol/inner.json', import.meta.url), 'utf8')) as {
  exchanges: { request: string; reply: string }[]
  events: string[]
  refusedRequests: string[]
}

describe('parseIncoming', () => {
  it('accepts every message the bridge and app send, unchanged', () => {
    expect(outer.toExtension.length).toBeGreaterThan(0)
    for (const json of outer.toExtension) {
      expect(JSON.stringify(parseIncoming(JSON.parse(json))), json).toBe(json)
    }
  })

  it('refuses malformed messages, the array form, and messages only the extension sends', () => {
    // `x` travels both ways, so it is in both lists.
    const extensionOnly = outer.fromExtension.filter((json) => !outer.toExtension.includes(json))
    for (const json of [...outer.refused, ...extensionOnly]) {
      expect(parseIncoming(JSON.parse(json)), json).toBeNull()
    }
    expect(parseIncoming(undefined)).toBeNull()
    expect(parseIncoming('{"t":"pong","n":1}')).toBeNull()
  })

  it('takes `need` with PROTOCOL_VERSION only', () => {
    expect(parseIncoming({ t: 'err', code: 'BAD_FRAME', need: 'update_app' })).toBeNull()
    expect(parseIncoming({ t: 'err', code: 'PROTOCOL_VERSION', need: null })).toBeNull()
    expect(parseIncoming({ t: 'x', c: 'A'.repeat(70_000) })).toBeNull()
  })
})

describe('the inner layer', () => {
  it('writes requests byte for byte as the app reads them, and reads its replies', () => {
    for (const { request, reply } of inner.exchanges) {
      const sent = JSON.parse(request) as { id: number; m: 'ping'; p?: Record<string, unknown> }
      expect(encodeRequest(sent)).toBe(request)
      const parsed = parseInner(reply)
      expect(parsed?.kind, reply).toBe('reply')
      expect(parsed && 'id' in parsed && parsed.id).toBe(sent.id)
    }
    expect(parseInner('{"id":1,"ok":true,"r":{}}')).toEqual({ kind: 'reply', id: 1, ok: true, r: {} })
  })

  it('reads every event', () => {
    expect(inner.events.map(parseInner)).toEqual([
      { kind: 'event', ev: 'locked' },
      { kind: 'event', ev: 'revoked' },
    ])
  })

  it('refuses anything else', () => {
    for (const text of [
      'nope',
      '[]',
      '{"ev":"exploded"}',
      '{"ev":"locked","extra":1}',
      '{"id":1,"ok":true}',
      '{"id":1,"ok":true,"r":{},"extra":1}',
      '{"id":-1,"ok":true,"r":{}}',
      '{"id":1,"ok":false,"e":{"code":"X"}}',
      '{"id":1,"ok":"yes","r":{}}',
      ...inner.refusedRequests,
    ]) {
      expect(parseInner(text), text).toBeNull()
    }
  })
})

describe('what the extension sends', () => {
  it('is byte for byte what the bridge and app expect', async () => {
    // Record what BridgeClient really posts during a check.
    const sent: Outgoing[] = []
    const listeners: ((message: unknown) => void)[] = []
    const port: NativePort = {
      postMessage(message) {
        sent.push(message)
        const replies =
          message.t === 'bridge.status'
            ? [{ t: 'bridge.state', app: 'running' }, { t: 'state', state: 'locked', protocol: 1 }]
            : message.t === 'ping'
              ? [{ t: 'pong', n: message.n }]
              : []
        for (const reply of replies) queueMicrotask(() => listeners.forEach((listener) => listener(reply)))
      },
      disconnect() {},
      onMessage: { addListener: (listener) => void listeners.push(listener) },
      onDisconnect: { addListener: () => {} },
    }
    await new BridgeClient(() => port, () => undefined).check({ pings: 1 })

    const [status, ping] = sent
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(status)).toBe(outer.fromExtension[0])
    // Same shape and key order; only the counter differs from the fixture's 7.
    expect(ping?.t).toBe('ping')
    expect(JSON.stringify({ ...ping, n: 7 })).toBe(outer.fromExtension[1])
  })
})

describe('hostName', () => {
  it('matches the bridge: dev builds reach the dev app only', () => {
    expect(RELEASE_HOST).toBe(outer.hostNames.release)
    expect(DEV_HOST).toBe(outer.hostNames.dev)
    expect(hostName('development')).toBe(DEV_HOST)
    expect(hostName('production')).toBe(RELEASE_HOST)
  })
})
