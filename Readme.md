# VaultKey

VaultKey is a local-first, single-user password vault for Electron. The app no longer starts a web server or requires Docker/PostgreSQL: Electron’s main process owns a persistent SQLite database and the React renderer owns the vault cryptography.

## Runtime architecture

```text
React renderer
  Argon2id + HKDF + AES-GCM
  in-memory encryption key
          │ typed contextBridge IPC
Electron main process
  SQLite database + auth verifier + session guard
          │
User data directory
  vaultkey.sqlite3
```

The database is created at `app.getPath('userData')/vaultkey.sqlite3`. On macOS this is normally under `~/Library/Application Support/VaultKey/`. The existing PostgreSQL data is not imported and any external Docker volume is left untouched.

## Security model

- The master password never leaves the renderer. Argon2id derives a master key, then HKDF derives independent authentication and encryption keys.
- New vaults use a random per-vault KDF salt. The main process stores only a salted scrypt verifier of the authentication key, never the raw key.
- Credential passwords are encrypted with AES-GCM in the renderer before they cross IPC. SQLite stores only the ciphertext for that field; usernames, emails, and domain names retain the existing plaintext behavior.
- Main-process IPC sessions are bound to the originating renderer and are revoked on lock, logout, or window destruction.
- SQLite uses prepared statements, foreign-key enforcement, WAL with full synchronization, secure deletion, disabled extensions, integrity checks, and restrictive file permissions.
- Renderer sandboxing, context isolation, CSP, external URL filtering, sensitive-log suppression, and cache clearing on lock are enabled.

Before a future schema migration, VaultKey creates and integrity-checks a timestamped SQLite backup in the database directory’s `backups/` folder. Backups are migration-only and are not automatically pruned.

## Development

```bash
cd app
npm install
npm run dev
```

For an isolated development vault, set `VAULTKEY_DATA_DIR` before `npm run dev`. This is honored only for unpackaged development builds.

## Verification

```bash
cd app
npm test
npm run typecheck
npm run lint
npm run build
npm run test:electron-sqlite
```

`test:electron-sqlite` verifies that the pinned Electron runtime can open and query SQLite through `node:sqlite`.

## Packaging

The macOS target produces an Apple Silicon (`arm64`) VaultKey app, DMG, and ZIP. The local build uses one consistent ad-hoc signature so it can launch on the build Mac without Apple Developer credentials:

```bash
cd app
npm run build:mac
npm run install:mac
```

Outputs are written to `app/dist/`:

```text
VaultKey-1.0.3-arm64.dmg
VaultKey-1.0.3-arm64.zip
mac-arm64/VaultKey.app
```

Install the local app directly with:

```bash
ditto dist/mac-arm64/VaultKey.app /Applications/VaultKey.app
open -a /Applications/VaultKey.app
```

This local app is not notarized. Other Macs will require manual Gatekeeper approval. There is no Apple-trusted public distribution path with a free Apple ID.

For a public release, enroll in the paid Apple Developer Program, install a `Developer ID Application` certificate in the login Keychain, create notarization credentials, and run:

```bash
export APPLE_ID='your-apple-id@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='ABCDE12345'
npm run build:mac:release
```

Never store these values in the repository. The release command requires a valid signing identity and enables notarization; it fails instead of silently producing an unsigned release.

Other platform commands remain available:

```bash
npm run build:win
npm run build:linux
```
