# VaultKey (Tauri + Rust)

The Rust/Tauri port of the Electron app in `../app`. Same UI, same data file, same
encryption format, so it opens the existing vault as-is.

## Commands

```bash
cd desktop
pnpm install            # first time only

pnpm tauri dev          # dev: Vite on :1420 + the Rust app with hot reload
pnpm tauri build        # prod: optimised, stripped release build + .app/.dmg
```

Release output (macOS, Apple Silicon):

```text
src-tauri/target/release/bundle/macos/VaultKey.app
src-tauri/target/release/bundle/dmg/VaultKey_2.0.0_aarch64.dmg
```

Install it over the old Electron app (same bundle id, so it simply replaces it):

```bash
rm -rf /Applications/VaultKey.app
ditto src-tauri/target/release/bundle/macos/VaultKey.app /Applications/VaultKey.app
open -a /Applications/VaultKey.app
```

Removing the old `.app` does **not** touch your data. Never delete
`~/Library/Application Support/vaultkey/`: that is where the vault lives, for both apps.

## Where the data is

Packaged builds use `<config dir>/vaultkey/vaultkey.sqlite3`, exactly where Electron's
`app.getPath('userData')` put it (Electron named the folder after `package.json` `name`):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/vaultkey/vaultkey.sqlite3` |
| Windows | `%APPDATA%\vaultkey\vaultkey.sqlite3` |
| Linux | `~/.config/vaultkey/vaultkey.sqlite3` |

The file stays encrypted on disk, and your master password is the key. The new app
reads the same file in the same format, so there is nothing to export or import.
Install the build and unlock.

**`pnpm tauri dev` never touches that file.** Dev builds use their own vault at
`<config dir>/vaultkey-dev/vaultkey.sqlite3`, so code in progress (a new migration in
particular) can't alter the real vault. The path is printed at startup.

| Command | What it does |
|---|---|
| `pnpm vault:where` | Prints where the real vault, its backups and the dev vault are |
| `pnpm vault:snapshot` | Copies the real vault into the dev vault, so dev shows your real data |
| `pnpm vault:snapshot --from <file>` | Puts a vault file from elsewhere into the dev vault (another computer, a backup) |
| `pnpm vault:rehearse` | Runs pending migrations on a throwaway copy of the real vault and proves nothing is lost |

These commands only *read* the real vault, and they refuse to run while any app has
it open (quit VaultKey and the old Electron app first). Every copy is checked
byte-for-byte, and the current dev vault is kept in `vaultkey-dev/previous/` instead
of being overwritten.

To develop against any folder, use `VAULTKEY_DATA_DIR=/tmp/vk pnpm tauri dev`.
Packaged builds ignore it.

## Changing the database safely

Your data matters more than any feature, so every schema change goes through the same
four steps:

1. **Append** a migration to `MIGRATIONS` in `src-tauri/src/db.rs`. Never edit, reorder
   or delete one that has shipped. Keep changes additive: new tables, or new columns
   with defaults.
2. **`cargo test`** (in `src-tauri`). `upgrades_and_opens_a_vault_written_by_the_electron_app`
   builds a vault exactly as the Electron app wrote it and upgrades it with every
   migration. It must still unlock and decrypt, and every original row must survive
   byte-for-byte.
3. **`pnpm vault:rehearse`** does the same check on a copy of *your* real vault.
   Migrations v2 (projects, services, secrets, account links) and v3 (devices, sign-in
   steps, account secrets and notes) passed it on 2026-11-09: v1 → v3, all 66
   original rows intact.
4. Ship it. The first time the app opens the real vault, it writes an
   integrity-checked backup to `vaultkey/backups/`. Then it applies all pending
   migrations in one transaction: they all apply, or none do.

Once the real vault is past v1, the old Electron app refuses to open it. That is by
design, to protect the data. The pre-migration backup stays readable by Electron, so
uninstall the Electron app before shipping the first migration.

## Architecture

```text
React UI (src/)                 DevNotes design language; talks to Rust through invoke()
        │  Tauri IPC (main window only; strict CSP in packaged builds)
Rust core (src-tauri/src/)
  commands.rs    IPC surface: trust check, runs work off the UI thread
  vault.rs       session (key in memory while unlocked, zeroised on lock) + operations
  crypto.rs      Argon2id → HKDF → AES-256-GCM, scrypt verifier (Electron-compatible)
  store.rs       SQL: websites and accounts
  workspace.rs   SQL: projects, services, secrets, files, account links
  account_details.rs  SQL: devices, sign-in steps, account secrets and notes
  totp.rs        authenticator codes (RFC 6238) from a saved setup key
  db.rs          SQLite: WAL, FULL sync, secure_delete, migrations + verified backups
  validation.rs  same rules as the Electron validation.ts
  paths.rs       resolves the Electron data location
