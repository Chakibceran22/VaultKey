// Build time only (wxt.config.ts): the manifest for a build mode. Kept here so the tests
// can check what each build asks for (tests/manifest.test.ts).
import devKey from '../dev-key.json'
import releaseKey from '../release-key.json'

// M2 (plans/02, "Browser permissions"): `nativeMessaging` for the bridge; site access for
// the content script that fills, and to read the active tab's address (decided: like
// Bitwarden). Its keys live in IndexedDB, which needs no permission. Not requested: `tabs`,
// `scripting`, `storage`, `cookies`, `webRequest`, `externally_connectable`.
export function buildManifest(mode: string) {
  const dev = mode === 'development'
  return {
    name: dev ? 'VaultKey (dev)' : 'VaultKey',
    description: 'Fill your VaultKey logins on websites.',
    permissions: ['nativeMessaging'],
    host_permissions: ['http://*/*', 'https://*/*'],
    commands: {
      fill: {
        suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
        description: 'Fill the login for this page',
      },
    },
    // The script that finds login fields and fills them (entrypoints/content-script.ts), in
    // every http(s) frame from the start. Listed here rather than as a WXT content script:
    // WXT's wrapper for those is ~2 KB of unused code (the script's budget is 20 KB) and
    // posts the extension's ID to every page.
    content_scripts: [
      { matches: ['http://*/*', 'https://*/*'], js: ['content-script.js'], run_at: 'document_start' as const, all_frames: true },
    ],
    // The inline menu (M3): the one page a site may embed, in the content script's iframe.
    // `use_dynamic_url` (so sites can't probe for it) is to be checked in Brave first (M6).
    web_accessible_resources: [{ resources: ['menu.html'], matches: ['http://*/*', 'https://*/*'] }],
    // A fixed public key gives each build a fixed extension ID, which only that flavor's
    // bridge allows (src-tauri/bridge/src/address.rs, Flavor::extension_id). Dev and
    // release keys differ, so the two never reach each other's app. A store listing gets
    // its own ID later (plans/06).
    key: dev ? devKey.publicKey : releaseKey.publicKey,
  }
}
