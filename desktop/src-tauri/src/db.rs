//! The embedded SQLite database. Port of the Electron `database.ts`.
//!
//! Opens the *same* `vaultkey.sqlite3` file the Electron app created, with the same
//! pragmas, migration bookkeeping (`PRAGMA user_version`), pre-migration backups and
//! integrity checks. The schema below is byte-for-byte the Electron migration v1.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use rusqlite::config::DbConfig;
use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::{ErrorCode, VaultError, VaultResult};

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// The schema history. To change the database:
///
/// 1. **Append** a migration with the next version. Never edit, reorder or remove
///    one that has shipped: it has already run on real vaults.
/// 2. Keep it additive (new tables/columns with defaults). Existing rows must
///    survive untouched; `cargo test` and `pnpm vault:rehearse` check exactly that.
/// 3. On open, a vault older than the newest migration is first backed up to
///    `backups/` (and the backup integrity-checked), then all pending migrations
///    run in a single transaction: all of them apply, or none do.
///
/// A vault migrated past v1 can no longer be opened by the old Electron app (it
/// refuses newer schemas by design); its pre-migration backup still can.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial-local-vault",
        sql: r#"
      CREATE TABLE IF NOT EXISTS vault_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kdf_version INTEGER NOT NULL CHECK (kdf_version = 2),
        kdf_salt BLOB NOT NULL CHECK (length(kdf_salt) = 16),
        argon2_iterations INTEGER NOT NULL CHECK (argon2_iterations > 0),
        argon2_memory_size INTEGER NOT NULL CHECK (argon2_memory_size > 0),
        argon2_parallelism INTEGER NOT NULL CHECK (argon2_parallelism > 0),
        argon2_hash_length INTEGER NOT NULL CHECK (argon2_hash_length > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS auth_key (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        verifier_version INTEGER NOT NULL CHECK (verifier_version = 1),
        verifier_salt BLOB NOT NULL CHECK (length(verifier_salt) = 16),
        verifier BLOB NOT NULL CHECK (length(verifier) = 32),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER NOT NULL,
        username TEXT,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_time_used TEXT NOT NULL,
        FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE ON UPDATE CASCADE,
        UNIQUE (email, domain_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS credentials_domain_id_idx ON credentials(domain_id);
    "#,
    },
    Migration {
        version: 2,
        name: "projects-services-secrets-links",
        sql: include_str!("migrations/0002_projects.sql"),
    },
    Migration {
        version: 3,
        name: "devices-factors-account-secrets",
        sql: include_str!("migrations/0003_account_details.sql"),
    },
    Migration {
        version: 4,
        name: "account-categories",
        sql: include_str!("migrations/0004_account_categories.sql"),
    },
    Migration {
        version: 5,
        name: "service-accounts-roles-descriptions-device-notes",
        sql: include_str!("migrations/0005_roles_and_descriptions.sql"),
    },
    Migration {
        version: 6,
        name: "service-logins",
        sql: include_str!("migrations/0006_service_logins.sql"),
    },
    Migration {
        version: 7,
        name: "vault-key-slots",
        sql: include_str!("migrations/0007_vault_key.sql"),
    },
    Migration {
        version: 8,
        name: "browser-extension",
        sql: include_str!("migrations/0008_browser_extension.sql"),
    },
];

/// `new Date().toISOString()`, e.g. `2026-07-15T19:44:45.457Z`, the format already in the DB.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The Electron backup suffix: ISO time with `T : . Z` replaced by `-`, trailing `-` trimmed.
fn backup_timestamp() -> String {
    now_iso()
        .replace(['T', ':', '.', 'Z'], "-")
        .trim_end_matches('-')
        .to_owned()
}

/// Runs a statement and drains any rows, so row-returning pragmas
/// (`journal_mode`, `secure_delete`, …) behave like a plain `exec`.
fn exec_drain(conn: &Connection, sql: &str) -> rusqlite::Result<()> {
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query([])?;
    while rows.next()?.is_some() {}
    Ok(())
}

fn integrity_ok(conn: &Connection) -> rusqlite::Result<bool> {
    let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    Ok(result == "ok")
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) {}

/// Creates the database file as 0600 *before* SQLite opens it, so a brand-new vault is
/// never briefly world-readable. Never touches an existing file.
fn create_private_file_if_missing(path: &Path) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

pub struct VaultDatabase {
    conn: Connection,
    path: PathBuf,
}

impl VaultDatabase {
    pub fn open(path: &Path) -> VaultResult<Self> {
        Self::open_with(path, MIGRATIONS, None)
    }

    pub fn open_with(
        path: &Path,
        migrations: &[Migration],
        backup_directory: Option<&Path>,
    ) -> VaultResult<Self> {
        let directory = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(directory)?;
        restrict(directory, 0o700);
        create_private_file_if_missing(path)?;

        // If anything below fails, `database` is dropped and the connection closed.
        let mut database = Self {
            conn: Connection::open(path)?,
            path: path.to_path_buf(),
        };
        database.configure()?;
        let backups = backup_directory
            .map(Path::to_path_buf)
            .unwrap_or_else(|| directory.join("backups"));
        database.migrate(migrations, &backups)?;
        database.assert_integrity()?;
        restrict(path, 0o600);
        database.restrict_sidecars();
        Ok(database)
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// `BEGIN IMMEDIATE` … `COMMIT`; rolled back if `body` fails.
    pub fn transaction<T>(
        &mut self,
        body: impl FnOnce(&Transaction<'_>) -> VaultResult<T>,
    ) -> VaultResult<T> {
        let transaction = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = body(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    /// Checkpoints the WAL back into the main file, then closes. Mirrors `close()`.
    pub fn close(self) {
        let _ = exec_drain(&self.conn, "PRAGMA wal_checkpoint(TRUNCATE)");
        if let Err((_, error)) = self.conn.close() {
            eprintln!("[vault] database close failed: {error}");
        }
    }

    fn configure(&self) -> VaultResult<()> {
        // node:sqlite options: timeout 5000, double-quoted string literals disabled.
        self.conn.busy_timeout(Duration::from_millis(5000))?;
        self.conn
            .set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
        self.conn
            .set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
        for pragma in [
            "PRAGMA foreign_keys = ON",
            "PRAGMA journal_mode = WAL",
            "PRAGMA synchronous = FULL",
            // On macOS a plain fsync() leaves the data in the drive's cache: a power
            // loss could undo a commit, or tear a checkpoint. F_FULLFSYNC flushes it.
            "PRAGMA fullfsync = ON",
            "PRAGMA checkpoint_fullfsync = ON",
            "PRAGMA secure_delete = ON",
            "PRAGMA trusted_schema = OFF",
            "PRAGMA wal_autocheckpoint = 1000",
        ] {
            exec_drain(&self.conn, pragma)?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> VaultResult<i64> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    fn migrate(&mut self, migrations: &[Migration], backup_directory: &Path) -> VaultResult<()> {
        let current = self.schema_version()?;
        let target = migrations
            .iter()
            .map(|migration| migration.version)
            .max()
            .unwrap_or(0)
            .max(0);
        if current > target {
            return Err(VaultError::new(
                ErrorCode::DatabaseUnavailable,
                "The local vault is newer than this app.",
            ));
        }
        if current > 0 && current < target {
            // Never migrate (or back up) a vault that is already damaged.
            self.assert_integrity()?;
            self.create_verified_backup(backup_directory, &format!("vaultkey-v{current}-{}", backup_timestamp()))?;
        }

        let mut pending: Vec<&Migration> = migrations
            .iter()
            .filter(|migration| migration.version > current)
            .collect();
        if pending.is_empty() {
            return Ok(());
        }
        pending.sort_by_key(|migration| migration.version);
        self.transaction(|transaction| {
            for migration in pending {
                transaction.execute_batch(migration.sql).map_err(|error| {
                    VaultError::from(error).with_detail(format!(
                        "migration {} ({}) failed",
                        migration.version, migration.name
                    ))
                })?;
                // Integer formatting only; there is no injection surface here.
                transaction
                    .execute_batch(&format!("PRAGMA user_version = {}", migration.version))?;
            }
            Ok(())
        })
    }

    /// A verified copy of the whole vault as it is now, taken before a change that
    /// can't be undone otherwise: `vaultkey-before-<label>-<time>.sqlite3` in
    /// `directory`. Returns where it is.
    pub(crate) fn backup_before(&self, directory: &Path, label: &str) -> VaultResult<PathBuf> {
        self.create_verified_backup(directory, &format!("vaultkey-before-{label}-{}", backup_timestamp()))
    }

    /// Folds the WAL back into the main file and empties it, so pages written before
    /// (under an old key) don't linger beside it. Best effort.
    pub(crate) fn checkpoint(&self) {
        let _ = exec_drain(&self.conn, "PRAGMA wal_checkpoint(TRUNCATE)");
    }

    /// Written as `<prefix>.partial`, verified and flushed, then renamed: a file under
    /// the final name is always a complete, verified backup. A failed one is removed.
    fn create_verified_backup(&self, directory: &Path, prefix: &str) -> VaultResult<PathBuf> {
        fs::create_dir_all(directory)?;
        restrict(directory, 0o700);
        let partial = directory.join(format!("{prefix}.partial"));
        let backup_path = directory.join(format!("{prefix}.sqlite3"));
        let written = self.write_backup(&partial).and_then(|()| {
            fs::rename(&partial, &backup_path)?;
            // The rename itself reaches the disk.
            if let Ok(folder) = fs::File::open(directory) {
                let _ = folder.sync_all();
            }
            Ok(())
        });
        if let Err(error) = written {
            for suffix in ["", "-journal", "-wal", "-shm"] {
                let _ = fs::remove_file(directory.join(format!("{prefix}.partial{suffix}")));
            }
            return Err(error);
        }
        restrict(&backup_path, 0o600);
        Ok(backup_path)
    }

    fn write_backup(&self, path: &Path) -> VaultResult<()> {
        let target = path
            .to_str()
            .ok_or_else(|| VaultError::unavailable().with_detail("backup path is not UTF-8"))?;
        // VACUUM INTO refuses an existing file: a leftover from an interrupted run.
        let _ = fs::remove_file(path);
        // A consistent snapshot of the live database, taken through SQLite itself.
        self.conn.execute("VACUUM INTO ?1", [target])?;
        restrict(path, 0o600);
        {
            let backup = Connection::open(path)?;
            if !integrity_ok(&backup)? {
                return Err(VaultError::new(
                    ErrorCode::DatabaseUnavailable,
                    "The local vault backup failed integrity verification.",
                ));
            }
            exec_drain(&backup, "PRAGMA wal_checkpoint(TRUNCATE)")?;
            exec_drain(&backup, "PRAGMA journal_mode = DELETE")?;
        }
        // On disk (F_FULLFSYNC on macOS) before it gets its final name.
        fs::File::open(path)?.sync_all()?;
        Ok(())
    }

    pub(crate) fn assert_integrity(&self) -> VaultResult<()> {
        if !integrity_ok(&self.conn)? {
            return Err(VaultError::new(
                ErrorCode::DatabaseUnavailable,
                "The local vault failed integrity verification.",
            ));
        }
        Ok(())
    }

    fn restrict_sidecars(&self) {
        restrict(&sidecar(&self.path, "-wal"), 0o600);
        restrict(&sidecar(&self.path, "-shm"), 0o600);
    }
}

/// Proves a migration lost nothing: every row of every table in `before` (a copy
/// taken before migrating) must still exist in `after` with all of its original
/// columns byte-identical. New tables, new columns and new rows are fine.
/// Returns how many rows were checked, and a description of each problem found.
#[cfg(test)]
pub(crate) fn rows_missing_after_migration(
    before: &Path,
    after: &Connection,
) -> VaultResult<(i64, Vec<String>)> {
    let quote = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    let before_path = before
        .to_str()
        .ok_or_else(|| VaultError::unavailable().with_detail("path is not UTF-8"))?;
    after.execute("ATTACH DATABASE ?1 AS before", [before_path])?;

    let result = (|| -> VaultResult<(i64, Vec<String>)> {
        let tables: Vec<String> = after
            .prepare(
                "SELECT name FROM before.sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;

        let mut checked = 0;
        let mut problems = Vec::new();
        for table in tables {
            let columns_of = |schema: &str| -> rusqlite::Result<Vec<String>> {
                after
                    .prepare(&format!("PRAGMA {schema}.table_info({})", quote(&table)))?
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect()
            };
            let old_columns = columns_of("before")?;
            let new_columns = columns_of("main")?;
            if new_columns.is_empty() {
                problems.push(format!("table {table} was dropped"));
                continue;
            }
            let dropped: Vec<&String> = old_columns
                .iter()
                .filter(|c| !new_columns.contains(c))
                .collect();
            if !dropped.is_empty() {
                problems.push(format!("table {table} lost columns {dropped:?}"));
                continue;
            }
            let columns = old_columns
                .iter()
                .map(|c| quote(c))
                .collect::<Vec<_>>()
                .join(", ");
            let rows: i64 = after.query_row(
                &format!("SELECT COUNT(*) FROM before.{}", quote(&table)),
                [],
                |row| row.get(0),
            )?;
            let missing: i64 = after.query_row(
                &format!(
                    "SELECT COUNT(*) FROM (SELECT {columns} FROM before.{t} EXCEPT SELECT {columns} FROM main.{t})",
                    t = quote(&table)
                ),
                [],
                |row| row.get(0),
            )?;
            if missing > 0 {
                problems.push(format!(
                    "{missing} of {rows} rows in {table} changed or disappeared"
                ));
            }
            checked += rows;
        }
        Ok((checked, problems))
    })();

    after.execute_batch("DETACH DATABASE before")?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        (directory, path)
    }

    #[test]
    fn timestamps_match_javascript_to_iso_string() {
        let now = now_iso();
        assert_eq!(now.len(), "2026-07-15T19:44:45.457Z".len());
        assert!(now.ends_with('Z') && now.as_bytes()[10] == b'T' && now.as_bytes()[19] == b'.');
        let stamp = backup_timestamp();
        assert_eq!(stamp.len(), "2026-07-15-19-44-45-457".len());
        assert!(!stamp.contains(['T', ':', '.', 'Z']) && !stamp.ends_with('-'));
    }

    #[test]
    fn opens_with_the_expected_configuration() {
        let (_directory, path) = temp_db();
        let database = VaultDatabase::open(&path).unwrap();
        let conn = database.connection();
        let pragma = |name: &str| -> i64 {
            conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
                .unwrap()
        };
        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        assert_eq!(pragma("foreign_keys"), 1);
        assert_eq!(pragma("synchronous"), 2); // FULL
        assert_eq!(pragma("fullfsync"), 1);
        assert_eq!(pragma("checkpoint_fullfsync"), 1);
        assert_eq!(pragma("secure_delete"), 1);
        assert_eq!(pragma("trusted_schema"), 0);
        assert_eq!(pragma("user_version"), MIGRATIONS.last().unwrap().version);
        // Double-quoted string literals are rejected.
        assert!(conn.execute_batch(r#"SELECT "not a column""#).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        database.close();
    }

    #[test]
    fn backs_up_and_verifies_before_a_schema_migration() {
        let (directory, path) = temp_db();
        let initial = Migration {
            version: 1,
            name: "initial",
            sql: "CREATE TABLE values_table (value TEXT NOT NULL) STRICT;",
        };
        let next = Migration {
            version: 2,
            name: "add-column",
            sql: "ALTER TABLE values_table ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
        };
        let first = VaultDatabase::open_with(&path, std::slice::from_ref(&initial), None).unwrap();
        first
            .connection()
            .execute("INSERT INTO values_table (value) VALUES ('kept')", [])
            .unwrap();
        first.close();

        let migrated = VaultDatabase::open_with(&path, &[initial, next], None).unwrap();
        assert_eq!(migrated.schema_version().unwrap(), 2);
        migrated.close();

        let backups: Vec<_> = fs::read_dir(directory.path().join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "sqlite3"))
            .collect();
        assert_eq!(backups.len(), 1);
        let name = backups[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(name.starts_with("vaultkey-v1-"), "{name}");
        let backup = Connection::open(&backups[0]).unwrap();
        let version: i64 = backup
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let value: String = backup
            .query_row("SELECT value FROM values_table", [], |row| row.get(0))
            .unwrap();
        let journal: String = backup
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            (version, value.as_str(), journal.as_str()),
            (1, "kept", "delete")
        );
    }

    /// v5 on a vault written by v4: every service keeps its account (now its first in
    /// `service_accounts`), every other row is untouched, and a backup is made first.
    #[test]
    fn v5_keeps_each_services_account() {
        let (directory, path) = temp_db();
        let v4 = VaultDatabase::open_with(&path, &MIGRATIONS[..4], None).unwrap();
        v4.connection()
            .execute_batch(
                "INSERT INTO domains (name, created_at, updated_at) VALUES ('coolify.io', 't', 't');
                 INSERT INTO credentials (domain_id, username, email, password, created_at, updated_at, last_time_used)
                   VALUES (1, NULL, 'me@example.com', 'sealed', 't', 't', 't');
                 INSERT INTO projects (name, description, created_at, updated_at) VALUES ('Acme', '', 't', 't');
                 INSERT INTO services (project_id, name, url, account_id, created_at, updated_at)
                   VALUES (1, 'Coolify', '', 1, 't0', 't1'), (1, 'Vercel', '', NULL, 't', 't');
                 INSERT INTO secrets (project_id, service_id, kind, name, mime_type, size, payload, created_at, updated_at)
                   VALUES (1, 1, 'text', 'TOKEN', 'text/plain', 3, x'00', 't', 't');
                 INSERT INTO devices (name, kind, notes, created_at, updated_at) VALUES ('iPhone', 'phone', '', 't', 't');
                 INSERT INTO account_devices (account_id, device_id, created_at) VALUES (1, 1, 't');",
            )
            .unwrap();
        v4.close();

        let v5 = VaultDatabase::open(&path).unwrap();
        assert_eq!(v5.schema_version().unwrap(), MIGRATIONS.last().unwrap().version);
        let conn = v5.connection();
        let linked: Vec<(i64, i64, Option<Vec<u8>>, i64, String)> = conn
            .prepare("SELECT service_id, account_id, role, position, created_at FROM service_accounts")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(linked, vec![(1, 1, None, 0, "t0".to_owned())], "Coolify keeps its account; Vercel had none");
        let (old_column, description, note): (Option<i64>, Option<Vec<u8>>, Option<Vec<u8>>) = conn
            .query_row(
                "SELECT s.account_id, x.description, d.note
                 FROM services s, secrets x, account_devices d WHERE s.id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((old_column, description, note), (Some(1), None, None), "existing rows untouched");
        v5.close();
        assert!(directory.path().join("backups").read_dir().unwrap().next().is_some(), "backed up first");
    }

    #[test]
    fn refuses_a_database_from_a_newer_app() {
        let (_directory, path) = temp_db();
        VaultDatabase::open(&path).unwrap().close();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99").unwrap();
        drop(conn);
        let error = VaultDatabase::open(&path).err().unwrap();
        assert_eq!(error.message, "The local vault is newer than this app.");
    }

    #[test]
    fn a_failed_backup_leaves_the_schema_untouched() {
        let (directory, path) = temp_db();
        let initial = Migration {
            version: 1,
            name: "initial",
            sql: "CREATE TABLE values_table (value TEXT NOT NULL) STRICT;",
        };
        let next = Migration {
            version: 2,
            name: "add-column",
            sql: "ALTER TABLE values_table ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
        };
        VaultDatabase::open_with(&path, std::slice::from_ref(&initial), None)
            .unwrap()
            .close();
        let blocked = directory.path().join("backup-target");
        fs::write(&blocked, "not a directory").unwrap();

        let migrations = [initial, next];
        assert!(VaultDatabase::open_with(&path, &migrations, Some(&blocked)).is_err());
        let reopened = VaultDatabase::open_with(&path, &migrations[..1], None).unwrap();
        assert_eq!(reopened.schema_version().unwrap(), 1);
        reopened.close();
    }

    #[test]
    fn the_preservation_check_catches_lost_or_changed_data() {
        let directory = tempfile::tempdir().unwrap();
        let before = directory.path().join("before.sqlite3");
        let after = directory.path().join("after.sqlite3");
        let seed = "CREATE TABLE keep (id INTEGER PRIMARY KEY, secret BLOB, note TEXT) STRICT;
                    INSERT INTO keep VALUES (1, x'0102', 'a'), (2, NULL, 'b');
                    CREATE TABLE gone (id INTEGER PRIMARY KEY) STRICT;";
        Connection::open(&before)
            .unwrap()
            .execute_batch(seed)
            .unwrap();

        // An additive migration: new column, new table, new row. Nothing lost.
        let good = Connection::open(&after).unwrap();
        good.execute_batch(seed).unwrap();
        good.execute_batch(
            "ALTER TABLE keep ADD COLUMN extra TEXT NOT NULL DEFAULT '';
             CREATE TABLE fresh (id INTEGER PRIMARY KEY) STRICT;
             INSERT INTO keep (id, secret, note) VALUES (3, x'03', 'c');",
        )
        .unwrap();
        let (checked, problems) = rows_missing_after_migration(&before, &good).unwrap();
        assert_eq!((checked, problems.len()), (2, 0), "{problems:?}");

        // A destructive one: a changed byte, a dropped table and a dropped column.
        good.execute_batch(
            "UPDATE keep SET secret = x'0103' WHERE id = 1;
             DROP TABLE gone;
             ALTER TABLE keep DROP COLUMN note;",
        )
        .unwrap();
        let (_, problems) = rows_missing_after_migration(&before, &good).unwrap();
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("gone was dropped")));
        assert!(problems.iter().any(|p| p.contains("keep lost columns")));

        // Without the column drop, the changed byte alone is caught.
        let changed = Connection::open(directory.path().join("changed.sqlite3")).unwrap();
        changed.execute_batch(seed).unwrap();
        changed
            .execute("UPDATE keep SET secret = x'0103' WHERE id = 1", [])
            .unwrap();
        let (_, problems) = rows_missing_after_migration(&before, &changed).unwrap();
        assert_eq!(
            problems,
            vec!["1 of 2 rows in keep changed or disappeared".to_owned()]
        );
    }

    #[test]
    fn rolls_back_a_failed_migration() {
        let (_directory, path) = temp_db();
        let broken = Migration {
            version: 1,
            name: "broken",
            sql: "CREATE TABLE ok_table (id INTEGER) STRICT; THIS IS NOT SQL;",
        };
        assert!(VaultDatabase::open_with(&path, &[broken], None).is_err());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'ok_table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((version, tables), (0, 0));
    }
}