```

What changed from Electron: key derivation, encryption and decryption moved from the
renderer (hash-wasm/WebCrypto) into native Rust. The master password is sent to the
Rust core over Tauri IPC. The encryption key never reaches JavaScript and is wiped on
lock, on page reload and on exit. The on-disk format is unchanged, so both apps can read each other's
writes.

## What it holds

| Area | What you keep there |
|---|---|
| **Accounts** | Logins: website, email, username, and how it signs in: a password, other accounts ("Sign in with Google"), or no password at all. Each account has its own page with everything it takes to get back in: **sign-in steps** (authenticator app, passkey, security key, text message, email code, sign-in prompt), **recovery codes** and its **recovery account**; **secrets and notes** kept with it (tokens, keys, anything you'd otherwise have to remember); and its **connections** (what signs in with it, what it recovers, the devices it's signed in on, the project services that use it). With an authenticator's setup key saved, the page shows the live six-digit code. |
| **Devices** | Your phones, computers, tablets and security keys. Each one shows the sign-in steps that live on it and the accounts signed in on it, and warns about accounts with no backup if you lost it. |
| **Projects** | Each project lists its **services** (Coolify, Vercel, a database…), each tied to an account; its **secrets** (API keys, tokens, env vars); and its **files** (SSH keys, certificates, .env, anything up to 25 MB). Secrets and files are encrypted with the same vault key as passwords. |

Files come in through the native file picker or by dropping them on the window, and go out
through the native save dialog. Both dialogs are opened by the Rust core, so the page
never handles a file path. Dropped paths stay in Rust until they're imported.

## UI

VaultKey uses the DevNotes design system without its layout: one muted indigo accent,
SF Pro (SF Mono for secrets), Phosphor icons and frosted surfaces on a flat canvas. The
surfaces follow the elevation rules in `src/assets/main.css`:

| Level | Class | Used for |
|---|---|---|
| L0 | `body` | The canvas: flat, no decoration |
| L1 | `.frost` | Lists and panels: 1 px border, almost no shadow |
| L2 | `.glass` | Dropdowns |
| L3 | `.glass-strong` | Modals, dialogs, the palette, toasts, over a scrim |

Each page follows one pattern:

- **Accounts**, **Projects** and **Devices** are lists: a search field, a framed list
  and one primary action.
- **An account** is a detail page with Sign-in, Secrets and notes, and Connections tabs.
- **A project** is a detail page: its name and description edit in place, with Services,
  Secrets and Files as tabs.
- **Creating and editing** happen in a centred modal, one at a time (a new device
  can be added inside the sign-in step form, never in a second modal).
- **Deleting** always asks first, naming what is deleted and what goes with it.

| Key | Action |
|---|---|
| ⌘K | Search everything. Every word must match, across what an account connects to ("github yubikey", "coolify acme") |
| ⌘1 / ⌘2 / ⌘3 | Accounts / Projects / Devices |
| / | Search the current list |
| ⌘N | New account, project, device, service or secret (whatever the page holds) |
| ⌘L | Lock the vault |

The app icon source is `src-tauri/icons/app-icon.svg`. Regenerate every size with
`pnpm tauri icon src-tauri/icons/app-icon.svg`.

**Browser preview.** `pnpm dev` opened in a normal browser tab, not the Tauri window,
runs on an in-memory mock with made-up data (`src/dev/mock-backend.ts`). A badge marks
it, and any master password works except `wrong`. It never runs inside the app and is
not included in production builds.

## Tests

```bash
cd src-tauri
cargo test
```

`crypto.rs` tests use vectors generated by the Electron app's own `crypto.ts`
(hash-wasm 4.12.0 + WebCrypto) and Node's `scrypt`. If they fail, the port can't open
existing vaults, so they must stay green.

To smoke-test against a **copy** of a real vault (never the live file):

```bash
cp ~/Library/Application\ Support/vaultkey/vaultkey.sqlite3 /tmp/vault-copy.sqlite3
VAULTKEY_COMPAT_DB=/tmp/vault-copy.sqlite3 cargo test real_vault_copy -- --ignored --nocapture
```
