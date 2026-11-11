import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fromHex, toHex, utf8 } from '../lib/bytes'
import { PROLOGUE, PROTOCOL_NAME, clientId, generateKeyPair, importKeyPair, initiate, pairingCode, respond } from '../lib/noise'

// Written by src-tauri/bridge/src/noise.rs with snow: this file must produce the same bytes.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/protocol/noise-kk.json', import.meta.url), 'utf8')) as {
  protocol: string
  prologue: string
  extension: { static: string; staticPublic: string; ephemeral: string; ephemeralPublic: string }
  app: { static: string; staticPublic: string; ephemeral: string; ephemeralPublic: string }
  clientId: string
  pairingCode: string
  message1: string
  message2: string
  transport: { from: 'extension' | 'app'; plaintext: string; ciphertext: string }[]
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('Noise KK against the Rust vectors', () => {
  it('speaks the same protocol', () => {
    expect(PROTOCOL_NAME).toBe(vectors.protocol)
    expect(PROLOGUE).toBe(vectors.prologue)
  })

  it('derives the same public keys, client id and pairing code', async () => {
    const extension = await importKeyPair(fromHex(vectors.extension.static))
    const app = await importKeyPair(fromHex(vectors.app.static))
    expect(toHex(extension.publicKey)).toBe(vectors.extension.staticPublic)
    expect(toHex(app.publicKey)).toBe(vectors.app.staticPublic)
    expect(toHex(await clientId(extension.publicKey))).toBe(vectors.clientId)
    expect(await pairingCode(extension.publicKey, app.publicKey)).toBe(vectors.pairingCode)
  })

  it('writes and reads the same handshake and transport messages, both ways', async () => {
    const extension = await importKeyPair(fromHex(vectors.extension.static))
    const app = await importKeyPair(fromHex(vectors.app.static))
    const extensionEphemeral = await importKeyPair(fromHex(vectors.extension.ephemeral))
    const appEphemeral = await importKeyPair(fromHex(vectors.app.ephemeral))

    const started = await initiate({ local: extension, remote: app.publicKey, ephemeral: extensionEphemeral })
    expect(toHex(started.message)).toBe(vectors.message1)

    // The TypeScript responder (the tests' fake VaultKey) agrees with snow too.
    const answered = await respond({ local: app, remote: extension.publicKey, message: started.message, ephemeral: appEphemeral })
    expect(toHex(answered.message)).toBe(vectors.message2)

    const session = await started.finish(fromHex(vectors.message2))
    for (const step of vectors.transport) {
      if (step.from === 'extension') {
        expect(toHex(await session.encrypt(utf8(step.plaintext)))).toBe(step.ciphertext)
        expect(text(await answered.transport.decrypt(fromHex(step.ciphertext)))).toBe(step.plaintext)
      } else {
        expect(text(await session.decrypt(fromHex(step.ciphertext)))).toBe(step.plaintext)
        expect(toHex(await answered.transport.encrypt(utf8(step.plaintext)))).toBe(step.ciphertext)
      }
    }
  })
})

describe('Noise KK', () => {
  it('only completes with the paired keys', async () => {
    const [extension, app, stranger] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()])
    // The app expects another browser's key.
    const hello = await initiate({ local: stranger, remote: app.publicKey })
    await expect(respond({ local: app, remote: extension.publicKey, message: hello.message })).rejects.toThrow()
    // The browser holds another app's key: the app can't read it either.
    const wrong = await initiate({ local: extension, remote: stranger.publicKey })
    await expect(respond({ local: app, remote: extension.publicKey, message: wrong.message })).rejects.toThrow()
    // An answer from someone without the app's key.
    const real = await initiate({ local: extension, remote: app.publicKey })
    const forged = await respond({ local: stranger, remote: extension.publicKey, message: (await initiate({ local: extension, remote: stranger.publicKey })).message })
    await expect(real.finish(forged.message)).rejects.toThrow()
  })

  it('refuses frames altered, replayed or out of order', async () => {
    const [extension, app] = await Promise.all([generateKeyPair(), generateKeyPair()])
    const started = await initiate({ local: extension, remote: app.publicKey })
    const answered = await respond({ local: app, remote: extension.publicKey, message: started.message })
    const session = await started.finish(answered.message)

    // The first frame never arrives: the second can't be read in its place.
    await session.encrypt(utf8('one'))
    const second = await session.encrypt(utf8('two'))
    await expect(answered.transport.decrypt(second)).rejects.toThrow()

    const [extension2, app2] = await Promise.all([generateKeyPair(), generateKeyPair()])
    const again = await initiate({ local: extension2, remote: app2.publicKey })
    const reply = await respond({ local: app2, remote: extension2.publicKey, message: again.message })
    const live = await again.finish(reply.message)
    const sealed = await live.encrypt(utf8('hello'))
    const altered = sealed.slice()
    altered[0] = (altered[0] ?? 0) ^ 1
    await expect(reply.transport.decrypt(altered)).rejects.toThrow()

    const [extension3, app3] = await Promise.all([generateKeyPair(), generateKeyPair()])
    const third = await initiate({ local: extension3, remote: app3.publicKey })
    const thirdReply = await respond({ local: app3, remote: extension3.publicKey, message: third.message })
    const thirdSession = await third.finish(thirdReply.message)
    const once = await thirdSession.encrypt(utf8('once'))
    expect(text(await thirdReply.transport.decrypt(once))).toBe('once')
    await expect(thirdReply.transport.decrypt(once)).rejects.toThrow()
  })

  it('keeps its private key out of reach', async () => {
    const pair = await generateKeyPair()
    expect(pair.privateKey.extractable).toBe(false)
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow()
  })
})
