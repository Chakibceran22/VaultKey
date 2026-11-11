// The encrypted channel to VaultKey (plans/02-security.md, "The channel"): Noise KK,
// 25519 / AESGCM / SHA256, on WebCrypto. The extension starts (initiator); the app answers
// (src-tauri/bridge/src/noise.rs, with snow). tests/noise.test.ts checks this file against
// vectors snow wrote, byte for byte.
//
// KK: each side knows the other's static key from pairing. Every connection does a fresh
// handshake with new ephemeral keys, so each session has forward secrecy.

import { concat, utf8, type Bytes } from './bytes'

const subtle = globalThis.crypto.subtle

export const PROTOCOL_NAME = 'Noise_KK_25519_AESGCM_SHA256'
export const PROLOGUE = 'vaultkey-bridge/1'
const DH_LEN = 32
const TAG_LEN = 16
const X25519 = { name: 'X25519' }

export interface KeyPair {
  /** Non-extractable when made by `generateKeyPair`: not even this code can read it. */
  privateKey: CryptoKey
  publicKey: Bytes
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await subtle.generateKey(X25519, false, ['deriveBits'])) as CryptoKeyPair
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) }
}

// PKCS#8 for a raw X25519 private key (OID 1.3.101.110).
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

/** Tests only: a key pair from its raw private bytes (the vectors' fixed keys). */
export async function importKeyPair(privateBytes: Bytes): Promise<KeyPair> {
  const privateKey = await subtle.importKey('pkcs8', concat(PKCS8_PREFIX, privateBytes), X25519, true, ['deriveBits'])
  const jwk = await subtle.exportKey('jwk', privateKey)
  const x = (jwk.x ?? '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(x + '='.repeat((4 - (x.length % 4)) % 4))
  return { privateKey, publicKey: Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
}

async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)))
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const hmacKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', hmacKey, data))
}

/** Noise's HKDF with two outputs. */
async function hkdf(chainingKey: Bytes, input: Bytes): Promise<[Bytes, Bytes]> {
  const temp = await hmac(chainingKey, input)
  const first = await hmac(temp, new Uint8Array([1]))
  const second = await hmac(temp, concat(first, new Uint8Array([2])))
  return [first, second]
}

async function dh(privateKey: CryptoKey, publicKey: Bytes): Promise<Bytes> {
  const peer = await subtle.importKey('raw', publicKey, X25519, false, [])
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, DH_LEN * 8))
}

/** One direction's key and message counter. */
class CipherState {
  private key: CryptoKey | null = null
  private nonce = 0n

  async initialize(key: Bytes): Promise<void> {
    this.key = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    this.nonce = 0n
  }

  /** 4 zero bytes, then the counter big-endian; taken synchronously, so calls keep their order. */
  private nextNonce(): Bytes {
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setBigUint64(4, this.nonce)
    this.nonce += 1n
    return nonce
  }

  async encrypt(ad: Bytes, plaintext: Bytes): Promise<Bytes> {
    if (!this.key) return plaintext
    const iv = this.nextNonce()
    return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad, tagLength: 128 }, this.key, plaintext))
  }

  /** Throws when the message was altered, replayed or reordered. */
  async decrypt(ad: Bytes, ciphertext: Bytes): Promise<Bytes> {
    if (!this.key) return ciphertext
    const iv = this.nextNonce()
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: ad, tagLength: 128 }, this.key, ciphertext))
  }
}

class SymmetricState {
  readonly cipher = new CipherState()

  private constructor(
    private chainingKey: Bytes,
    private hash: Bytes,
  ) {}

  static async start(): Promise<SymmetricState> {
    // The name fits in 32 bytes: zero-padded, not hashed.
    const name = utf8(PROTOCOL_NAME)
    const hash = new Uint8Array(32)
    hash.set(name)
    const state = new SymmetricState(hash.slice(), hash)
    await state.mixHash(utf8(PROLOGUE))
    return state
  }

  async mixHash(data: Bytes): Promise<void> {
    this.hash = await sha256(this.hash, data)
  }

  async mixKey(input: Bytes): Promise<void> {
    const [chainingKey, key] = await hkdf(this.chainingKey, input)
    this.chainingKey = chainingKey
    await this.cipher.initialize(key)
  }

  async encryptAndHash(plaintext: Bytes): Promise<Bytes> {
    const ciphertext = await this.cipher.encrypt(this.hash, plaintext)
    await this.mixHash(ciphertext)
    return ciphertext
  }

  async decryptAndHash(ciphertext: Bytes): Promise<Bytes> {
    const plaintext = await this.cipher.decrypt(this.hash, ciphertext)
    await this.mixHash(ciphertext)
    return plaintext
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [first, second] = await hkdf(this.chainingKey, new Uint8Array(0))
    const [a, b] = [new CipherState(), new CipherState()]
    await a.initialize(first)
    await b.initialize(second)
    return [a, b]
  }
}

