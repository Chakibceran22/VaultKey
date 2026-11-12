# VaultKey browser extension

Fills VaultKey logins on websites. The extension holds no vault data: it asks the
desktop app through `vaultkey-bridge`, a small native-messaging host
(`src-tauri/bridge/`), over a channel encrypted end to end (Noise KK) that the bridge
can't read.

**Status: M4 (domain smarts).** Pair a browser with VaultKey by comparing a 6-digit
code. Then click into a login field: a VaultKey key icon sits in the field, and a menu
under it lists that site's logins. Pick one (click, or ↑ ↓ Enter) and it's filled. The
toolbar popup lists them too (**Fill**, **Copy code**), and `⌘⇧L` fills when the page has
exactly one login for this exact site. VaultKey decides what matches (lookalike sites get
nothing), refuses clicks on a menu the page has hidden or covered, and lists every fill in
Settings → Browser extension → Recent fills. It locks itself after a few minutes without
use (1–60, in Settings → Background & auto-lock).

What M4 adds:

- **Shared logins.** Sites that share one account (Apple's list of related domains) offer
  it too, labelled "Saved for example.co.uk (shared login)". Like a sibling subdomain's
  login, it fills on a click; the menu opens by itself only for logins saved for exactly
  this site.
- **"Signs in with".** An account saved as signing in with Google (no password) shows as
  a hint, "Signs in with Google · you@gmail.com", with nothing to fill. On the site's
  login page, a small badge by its "Continue with Google" button says "You use Google
  here — you@gmail.com" (found by the button's words in English or French, by where it
  sends you, or as Google's sign-in iframe). The badge is display only: clicks go to the
  button. On Google's own sign-in page for, say, Vercel, the Google account you use there
  comes first: "You use this one for vercel.com".
- **Service logins** from VaultKey's Projects are offered like accounts, under the
  service's name.
- **Search, in the popup only.** Type under "Other logins" to find a login saved for any
  site, by name, website, email or username (at most 20). Using one on a page it isn't
  saved for takes a second, deliberate click: "Fill gitlab.com's login on example.org?".
  It fills only if the tab is still on that page, and VaultKey records it as a cross-site
  fill (a few a minute at most). Pages and the inline menu can't search.

## Run it (development, Brave / Chrome / Edge)

```bash
# 1. Build the dev bridge (a debug build, put where the app looks for it)
cd desktop && pnpm bridge:dev

# 2. Build the dev extension
cd extension && pnpm build:dev               # → .output/chrome-mv3-dev

# 3. Start VaultKey in dev mode (its own dev vault, never the real one)
cd .. && pnpm tauri dev
```

4. In VaultKey, unlock, open **Settings** (the gear button, or `⌘,`) → **Browser
   extension**, and **Turn on**. That registers the dev bridge with your installed
   browsers and starts listening. (`pnpm register-host` does the registration from the
   command line too.)
5. In Brave, open `brave://extensions` (Chrome: `chrome://extensions`), turn on
   **Developer mode**, click **Load unpacked**, and pick `desktop/extension/.output/chrome-mv3-dev`.
6. Click the VaultKey toolbar button, then **Connect to VaultKey**. VaultKey shows a
   dialog with a code: if it's the same as the popup's, click **Connect browser**.
   The popup turns to **Connected · Encrypted**.

Lock VaultKey and the popup says **Locked** at once; unlock and it reconnects by itself.
Settings lists paired browsers; **Disconnect** makes that browser pair again.

7. Open a site you have a login for (say github.com/login), click the VaultKey button,
   then **Fill**. Or press `⌘⇧L`. To try "signs in with": in VaultKey, save an account for
   vercel.com that signs in with your Google account, then open vercel.com/login. After an extension reload, reload the page too: the
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
