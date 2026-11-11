//! Moving every encrypted value from one key to another: the one-time move of a vault
//! from a key made from its master password to a random vault key (`vault.rs`), and,
//! later, replacing the vault key.
//!
//! [`rekey`] runs inside the caller's SQLite transaction, so SQLite keeps all of it or
//! none of it: an error rolls it back, and a transaction cut short by a crash, a kill
//! or a power loss is rolled back the next time the file is opened (WAL, `synchronous
//! = FULL`, `fullfsync`, `db.rs`). There is never a vault half under each key.
//!
//! Before the transaction commits, every value is read back, decrypted with the new
//! key and compared (a hash keyed for this run) with what it held before; any
//! difference is an error, so it rolls back too. A value that can't be decrypted with
//! the current key stops everything; [`unreadable`] finds those beforehand, by name.
//!
//! The plaintext is moved as bytes, never decoded as text: an account password the
//! Electron app stored with a byte-order mark or invalid UTF-8 keeps its exact bytes.
//!
//! [`ENCRYPTED`] lists every encrypted column and [`PLAIN`] every other one. A test
//! checks that together they cover the schema the migrations build, and [`rekey`]
//! checks the live file's schema too, refusing a column it doesn't know.

use std::collections::BTreeSet;

use rusqlite::{Connection, params, types::Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::{self, KEY_LEN};
use crate::error::{VaultError, VaultResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// `iv || AES-256-GCM ciphertext || tag`, in a BLOB.
    Sealed,
    /// The same bytes, base64 in TEXT: account passwords, as the Electron app wrote them.
    Base64,
}

pub struct EncryptedColumn {
    pub table: &'static str,
    pub column: &'static str,
    pub format: Format,
    /// What it holds, for an error message.
    pub holds: &'static str,
}

const fn encrypted(table: &'static str, column: &'static str, format: Format, holds: &'static str) -> EncryptedColumn {
    EncryptedColumn { table, column, format, holds }
}

/// Every column that holds a value encrypted with the vault key. NULL means none.
pub const ENCRYPTED: &[EncryptedColumn] = &[
    encrypted("credentials", "password", Format::Base64, "an account password"),
    encrypted("secrets", "payload", Format::Sealed, "a secret or file"),
    encrypted("secrets", "description", Format::Sealed, "a secret's description"),
    encrypted("account_factors", "payload", Format::Sealed, "a sign-in step's key or codes"),
    encrypted("account_secrets", "payload", Format::Sealed, "an account's secret or note"),
    encrypted("account_devices", "note", Format::Sealed, "a device note"),
    encrypted("service_accounts", "role", Format::Sealed, "a service role"),
    encrypted("service_logins", "username", Format::Sealed, "a service login"),
    encrypted("service_logins", "password", Format::Sealed, "a service login's password"),
    encrypted("service_logins", "note", Format::Sealed, "a service login's note"),
    encrypted("bridge_settings", "private_key", Format::Sealed, "the browser extension's key"),
    encrypted("browser_clients", "public_key", Format::Sealed, "a paired browser's key"),
    encrypted("browser_clients", "name", Format::Sealed, "a paired browser's name"),
];

/// Every other column, by table: never encrypted with the vault key. (The KDF salts and
/// the verifier belong to the master password; `key_slots.wrapped_key` is the vault
/// key sealed by the password's or the recovery code's key, never by itself, and is
/// rewritten on purpose by `vault.rs`, never here.)
#[cfg_attr(not(test), allow(dead_code))]
pub const PLAIN: &[(&str, &[&str])] = &[
    (
        "vault_metadata",
        &[
            "id", "kdf_version", "kdf_salt", "argon2_iterations", "argon2_memory_size", "argon2_parallelism",
            "argon2_hash_length", "created_at", "updated_at",
        ],
    ),
    ("auth_key", &["id", "verifier_version", "verifier_salt", "verifier", "created_at", "updated_at"]),
    ("domains", &["id", "name", "created_at", "updated_at"]),
    ("credentials", &["id", "domain_id", "username", "email", "created_at", "updated_at", "last_time_used"]),
    ("projects", &["id", "name", "description", "created_at", "updated_at"]),
    ("services", &["id", "project_id", "name", "url", "account_id", "created_at", "updated_at"]),
    ("secrets", &["id", "project_id", "service_id", "kind", "name", "mime_type", "size", "created_at", "updated_at"]),
    ("account_links", &["account_id", "linked_account_id", "kind", "created_at"]),
    ("devices", &["id", "name", "kind", "notes", "created_at", "updated_at"]),
    ("account_factors", &["id", "account_id", "kind", "label", "device_id", "created_at", "updated_at"]),
    ("account_secrets", &["id", "account_id", "kind", "name", "size", "created_at", "updated_at"]),
    ("account_devices", &["account_id", "device_id", "created_at"]),
    ("account_categories", &["account_id", "name", "updated_at"]),
    ("service_accounts", &["service_id", "account_id", "position", "created_at", "updated_at"]),
    ("service_logins", &["id", "service_id", "position", "created_at", "updated_at"]),
    ("bridge_settings", &["id", "enabled", "created_at", "updated_at"]),
    ("browser_clients", &["id", "client_id", "created_at", "last_seen_at"]),
    (
        "key_slots",
        &[
            "kind", "kdf_salt", "argon2_iterations", "argon2_memory_size", "argon2_parallelism", "argon2_hash_length",
            "wrapped_key", "created_at", "updated_at",
        ],
    ),
];

fn rowids(tx: &Connection, column: &EncryptedColumn) -> VaultResult<Vec<i64>> {
    // Names come from the constants above, never from input.
    let sql = format!(
        "SELECT rowid FROM {} WHERE {} IS NOT NULL ORDER BY rowid",
        column.table, column.column
    );
    let ids = tx
        .prepare(&sql)?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ids)
}

