import { argon2id } from 'hash-wasm'

const ARGON2_SALT = 'vaultkey-password-manager'
const ARGON2_ITERATIONS = 3
const ARGON2_MEMORY = 65536 // 64MB
const ARGON2_PARALLELISM = 1
const ARGON2_HASH_LENGTH = 32 // 32 bytes = 256 bits master key

const encoder = new TextEncoder()

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Derives 32 bytes from the master key using HKDF-Expand with the given info string.
 */
async function hkdfDerive(masterKeyBytes: Uint8Array, info: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey('raw', masterKeyBytes.buffer as ArrayBuffer, 'HKDF', false, [
    'deriveBits',
  ])

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(ARGON2_SALT),
      info: encoder.encode(info),
    },
    keyMaterial,
    256,
  )

  return bytesToHex(derived)
}

/**
 * Derives an auth key and encryption key from the master password.
 * Uses Argon2id for master key derivation, then HKDF for key separation.
 *
 * - authKey: sent to server for authentication (never used for encryption)
 * - encryptionKey: used client-side only for encrypting/decrypting vault data
 */
export async function deriveKeys(masterPassword: string): Promise<{
  authKey: string
  encryptionKey: string
}> {
  const masterKeyHex = await argon2id({
    password: masterPassword,
    salt: ARGON2_SALT,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'hex',
  })

  const masterKeyBytes = hexToBytes(masterKeyHex)

  const authKey = await hkdfDerive(masterKeyBytes, 'vaultkey-auth')
  const encryptionKey = await hkdfDerive(masterKeyBytes, 'vaultkey-enc')

  return { authKey, encryptionKey }
}

export async function encrypt(plaintext: string, encryptionKeyHex: string): Promise<string> {
  const keyBytes = hexToBytes(encryptionKeyHex)
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoder.encode(plaintext))
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function decrypt(encrypted: string, encryptionKeyHex: string): Promise<string> {
  const keyBytes = hexToBytes(encryptionKeyHex)
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
  const raw = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))
  const iv = raw.slice(0, 12)
  const ciphertext = raw.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext)
  return new TextDecoder().decode(decrypted)
}
