-- v6: a service can keep its own logins, for what has no account in the vault: a
-- private server's root or deploy user, a database user. Its address is the service's
-- URL field (a URL, a hostname or an IP).
--
-- Username, password and note are sealed with the vault key (AES-256-GCM, the format
-- of every other encrypted payload). NULL password: none (a user that signs in with an
-- SSH key); NULL note: none.
--
-- Additive only: one new table, every existing row untouched.

CREATE TABLE service_logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  -- Sealed username, never empty.
  username BLOB NOT NULL,
  -- Sealed password, or NULL.
  password BLOB,
  -- Sealed note ("root", "read-only"), or NULL.
  note BLOB,
  -- Order shown; 0 first.
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX service_logins_service_id_idx ON service_logins(service_id);