fn read(tx: &Connection, column: &EncryptedColumn, rowid: i64) -> VaultResult<Value> {
    let sql = format!("SELECT {} FROM {} WHERE rowid = ?1", column.column, column.table);
    Ok(tx.query_row(&sql, [rowid], |row| row.get(0))?)
}

/// The exact plaintext bytes of a stored value.
fn open(column: &EncryptedColumn, value: &Value, key: &[u8; KEY_LEN]) -> VaultResult<Zeroizing<Vec<u8>>> {
    match (column.format, value) {
        (Format::Sealed, Value::Blob(sealed)) => crypto::decrypt_bytes(sealed, key),
        (Format::Base64, Value::Text(encoded)) => crypto::decrypt_base64_bytes(encoded, key),
        _ => Err(VaultError::internal("A stored value has an unexpected type.")),
    }
}

fn seal(column: &EncryptedColumn, plain: &[u8], key: &[u8; KEY_LEN]) -> VaultResult<Value> {
    Ok(match column.format {
        Format::Sealed => Value::Blob(crypto::encrypt_bytes(plain, key)?),
        Format::Base64 => Value::Text(crypto::encrypt_bytes_base64(plain, key)?),
    })
}

/// A hash of a value, keyed for one run: it shows two values are equal, and can't be
/// used to guess a short one (a PIN) from memory afterwards.
fn digest(run_key: &[u8; 32], plain: &[u8]) -> [u8; 32] {
    Sha256::new().chain_update(run_key).chain_update((plain.len() as u64).to_le_bytes()).chain_update(plain).finalize().into()
}

