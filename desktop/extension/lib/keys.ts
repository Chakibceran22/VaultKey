// This browser's pairing with VaultKey (plans/02-security.md, "Pairing"): its own X25519
// key pair and, once VaultKey approved it, VaultKey's public key. Kept in the extension's
// IndexedDB. The private key is a non-extractable CryptoKey: not even the extension's
// own code can read its bytes. Nothing from the vault is ever stored here.

import type { Bytes } from './bytes'
import { generateKeyPair, type KeyPair } from './noise'

export interface Pairing extends KeyPair {
  /** VaultKey's public key: null until VaultKey approved this browser. */
  appKey: Bytes | null
}

export interface PairingStore {
  load(): Promise<Pairing | null>
  save(pairing: Pairing): Promise<void>
  /** Forgets everything: the next pairing starts with new keys. */
  clear(): Promise<void>
}

/** This browser's keys, made the first time it asks to pair. */
export async function newPairing(): Promise<Pairing> {
  return { ...(await generateKeyPair()), appKey: null }
}

const DATABASE = 'vaultkey'
const STORE = 'pairing'
const KEY = 'this-browser'

function request<T>(run: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const database = open.result
      const transaction = database.transaction(STORE, mode)
      const result = run(transaction.objectStore(STORE))
      transaction.oncomplete = () => {
        database.close()
        resolve(result.result)
      }
      transaction.onerror = transaction.onabort = () => {
        database.close()
        reject(transaction.error)
      }
    }
  })
}

function isPairing(value: unknown): value is Pairing {
  const pairing = value as Partial<Pairing> | undefined
  return (
    typeof pairing === 'object' &&
    pairing !== null &&
    pairing.privateKey instanceof CryptoKey &&
    pairing.publicKey instanceof Uint8Array &&
    (pairing.appKey === null || pairing.appKey instanceof Uint8Array)
  )
}

export class IndexedDbStore implements PairingStore {
  async load(): Promise<Pairing | null> {
    const value = await request((store) => store.get(KEY), 'readonly')
    return isPairing(value) ? value : null
  }

  async save(pairing: Pairing): Promise<void> {
    await request((store) => store.put(pairing, KEY), 'readwrite')
  }

  async clear(): Promise<void> {
    await request((store) => store.delete(KEY), 'readwrite')
  }
}

/** For tests. */
export class MemoryStore implements PairingStore {
  constructor(public pairing: Pairing | null = null) {}

  async load(): Promise<Pairing | null> {
    return this.pairing
  }

  async save(pairing: Pairing): Promise<void> {
    this.pairing = pairing
  }

  async clear(): Promise<void> {
    this.pairing = null
  }
}
