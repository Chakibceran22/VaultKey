-- v3: everything else that gets you into an account, so none of it has to be
-- remembered: devices, second steps (authenticator apps, passkeys, security keys,
-- codes by text or email, sign-in prompts, recovery codes), secrets and notes
-- kept with an account, and the devices an account is signed in on.
-- Additive only: no existing table or row is touched.

-- A phone, computer, tablet or security key that accounts depend on.
-- kind is validated in code (phone, computer, tablet, security_key, other).
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- How an account is protected beyond its password.
--   kind      validated in code: authenticator, passkey, security_key, sms,
--             email, prompt, recovery_codes
--   label     what to show: the app's name, a phone number, where a passkey lives
--   device_id where it lives: the phone with the app, the key, the Mac
--   payload   iv || AES-256-GCM ciphertext || tag of its secret part, when it has
--             one (an authenticator's setup key, the recovery codes); else NULL
CREATE TABLE account_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  device_id INTEGER,
  payload BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX account_factors_account_id_idx ON account_factors(account_id);
CREATE INDEX account_factors_device_id_idx ON account_factors(device_id);

-- Secrets and notes kept with an account rather than a project: an API token, a
-- personal access token, answers to security questions. Sealed like project
-- secrets; size is the plaintext size in bytes.
CREATE TABLE account_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('secret', 'note')),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX account_secrets_account_id_idx ON account_secrets(account_id);

-- Devices an account is signed in on or trusts (the Apple ID on the iPhone).
CREATE TABLE account_devices (
  account_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id),
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX account_devices_device_id_idx ON account_devices(device_id);
