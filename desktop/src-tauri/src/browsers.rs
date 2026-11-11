//! The browser extension's rows (schema v8, `migrations/0008_browser_extension.sql`):
//! VaultKey's own key for the channel, and the browsers paired with it. Values arrive
//! sealed and leave sealed; `vault.rs` holds the key.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::db::now_iso;
use crate::error::VaultResult;

/// The `bridge_settings` row, if "Browser extension" was ever turned on.
pub struct Settings {
    pub enabled: bool,
    /// The X25519 private key, sealed.
    pub private_key: Vec<u8>,
}

pub fn read_settings(conn: &Connection) -> VaultResult<Option<Settings>> {
    Ok(conn
        .query_row("SELECT enabled, private_key FROM bridge_settings WHERE id = 1", [], |row| {
            Ok(Settings { enabled: row.get::<_, i64>(0)? == 1, private_key: row.get(1)? })
        })
        .optional()?)
}

/// The first time it's turned on: the key pair is made, and the setting is on.
pub fn create_settings(conn: &Connection, sealed_private_key: &[u8]) -> VaultResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO bridge_settings (id, enabled, private_key, created_at, updated_at) VALUES (1, 1, ?1, ?2, ?2)",
        params![sealed_private_key, now],
    )?;
    Ok(())
}

pub fn set_enabled(conn: &Connection, enabled: bool) -> VaultResult<()> {
    conn.execute(
        "UPDATE bridge_settings SET enabled = ?1, updated_at = ?2 WHERE id = 1",
        params![i64::from(enabled), now_iso()],
    )?;
    Ok(())
}

/// A paired browser, sealed.
pub struct StoredClient {
    pub id: i64,
    pub client_id: Vec<u8>,
    pub name: Vec<u8>,
    pub created_at: String,
    pub last_seen_at: String,
}

/// A paired browser's sealed public key, by its client id.
pub fn client_key(conn: &Connection, client_id: &[u8]) -> VaultResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row("SELECT public_key FROM browser_clients WHERE client_id = ?1", [client_id], |row| row.get(0))
        .optional()?)
}

/// Saves a newly paired browser. Pairing the same key again (the extension forgot it was
/// paired) keeps the row and takes the new name.
pub fn save_client(conn: &Connection, client_id: &[u8], sealed_public_key: &[u8], sealed_name: &[u8]) -> VaultResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO browser_clients (client_id, public_key, name, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (client_id) DO UPDATE SET
           public_key = excluded.public_key, name = excluded.name, last_seen_at = excluded.last_seen_at",
        params![client_id, sealed_public_key, sealed_name, now],
    )?;
    Ok(())
}

pub fn list_clients(conn: &Connection) -> VaultResult<Vec<StoredClient>> {
    let mut statement =
        conn.prepare("SELECT id, client_id, name, created_at, last_seen_at FROM browser_clients ORDER BY created_at, id")?;
    let rows = statement.query_map([], |row| {
        Ok(StoredClient {
            id: row.get(0)?,
            client_id: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get(3)?,
            last_seen_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Whether a row was removed.
pub fn delete_client(conn: &Connection, id: i64) -> VaultResult<bool> {
    Ok(conn.execute("DELETE FROM browser_clients WHERE id = ?1", [id])? == 1)
}

/// Removes a browser by its client id (a pairing the browser never heard was approved).
pub fn delete_client_by_client_id(conn: &Connection, client_id: &[u8]) -> VaultResult<()> {
    conn.execute("DELETE FROM browser_clients WHERE client_id = ?1", [client_id])?;
    Ok(())
}

// ── what the extension reads (M2) ──────────────────────────────────────────

/// Accounts with an authenticator whose setup key is saved (so a code can be made).
pub fn accounts_with_authenticator(conn: &Connection) -> VaultResult<HashSet<i64>> {
    let mut statement = conn
        .prepare("SELECT DISTINCT account_id FROM account_factors WHERE kind = 'authenticator' AND payload IS NOT NULL")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The account's first authenticator with a setup key.
pub fn authenticator_of(conn: &Connection, account: i64) -> VaultResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM account_factors WHERE account_id = ?1 AND kind = 'authenticator' AND payload IS NOT NULL ORDER BY id LIMIT 1",
            [account],
            |row| row.get(0),
        )
        .optional()?)
}

/// One account's login, its password still sealed (base64, as the Electron app wrote it).
pub struct StoredLogin {
    pub email: String,
    pub username: Option<String>,
    pub password: String,
}

pub fn login(conn: &Connection, account: i64) -> VaultResult<Option<StoredLogin>> {
    Ok(conn
        .query_row("SELECT email, username, password FROM credentials WHERE id = ?1", [account], |row| {
            Ok(StoredLogin { email: row.get(0)?, username: row.get(1)?, password: row.get(2)? })
        })
        .optional()?)
}

pub fn touch_client(conn: &Connection, client_id: &[u8]) -> VaultResult<()> {
    conn.execute(
        "UPDATE browser_clients SET last_seen_at = ?1 WHERE client_id = ?2",
        params![now_iso(), client_id],
    )?;
    Ok(())
}
