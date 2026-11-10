//! Schema v2 and v5: projects, the services they use (several accounts each, with a
//! sealed role), their encrypted secrets and files (with a sealed description), and
//! links between accounts. SQL only; encryption and the unlock guard live in
//! `vault.rs`. Secret payloads never leave this module except through
//! `secret_payload` (for decryption) — listings carry metadata only.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::db::{VaultDatabase, now_iso};
use crate::error::{ErrorCode, VaultError, VaultResult};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A note sealed with the vault key (`crypto::encrypt_bytes`), or `None` for no note.
pub type Sealed = Option<Vec<u8>>;

/// Opens a sealed note: "" for none. Given by `vault.rs`, which holds the key.
pub type Open<'a> = &'a dyn Fn(Sealed) -> VaultResult<String>;

/// An account a service uses, and what it is for there.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccount {
    pub account_id: i64,
    /// "admin", "deploy only"…; empty for none. Stored sealed.
    pub role: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    pub url: String,
    /// In order; the first is the main one.
    pub accounts: Vec<ServiceAccount>,
    pub created_at: String,
    pub updated_at: String,
}

/// A secret or file as listed: never its payload.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretMeta {
    pub id: i64,
    pub project_id: i64,
    pub service_id: Option<i64>,
    /// "text" or "file".
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    /// What it's for, its scopes; empty for none. Stored sealed.
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountLink {
    pub account_id: i64,
    pub linked_account_id: i64,
    pub kind: String,
}

/// Everything the projects screens and the search need, in one call.
#[derive(Debug, Serialize)]
pub struct Workspace {
    pub projects: Vec<Project>,
    pub services: Vec<Service>,
    pub secrets: Vec<SecretMeta>,
}

/// (vercel, google, sign_in): the Vercel account signs in with the Google one.
pub const SIGN_IN: &str = "sign_in";
/// (github, gmail, recovery): GitHub sends its recovery mail to the Gmail account.
pub const RECOVERY: &str = "recovery";
pub const LINK_KINDS: &[&str] = &[SIGN_IN, RECOVERY];

pub(crate) fn renamed(error: VaultError, message: &str) -> VaultError {
    if error.code == ErrorCode::AlreadyExists {
        VaultError::already_exists(message).with_detail(error.message)
    } else {
        error
    }
}

