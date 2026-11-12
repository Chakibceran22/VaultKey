-- v9: the app's own settings (extension/plans/06-desktop.md §3, background mode). Additive:
-- the table starts empty, and a missing key means its default.

-- One row per setting, as text: "keep_running" ("1" or "0"), "auto_lock_minutes" (1–60).
-- Nothing here is a secret, and nothing is sealed with the vault key: settings are read
-- before unlock (whether closing the window hides it, how soon the vault locks itself).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (length(value) <= 256),
  updated_at TEXT NOT NULL
) STRICT;