/// What a value belongs to, as the app names it: "github.com (me@example.com)".
fn label(conn: &Connection, column: &EncryptedColumn, rowid: i64) -> String {
    let sql = match column.table {
        "credentials" => "SELECT d.name || ' (' || c.email || ')' FROM credentials c JOIN domains d ON d.id = c.domain_id WHERE c.rowid = ?1",
        "secrets" => "SELECT s.name || ' in ' || p.name FROM secrets s JOIN projects p ON p.id = s.project_id WHERE s.rowid = ?1",
        "account_factors" => "SELECT f.kind || ' of ' || d.name FROM account_factors f JOIN credentials c ON c.id = f.account_id JOIN domains d ON d.id = c.domain_id WHERE f.rowid = ?1",
        "account_secrets" => "SELECT a.name || ' of ' || d.name FROM account_secrets a JOIN credentials c ON c.id = a.account_id JOIN domains d ON d.id = c.domain_id WHERE a.rowid = ?1",
        "account_devices" => "SELECT d.name || ' on ' || v.name FROM account_devices a JOIN credentials c ON c.id = a.account_id JOIN domains d ON d.id = c.domain_id JOIN devices v ON v.id = a.device_id WHERE a.rowid = ?1",
        "service_accounts" => "SELECT d.name || ' in ' || s.name FROM service_accounts a JOIN services s ON s.id = a.service_id JOIN credentials c ON c.id = a.account_id JOIN domains d ON d.id = c.domain_id WHERE a.rowid = ?1",
        "service_logins" => "SELECT s.name FROM service_logins l JOIN services s ON s.id = l.service_id WHERE l.rowid = ?1",
        _ => "SELECT NULL",
    };
    conn.query_row(sql, [rowid], |row| row.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .unwrap_or_else(|| format!("row {rowid} of {}", column.table))
}

fn unreadable_error(conn: &Connection, column: &EncryptedColumn, rowid: i64) -> VaultError {
    VaultError::internal(format!(
        "{} can't be decrypted with the current key ({}), so nothing was changed. Delete or re-enter it, then try again.",
        capitalized(column.holds),
        label(conn, column, rowid)
    ))
}

/// Every value that doesn't open with `key`, named (read-only): checked before a
/// backup is taken and a move attempted.
pub fn unreadable(conn: &Connection, key: &[u8; KEY_LEN]) -> VaultResult<Vec<String>> {
    let mut found = Vec::new();
    for column in ENCRYPTED {
        for rowid in rowids(conn, column)? {
            if open(column, &read(conn, column, rowid)?, key).is_err() {
                found.push(format!("{}: {}", capitalized(column.holds), label(conn, column, rowid)));
            }
        }
    }
    Ok(found)
}

/// Refuses a file whose schema has a column neither list knows: it might hold
/// ciphertext that a move would leave behind under the old key.
pub(crate) fn check_schema(conn: &Connection) -> VaultResult<()> {
    let mut known = BTreeSet::new();
    for column in ENCRYPTED {
        known.insert((column.table.to_owned(), column.column.to_owned()));
    }
    for (table, columns) in PLAIN {
        for column in *columns {
            known.insert(((*table).to_owned(), (*column).to_owned()));
        }
    }
    let live: Vec<(String, String)> = conn
        .prepare(
            "SELECT t.name, c.name FROM sqlite_schema t, pragma_table_info(t.name) c
             WHERE t.type = 'table' AND t.name NOT LIKE 'sqlite_%'",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if let Some((table, column)) = live.iter().find(|c| !known.contains(*c)) {
        return Err(VaultError::internal(format!(
            "The vault has a column this app doesn't know ({table}.{column}), so its encryption wasn't changed."
        )));
    }
    Ok(())
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

fn verification_failed() -> VaultError {
    VaultError::internal("The re-encrypted vault didn't verify, so nothing was changed.")
}

/// Re-encrypts every encrypted value from `old` to `new`, inside `tx` (which the
/// caller commits, or rolls back on an error). Returns how many values it moved.
pub fn rekey(tx: &Connection, old: &[u8; KEY_LEN], new: &[u8; KEY_LEN]) -> VaultResult<usize> {
    check_schema(tx)?;
    let run_key: Zeroizing<[u8; 32]> = Zeroizing::new(crypto::random_bytes());
    // What each value held, by column and row, in a fixed order.
    let mut before: Zeroizing<Vec<(usize, i64, [u8; 32])>> = Zeroizing::new(Vec::new());
    for (index, column) in ENCRYPTED.iter().enumerate() {
        for rowid in rowids(tx, column)? {
            let plain = open(column, &read(tx, column, rowid)?, old).map_err(|_| unreadable_error(tx, column, rowid))?;
            before.push((index, rowid, digest(&run_key, &plain)));
            let sealed = seal(column, &plain, new)?;
            let sql = format!("UPDATE {} SET {} = ?1 WHERE rowid = ?2", column.table, column.column);
            if tx.execute(&sql, params![sealed, rowid])? != 1 {
                return Err(verification_failed());
            }
            #[cfg(test)]
            hooks::after_value(before.len())?;
        }
    }
    // Read everything back: each value must open with the new key to exactly what it
    // held, and nothing may be missing or extra.
    let mut after: Zeroizing<Vec<(usize, i64, [u8; 32])>> = Zeroizing::new(Vec::with_capacity(before.len()));
    for (index, column) in ENCRYPTED.iter().enumerate() {
        for rowid in rowids(tx, column)? {
            let plain = open(column, &read(tx, column, rowid)?, new).map_err(|_| verification_failed())?;
            after.push((index, rowid, digest(&run_key, &plain)));
        }
    }
    if *before != *after {
        return Err(verification_failed());
    }
    Ok(before.len())
}

/// Test-only fault injection, per thread (tests run in parallel threads).
#[cfg(test)]
pub(crate) mod hooks {
    use std::cell::Cell;
    use std::path::PathBuf;

    use crate::error::{VaultError, VaultResult};

    thread_local! {
        /// Fail once this many values were re-encrypted (0: never).
        pub static FAIL_AFTER: Cell<usize> = const { Cell::new(0) };
        /// Once this many values were re-encrypted, create this file and hang, for a
        /// test to kill the process mid-transaction.
        pub static HANG_AFTER: std::cell::RefCell<Option<(usize, PathBuf)>> = const { std::cell::RefCell::new(None) };
    }

    pub fn after_value(done: usize) -> VaultResult<()> {
        if FAIL_AFTER.get() == done {
            return Err(VaultError::internal("injected failure"));
        }
        HANG_AFTER.with_borrow(|hang| {
            if let Some((after, marker)) = hang
                && *after == done
            {
                std::fs::write(marker, b"inside the transaction").expect("marker");
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                }
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use rusqlite::{Connection, types::Value};

    use super::*;
    use crate::db::VaultDatabase;
    use crate::error::ErrorCode;
    use crate::store;
    use crate::validation::{
        AccountSecretInput, CredentialInput, DeviceInput, DeviceLinkInput, FactorInput, ProjectInput,
        SecretInput, ServiceAccountInput, ServiceInput, ServiceLoginInput, StagedFileInput,
    };
    use crate::vault::{PASSWORD_LABEL, RecoveryAnswer, Vault};

    const OLD: &str = "correct horse battery staple";
    const NEW: &str = "a different passphrase entirely";

    fn db(directory: &Path) -> PathBuf {
        directory.join("vaultkey.sqlite3")
    }

    /// A vault with at least one value in every encrypted column, some NULLs and a
    /// file; `legacy`: as before v7, its data under the password's key.
    fn populated(directory: &Path, file_bytes: usize, legacy: bool) -> (Vault, i64) {
        let vault = Vault::open(db(directory));
        vault.create_vault(OLD).unwrap();
        assert!(vault.unlock(OLD).unwrap().valid);
        if legacy {
            vault.make_legacy(OLD);
        }
        let credential = |vault: &Vault, site: &str, password: &str| {
            let domain = vault.create_domain(site).unwrap();
            vault
                .create_credential(CredentialInput {
                    domain_id: domain,
                    username: Some("me".into()),
                    email: format!("me@{site}"),
                    password: password.into(),
                })
                .unwrap()
        };
        let github = credential(&vault, "github.com", "hunter2");
        let google = credential(&vault, "google.com", "");
        let factor = |kind: &str, secret: Option<&str>| FactorInput {
            kind: kind.into(),
            label: String::new(),
            device_id: None,
            secret: secret.map(Into::into),
        };
        vault.create_factor(github, factor("recovery_codes", Some("aaaa-bbbb cccc-dddd"))).unwrap();
        vault.create_factor(github, factor("passkey", None)).unwrap();
        vault
            .create_account_secret(github, AccountSecretInput { kind: "note".into(), name: "PIN".into(), value: "4421".into() })
            .unwrap();
        let phone = vault
            .create_device(&DeviceInput { name: "iPhone".into(), kind: "phone".into(), notes: "plain".into() })
            .unwrap();
        vault
            .set_account_connections(github, &[google], &[google], &[DeviceLinkInput { device_id: phone, note: "authenticator".into() }])
            .unwrap();
        let project = vault.create_project(&ProjectInput { name: "Shaba".into(), description: String::new() }).unwrap();
        vault
            .create_service(
                project,
                &ServiceInput {
                    name: "Prod server".into(),
                    url: "203.0.113.7:22".into(),
                    accounts: vec![ServiceAccountInput { account_id: github, role: "admin".into() }],
                    logins: vec![
                        ServiceLoginInput { id: None, username: "root".into(), password: Some("r00t".into()), note: "ssh".into() },
                        ServiceLoginInput { id: None, username: "deploy".into(), password: None, note: String::new() },
                    ],
                },
            )
            .unwrap();
        let secret = vault
            .create_text_secret(
                project,
                SecretInput { name: "STRIPE".into(), value: "sk_live_1".into(), service_id: None, description: "payments".into() },
            )
            .unwrap();
        let file = directory.join("id_ed25519");
        let bytes: Vec<u8> = (0..file_bytes).map(|i| (i * 7 + 3) as u8).collect();
        std::fs::write(&file, bytes).unwrap();
        let token = vault.stage_files(vec![file]).unwrap().files[0].token;
        vault
            .import_staged(project, None, &[StagedFileInput { token, description: "deploy key".into(), name: None }])
            .unwrap();
        vault.set_bridge_enabled(true).unwrap();
        vault.pair_browser(&vaultkey_bridge::noise::public_key(&[5; 32]), "Brave on macOS").unwrap();
        (vault, secret)
    }

    /// The key made from a master password (what data was under before v7).
    fn password_key(path: &Path, password: &str) -> crypto::SecretKey {
        let conn = Connection::open(path).unwrap();
        let kdf = store::read_kdf(&conn).unwrap().unwrap();
        crypto::derive_keys(password, &kdf).unwrap().encryption_key
    }

    /// The vault key, opened with a master password.
    fn vault_key(path: &Path, password: &str) -> crypto::SecretKey {
        let conn = Connection::open(path).unwrap();
        let slot = store::read_slot(&conn, store::PASSWORD_SLOT).unwrap().expect("a vault key");
        crypto::unwrap_key(&slot.wrapped, &password_key(path, password), PASSWORD_LABEL).unwrap()
    }

    type Plain = Vec<(&'static str, &'static str, i64, Vec<u8>)>;

    /// Every encrypted value's plaintext bytes, opened with `key`.
    fn plaintexts(path: &Path, key: &[u8; KEY_LEN]) -> Plain {
        let conn = Connection::open(path).unwrap();
        let mut out = Vec::new();
        for column in ENCRYPTED {
            for rowid in rowids(&conn, column).unwrap() {
                let plain = open(column, &read(&conn, column, rowid).unwrap(), key)
                    .unwrap_or_else(|_| panic!("{}.{} row {rowid} doesn't open", column.table, column.column));
                out.push((column.table, column.column, rowid, plain.to_vec()));
            }
        }
        out
    }

    fn dump(path: &Path, queries: &[String]) -> Vec<String> {
        let conn = Connection::open(path).unwrap();
        let mut out = Vec::new();
        for sql in queries {
            let mut statement = conn.prepare(sql).unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    Ok((0..columns).map(|i| format!("{:?}", row.get::<_, Value>(i).unwrap())).collect::<Vec<_>>().join("|"))
                })
                .unwrap();
            out.extend(rows.map(Result::unwrap).map(|row| format!("{sql}: {row}")));
        }
        out
    }

    /// The stored bytes of every encrypted value.
    fn data(path: &Path) -> Vec<String> {
        let queries: Vec<String> =
            ENCRYPTED.iter().map(|c| format!("SELECT rowid, {} FROM {} ORDER BY rowid", c.column, c.table)).collect();
        dump(path, &queries)
    }

    /// Everything a change of keys could touch: the data and every key's row.
    fn raw(path: &Path) -> Vec<String> {
        let mut out = dump(
            path,
            &["SELECT * FROM vault_metadata".into(), "SELECT * FROM auth_key".into(), "SELECT * FROM key_slots ORDER BY kind".into()],
        );
        out.extend(data(path));
        out
    }

    fn backups(directory: &Path) -> Vec<String> {
        std::fs::read_dir(directory.join("backups"))
            .map(|entries| entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.contains("vault-key")).collect())
            .unwrap_or_default()
    }

    #[test]
    fn every_column_of_the_schema_is_classified() {
        let directory = tempfile::tempdir().unwrap();
        let database = VaultDatabase::open(&db(directory.path())).unwrap();
        let conn = database.connection();
        check_schema(conn).unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut schema = BTreeSet::new();
        for table in &tables {
            let columns: Vec<String> = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            schema.extend(columns.into_iter().map(|column| (table.clone(), column)));
        }
        let mut listed = BTreeSet::new();
        for column in ENCRYPTED {
            assert!(listed.insert((column.table.to_owned(), column.column.to_owned())), "{}.{} listed twice", column.table, column.column);
        }
        for (table, columns) in PLAIN {
            for column in *columns {
                assert!(listed.insert(((*table).to_owned(), (*column).to_owned())), "{table}.{column} listed twice");
            }
        }
        let unlisted: Vec<_> = schema.difference(&listed).collect();
        let missing: Vec<_> = listed.difference(&schema).collect();
        assert!(
            unlisted.is_empty() && missing.is_empty(),
            "a new column must be listed in rekey.rs, as ENCRYPTED or PLAIN: unlisted {unlisted:?}, not in the schema {missing:?}"
        );
        // And a live file with an unknown column is refused.
        conn.execute_batch("ALTER TABLE devices ADD COLUMN sealed_extra BLOB").unwrap();
        assert!(check_schema(conn).unwrap_err().message.contains("devices.sealed_extra"));
    }

    #[test]
    fn a_new_vault_has_a_vault_key_from_the_start() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, _) = populated(directory.path(), 64, false);
        let key = vault_key(&path, OLD);
        assert!(!crypto::same_key(&key, &password_key(&path, OLD)));
        let plain = plaintexts(&path, &key);
        assert!(plain.len() >= 16);
        assert!(unreadable(&Connection::open(&path).unwrap(), &password_key(&path, OLD)).unwrap().len() == plain.len());
        let status = vault.security_status().unwrap();
        assert!(status.vault_key && !status.recovery_code && status.waiting_on.is_empty());
    }

    #[test]
    fn the_first_unlock_moves_an_old_vault_to_a_vault_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, secret) = populated(directory.path(), 4096, true);
        let before = plaintexts(&path, &password_key(&path, OLD));
        for column in ENCRYPTED {
            assert!(before.iter().any(|(t, c, _, _)| *t == column.table && *c == column.column), "no {}.{} in the test data", column.table, column.column);
        }
        assert!(!vault.security_status().unwrap().vault_key);

        vault.lock();
        let unlocked = vault.unlock(OLD).unwrap();
        assert!(unlocked.valid);
        let backup = PathBuf::from(unlocked.upgraded_backup.expect("it moved"));
        assert_eq!(plaintexts(&path, &vault_key(&path, OLD)), before, "every value, byte for byte");
        let conn = Connection::open(&path).unwrap();
        assert_eq!(unreadable(&conn, &password_key(&path, OLD)).unwrap().len(), before.len(), "nothing opens with the old key");
        assert_eq!(vault.reveal_secret(secret).unwrap().value, "sk_live_1");
        assert!(vault.security_status().unwrap().vault_key);

        // The backup is the vault as it was, under its password's key.
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("vaultkey-before-vault-key-"));
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::copy(&backup, db(elsewhere.path())).unwrap();
        assert_eq!(plaintexts(&db(elsewhere.path()), &password_key(&db(elsewhere.path()), OLD)), before);

        // Only once.
        vault.lock();
        assert!(vault.unlock(OLD).unwrap().upgraded_backup.is_none());
        assert_eq!(backups(directory.path()).len(), 1);
    }

    #[test]
    fn a_failure_midway_leaves_the_old_vault_and_no_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, secret) = populated(directory.path(), 4096, true);
        vault.lock();
        let stored = raw(&path);
        hooks::FAIL_AFTER.set(5);
        let failed = vault.unlock(OLD);
        hooks::FAIL_AFTER.set(0);
        assert!(failed.unwrap_err().message.contains("nothing was changed"));
        assert_eq!(raw(&path), stored, "not one byte changed");
        assert!(backups(directory.path()).is_empty(), "no copy left behind");
        assert!(vault.unlock(OLD).unwrap().upgraded_backup.is_some(), "it moves on the next try");
        assert_eq!(vault.reveal_secret(secret).unwrap().value, "sk_live_1");
    }

    #[test]
    fn an_unreadable_value_keeps_the_old_encryption_and_says_which() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, secret) = populated(directory.path(), 64, true);
        vault.lock();
        {
            let conn = Connection::open(&path).unwrap();
            let mut payload: Vec<u8> = conn.query_row("SELECT payload FROM secrets WHERE id = ?1", [secret], |r| r.get(0)).unwrap();
            *payload.last_mut().unwrap() ^= 1;
            conn.execute("UPDATE secrets SET payload = ?1 WHERE id = ?2", rusqlite::params![payload, secret]).unwrap();
        }
        let stored = raw(&path);
        let unlocked = vault.unlock(OLD).unwrap();
        assert!(unlocked.valid && unlocked.upgraded_backup.is_none(), "it unlocks as before");
        assert_eq!(raw(&path), stored);
        assert!(backups(directory.path()).is_empty());
        let status = vault.security_status().unwrap();
        assert!(!status.vault_key);
        assert_eq!(status.waiting_on, ["A secret or file: STRIPE in Shaba"]);
        assert!(vault.change_master_password(OLD, NEW).unwrap_err().message.contains("hasn’t moved"));
        assert!(vault.new_recovery_code().is_err());
    }

    #[test]
    fn keeps_the_exact_bytes_of_an_electron_era_password() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, _) = populated(directory.path(), 16, true);
        // A byte-order mark and invalid UTF-8: decrypting as text would change them.
        let odd = b"\xEF\xBB\xBFpa\xFFss".to_vec();
        {
            let conn = Connection::open(&path).unwrap();
            let sealed = crypto::encrypt_bytes_base64(&odd, &password_key(&path, OLD)).unwrap();
            conn.execute("UPDATE credentials SET password = ?1 WHERE id = 1", [sealed]).unwrap();
        }
        vault.lock();
        assert!(vault.unlock(OLD).unwrap().upgraded_backup.is_some());
        let conn = Connection::open(&path).unwrap();
        let stored: String = conn.query_row("SELECT password FROM credentials WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(crypto::decrypt_base64_bytes(&stored, &vault_key(&path, OLD)).unwrap().to_vec(), odd);
    }

    #[test]
    fn changing_the_password_rewraps_only_the_vault_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, secret) = populated(directory.path(), 4096, false);
        let key = vault_key(&path, OLD);
        let stored = data(&path);
        vault.change_master_password(OLD, NEW).unwrap();
        assert_eq!(data(&path), stored, "no value rewritten");
        assert!(crypto::same_key(&vault_key(&path, NEW), &key), "the same vault key, now under the new password");
        assert_eq!(vault.reveal_secret(secret).unwrap().value, "sk_live_1");
        vault.lock();
        assert!(!vault.unlock(OLD).unwrap().valid);
        assert!(vault.unlock(NEW).unwrap().valid);
        assert_eq!(vault.reveal_secret(secret).unwrap().value, "sk_live_1");
        assert!(backups(directory.path()).is_empty(), "no backup needed");
    }

    #[test]
    fn refuses_a_wrong_same_or_short_password_and_a_locked_vault() {
        let directory = tempfile::tempdir().unwrap();
        let (vault, _) = populated(directory.path(), 16, false);
        let stored = raw(&db(directory.path()));
        let code = |result: VaultResult<()>| result.unwrap_err().code;
        assert_eq!(code(vault.change_master_password("not the password", NEW)), ErrorCode::AuthFailed);
        assert_eq!(code(vault.change_master_password(OLD, OLD)), ErrorCode::InvalidInput);
        assert_eq!(code(vault.change_master_password(OLD, "short")), ErrorCode::InvalidInput);
        vault.lock();
        assert_eq!(code(vault.change_master_password(OLD, NEW)), ErrorCode::VaultLocked);
        assert_eq!(raw(&db(directory.path())), stored);
    }

    #[test]
    fn a_recovery_code_resets_a_forgotten_password() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        let (vault, secret) = populated(directory.path(), 64, false);
        let stored = data(&path);
        let words = vault.new_recovery_code().unwrap().words;
        assert_eq!(words.len(), 24);
        let answer = |position: usize, word: &str| RecoveryAnswer { position, word: word.into() };
        let right = || vec![answer(1, &words[0]), answer(12, &words[11].to_uppercase()), answer(24, &words[23])];

        // Not saved with a wrong word, too few words, or the wrong master password.
        let wrong_word = vec![answer(1, &words[0]), answer(12, "zoo"), answer(24, &words[23])];
        assert_eq!(vault.save_recovery_code(OLD, &wrong_word).unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(vault.save_recovery_code(OLD, &right()[..2]).unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(vault.save_recovery_code("not the password", &right()).unwrap_err().code, ErrorCode::AuthFailed);
        assert!(!vault.status().unwrap().recovery_code);
        vault.save_recovery_code(OLD, &right()).unwrap();
        assert!(vault.status().unwrap().recovery_code);
        assert!(vault.security_status().unwrap().recovery_code);

        // The password is forgotten.
        vault.lock();
        let code = words.join(" ");
        let (other, _) = crate::recovery::generate();
        assert_eq!(vault.recover(&other.join(" "), NEW).unwrap_err().code, ErrorCode::AuthFailed);
        let mut typo = words.clone();
        typo[3] = "zzzz".into();
        assert_eq!(vault.recover(&typo.join(" "), NEW).unwrap_err().code, ErrorCode::InvalidInput);
        assert!(vault.reveal_secret(secret).is_err(), "still locked");
        vault.recover(&code, NEW).unwrap();
        assert_eq!(vault.reveal_secret(secret).unwrap().value, "sk_live_1", "unlocked");
        vault.lock();
        assert!(!vault.unlock(OLD).unwrap().valid);
        assert!(vault.unlock(NEW).unwrap().valid);

        // It survives a password change, and the data never moved.
        vault.change_master_password(NEW, "a third passphrase here").unwrap();
        vault.lock();
        vault.recover(&code, "and a fourth passphrase").unwrap();
        assert_eq!(vault.reveal_secret(secret).unwrap().value, "sk_live_1");
        assert_eq!(data(&path), stored);
        vault.lock();
        assert!(vault.unlock("and a fourth passphrase").unwrap().valid);
    }

    /// Kills a real process inside the move to a vault key (SIGKILL: no cleanup, no
    /// rollback code runs) and opens what it left on disk.
    #[test]
    fn a_crash_inside_the_move_leaves_the_old_vault() {
        let directory = tempfile::tempdir().unwrap();
        let path = db(directory.path());
        // A file larger than SQLite's page cache, so the transaction's pages spill
        // into the WAL before the crash: the hard case.
        let (vault, _) = populated(directory.path(), 6 * 1024 * 1024, true);
        let before = plaintexts(&path, &password_key(&path, OLD));
        drop(vault);
        let stored = raw(&path);

        let marker = directory.path().join("inside");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["rekey::tests::crash_child", "--exact", "--ignored", "--test-threads=1"])
            .env("VK_REKEY_CRASH_DB", &path)
            .env("VK_REKEY_CRASH_MARKER", &marker)
            .env("VK_REKEY_CRASH_AFTER", (before.len() - 1).to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !marker.exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("the child ended before the crash point: {status}");
            }
            assert!(started.elapsed() < Duration::from_secs(120), "the child never reached the crash point");
            std::thread::sleep(Duration::from_millis(50));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let wal = std::fs::metadata(directory.path().join("vaultkey.sqlite3-wal")).map_or(0, |m| m.len());
        assert!(wal > 0, "the killed transaction left pages in the WAL");

        // What the killed process left: the vault exactly as it was.
        assert_eq!(raw(&path), stored);
        let vault = Vault::open(path.clone());
        assert!(vault.unlock(OLD).unwrap().upgraded_backup.is_some(), "and it moves at the next unlock");
        assert_eq!(plaintexts(&path, &vault_key(&path, OLD)), before);
    }

    /// Run by the test above, in a process of its own, which it kills.
    #[test]
    #[ignore = "run by a_crash_inside_the_move_leaves_the_old_vault"]
    fn crash_child() {
        let (Ok(path), Ok(marker), Ok(after)) = (
            std::env::var("VK_REKEY_CRASH_DB"),
            std::env::var("VK_REKEY_CRASH_MARKER"),
            std::env::var("VK_REKEY_CRASH_AFTER"),
        ) else {
            return;
        };
        let vault = Vault::open(PathBuf::from(path));
        hooks::HANG_AFTER.with_borrow_mut(|hang| *hang = Some((after.parse().unwrap(), PathBuf::from(marker))));
        let _ = vault.unlock(OLD);
        unreachable!("the parent kills this process inside the transaction");
    }
}
