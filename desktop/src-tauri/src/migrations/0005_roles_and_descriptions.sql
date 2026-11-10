-- v5: a service uses several accounts, each with what it is for there ("admin",
-- "deploy only"); secrets and files get a description (what it's for, its scopes);
-- an account–device link gets a note ("mobile app + authenticator").
--
-- The new text is sealed with the vault key (AES-256-GCM, the format of every other
-- encrypted payload) before it is written: these notes describe privileges. NULL
-- means no note.
--
-- Additive only: every existing row survives untouched. services.account_id stays
-- (a column can't be dropped safely in place) and is kept equal to the service's
-- first account; service_accounts is what the app reads.

CREATE TABLE service_accounts (
  service_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  -- Sealed role, or NULL.
  role BLOB,
  -- Order shown; 0 is the main account.
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (service_id, account_id),
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX service_accounts_account_id_idx ON service_accounts(account_id);

-- Every service's one account so far becomes its first.
INSERT INTO service_accounts (service_id, account_id, role, position, created_at, updated_at)
  SELECT id, account_id, NULL, 0, created_at, updated_at
  FROM services
  WHERE account_id IS NOT NULL;

-- Sealed description of a secret or file, or NULL.
ALTER TABLE secrets ADD COLUMN description BLOB;

-- Sealed note on an account–device link, or NULL.
ALTER TABLE account_devices ADD COLUMN note BLOB;
