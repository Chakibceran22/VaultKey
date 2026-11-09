-- v2: projects, their services, encrypted secrets and files, and account links.
-- Additive only: no existing table or row is touched.

-- A project groups the services it runs on and the secrets it needs.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- A service a project uses (Coolify, Vercel, a database...), signed into with
-- one of the vault's accounts. The account stays when the service is removed.
CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  account_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE SET NULL,
  UNIQUE (project_id, name)
) STRICT;
CREATE INDEX services_project_id_idx ON services(project_id);
CREATE INDEX services_account_id_idx ON services(account_id);

-- Encrypted secrets: a text value (API key, token) or a whole file (SSH key,
-- certificate, .env). payload = iv || AES-256-GCM ciphertext || tag, under the
-- same vault key as passwords. size is the plaintext size in bytes.
CREATE TABLE secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  service_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'file')),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL CHECK (size >= 0),
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX secrets_project_id_idx ON secrets(project_id);
CREATE INDEX secrets_service_id_idx ON secrets(service_id);

-- Directed links between accounts: (vercel, google, 'sign_in') means the Vercel
-- account signs in with the Google account. kind is validated in code, so new
-- kinds need no table rebuild.
CREATE TABLE account_links (
  account_id INTEGER NOT NULL,
  linked_account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, linked_account_id, kind),
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (linked_account_id) REFERENCES credentials(id) ON DELETE CASCADE,
  CHECK (account_id <> linked_account_id)
) STRICT;
CREATE INDEX account_links_linked_account_id_idx ON account_links(linked_account_id);
