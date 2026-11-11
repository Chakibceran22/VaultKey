-- v8: the browser extension (extension/plans/06-desktop.md). Additive: both tables start
-- empty, and nothing here changes until "Browser extension" is turned on in Settings.

-- VaultKey's own end of the extension's encrypted channel: one X25519 key pair, made the
-- first time the setting is turned on and kept when it's turned off (so browsers paired
-- before stay paired). `enabled` is read before unlock: whether to listen at all.
CREATE TABLE bridge_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  -- The X25519 private key, sealed with the vault key: iv || ciphertext || tag.
  private_key BLOB NOT NULL CHECK (length(private_key) = 60),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Browsers paired with the extension. The public key and name are sealed with the vault
-- key, like every other payload; nothing here is a secret on its own. `client_id` is how
-- a browser names itself when it opens a session: SHA-256(public key)[..16].
CREATE TABLE browser_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id BLOB NOT NULL UNIQUE CHECK (length(client_id) = 16),
  public_key BLOB NOT NULL CHECK (length(public_key) = 60),
  name BLOB NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
