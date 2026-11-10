//! Schema v3: what else gets you into an account. Devices, second steps
//! (authenticator apps, passkeys, security keys, codes by text or email, sign-in
//! prompts, recovery codes), secrets and notes kept with an account, and the
//! devices an account is signed in on.
//!
//! SQL only; sealing and the unlock guard live in `vault.rs`. Payloads leave this
//! module only through the `*_payload` functions (for decryption): listings carry
//! metadata, never a secret.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::db::{VaultDatabase, now_iso};
use crate::error::{VaultError, VaultResult};
use crate::workspace::{
    RECOVERY, SIGN_IN, changed, exists, renamed, replace_links, require_account,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A second step or recovery method, as listed: whether it keeps a secret, never the secret.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Factor {
    pub id: i64,
    pub account_id: i64,
    pub kind: String,
    pub label: String,
    pub device_id: Option<i64>,
    pub has_secret: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSecretMeta {
    pub id: i64,
    pub account_id: i64,
    /// "secret" or "note".
    pub kind: String,
    pub name: String,
    pub size: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDevice {
    pub account_id: i64,
    pub device_id: i64,
}

/// Everything the account and device screens need, in one call.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDetails {
    pub devices: Vec<Device>,
    pub factors: Vec<Factor>,
    pub secrets: Vec<AccountSecretMeta>,
    pub device_links: Vec<AccountDevice>,
}

pub fn load(conn: &Connection) -> VaultResult<AccountDetails> {
    let devices = conn
        .prepare_cached(
            "SELECT id, name, kind, notes, created_at, updated_at
             FROM devices ORDER BY name COLLATE NOCASE, id",
        )?
        .query_map([], |row| {
            Ok(Device {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                notes: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let factors = conn
        .prepare_cached(
            "SELECT id, account_id, kind, label, device_id, payload IS NOT NULL, created_at, updated_at
             FROM account_factors ORDER BY account_id, id",
        )?
        .query_map([], |row| {
            Ok(Factor {
                id: row.get(0)?,
                account_id: row.get(1)?,
                kind: row.get(2)?,
                label: row.get(3)?,
                device_id: row.get(4)?,
                has_secret: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let secrets = conn
        .prepare_cached(
            "SELECT id, account_id, kind, name, size, created_at, updated_at
             FROM account_secrets ORDER BY account_id, name COLLATE NOCASE, id",
        )?
        .query_map([], |row| {
            Ok(AccountSecretMeta {
                id: row.get(0)?,
                account_id: row.get(1)?,
                kind: row.get(2)?,
                name: row.get(3)?,
                size: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let device_links = conn
        .prepare_cached(
            "SELECT account_id, device_id FROM account_devices ORDER BY account_id, device_id",
        )?
        .query_map([], |row| {
            Ok(AccountDevice {
                account_id: row.get(0)?,
                device_id: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(AccountDetails {
        devices,
        factors,
        secrets,
        device_links,
    })
}

fn require_device(conn: &Connection, id: i64) -> VaultResult<()> {
    if !exists(conn, "SELECT id FROM devices WHERE id = ?1", id)? {
        return Err(VaultError::not_found("Device not found."));
    }
    Ok(())
}

const DUPLICATE_DEVICE: &str = "A device with that name already exists.";

// ── devices ─────────────────────────────────────────────────────────────────

pub fn create_device(conn: &Connection, name: &str, kind: &str, notes: &str) -> VaultResult<i64> {
    conn.execute(
        "INSERT INTO devices (name, kind, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![name, kind, notes, now_iso()],
    )
    .map_err(|e| renamed(e.into(), DUPLICATE_DEVICE))?;
    Ok(conn.last_insert_rowid())
}

pub fn update_device(
    conn: &Connection,
    id: i64,
    name: &str,
    kind: &str,
    notes: &str,
) -> VaultResult<()> {
    let rows = conn
        .execute(
            "UPDATE devices SET name = ?1, kind = ?2, notes = ?3, updated_at = ?4 WHERE id = ?5",
            params![name, kind, notes, now_iso(), id],
        )
        .map_err(|e| renamed(e.into(), DUPLICATE_DEVICE))?;
    changed(rows, "Device")
}

/// Removes the device. Second steps that lived on it stay, no longer tied to a device.
pub fn delete_device(conn: &Connection, id: i64) -> VaultResult<()> {
    changed(
        conn.execute("DELETE FROM devices WHERE id = ?1", [id])?,
        "Device",
    )
}

// ── the group an account is shown in ────────────────────────────────────────

/// Pins the account to a group, or (None) goes back to the guessed one.
pub fn set_account_category(conn: &Connection, account_id: i64, name: Option<&str>) -> VaultResult<()> {
    require_account(conn, account_id)?;
    match name {
        Some(name) => conn.execute(
            "INSERT INTO account_categories (account_id, name, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
            params![account_id, name, now_iso()],
        )?,
        None => conn.execute("DELETE FROM account_categories WHERE account_id = ?1", [account_id])?,
    };
    Ok(())
}

// ── second steps and recovery ───────────────────────────────────────────────

pub struct NewFactor<'a> {
    pub account_id: i64,
    pub kind: &'a str,
    pub label: &'a str,
    pub device_id: Option<i64>,
    pub payload: Option<&'a [u8]>,
}

pub fn insert_factor(database: &mut VaultDatabase, factor: NewFactor<'_>) -> VaultResult<i64> {
    let now = now_iso();
    database.transaction(|tx| {
        require_account(tx, factor.account_id)?;
        if let Some(device_id) = factor.device_id {
            require_device(tx, device_id)?;
        }
        tx.execute(
            "INSERT INTO account_factors (account_id, kind, label, device_id, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![factor.account_id, factor.kind, factor.label, factor.device_id, factor.payload, now],
        )?;
        Ok(tx.last_insert_rowid())
    })
}

/// The factor's kind, and its sealed secret if it keeps one.
pub fn factor_payload(conn: &Connection, id: i64) -> VaultResult<(String, Option<Vec<u8>>)> {
    conn.query_row(
        "SELECT kind, payload FROM account_factors WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| VaultError::not_found("That sign-in step no longer exists."))
}

/// What a factor's secret becomes on update.
pub enum PayloadChange<'a> {
    Keep,
    Clear,
    Set(&'a [u8]),
}

pub fn update_factor(
    database: &mut VaultDatabase,
    id: i64,
    label: &str,
    device_id: Option<i64>,
    payload: PayloadChange<'_>,
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        if let Some(device_id) = device_id {
            require_device(tx, device_id)?;
        }
        let rows = tx.execute(
            "UPDATE account_factors SET label = ?1, device_id = ?2, updated_at = ?3 WHERE id = ?4",
            params![label, device_id, now, id],
        )?;
        changed(rows, "Sign-in step")?;
        match payload {
            PayloadChange::Keep => {}
            PayloadChange::Clear => {
                tx.execute(
                    "UPDATE account_factors SET payload = NULL WHERE id = ?1",
                    [id],
                )?;
            }
            PayloadChange::Set(sealed) => {
                tx.execute(
                    "UPDATE account_factors SET payload = ?1 WHERE id = ?2",
                    params![sealed, id],
                )?;
            }
        }
        Ok(())
    })
}

pub fn delete_factor(conn: &Connection, id: i64) -> VaultResult<()> {
    changed(
        conn.execute("DELETE FROM account_factors WHERE id = ?1", [id])?,
        "Sign-in step",
    )
}

// ── secrets and notes kept with an account ──────────────────────────────────

pub fn insert_account_secret(
    database: &mut VaultDatabase,
    account_id: i64,
    kind: &str,
    name: &str,
    size: i64,
    payload: &[u8],
) -> VaultResult<i64> {
    let now = now_iso();
    database.transaction(|tx| {
        require_account(tx, account_id)?;
        tx.execute(
            "INSERT INTO account_secrets (account_id, kind, name, size, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![account_id, kind, name, size, payload, now],
        )?;
        Ok(tx.last_insert_rowid())
    })
}

pub fn account_secret_payload(conn: &Connection, id: i64) -> VaultResult<Vec<u8>> {
    conn.query_row(
        "SELECT payload FROM account_secrets WHERE id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| VaultError::not_found("Secret not found."))
}

pub fn update_account_secret(
    database: &mut VaultDatabase,
    id: i64,
    name: &str,
    value: Option<(&[u8], i64)>,
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        let rows = tx.execute(
            "UPDATE account_secrets SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, id],
        )?;
        changed(rows, "Secret")?;
        if let Some((payload, size)) = value {
            tx.execute(
                "UPDATE account_secrets SET payload = ?1, size = ?2 WHERE id = ?3",
                params![payload, size, id],
            )?;
        }
        Ok(())
    })
}

pub fn delete_account_secret(conn: &Connection, id: i64) -> VaultResult<()> {
    changed(
        conn.execute("DELETE FROM account_secrets WHERE id = ?1", [id])?,
        "Secret",
    )
}

// ── devices an account is signed in on ──────────────────────────────────────

/// Inside a transaction: replaces the devices `account_id` is signed in on.
fn replace_devices(
    tx: &Connection,
    account_id: i64,
    device_ids: &[i64],
    now: &str,
) -> VaultResult<()> {
    tx.execute(
        "DELETE FROM account_devices WHERE account_id = ?1",
        [account_id],
    )?;
    for &device_id in device_ids {
        require_device(tx, device_id)?;
        tx.execute(
            "INSERT OR IGNORE INTO account_devices (account_id, device_id, created_at) VALUES (?1, ?2, ?3)",
            params![account_id, device_id, now],
        )?;
    }
    Ok(())
}

/// Replaces the devices `account_id` is signed in on.
pub fn set_account_devices(
    database: &mut VaultDatabase,
    account_id: i64,
    device_ids: &[i64],
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        require_account(tx, account_id)?;
        replace_devices(tx, account_id, device_ids, &now)
    })
}

/// What an account connects to, as the account form edits it.
pub struct Connections<'a> {
    pub sign_in: &'a [i64],
    pub recovery: &'a [i64],
    pub devices: &'a [i64],
}

/// Replaces an account's sign-in links, recovery links and devices together:
/// all of them change, or (on any bad id) none do.
pub fn set_connections(
    database: &mut VaultDatabase,
    account_id: i64,
    connections: Connections<'_>,
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        require_account(tx, account_id)?;
        replace_links(tx, account_id, SIGN_IN, connections.sign_in, &now)?;
        replace_links(tx, account_id, RECOVERY, connections.recovery, &now)?;
        replace_devices(tx, account_id, connections.devices, &now)
    })
}
