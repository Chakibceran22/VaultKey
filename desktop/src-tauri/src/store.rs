//! SQL for metadata, auth, domains and credentials. Port of the Electron
//! `auth-service.ts`, `domain-service.ts` and `credential-service.ts` queries.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::crypto::{
    DEFAULT_ARGON2_HASH_LENGTH, DEFAULT_ARGON2_ITERATIONS, DEFAULT_ARGON2_MEMORY_KIB,
    DEFAULT_ARGON2_PARALLELISM, KDF_VERSION, KdfParams, SALT_LEN, VERIFIER_LEN, VERIFIER_VERSION,
};
use crate::db::{VaultDatabase, now_iso};
use crate::error::{VaultError, VaultResult};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DomainRecord {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(rename = "_count")]
    pub count: DomainCount,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DomainCount {
    pub credentials: i64,
}

/// A credential row as stored: `password` is the base64 AES-GCM ciphertext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCredential {
    pub id: i64,
    pub username: Option<String>,
    pub email: String,
    pub password: String,
}

pub struct StoredVerifier {
    pub salt: Vec<u8>,
    pub verifier: Vec<u8>,
}

fn unsupported_kdf() -> VaultError {
    VaultError::internal("Unsupported vault key derivation configuration.")
}

fn to_u32(value: i64) -> VaultResult<u32> {
    u32::try_from(value).map_err(|_| unsupported_kdf())
}

pub fn read_kdf(conn: &Connection) -> VaultResult<Option<KdfParams>> {
    let row = conn
        .query_row(
            "SELECT kdf_version, kdf_salt, argon2_iterations, argon2_memory_size,
                    argon2_parallelism, argon2_hash_length
             FROM vault_metadata WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((version, salt, iterations, memory, parallelism, hash_length)) = row else {
        return Ok(None);
    };
    if version != KDF_VERSION {
        return Err(unsupported_kdf());
    }
    kdf_from_parts(&salt, iterations, memory, parallelism, hash_length).map(Some)
}

/// Stored Argon2id parameters, checked: the same bounds for every KDF the vault keeps.
fn kdf_from_parts(salt: &[u8], iterations: i64, memory: i64, parallelism: i64, hash_length: i64) -> VaultResult<KdfParams> {
    let kdf = KdfParams {
        salt: <[u8; SALT_LEN]>::try_from(salt).map_err(|_| unsupported_kdf())?,
        iterations: to_u32(iterations)?,
        memory_kib: to_u32(memory)?,
        parallelism: to_u32(parallelism)?,
        hash_length: to_u32(hash_length)?,
    };
    // Every vault ever created uses t=3, m=64 MiB, p=1, len=32. A tampered row must
    // not be able to weaken the KDF (downgrade) or make unlock hang / exhaust memory.
    let in_bounds = kdf.hash_length == DEFAULT_ARGON2_HASH_LENGTH
        && (DEFAULT_ARGON2_ITERATIONS..=MAX_ARGON2_ITERATIONS).contains(&kdf.iterations)
        && (DEFAULT_ARGON2_MEMORY_KIB..=MAX_ARGON2_MEMORY_KIB).contains(&kdf.memory_kib)
        && (DEFAULT_ARGON2_PARALLELISM..=MAX_ARGON2_PARALLELISM).contains(&kdf.parallelism);
    if !in_bounds {
        return Err(unsupported_kdf());
    }
    Ok(kdf)
}

// ── the vault key's slots (schema v7) ────────────────────────────────────────

pub const PASSWORD_SLOT: &str = "password";
pub const RECOVERY_SLOT: &str = "recovery";

/// The vault key, wrapped by one way of opening the vault. `kdf`: the recovery code's
/// own Argon2id parameters (the password's are in `vault_metadata`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySlot {
    pub kdf: Option<KdfParams>,
    pub wrapped: Vec<u8>,
}