/** A session after the handshake. Encrypt and decrypt in the order messages are sent and received. */
export interface Transport {
  encrypt(plaintext: Bytes): Promise<Bytes>
  /** Throws on a message altered, replayed, dropped or reordered: the session is over. */
  decrypt(ciphertext: Bytes): Promise<Bytes>
}

function transport(send: CipherState, receive: CipherState): Transport {
  const none = new Uint8Array(0)
  return {
    encrypt: (plaintext) => send.encrypt(none, plaintext),
    decrypt: (ciphertext) => receive.decrypt(none, ciphertext),
  }
}

/** Both pre-messages (`-> s`, `<- s`): the initiator's static key first. */
async function begin(initiatorStatic: Bytes, responderStatic: Bytes): Promise<SymmetricState> {
  const state = await SymmetricState.start()
  await state.mixHash(initiatorStatic)
  await state.mixHash(responderStatic)
  return state
}

class HandshakeError extends Error {
  constructor() {
    super('The secure connection to VaultKey could not be set up.')
  }
}

/**
 * The extension's side. Returns `hs1`'s message; `finish` reads `hs2`'s and gives the
 * session. Both payloads are empty.
 */
export async function initiate(options: {
  local: KeyPair
  remote: Bytes
  /** Tests only: the vectors' fixed ephemeral key. */
  ephemeral?: KeyPair
}): Promise<{ message: Bytes; finish(reply: Bytes): Promise<Transport> }> {
  const { local, remote } = options
  const state = await begin(local.publicKey, remote)
  const ephemeral = options.ephemeral ?? (await generateKeyPair())
  // -> e, es, ss
  await state.mixHash(ephemeral.publicKey)
  await state.mixKey(await dh(ephemeral.privateKey, remote))
  await state.mixKey(await dh(local.privateKey, remote))
  const message = concat(ephemeral.publicKey, await state.encryptAndHash(new Uint8Array(0)))
  return {
    message,
    async finish(reply) {
      if (reply.length !== DH_LEN + TAG_LEN) throw new HandshakeError()
      // <- e, ee, se
      const theirs = reply.slice(0, DH_LEN)
      try {
        await state.mixHash(theirs)
        await state.mixKey(await dh(ephemeral.privateKey, theirs))
        await state.mixKey(await dh(local.privateKey, theirs))
        await state.decryptAndHash(reply.slice(DH_LEN))
      } catch {
        throw new HandshakeError()
      }
      const [send, receive] = await state.split()
      return transport(send, receive)
    },
  }
}

/** The app's side, in TypeScript: for tests (a fake VaultKey) only. */
export async function respond(options: {
  local: KeyPair
  remote: Bytes
  message: Bytes
  ephemeral?: KeyPair
}): Promise<{ message: Bytes; transport: Transport }> {
  const { local, remote, message } = options
  if (message.length !== DH_LEN + TAG_LEN) throw new HandshakeError()
  const state = await begin(remote, local.publicKey)
  // -> e, es, ss (read)
  const theirs = message.slice(0, DH_LEN)
  try {
    await state.mixHash(theirs)
    await state.mixKey(await dh(local.privateKey, theirs))
    await state.mixKey(await dh(local.privateKey, remote))
    await state.decryptAndHash(message.slice(DH_LEN))
  } catch {
    throw new HandshakeError()
  }
  // <- e, ee, se
  const ephemeral = options.ephemeral ?? (await generateKeyPair())
  await state.mixHash(ephemeral.publicKey)
  await state.mixKey(await dh(ephemeral.privateKey, theirs))
  await state.mixKey(await dh(ephemeral.privateKey, remote))
  const answer = concat(ephemeral.publicKey, await state.encryptAndHash(new Uint8Array(0)))
  const [receive, send] = await state.split()
  return { message: answer, transport: transport(send, receive) }
}

/** How this browser names itself in `hs1`: the first 16 bytes of SHA-256(its key). */
export async function clientId(publicKey: Bytes): Promise<Bytes> {
  return (await sha256(publicKey)).slice(0, 16)
}

/**
 * The 6-digit code the popup and VaultKey both show while pairing:
 * SHA-256("vaultkey-pair-v1" ‖ extension key ‖ app key), big-endian, mod 10⁶.
 */
export async function pairingCode(extensionKey: Bytes, appKey: Bytes): Promise<string> {
  const digest = await sha256(utf8('vaultkey-pair-v1'), extensionKey, appKey)
  const code = digest.reduce((value, byte) => (value * 256 + byte) % 1_000_000, 0)
  return String(code).padStart(6, '0')
}
