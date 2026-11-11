# VaultKey

A password vault that lives only on your computer. It keeps your accounts, how each one
signs in (passwords, authenticator codes, passkeys, recovery codes…), the devices they
depend on, and your projects' services, secrets and files, all encrypted, in one file
on your disk.

There is no account to create, no server, no sync and no internet connection: the app
can't reach the network at all. It runs on **macOS, Windows and Linux** (Tauri 2: a
Rust core with a React interface).

![VaultKey's accounts page: accounts grouped by what they're for](docs/screenshots/accounts.webp)

*Screenshots show made-up test data.*

**Contents:**
[Using VaultKey](#using-vaultkey) ·
[Your master password and recovery code](#your-master-password-and-recovery-code) ·
[What it holds](#what-it-holds) ·
[Security](#security) ·
[Where your data is](#where-your-data-is) ·
[Build and run it](#build-and-run-it) ·
[For developers](#for-developers)

---

## Using VaultKey

### The first time

1. **Create your master password** (at least 8 characters). It is the one password
   you will need to remember. Nobody can reset it for you, so make it strong and
   memorable.
2. You're taken to the lock screen. **Unlock** with the password you just chose.

   ![The lock screen](docs/screenshots/lock.webp)

3. **Save your recovery code.** VaultKey shows 24 words, once. Write them on paper,
   numbered and in order, then type three of them back with your master password to
   confirm. This screen can't be skipped: until a code is saved, it comes back at
   every unlock.

   ![The recovery code, shown once: 24 numbered words](docs/screenshots/recovery-code.webp)

### Every day

- **Unlock** with your master password. **Lock** with ⌘L (Ctrl+L), or by closing the
  window. Reloading the page also locks it.
- While the vault is locked, nothing in it can be read: the key that opens it exists
  only in memory while it's unlocked, and is wiped when it locks.

## Your master password and recovery code

The **master password** opens your vault every day. The **recovery code** is the only
way back in if you forget it.

> **Never lose your recovery code.** Nobody can reset your master password for you:
> not VaultKey, not support, not by email. If you forget your master password *and*
> lose the code, everything in the vault is gone for good. Keep the 24 words on paper,
> somewhere safe and away from your computer. Never keep them in the vault itself, in
> email, in a notes app or in the cloud: anyone with these words and your vault file
> can open your vault.

### If you forget your master password

1. On the lock screen, choose **Forgot your master password?** (it appears once a
   recovery code is saved).
2. Type the **24 words**, in order. Spaces, commas, new lines and numbering are all
   fine, capital letters don't matter, and the first four letters of each word are
   enough. A mistyped or swapped word is caught before anything happens.
3. Choose a **new master password** and confirm it.
4. The vault opens with the new password, and asks you to save a **new recovery code**
   right away (the old one has now been typed in somewhere). The old code keeps working
   until the new one is saved.

![Recovering a vault: the 24 words and a new master password](docs/screenshots/recover.webp)

### Changing your master password

The **key icon** in the top bar → current password, new password, confirm. It takes a
moment and changes nothing else: your data isn't rewritten, and your recovery code
keeps working. Lock and unlock once with the new password to be sure you have it.

### A new recovery code

The **key icon** → **New recovery code**. You'll write down the new 24 words and confirm
three of them with your master password. The new code replaces the old one, which stops
working. Do this if you think someone may have seen your code.

### Updating from an older VaultKey

Your data comes along on its own:

- On first launch, the database is upgraded in place, after a verified backup.
- **On your first unlock** (same password as before), the vault moves to the new
  encryption that makes a recovery code possible. It takes a few seconds, once, after
  another verified backup. Then it asks you to save your recovery code.
- All of it happens completely or not at all. If the app is closed or the computer
  loses power midway, the vault is exactly as it was and your password still works.
- If an item in your vault can't be read (damaged), the move waits: the vault unlocks
  as before, a message names the item, and the move happens at the next unlock once
  you've deleted or re-entered it.

## What it holds

| Area | What you keep there |
|---|---|
| **Accounts** | Website, email, username, and how it signs in: a **password**, **another account** ("Sign in with Google"), or both, or **no password** (passkey only). Each account's page has everything it takes to get back in: **sign-in steps** (authenticator app with its live six-digit code, passkey, security key, text message, email code, sign-in prompt), **recovery codes** and a **recovery account**; **secrets and notes** kept with it; and its **connections**: what signs in with it, what it recovers, the devices it's signed in on (with a note each: "GitHub Mobile, authenticator"), and the projects that use it. Accounts are grouped by what they're for (Email and identity, Developer and cloud, Money, Games…). |
| **Projects** | A project's **services** (Coolify, Vercel, a database, a private server…). A service can use **accounts** from the vault, each with its role there ("admin", "deploy only"), and keep its **own logins**: an address (URL, hostname or IP) with a username, password and note, for what has no website account, like a server's root user. Its **secrets** (API keys, tokens, environment variables), each with a description, and its **files** (SSH keys, certificates, .env files, anything up to 25 MB): pick them or drop them on the window, rename them, describe them. |
| **Devices** | Your phones, computers, tablets and security keys: the sign-in steps that live on each one, the accounts signed in on it, and a warning about accounts with no backup if you lost it. |
| **Search** | ⌘K (Ctrl+K), in your own words: "github recovery codes", "what signs in with google", "device for coolify", "root prod server". It follows the links between things, shows how it read the question, and the path to each answer. |

**An account**: how it signs in (here a password, a live authenticator code, a passkey,
a security key and recovery codes), its recovery account, and everything it connects to.

![An account's page: its sign-in steps and connections](docs/screenshots/account.webp)

**A project**: its services, here a server with its own logins opened up, its secrets
and files, and the accounts it depends on.

![A project's page: services, a server's logins, secrets](docs/screenshots/project.webp)

**Devices**: what lives on each phone, computer and security key.

![The devices page](docs/screenshots/devices.webp)

**Search** (⌘K): ask in your own words. It shows how it read the question, the answers,
and for each one the path of links that leads to it.

![Search: "what signs in with google"](docs/screenshots/search.webp)

### Importing a .env file

In a project's **Secrets**: **Import .env**, then paste the file, choose it (in the
macOS file picker, ⌘⇧. shows hidden files like `.env`), or drop it on the window. Each
`NAME=value` line becomes a secret, and a comment on the same line becomes its
description:

```bash
STRIPE_SECRET_KEY=sk_live_… # live payments, full write access
DATABASE_URL="postgres://user:p#ss@host/db" # production database
```

A `#` inside a value (`p@ss#word`) is part of it; a comment needs a space before it.
Quoted values may span lines (a private key), and `export NAME=value` works too. You see
every secret before importing: untick any, edit descriptions. Names already in the
project are marked **Replaces** and get the new value. Lines that can't be read are
listed with the reason. Everything is saved together, or nothing is.

![Importing a .env file: each line becomes a secret, its comment the description](docs/screenshots/env-import.webp)

### Getting around

| Keys | Action |
|---|---|
| ⌘K | Search everything |
| ⌘1 / ⌘2 / ⌘3 | Accounts / Projects / Devices |
| / | Filter the current list |
| ⌘N | New account, project or device on its list; a new service on a project page |
| ⌘L | Lock the vault |
| ⌘M | Full screen on / off (macOS) |
| ⌘[ ⌘] or ⌘← ⌘→ | Back / forward (macOS) |
| Alt+← Alt+→ | Back / forward (Windows, Linux) |

On Windows and Linux, use Ctrl where macOS uses ⌘. A two-finger swipe left or right on
a trackpad, and a mouse's back and forward buttons, also go back and forward.

## Security

### How your data is protected

```text
master password ──Argon2id──▶ password key ──┐
                                             ├─ each opens ──▶ vault key ──AES-256-GCM──▶ your data
recovery code   ──Argon2id──▶ recovery key ──┘
```

- Your data is encrypted with a random **vault key** (256 bits, AES-256-GCM). The vault
  key is stored twice, sealed once by your master password's key and once by your
  recovery code's key. Neither copy can be moved to the other's place.
- A key is made from your master password with **Argon2id** (64 MiB of memory, 3
  passes) and HKDF-SHA256. Every guess at your password costs an attacker that much
  work, which is what slows down guessing offline. A long password is still your best
  protection.
- The **recovery code** is 24 words from the BIP39 English list: 256 random bits and a
  checksum. Guessing it is out of reach (2²⁵⁶ possibilities), and each guess also costs
  a full Argon2id run.
- Changing the master password seals the same vault key with the new password's key:
  one small change, saved at once.
- Encryption happens in the Rust core. The key never reaches the web page, and is wiped
  on lock, page reload and exit.

### What is encrypted, and what isn't

| Encrypted | Stored as plain text |
|---|---|
| Account passwords | Website names, emails and usernames of accounts |
| Authenticator setup keys and recovery codes | Labels of sign-in steps |
| Secrets, files, and their descriptions | Names of secrets and files |
| Account secrets and notes | Project names and descriptions |
| Notes on account–device links | Service names and addresses (URL, host or IP) |
| Service roles, and services' own logins (username, password, note) | Device names and notes, groups, and which account links to which |

The plain-text column is what lets the app list and search your vault before you open
anything. It is still only in the vault file on your disk, but anyone who copies that
file can read it. The secrets themselves need your master password or recovery code.

### Safety measures

- **All or nothing.** Every change is one SQLite transaction. A crash, a forced quit or
  a power cut never leaves anything half written. On macOS, VaultKey asks the disk to
  flush its cache (F_FULLFSYNC) so a commit survives a power cut.
- **Verified backups** are written before every database upgrade and before the move to
  the vault key, checked, and only then given their final name.
- **One app at a time** can open the vault: a second copy shows "already open in
  another window".
- **No network.** The page's content security policy only lets it talk to the app's
  own Rust core.
- Copied secrets are marked as concealed, which keeps them out of clipboard history.

## Where your data is

| OS | Vault | Backups |
|---|---|---|
| macOS | `~/Library/Application Support/vaultkey/vaultkey.sqlite3` | `…/vaultkey/backups/` |
| Windows | `%APPDATA%\vaultkey\vaultkey.sqlite3` | `%APPDATA%\vaultkey\backups\` |
| Linux | `~/.config/vaultkey/vaultkey.sqlite3` | `~/.config/vaultkey/backups/` |

**Never delete the `vaultkey` folder**: it is your vault. Removing or reinstalling the
app doesn't touch it.

The backups are full copies of the vault as it was at the time, and open with the
master password that was current then. Delete old ones once you're sure you don't need
them, especially if you changed your password because the old one may be known to
someone.

To move to another computer, copy the `vaultkey` folder there while VaultKey is closed
on both machines. It opens with the same master password and recovery code.

## Build and run it

### What you need

On every system:

- **Rust 1.89 or newer**, from [rustup.rs](https://rustup.rs)
- **Node.js 20.19+ or 22.12+**, and **pnpm** (`npm install -g pnpm`, or `corepack enable`)

Then, depending on the system (the full list is in
[Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/)):

**macOS**: the Xcode command line tools.

```bash
xcode-select --install
```

**Windows**:

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),
  with **Desktop development with C++**.
- **WebView2**: already part of Windows 10 and 11.
- Rust's default MSVC toolchain, which rustup installs.

**Linux**: the WebKitGTK and build packages.

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
sudo dnf group install "c-development"

# Arch
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

### Run it in development

```bash
cd desktop
pnpm install            # the first time only
pnpm tauri dev          # the app, with hot reload
```

`pnpm tauri dev` **never touches your real vault**: development uses a vault of its own,
in a `vaultkey-dev` folder next to the real one (the path is printed when it starts).
To start from an empty vault in a folder of your choosing:

```bash
# macOS, Linux
VAULTKEY_DATA_DIR=~/vaultkey-test pnpm tauri dev
```

```powershell
# Windows (PowerShell)
$env:VAULTKEY_DATA_DIR = "$HOME\vaultkey-test"; pnpm tauri dev
```

Delete that folder to start over. Installed builds ignore `VAULTKEY_DATA_DIR`.

To try development on a copy of your real data (quit VaultKey first; the real vault is
only read):

```bash
pnpm vault:snapshot
pnpm tauri dev
```

### Build and install

```bash
cd desktop
pnpm tauri build
```

It builds an optimised app and its installers in `src-tauri/target/release/bundle/`:

| OS | Files | Install |
|---|---|---|
| macOS | `macos/VaultKey.app`, `dmg/VaultKey_<version>_<arch>.dmg` | Open the `.dmg` and drag VaultKey to Applications, or see below |
| Windows | `msi/*.msi`, `nsis/*-setup.exe` | Run either installer |
| Linux | `deb/*.deb`, `rpm/*.rpm`, `appimage/*.AppImage` | `sudo apt install ./<file>.deb`, `sudo dnf install ./<file>.rpm`, or make the AppImage executable and run it |

Builds are not signed with a developer certificate:

- **macOS, on another Mac:** open it the first time with right-click → Open, or System
  Settings → Privacy & Security → Open Anyway.
- **Windows:** SmartScreen may ask; choose More info → Run anyway.

### Updating an installed VaultKey safely

1. **Quit VaultKey.**
2. **Keep copies** of your vault folder ([where it is](#where-your-data-is)) and of the
   installed app, so you can go back:

   ```bash
   # macOS
   cp -Rp ~/Library/Application\ Support/vaultkey ~/Desktop/vaultkey-backup-$(date +%Y%m%d)
   ditto /Applications/VaultKey.app ~/Desktop/VaultKey-previous.app
   ```

3. **Rehearse** the new version's database upgrade on a throwaway copy of your vault.
   It must end with "✓ Safe to ship":

   ```bash
   pnpm vault:rehearse
   ```

4. **Build and install** (above). On macOS:

   ```bash
   pnpm tauri build
   rm -rf /Applications/VaultKey.app
   ditto src-tauri/target/release/bundle/macos/VaultKey.app /Applications/VaultKey.app
   open -a /Applications/VaultKey.app
   ```

5. **Unlock**, check a few accounts, secrets and files, then lock and unlock again.

To go back: quit, put the copied vault folder back in place of the new one, and
reinstall the copied app. (An older VaultKey refuses a vault upgraded by a newer one, to
protect it.) Delete the copies once you're confident: they open with your password.

## For developers

### Vault tools

| Command | What it does |
|---|---|
| `pnpm vault:where` | Prints where the real vault, its backups and the dev vault are |
| `pnpm vault:snapshot` | Copies the real vault into the dev vault, so dev shows your real data |
| `pnpm vault:snapshot --from <file>` | Puts a vault file from elsewhere into the dev vault (another computer, a backup) |
| `pnpm vault:rehearse` | Runs pending migrations on a throwaway copy of the real vault and proves nothing is lost |

These only *read* the real vault, and refuse to run while any app has it open. Every
copy is checked byte for byte, and the current dev vault is kept in
`vaultkey-dev/previous/` instead of being overwritten.

### Changing the database safely

1. **Append** a migration to `MIGRATIONS` in `src-tauri/src/db.rs`. Never edit, reorder
   or delete one that has shipped. Keep changes additive: new tables, or new columns
   with defaults.
2. **Classify every new column** in `src-tauri/src/rekey.rs`: `ENCRYPTED` if it holds a
   value sealed with the vault key, `PLAIN` otherwise. A test fails until you do, and
   the move to a vault key refuses a file with a column it doesn't know, so no
   encrypted value can be left behind.
3. **`cargo test`** (in `src-tauri`). `upgrades_and_opens_a_vault_written_by_the_electron_app`
   builds a vault exactly as the first Electron app wrote it, upgrades it with every
   migration, moves it to a vault key, and checks every original row survived and
   still decrypts.
4. **`pnpm vault:rehearse`** does the same check on a copy of *your* real vault.
5. Ship it. The first time the app opens the real vault, it writes an
   integrity-checked backup to `backups/`, then applies all pending migrations in one
   transaction.

The schema so far: v1 accounts (the Electron app), v2 projects, services, secrets and
account links, v3 devices, sign-in steps, account secrets and notes, v4 account groups,
v5 several accounts per service with roles, descriptions and device-link notes, v6
services' own logins, v7 the vault key's slots.

### Tests

```bash
cd src-tauri
cargo test -j 2
```

Among them:

- `crypto.rs` uses vectors generated by the Electron app's own code: if they fail,
  older vaults can't be opened.
- `rekey.rs` kills a real process in the middle of the move to a vault key and checks
  that the vault is exactly as it was.
- `recovery.rs` checks the official BIP39 test vectors.

To smoke-test against a **copy** of a real vault (never the live file):

```bash
cp ~/Library/Application\ Support/vaultkey/vaultkey.sqlite3 /tmp/vault-copy.sqlite3
VAULTKEY_COMPAT_DB=/tmp/vault-copy.sqlite3 cargo test real_vault_copy -- --ignored --nocapture
```

**Browser preview.** `pnpm dev` opened in a normal browser tab (not the app window) runs
on an in-memory mock with made-up data (`src/dev/mock-backend.ts`). A badge marks it,
and any master password works except `wrong`. It never runs inside the app and is not
part of builds. The screenshots in this README are taken from it, so they only ever
show that test data.

### Architecture

```text
React UI (src/)                 talks to Rust through invoke()
        │  Tauri IPC (main window only; strict CSP in builds)
Rust core (src-tauri/src/)
  commands.rs         IPC surface: trust check, runs work off the UI thread
  vault.rs            session (vault key in memory while unlocked) + every operation,
                      master password change, recovery code, the move to a vault key
  crypto.rs           Argon2id → HKDF → AES-256-GCM, key wrapping, scrypt verifier
  rekey.rs            moves every encrypted value to a new key, in one verified transaction
  recovery.rs         the 24-word recovery code (BIP39 words, checksum)
  store.rs            SQL: websites, accounts, the master password, key slots
  workspace.rs        SQL: projects, services (accounts, logins), secrets, files, links
  account_details.rs  SQL: devices, sign-in steps, account secrets and notes
  dotenv.rs           reads .env files into secrets
  totp.rs             authenticator codes (RFC 6238)
  db.rs               SQLite: WAL, FULL sync + fullfsync, migrations, verified backups
  validation.rs       input rules
  paths.rs            where the vault lives on each OS
src-tauri/search/     the search engine in Rust, for a future shared core (not linked into the app)
```

### Interface

VaultKey uses the DevNotes design language: one muted indigo accent, SF Pro (SF Mono
for secrets), Phosphor icons and frosted surfaces on a flat canvas, with the elevation
levels in `src/assets/main.css` (`.frost` for lists and panels, `.glass` for dropdowns,
`.glass-strong` for dialogs). Lists show their first items with a filter and "Show all"
so a project with 40 services or 50 secrets stays readable. Creating and editing happen
in one centred dialog at a time, and deleting always asks first, naming what goes with it.

The app icon's source is `src-tauri/icons/app-icon.svg`; regenerate every size with
`pnpm tauri icon src-tauri/icons/app-icon.svg`.