pub fn read_slot(conn: &Connection, kind: &str) -> VaultResult<Option<KeySlot>> {
    let row = conn
        .query_row(
            "SELECT kdf_salt, argon2_iterations, argon2_memory_size, argon2_parallelism, argon2_hash_length, wrapped_key
             FROM key_slots WHERE kind = ?1",
            [kind],
            |row| {
                Ok((
                    row.get::<_, Option<Vec<u8>>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((salt, iterations, memory, parallelism, hash_length, wrapped)) = row else {
        return Ok(None);
    };
    let kdf = match (salt, iterations, memory, parallelism, hash_length) {
        (Some(salt), Some(i), Some(m), Some(p), Some(h)) => Some(kdf_from_parts(&salt, i, m, p, h)?),
        (None, None, None, None, None) => None,
        _ => return Err(unsupported_kdf()),
    };
    Ok(Some(KeySlot { kdf, wrapped }))
}

/// Inserts or replaces a slot (inside the caller's transaction).
pub fn write_slot(conn: &Connection, kind: &str, kdf: Option<&KdfParams>, wrapped: &[u8]) -> VaultResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO key_slots (kind, kdf_salt, argon2_iterations, argon2_memory_size, argon2_parallelism,
           argon2_hash_length, wrapped_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT (kind) DO UPDATE SET kdf_salt = excluded.kdf_salt,
           argon2_iterations = excluded.argon2_iterations, argon2_memory_size = excluded.argon2_memory_size,
           argon2_parallelism = excluded.argon2_parallelism, argon2_hash_length = excluded.argon2_hash_length,
           wrapped_key = excluded.wrapped_key, updated_at = excluded.updated_at",
        params![
            kind,
            kdf.map(|k| k.salt.to_vec()),
            kdf.map(|k| k.iterations),
            kdf.map(|k| k.memory_kib),
            kdf.map(|k| k.parallelism),
            kdf.map(|k| k.hash_length),
            wrapped,
            now
        ],
    )?;
    Ok(())
}

/// A new master password's Argon2id parameters and verifier, replacing the current
/// ones (inside the caller's transaction).
pub fn write_password(
    conn: &Connection,
    kdf: &KdfParams,
    verifier_salt: &[u8; SALT_LEN],
    verifier: &[u8; VERIFIER_LEN],
) -> VaultResult<()> {
    let now = now_iso();
    let metadata = conn.execute(
        "UPDATE vault_metadata SET kdf_version = ?1, kdf_salt = ?2, argon2_iterations = ?3,
           argon2_memory_size = ?4, argon2_parallelism = ?5, argon2_hash_length = ?6, updated_at = ?7
         WHERE id = 1",
        params![KDF_VERSION, &kdf.salt[..], kdf.iterations, kdf.memory_kib, kdf.parallelism, kdf.hash_length, now],
    )?;
    let auth = conn.execute(
        "UPDATE auth_key SET verifier_version = ?1, verifier_salt = ?2, verifier = ?3, updated_at = ?4 WHERE id = 1",
        params![VERIFIER_VERSION, &verifier_salt[..], &verifier[..], now],
    )?;
    if metadata != 1 || auth != 1 {
        return Err(VaultError::internal("The vault has no master password to change."));
    }
    Ok(())
}

const MAX_ARGON2_ITERATIONS: u32 = 64;
const MAX_ARGON2_MEMORY_KIB: u32 = 1 << 20; // 1 GiB
const MAX_ARGON2_PARALLELISM: u32 = 16;

/// Port of `ensureMetadata`: creates the KDF salt on first run, otherwise a no-op.
pub fn ensure_metadata(database: &mut VaultDatabase) -> VaultResult<KdfParams> {
    if let Some(kdf) = read_kdf(database.connection())? {
        return Ok(kdf);
    }
    let generated = KdfParams::generate();
    let now = now_iso();
    database.transaction(|transaction| {
        if read_kdf(transaction)?.is_none() {
            transaction.execute(
                "INSERT INTO vault_metadata (
                   id, kdf_version, kdf_salt, argon2_iterations, argon2_memory_size,
                   argon2_parallelism, argon2_hash_length, created_at, updated_at
                 ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    KDF_VERSION,
                    &generated.salt[..],
                    generated.iterations,
                    generated.memory_kib,
                    generated.parallelism,
                    generated.hash_length,
                    now,
                ],
            )?;
        }
        Ok(())
    })?;
    read_kdf(database.connection())?.ok_or_else(VaultError::unavailable)
}

pub fn has_auth(conn: &Connection) -> VaultResult<bool> {
    Ok(conn
        .query_row("SELECT id FROM auth_key WHERE id = 1", [], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn read_verifier(conn: &Connection) -> VaultResult<Option<StoredVerifier>> {
    Ok(conn
        .query_row(
            "SELECT verifier_salt, verifier FROM auth_key WHERE id = 1",
            [],
            |row| {
                Ok(StoredVerifier {
                    salt: row.get(0)?,
                    verifier: row.get(1)?,
                })
            },
        )
        .optional()?)
}

/// A new vault's master password: its verifier and the new vault key wrapped by it,
/// together.
pub fn insert_verifier(
    database: &mut VaultDatabase,
    salt: &[u8; SALT_LEN],
    verifier: &[u8; VERIFIER_LEN],
    wrapped_vault_key: &[u8],
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|transaction| {
        write_slot(transaction, PASSWORD_SLOT, None, wrapped_vault_key)?;
        if has_auth(transaction)? {
            return Err(VaultError::already_exists(
                "A master password is already configured.",
            ));
        }
        transaction.execute(
            "INSERT INTO auth_key (id, verifier_version, verifier_salt, verifier, created_at, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?4)",
            params![VERIFIER_VERSION, &salt[..], &verifier[..], now],
        )?;
        Ok(())
    })
}

pub fn list_domains(conn: &Connection) -> VaultResult<Vec<DomainRecord>> {
    let mut statement = conn.prepare_cached(
        "SELECT d.id, d.name, d.created_at, d.updated_at, COUNT(c.id) AS credential_count
         FROM domains d
         LEFT JOIN credentials c ON c.domain_id = d.id
         GROUP BY d.id
         ORDER BY d.id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(DomainRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            count: DomainCount {
                credentials: row.get(4)?,
            },
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_domain(conn: &Connection, name: &str) -> VaultResult<i64> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO domains (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![name, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_domain(conn: &Connection, id: i64) -> VaultResult<()> {
    if conn.execute("DELETE FROM domains WHERE id = ?1", [id])? == 0 {
        return Err(VaultError::not_found("Domain not found."));
    }
    Ok(())
}

pub fn list_credentials(conn: &Connection, domain_id: i64) -> VaultResult<Vec<StoredCredential>> {
    let mut statement = conn.prepare_cached(
        "SELECT id, username, email, password
         FROM credentials WHERE domain_id = ?1 ORDER BY id ASC",
    )?;
    let rows = statement.query_map([domain_id], |row| {
        Ok(StoredCredential {
            id: row.get(0)?,
            username: row.get(1)?,
            email: row.get(2)?,
            password: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every account (credential) with its website, for the account list. Never the
/// password: only the account being looked at is decrypted.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: i64,
    pub domain_id: i64,
    pub domain_name: String,
    pub username: Option<String>,
    pub email: String,
    /// False for an account saved without a password (it signs in with another
    /// account, a passkey, or only keeps secrets). Known without decrypting.
    pub has_password: bool,
    /// The group chosen for it by hand; None when the UI guesses one.
    pub category: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Whether a stored ciphertext seals a non-empty password: an empty one is the
/// 12-byte IV plus the 16-byte tag and nothing else.
fn seals_something(ciphertext: &str) -> bool {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_or(true, |raw| {
            raw.len() > crate::crypto::IV_LEN + crate::crypto::TAG_LEN
        })
}

pub fn list_accounts(conn: &Connection) -> VaultResult<Vec<AccountSummary>> {
    let mut statement = conn.prepare_cached(
        "SELECT c.id, c.domain_id, d.name, c.username, c.email, c.created_at, c.updated_at, c.password, ac.name
         FROM credentials c
         JOIN domains d ON d.id = c.domain_id
         LEFT JOIN account_categories ac ON ac.account_id = c.id
         ORDER BY d.name COLLATE NOCASE ASC, c.email COLLATE NOCASE ASC, c.id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AccountSummary {
            id: row.get(0)?,
            domain_id: row.get(1)?,
            domain_name: row.get(2)?,
            username: row.get(3)?,
            email: row.get(4)?,
            has_password: seals_something(&row.get::<_, String>(7)?),
            category: row.get(8)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_credential(
    database: &mut VaultDatabase,
    domain_id: i64,
    username: Option<&str>,
    email: &str,
    ciphertext: &str,
) -> VaultResult<i64> {
    let now = now_iso();
    database.transaction(|transaction| {
        let domain_exists = transaction
            .query_row("SELECT id FROM domains WHERE id = ?1", [domain_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !domain_exists {
            return Err(VaultError::not_found("Domain not found."));
        }
        let duplicate = transaction
            .query_row(
                "SELECT id FROM credentials WHERE email = ?1 AND domain_id = ?2",
                params![email, domain_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if duplicate {
            return Err(VaultError::already_exists(
                "That email is already used in this domain.",
            ));
        }
        transaction.execute(
            "INSERT INTO credentials (
               domain_id, username, email, password, created_at, updated_at, last_time_used
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)",
            params![domain_id, username, email, ciphertext, now],
        )?;
        Ok(transaction.last_insert_rowid())
    })
}

pub struct CredentialChanges<'a> {
    pub username: Option<&'a str>,
    pub email: Option<&'a str>,
    pub ciphertext: Option<&'a str>,
}

pub fn update_credential(
    database: &mut VaultDatabase,
    id: i64,
    changes: CredentialChanges<'_>,
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|transaction| {
        let exists = transaction
            .query_row("SELECT id FROM credentials WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(VaultError::not_found("Credential not found."));
        }
        // Column names come from this fixed list only; values are always bound.
        let mut assignments: Vec<&str> = Vec::with_capacity(4);
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(5);
        if let Some(username) = &changes.username {
            assignments.push("username = ?");
            values.push(username);
        }
        if let Some(email) = &changes.email {
            assignments.push("email = ?");
            values.push(email);
        }
        if let Some(ciphertext) = &changes.ciphertext {
            assignments.push("password = ?");
            values.push(ciphertext);
        }
        assignments.push("updated_at = ?");
        values.push(&now);
        values.push(&id);
        let sql = format!(
            "UPDATE credentials SET {} WHERE id = ?",
            assignments.join(", ")
        );
        transaction.execute(&sql, values.as_slice())?;
        Ok(())
    })
}

pub fn delete_credential(conn: &Connection, id: i64) -> VaultResult<()> {
    if conn.execute("DELETE FROM credentials WHERE id = ?1", [id])? == 0 {
        return Err(VaultError::not_found("Credential not found."));
    }
    Ok(())
}
