// Bytes as WebCrypto takes them, and as the messages carry them (standard base64).

/** A byte array backed by a plain ArrayBuffer (what WebCrypto accepts). */
export type Bytes = Uint8Array<ArrayBuffer>

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function utf8(text: string): Bytes {
  return new Uint8Array(new TextEncoder().encode(text))
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Standard, padded, canonical base64 of at most `max` bytes, or null. */
export function fromBase64(text: string, max: number): Bytes | null {
  if (text.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    return null
  }
  let binary: string
  try {
    binary = atob(text)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  // Canonical only (the spare bits of the last character are zero), like the Rust side.
  if (bytes.length > max || toBase64(bytes) !== text) return null
  return bytes
}

export function fromHex(hex: string): Bytes {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
