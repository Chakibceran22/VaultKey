import { argon2id, sha256 } from 'hash-wasm'

const ARGON2_SALT = 'vaultkey-password-manager'
const ARGON2_ITERATIONS = 3
const ARGON2_MEMORY = 65536 // 64MB
const ARGON2_PARALLELISM = 1
const ARGON2_HASH_LENGTH = 64 // 64 bytes = 512 bits, enough to split into two 32-byte keys

/**
 * Derives an auth key and encryption key from the master password.
 * Uses Argon2id for master key derivation, then HKDF-like separation via SHA-256.
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

  // Split the master key into two halves and derive separate keys via HKDF-like approach
  const authKey = await sha256(masterKeyHex + ':auth')
  const encryptionKey = await sha256(masterKeyHex + ':enc')

  return { authKey, encryptionKey }
}