pub fn load_workspace(conn: &Connection, open: Open<'_>) -> VaultResult<Workspace> {
    let projects = conn
        .prepare_cached(
            "SELECT id, name, description, created_at, updated_at
             FROM projects ORDER BY name COLLATE NOCASE, id",
        )?
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut accounts: HashMap<i64, Vec<ServiceAccount>> = HashMap::new();
    let rows: Vec<(i64, i64, Sealed)> = conn
        .prepare_cached(
            "SELECT service_id, account_id, role FROM service_accounts
             ORDER BY service_id, position, account_id",
        )?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (service_id, account_id, role) in rows {
        accounts.entry(service_id).or_default().push(ServiceAccount {
            account_id,
            role: open(role)?,
        });
    }
    let services = conn
        .prepare_cached(
            "SELECT id, project_id, name, url, created_at, updated_at
             FROM services ORDER BY name COLLATE NOCASE, id",
        )?
        .query_map([], |row| {
            Ok(Service {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                url: row.get(3)?,
                accounts: Vec::new(),
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|mut service| {
            service.accounts = accounts.remove(&service.id).unwrap_or_default();
            service
        })
        .collect();
    let rows: Vec<(SecretMeta, Sealed)> = conn
        .prepare_cached(
            "SELECT id, project_id, service_id, kind, name, mime_type, size, created_at, updated_at, description
             FROM secrets ORDER BY name COLLATE NOCASE, id",
        )?
        .query_map([], |row| {
            Ok((
                SecretMeta {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    service_id: row.get(2)?,
                    kind: row.get(3)?,
                    name: row.get(4)?,
                    mime_type: row.get(5)?,
                    size: row.get(6)?,
                    description: String::new(),
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                },
                row.get(9)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    let secrets = rows
        .into_iter()
        .map(|(mut secret, description)| {
            secret.description = open(description)?;
            Ok(secret)
        })
        .collect::<VaultResult<_>>()?;
    Ok(Workspace {
        projects,
        services,
        secrets,
    })
}

pub(crate) fn exists(conn: &Connection, sql: &str, id: i64) -> VaultResult<bool> {
    Ok(conn.query_row(sql, [id], |_| Ok(())).optional()?.is_some())
}

fn require_project(conn: &Connection, id: i64) -> VaultResult<()> {
    if !exists(conn, "SELECT id FROM projects WHERE id = ?1", id)? {
        return Err(VaultError::not_found("Project not found."));
    }
    Ok(())
}

pub(crate) fn require_account(conn: &Connection, id: i64) -> VaultResult<()> {
    if !exists(conn, "SELECT id FROM credentials WHERE id = ?1", id)? {
        return Err(VaultError::not_found("Account not found."));
    }
    Ok(())
}

/// A secret may only be attached to a service of its own project.
fn require_service_in(
    conn: &Connection,
    service_id: Option<i64>,
    project_id: i64,
) -> VaultResult<()> {
    let Some(service_id) = service_id else {
        return Ok(());
    };
    let owner: Option<i64> = conn
        .query_row(
            "SELECT project_id FROM services WHERE id = ?1",
            [service_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        None => Err(VaultError::not_found("Service not found.")),
        Some(owner) if owner != project_id => Err(VaultError::invalid_input(
            "That service belongs to another project.",
        )),
        Some(_) => Ok(()),
    }
}

pub(crate) fn changed(rows: usize, what: &str) -> VaultResult<()> {
    if rows == 0 {
        return Err(VaultError::not_found(format!("{what} not found.")));
    }
    Ok(())
}

// ── projects ────────────────────────────────────────────────────────────────

pub fn create_project(conn: &Connection, name: &str, description: &str) -> VaultResult<i64> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO projects (name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![name, description, now],
    )
    .map_err(|e| renamed(e.into(), "A project with that name already exists."))?;
    Ok(conn.last_insert_rowid())
}

pub fn update_project(
    conn: &Connection,
    id: i64,
    name: &str,
    description: &str,
) -> VaultResult<()> {
    let rows = conn
        .execute(
            "UPDATE projects SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, description, now_iso(), id],
        )
        .map_err(|e| renamed(e.into(), "A project with that name already exists."))?;
    changed(rows, "Project")
}

/// Removes the project with its services, secrets and files. Accounts stay.
pub fn delete_project(conn: &Connection, id: i64) -> VaultResult<()> {
    changed(
        conn.execute("DELETE FROM projects WHERE id = ?1", [id])?,
        "Project",
    )
}

// ── services ────────────────────────────────────────────────────────────────

/// Inside a transaction: replaces the accounts a service uses, in order, each with
/// its sealed role. Ids are checked to exist. `services.account_id` (pre-v5) is kept
/// equal to the first.
fn replace_service_accounts(
    tx: &Connection,
    service_id: i64,
    accounts: &[(i64, Sealed)],
    now: &str,
) -> VaultResult<()> {
    for (account_id, _) in accounts {
        require_account(tx, *account_id)?;
    }
    tx.execute(
        "DELETE FROM service_accounts WHERE service_id = ?1",
        [service_id],
    )?;
    for (position, (account_id, role)) in accounts.iter().enumerate() {
        tx.execute(
            "INSERT INTO service_accounts (service_id, account_id, role, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![service_id, account_id, role, position as i64, now],
        )?;
    }
    tx.execute(
        "UPDATE services SET account_id = ?1 WHERE id = ?2",
        params![accounts.first().map(|(id, _)| *id), service_id],
    )?;
    Ok(())
}

/// The accounts are `(account id, sealed role)`, distinct, in order.
pub fn create_service(
    database: &mut VaultDatabase,
    project_id: i64,
    name: &str,
    url: &str,
    accounts: &[(i64, Sealed)],
) -> VaultResult<i64> {
    let now = now_iso();
    database.transaction(|tx| {
        require_project(tx, project_id)?;
        tx.execute(
            "INSERT INTO services (project_id, name, url, account_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
            params![project_id, name, url, now],
        )
        .map_err(|e| {
            renamed(
                e.into(),
                "This project already has a service with that name.",
            )
        })?;
        let id = tx.last_insert_rowid();
        replace_service_accounts(tx, id, accounts, &now)?;
        Ok(id)
    })
}

pub fn update_service(
    database: &mut VaultDatabase,
    id: i64,
    name: &str,
    url: &str,
    accounts: &[(i64, Sealed)],
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        let rows = tx
            .execute(
                "UPDATE services SET name = ?1, url = ?2, updated_at = ?3 WHERE id = ?4",
                params![name, url, now, id],
            )
            .map_err(|e| renamed(e.into(), "This project already has a service with that name."))?;
        changed(rows, "Service")?;
        replace_service_accounts(tx, id, accounts, &now)
    })
}

/// Removes the service. Its secrets stay in the project; its account stays in the vault.
pub fn delete_service(conn: &Connection, id: i64) -> VaultResult<()> {
    changed(
        conn.execute("DELETE FROM services WHERE id = ?1", [id])?,
        "Service",
    )
}

// ── secrets and files ───────────────────────────────────────────────────────

pub struct NewSecret<'a> {
    pub project_id: i64,
    pub service_id: Option<i64>,
    pub kind: &'a str,
    pub name: &'a str,
    pub mime_type: &'a str,
    pub size: i64,
    pub payload: &'a [u8],
    pub description: Option<&'a [u8]>,
}

pub fn insert_secret(database: &mut VaultDatabase, secret: NewSecret<'_>) -> VaultResult<i64> {
    let now = now_iso();
    database.transaction(|tx| {
        require_project(tx, secret.project_id)?;
        require_service_in(tx, secret.service_id, secret.project_id)?;
        tx.execute(
            "INSERT INTO secrets (project_id, service_id, kind, name, mime_type, size, payload, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                secret.project_id,
                secret.service_id,
                secret.kind,
                secret.name,
                secret.mime_type,
                secret.size,
                secret.payload,
                secret.description,
                now
            ],
        )?;
        Ok(tx.last_insert_rowid())
    })
}

pub struct StoredSecret {
    pub kind: String,
    pub name: String,
    pub size: i64,
    pub payload: Vec<u8>,
}

pub fn secret_payload(conn: &Connection, id: i64) -> VaultResult<StoredSecret> {
    conn.query_row(
        "SELECT kind, name, size, payload FROM secrets WHERE id = ?1",
        [id],
        |row| {
            Ok(StoredSecret {
                kind: row.get(0)?,
                name: row.get(1)?,
                size: row.get(2)?,
                payload: row.get(3)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| VaultError::not_found("Secret not found."))
}

/// Renames / re-attaches a secret, and replaces its sealed value and its sealed
/// description when given (`Some(None)` clears the description).
pub fn update_secret(
    database: &mut VaultDatabase,
    id: i64,
    name: &str,
    service_id: Option<i64>,
    value: Option<(&[u8], i64)>,
    description: Option<Option<&[u8]>>,
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        let project_id: i64 = tx
            .query_row(
                "SELECT project_id FROM secrets WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::not_found("Secret not found."))?;
        require_service_in(tx, service_id, project_id)?;
        tx.execute(
            "UPDATE secrets SET name = ?1, service_id = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, service_id, now, id],
        )?;
        if let Some((payload, size)) = value {
            tx.execute(
                "UPDATE secrets SET payload = ?1, size = ?2 WHERE id = ?3",
                params![payload, size, id],
            )?;
        }
        if let Some(description) = description {
            tx.execute(
                "UPDATE secrets SET description = ?1 WHERE id = ?2",
                params![description, id],
            )?;
        }
        Ok(())
    })
}

pub fn delete_secret(conn: &Connection, id: i64) -> VaultResult<()> {
    changed(
        conn.execute("DELETE FROM secrets WHERE id = ?1", [id])?,
        "Secret",
    )
}

// ── account links ───────────────────────────────────────────────────────────

pub fn list_links(conn: &Connection) -> VaultResult<Vec<AccountLink>> {
    Ok(conn
        .prepare_cached(
            "SELECT account_id, linked_account_id, kind FROM account_links
             ORDER BY account_id, linked_account_id",
        )?
        .query_map([], |row| {
            Ok(AccountLink {
                account_id: row.get(0)?,
                linked_account_id: row.get(1)?,
                kind: row.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

/// Inside a transaction: replaces the accounts `account_id` is linked to with this
/// kind of link. The caller has checked `account_id` exists.
pub(crate) fn replace_links(
    tx: &Connection,
    account_id: i64,
    kind: &str,
    linked: &[i64],
    now: &str,
) -> VaultResult<()> {
    tx.execute(
        "DELETE FROM account_links WHERE account_id = ?1 AND kind = ?2",
        params![account_id, kind],
    )?;
    for &other in linked {
        if other == account_id {
            return Err(VaultError::invalid_input(if kind == SIGN_IN {
                "An account can’t sign in with itself."
            } else {
                "An account can’t be its own recovery account."
            }));
        }
        require_account(tx, other)?;
        tx.execute(
            "INSERT OR IGNORE INTO account_links (account_id, linked_account_id, kind, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![account_id, other, kind, now],
        )?;
    }
    Ok(())
}

/// Replaces the accounts `account_id` is linked to with this kind of link.
pub fn set_links(
    database: &mut VaultDatabase,
    account_id: i64,
    kind: &str,
    linked: &[i64],
) -> VaultResult<()> {
    let now = now_iso();
    database.transaction(|tx| {
        require_account(tx, account_id)?;
        replace_links(tx, account_id, kind, linked, &now)
    })
}

/// A rough content type from the file name, for icons and for the export dialog.
pub fn guess_mime(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some(
            "txt" | "md" | "log" | "csv" | "env" | "ini" | "conf" | "cfg" | "toml" | "yaml" | "yml",
        ) => "text/plain",
        Some("json") => "application/json",
        Some("pem" | "crt" | "cer" | "key" | "pub" | "csr") => "application/x-pem-file",
        Some("sh" | "zsh" | "bash" | "ps1") => "text/x-shellscript",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("gpg" | "asc" | "sig") => "application/pgp-encrypted",
        _ => "application/octet-stream",
    }
}
