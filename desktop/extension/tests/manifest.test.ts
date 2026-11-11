import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import devKey from '../dev-key.json'
import releaseKey from '../release-key.json'
import { buildManifest } from '../lib/manifest'

/** Chrome/Brave's extension ID for a manifest `key`: SHA-256 of the key, first 16 bytes as a–p. */
function extensionIdOf(base64Key: string): string {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')
}

// The IDs each flavor's bridge allows (src-tauri/bridge/src/address.rs checks the same file).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/protocol/outer.json', import.meta.url), 'utf8')) as {
  extensionIds: { release: string; dev: string }
}

describe('buildManifest', () => {
  it('release: the release key, whose ID the release bridge allows; nothing but nativeMessaging', () => {
    const manifest = buildManifest('production')
    expect(manifest.key).toBe(releaseKey.publicKey)
    expect(extensionIdOf(releaseKey.publicKey)).toBe(releaseKey.extensionId)
    expect(releaseKey.extensionId).toBe(fixture.extensionIds.release)
    expect(manifest.permissions).toEqual(['nativeMessaging'])
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.commands.fill.suggested_key).toEqual({ default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' })
    expect(manifest).not.toHaveProperty('externally_connectable')
    // Only the inline menu is exposed to pages.
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['menu.html'], matches: ['http://*/*', 'https://*/*'] }])
    expect(manifest.name).toBe('VaultKey')
  })

  it('dev: the dev key, whose ID the dev bridge allows', () => {
    const manifest = buildManifest('development')
    expect(manifest.key).toBe(devKey.publicKey)
    expect(extensionIdOf(devKey.publicKey)).toBe(devKey.extensionId)
    expect(devKey.extensionId).toBe(fixture.extensionIds.dev)
    expect(manifest.permissions).toEqual(['nativeMessaging'])
    expect(manifest.name).toBe('VaultKey (dev)')
  })

  it('dev and release never share an ID', () => {
    expect(devKey.extensionId).not.toBe(releaseKey.extensionId)
  })
})
