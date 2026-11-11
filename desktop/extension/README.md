# VaultKey browser extension

Fills VaultKey logins on websites. The extension holds no vault data: it asks the
desktop app through `vaultkey-bridge`, a small native-messaging host
(`src-tauri/bridge/`), over a channel encrypted end to end (Noise KK) that the bridge
can't read.

**Status: M3 (inline, like Google's).** Pair a browser with VaultKey by comparing a
6-digit code. Then click into a login field: a VaultKey key icon sits in the field, and a
menu under it lists that site's logins. Pick one (click, or ↑ ↓ Enter) and it's filled.
The toolbar popup lists them too (**Fill**, **Copy code**), and `⌘⇧L` fills when the page
has exactly one login for this exact site. VaultKey decides what matches (lookalike sites
get nothing), refuses clicks on a menu the page has hidden or covered, and lists every fill
in Settings → Browser extension → Recent fills. It locks itself after 5 minutes without
use. Related domains and "signs in with Google" come in M4.

## Run it (development, Brave / Chrome / Edge)

```bash
# 1. Build the dev bridge (the app looks for it next to itself, in target/debug)
cd desktop/src-tauri && cargo build -p vaultkey-bridge -j 2

# 2. Build the dev extension
cd ../extension && pnpm build:dev            # → .output/chrome-mv3-dev

# 3. Start VaultKey in dev mode (its own dev vault, never the real one)
cd .. && pnpm tauri dev
```

4. In VaultKey, unlock, click the **puzzle-piece** button (Browser extension) and
   **Turn on**. That registers the dev bridge with your installed browsers and starts
   listening. (`pnpm register-host` does the registration from the command line too.)
5. In Brave, open `brave://extensions` (Chrome: `chrome://extensions`), turn on
   **Developer mode**, click **Load unpacked**, and pick `desktop/extension/.output/chrome-mv3-dev`.
6. Click the VaultKey toolbar button, then **Connect to VaultKey**. VaultKey shows a
   dialog with a code: if it's the same as the popup's, click **Connect browser**.
   The popup turns to **Connected · Encrypted**.

Lock VaultKey and the popup says **Locked** at once; unlock and it reconnects by itself.
Settings lists paired browsers; **Disconnect** makes that browser pair again.

7. Open a site you have a login for (say github.com/login), click the VaultKey button,
   then **Fill**. Or press `⌘⇧L`. After an extension reload, reload the page too: the
   content script only arrives in pages loaded after it.

The dev extension always has the ID in `dev-key.json` and the release build the one in
`release-key.json` (public keys only). Each flavor's bridge allows only its own ID, and
reaches only its own app. Undo a command-line registration with `pnpm unregister-host`.

## Tests

```bash
pnpm test         # extension (vitest): Noise against the Rust vectors, pairing and sessions against a fake VaultKey
pnpm typecheck
cd ../src-tauri && cargo test -p vaultkey-bridge -j 2   # bridge, server, Noise, registration, end to end
```

The Noise test vectors (`tests/fixtures/protocol/noise-kk.json`) are written by the
Rust side: after an intended change, run
`VAULTKEY_WRITE_FIXTURES=1 cargo test -p vaultkey-bridge noise`.
