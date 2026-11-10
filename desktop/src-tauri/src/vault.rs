//! The vault service: database + unlocked session. Everything the UI can do goes
//! through here. It knows nothing about Tauri, so it is fully unit-testable.
//!
//! Locking discipline: the expensive KDF work (Argon2id, scrypt) runs with *no* lock
//! held, so a slow unlock never blocks other calls.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::account_details::{self, AccountDetails, Connections, NewFactor, PayloadChange};
use crate::crypto::{self, SALT_LEN, SecretKey};
use crate::db::VaultDatabase;
use crate::error::{VaultError, VaultResult, log_failure};
use crate::store::{self, CredentialChanges, DomainRecord};
use crate::totp::{Totp, TotpCode};
use crate::validation::{
    self, CredentialInput, CredentialUpdateInput, validate_credential_input,
    validate_credential_update, validate_domain_name, validate_id,
};
use crate::validation::{
    ACCOUNT_SECRET_KINDS, AccountSecretInput, AccountSecretUpdateInput, DeviceInput, FACTOR_KINDS,
    FactorInput, FactorUpdateInput, MAX_SECRET_TEXT_BYTES, MAX_SETUP_KEY_BYTES, validate_category,
    validate_device, validate_kind, validate_label,
};
use crate::validation::{
    MAX_FILE_BYTES, MAX_TEXT_FILE_BYTES, ProjectInput, SecretInput, SecretUpdateInput,
    ServiceInput, validate_name, validate_optional_id, validate_project, validate_secret_value,
    validate_service,
};
use crate::workspace::{self, AccountLink, NewSecret, Workspace};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthStatus {
    NeedsSignup,
    NeedsLogin,
}

#[derive(Debug, Serialize)]
pub struct VaultStatus {
    pub status: AuthStatus,
}

#[derive(Debug, Serialize)]
pub struct UnlockResult {
    pub valid: bool,
}

#[derive(Debug, Serialize)]
pub struct DomainList {
    pub domains: Vec<DomainRecord>,
}

/// A decrypted credential as shown in the UI (same shape the old renderer produced).
#[derive(Serialize)]
pub struct Credential {
    pub id: i64,
    pub username: Option<String>,
    pub email: String,
    pub password: String,
}

/// Never print plaintext, even by accident in a debug log.
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("id", &self.id)
            .field("password", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Serialize)]
pub struct CredentialList {
    pub credentials: Vec<Credential>,
}

#[derive(Debug, Serialize)]
pub struct AccountList {
    pub accounts: Vec<store::AccountSummary>,
}

#[derive(Default)]
struct Session {
    /// `Some(key)` while unlocked. The key is zeroised when replaced or dropped.
    key: Option<SecretKey>,
    /// Bumped by every lock, so an unlock that was in flight when the vault was
    /// locked (page reload, window closed) cannot resurrect the session.
    epoch: u64,
}

pub struct Vault {
    path: PathBuf,
    database: Mutex<Option<VaultDatabase>>,
    session: Mutex<Session>,
    /// Serialises Argon2id/scrypt work: each run costs ~96 MiB, so concurrent
    /// unlock storms from a misbehaving webview cannot exhaust memory.
    kdf_gate: Mutex<()>,
    /// Files last dropped onto the window (paths from the OS, never from the page),
    /// waiting to be imported into a project.
    dropped: Mutex<Option<(Instant, Vec<PathBuf>)>>,
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Vault {
    /// Opens the database at `path`. A failure is logged and remembered rather than
    /// fatal: the UI shows its "Local Vault Error" screen, and Retry reopens.
    pub fn open(path: PathBuf) -> Self {
        let database = match VaultDatabase::open(&path) {
            Ok(database) => Some(database),
            Err(error) => {
                log_failure("database initialization", &error);
                None
            }
        };
        Self {
            path,
            database: Mutex::new(database),
            session: Mutex::new(Session::default()),
            kdf_gate: Mutex::new(()),
            dropped: Mutex::new(None),
        }
    }

    fn with_database<T>(
        &self,
        body: impl FnOnce(&mut VaultDatabase) -> VaultResult<T>,
    ) -> VaultResult<T> {
        let mut guard = lock_or_recover(&self.database);
        let database = guard.as_mut().ok_or_else(VaultError::unavailable)?;
        body(database)
    }

    fn session_key(&self) -> VaultResult<SecretKey> {
        lock_or_recover(&self.session)
            .key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or_else(|| VaultError::locked("Unlock the vault first."))
    }

    fn require_unlocked(&self) -> VaultResult<()> {
        self.session_key().map(drop)
    }

    #[cfg(test)]
    pub fn is_unlocked(&self) -> bool {
        lock_or_recover(&self.session).key.is_some()
    }

    // ── auth ────────────────────────────────────────────────────────────────

    pub fn status(&self) -> VaultResult<VaultStatus> {
        let mut guard = lock_or_recover(&self.database);
        if guard.is_none() {
            // Retry after a failed start-up (e.g. the disk was unavailable).
            *guard = Some(VaultDatabase::open(&self.path)?);
        }
        let database = guard.as_mut().ok_or_else(VaultError::unavailable)?;
        store::ensure_metadata(database)?;
        let status = if store::has_auth(database.connection())? {
            AuthStatus::NeedsLogin
        } else {
            AuthStatus::NeedsSignup
        };
        Ok(VaultStatus { status })
    }

    /// First-run signup: stores only a verifier of the derived auth key.
    /// Like the Electron app, this does not unlock; the user logs in afterwards.
    pub fn create_vault(&self, master_password: &str) -> VaultResult<()> {
        validation::validate_new_master_password(master_password)?;
        let kdf = self.with_database(|database| {
            let kdf = store::ensure_metadata(database)?;
            if store::has_auth(database.connection())? {
                return Err(VaultError::already_exists(
                    "A master password is already configured.",
                ));
            }
            Ok(kdf)
        })?;
        let salt: [u8; SALT_LEN] = crypto::random_bytes();
        let verifier = {
            let _gate = lock_or_recover(&self.kdf_gate);
            let keys = crypto::derive_keys(master_password, &kdf)?;
            crypto::derive_verifier(keys.auth_key.as_ref(), &salt)?
        };
        self.with_database(|database| store::insert_verifier(database, &salt, &verifier))
    }

    pub fn unlock(&self, master_password: &str) -> VaultResult<UnlockResult> {
        validation::validate_master_password(master_password)?;
        let epoch = lock_or_recover(&self.session).epoch;
        let (kdf, stored) = self.with_database(|database| {
            let not_initialized = || VaultError::not_found("The vault has not been initialized.");
            let kdf = store::read_kdf(database.connection())?.ok_or_else(not_initialized)?;
            let stored =
                store::read_verifier(database.connection())?.ok_or_else(not_initialized)?;
            Ok((kdf, stored))
        })?;
        let (keys, valid) = {
            let _gate = lock_or_recover(&self.kdf_gate);
            let keys = crypto::derive_keys(master_password, &kdf)?;
            let derived = crypto::derive_verifier(keys.auth_key.as_ref(), &stored.salt)?;
            let valid = crypto::verifier_matches(&stored.verifier, derived.as_ref());
            (keys, valid)
        };
        if !valid {
            return Ok(UnlockResult { valid: false });
        }
        let mut session = lock_or_recover(&self.session);
        if session.epoch != epoch {
            // The vault was locked while we were deriving keys (e.g. the page
            // reloaded). Honour the lock; the UI will ask for the password again.
            return Err(VaultError::locked("The vault was locked during unlock."));
        }
        session.key = Some(keys.encryption_key);
        Ok(UnlockResult { valid: true })
    }

    pub fn lock(&self) {
        let mut session = lock_or_recover(&self.session);
        // Dropping the key zeroises it.
        session.key = None;
        session.epoch = session.epoch.wrapping_add(1);
    }

    // ── domains ─────────────────────────────────────────────────────────────

    pub fn list_domains(&self) -> VaultResult<DomainList> {
        self.require_unlocked()?;
        let domains = self.with_database(|database| store::list_domains(database.connection()))?;
        Ok(DomainList { domains })
    }

    pub fn create_domain(&self, name: &str) -> VaultResult<i64> {
        self.require_unlocked()?;
        let name = validate_domain_name(name)?;
        self.with_database(|database| store::create_domain(database.connection(), &name))
    }

    pub fn delete_domain(&self, domain_id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let domain_id = validate_id(domain_id, "domain id")?;
        self.with_database(|database| store::delete_domain(database.connection(), domain_id))
    }

    // ── credentials ─────────────────────────────────────────────────────────

    /// Every account across all websites, without passwords (nothing is decrypted).
    pub fn list_accounts(&self) -> VaultResult<AccountList> {
        self.require_unlocked()?;
        let accounts =
            self.with_database(|database| store::list_accounts(database.connection()))?;
        Ok(AccountList { accounts })
    }

    pub fn list_credentials(&self, domain_id: i64) -> VaultResult<CredentialList> {
        let key = self.session_key()?;
        let domain_id = validate_id(domain_id, "domain id")?;
        let rows = self
            .with_database(|database| store::list_credentials(database.connection(), domain_id))?;
        let credentials = rows
            .into_iter()
            .map(|row| {
                let password = crypto::decrypt(&row.password, &key)?;
                Ok(Credential {
                    id: row.id,
                    username: row.username,
                    email: row.email,
                    password: password.as_str().to_owned(),
                })
            })
            .collect::<VaultResult<Vec<_>>>()?;
        Ok(CredentialList { credentials })
    }

    pub fn create_credential(&self, input: CredentialInput) -> VaultResult<i64> {
        let key = self.session_key()?;
        let input = validate_credential_input(input)?;
        let ciphertext = crypto::encrypt(&input.password, &key)?;
        self.with_database(|database| {
            store::create_credential(
                database,
                input.domain_id,
                input.username.as_deref(),
                &input.email,
                &ciphertext,
            )
        })
    }

    pub fn update_credential(
        &self,
        credential_id: i64,
        input: CredentialUpdateInput,
    ) -> VaultResult<()> {
        let key = self.session_key()?;
        let credential_id = validate_id(credential_id, "credential id")?;
        let input = validate_credential_update(input)?;
        let ciphertext = input
            .password
            .as_ref()
            .map(|password| crypto::encrypt(password, &key))
            .transpose()?;
        self.with_database(|database| {
            store::update_credential(
                database,
                credential_id,
                CredentialChanges {
                    username: input.username.as_deref(),
                    email: input.email.as_deref(),
                    ciphertext: ciphertext.as_deref(),
                },
            )
        })
    }

    pub fn delete_credential(&self, credential_id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let credential_id = validate_id(credential_id, "credential id")?;
        self.with_database(|database| {
            store::delete_credential(database.connection(), credential_id)
        })
    }

    /// Locks, checkpoints the WAL and closes the database. Called on app exit.
    pub fn close(&self) {
        self.lock();
        if let Some(database) = lock_or_recover(&self.database).take() {
            database.close();
        }
    }
}

// ── projects, services, secrets, files and links (schema v2) ────────────────

#[derive(Debug, Serialize)]
pub struct Created {
    pub id: i64,
}

#[derive(Debug, Serialize)]
pub struct LinkList {
    pub links: Vec<AccountLink>,
}

#[derive(Serialize)]
pub struct RevealedSecret {
    pub value: String,
}

impl std::fmt::Debug for RevealedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RevealedSecret(<redacted>)")
    }
}

#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub imported: Vec<i64>,
    pub skipped: Vec<SkippedFile>,
}

#[derive(Debug, Serialize)]
pub struct SkippedFile {
    pub name: String,
    pub reason: String,
}

/// Dropped files stay importable this long after the drop.
const DROP_TTL: Duration = Duration::from_secs(120);

/// Writes a decrypted secret where the user chose, readable by them only.
fn write_private(path: &Path, bytes: &[u8]) -> VaultResult<()> {
    let failure =
        |error: std::io::Error| VaultError::internal("Couldn’t write the file.").with_detail(error);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(failure)?;
    file.write_all(bytes).map_err(failure)?;
    #[cfg(unix)]
    {
        // `mode` only applies to new files; tighten one being replaced too.
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

impl Vault {
    pub fn workspace(&self) -> VaultResult<Workspace> {
        self.require_unlocked()?;
        self.with_database(|db| workspace::load_workspace(db.connection()))
    }

    pub fn create_project(&self, input: &ProjectInput) -> VaultResult<i64> {
        self.require_unlocked()?;
        let (name, description) = validate_project(input)?;
        self.with_database(|db| workspace::create_project(db.connection(), &name, &description))
    }

    pub fn update_project(&self, id: i64, input: &ProjectInput) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "project id")?;
        let (name, description) = validate_project(input)?;
        self.with_database(|db| workspace::update_project(db.connection(), id, &name, &description))
    }

    pub fn delete_project(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "project id")?;
        self.with_database(|db| workspace::delete_project(db.connection(), id))
    }

    pub fn require_project(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "project id")?;
        self.with_database(|db| {
            let found = db
                .connection()
                .query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |_| Ok(()))
                .is_ok();
            if found {
                Ok(())
            } else {
                Err(VaultError::not_found("Project not found."))
            }
        })
    }

    pub fn create_service(&self, project_id: i64, input: &ServiceInput) -> VaultResult<i64> {
        self.require_unlocked()?;
        let project_id = validate_id(project_id, "project id")?;
        let (name, url, account_id) = validate_service(input)?;
        self.with_database(|db| workspace::create_service(db, project_id, &name, &url, account_id))
    }

    pub fn update_service(&self, id: i64, input: &ServiceInput) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "service id")?;
        let (name, url, account_id) = validate_service(input)?;
        self.with_database(|db| workspace::update_service(db, id, &name, &url, account_id))
    }

    pub fn delete_service(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "service id")?;
        self.with_database(|db| workspace::delete_service(db.connection(), id))
    }

    pub fn create_text_secret(&self, project_id: i64, input: SecretInput) -> VaultResult<i64> {
        let key = self.session_key()?;
        let project_id = validate_id(project_id, "project id")?;
        let name = validate_name(&input.name, "name", 200)?;
        let service_id = validate_optional_id(input.service_id, "service id")?;
        let value = Zeroizing::new(input.value);
        validate_secret_value(&value)?;
        let payload = crypto::encrypt_bytes(value.as_bytes(), &key)?;
        self.with_database(|db| {
            workspace::insert_secret(
                db,
                NewSecret {
                    project_id,
                    service_id,
                    kind: "text",
                    name: &name,
                    mime_type: "text/plain",
                    size: value.len() as i64,
                    payload: &payload,
                },
            )
        })
    }

    pub fn update_secret(&self, id: i64, input: SecretUpdateInput) -> VaultResult<()> {
        let key = self.session_key()?;
        let id = validate_id(id, "secret id")?;
        let name = validate_name(&input.name, "name", 200)?;
        let service_id = validate_optional_id(input.service_id, "service id")?;
        let sealed = match input.value {
            Some(value) => {
                let value = Zeroizing::new(value);
                validate_secret_value(&value)?;
                let kind = self
                    .with_database(|db| Ok(workspace::secret_payload(db.connection(), id)?.kind))?;
                if kind != "text" {
                    return Err(VaultError::invalid_input(
                        "A file’s content can’t be edited. Add the new version as a file.",
                    ));
                }
                Some((
                    crypto::encrypt_bytes(value.as_bytes(), &key)?,
                    value.len() as i64,
                ))
            }
            None => None,
        };
        self.with_database(|db| {
            workspace::update_secret(
                db,
                id,
                &name,
                service_id,
                sealed
                    .as_ref()
                    .map(|(payload, size)| (payload.as_slice(), *size)),
            )
        })
    }

    /// The plaintext of a text secret, or of a small UTF-8 file (an SSH key, a .env).
    pub fn reveal_secret(&self, id: i64) -> VaultResult<RevealedSecret> {
        let key = self.session_key()?;
        let id = validate_id(id, "secret id")?;
        let stored = self.with_database(|db| workspace::secret_payload(db.connection(), id))?;
        if stored.kind == "file" && stored.size > MAX_TEXT_FILE_BYTES {
            return Err(VaultError::invalid_input(format!(
                "“{}” is too large to show here. Save it as a file instead.",
                stored.name
            )));
        }
        let plain = crypto::decrypt_bytes(&stored.payload, &key)?;
        let text = std::str::from_utf8(&plain).map_err(|_| {
            VaultError::invalid_input(format!(
                "“{}” isn’t a text file. Save it as a file instead.",
                stored.name
            ))
        })?;
        Ok(RevealedSecret {
            value: text.to_owned(),
        })
    }

    pub fn delete_secret(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "secret id")?;
        self.with_database(|db| workspace::delete_secret(db.connection(), id))
    }

    pub fn secret_name(&self, id: i64) -> VaultResult<String> {
        self.require_unlocked()?;
        let id = validate_id(id, "secret id")?;
        self.with_database(|db| Ok(workspace::secret_payload(db.connection(), id)?.name))
    }

    /// Encrypts files from disk into a project. Paths come from the native picker
    /// or the OS drop event, never from the page.
    pub fn import_files(
        &self,
        project_id: i64,
        service_id: Option<i64>,
        paths: &[PathBuf],
    ) -> VaultResult<ImportReport> {
        let key = self.session_key()?;
        let project_id = validate_id(project_id, "project id")?;
        let service_id = validate_optional_id(service_id, "service id")?;
        let mut report = ImportReport::default();
        for path in paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".to_owned());
            let reason = match fs::metadata(path) {
                Ok(meta) if !meta.is_file() => Some("Only files can be added, not folders."),
                Ok(meta) if meta.len() > MAX_FILE_BYTES => Some("Files can be at most 25 MB."),
                Ok(_) => None,
                Err(_) => Some("The file couldn’t be read."),
            };
            if let Some(reason) = reason {
                report.skipped.push(SkippedFile {
                    name,
                    reason: reason.to_owned(),
                });
                continue;
            }
            let Ok(bytes) = fs::read(path).map(Zeroizing::new) else {
                report.skipped.push(SkippedFile {
                    name,
                    reason: "The file couldn’t be read.".to_owned(),
                });
                continue;
            };
            let payload = crypto::encrypt_bytes(&bytes, &key)?;
            let id = self.with_database(|db| {
                workspace::insert_secret(
                    db,
                    NewSecret {
                        project_id,
                        service_id,
                        kind: "file",
                        name: &name,
                        mime_type: workspace::guess_mime(&name),
                        size: bytes.len() as i64,
                        payload: &payload,
                    },
                )
            })?;
            report.imported.push(id);
        }
        Ok(report)
    }

    /// Decrypts a secret or file to a path the user chose in the native save dialog.
    pub fn export_secret(&self, id: i64, destination: &Path) -> VaultResult<()> {
        let key = self.session_key()?;
        let id = validate_id(id, "secret id")?;
        let stored = self.with_database(|db| workspace::secret_payload(db.connection(), id))?;
        let plain = crypto::decrypt_bytes(&stored.payload, &key)?;
        write_private(destination, &plain)
    }

    pub fn account_links(&self) -> VaultResult<LinkList> {
        self.require_unlocked()?;
        let links = self.with_database(|db| workspace::list_links(db.connection()))?;
        Ok(LinkList { links })
    }

    pub fn set_sign_in_links(&self, account_id: i64, linked: &[i64]) -> VaultResult<()> {
        self.require_unlocked()?;
        let account_id = validate_id(account_id, "account id")?;
        for &id in linked {
            validate_id(id, "account id")?;
        }
        self.with_database(|db| workspace::set_links(db, account_id, workspace::SIGN_IN, linked))
    }

    /// Replaces one kind of link from `account_id`: the accounts it signs in with
    /// (`sign_in`) or the accounts that can recover it (`recovery`).
    pub fn set_account_links(
        &self,
        account_id: i64,
        kind: &str,
        linked: &[i64],
    ) -> VaultResult<()> {
        self.require_unlocked()?;
        let account_id = validate_id(account_id, "account id")?;
        let kind = validate_kind(kind, workspace::LINK_KINDS, "kind of link")?;
        for &id in linked {
            validate_id(id, "account id")?;
        }
        self.with_database(|db| workspace::set_links(db, account_id, kind, linked))
    }

    pub fn remember_dropped(&self, paths: Vec<PathBuf>) {
        *lock_or_recover(&self.dropped) = Some((Instant::now(), paths));
    }

    /// The last dropped files, once, if they were dropped recently.
    pub fn take_dropped(&self) -> Vec<PathBuf> {
        match lock_or_recover(&self.dropped).take() {
            Some((at, paths)) if at.elapsed() < DROP_TTL => paths,
            _ => Vec::new(),
        }
    }
}

// ── devices, second steps, account secrets and notes (schema v3) ────────────

/// Seals a second step's secret part after checking it suits the kind: an
/// authenticator's setup key must produce codes, recovery codes can't be empty,
/// and the other kinds keep no secret. `None`: nothing to keep.
fn seal_factor_secret(
    kind: &str,
    secret: &str,
    key: &[u8; crypto::KEY_LEN],
) -> VaultResult<Option<Vec<u8>>> {
    let secret = secret.trim_matches(validation::is_js_whitespace);
    match kind {
        "authenticator" => {
            if secret.is_empty() {
                return Ok(None);
            }
            if secret.len() > MAX_SETUP_KEY_BYTES {
                return Err(VaultError::invalid_input("That setup key is too long."));
            }
            Totp::parse(secret)?;
            Ok(Some(crypto::encrypt_bytes(secret.as_bytes(), key)?))
        }
        "recovery_codes" => {
            if secret.is_empty() {
                return Err(VaultError::invalid_input("Enter the recovery codes."));
            }
            if secret.len() > MAX_SECRET_TEXT_BYTES {
                return Err(VaultError::invalid_input(
                    "Recovery codes can be at most 64 KB.",
                ));
            }
            Ok(Some(crypto::encrypt_bytes(secret.as_bytes(), key)?))
        }
        _ if secret.is_empty() => Ok(None),
        _ => Err(VaultError::invalid_input(
            "Only an authenticator app or recovery codes keep a secret.",
        )),
    }
}

fn utf8(plain: Zeroizing<Vec<u8>>) -> VaultResult<RevealedSecret> {
    let text = std::str::from_utf8(&plain)
        .map_err(|_| VaultError::internal("A stored secret could not be decrypted."))?;
    Ok(RevealedSecret {
        value: text.to_owned(),
    })
}

impl Vault {
    /// Devices, second steps, account secrets (metadata only) and device links.
    pub fn account_details(&self) -> VaultResult<AccountDetails> {
        self.require_unlocked()?;
        self.with_database(|db| account_details::load(db.connection()))
    }

    pub fn create_device(&self, input: &DeviceInput) -> VaultResult<i64> {
        self.require_unlocked()?;
        let (name, kind, notes) = validate_device(input)?;
        self.with_database(|db| {
            account_details::create_device(db.connection(), &name, kind, &notes)
        })
    }

    pub fn update_device(&self, id: i64, input: &DeviceInput) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "device id")?;
        let (name, kind, notes) = validate_device(input)?;
        self.with_database(|db| {
            account_details::update_device(db.connection(), id, &name, kind, &notes)
        })
    }

    pub fn delete_device(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "device id")?;
        self.with_database(|db| account_details::delete_device(db.connection(), id))
    }

    pub fn create_factor(&self, account_id: i64, input: FactorInput) -> VaultResult<i64> {
        let key = self.session_key()?;
        let account_id = validate_id(account_id, "account id")?;
        let kind = validate_kind(&input.kind, FACTOR_KINDS, "sign-in step")?;
        let label = validate_label(&input.label)?;
        let device_id = validate_optional_id(input.device_id, "device id")?;
        let secret = Zeroizing::new(input.secret.unwrap_or_default());
        let payload = seal_factor_secret(kind, &secret, &key)?;
        self.with_database(|db| {
            account_details::insert_factor(
                db,
                NewFactor {
                    account_id,
                    kind,
                    label: &label,
                    device_id,
                    payload: payload.as_deref(),
                },
            )
        })
    }

    pub fn update_factor(&self, id: i64, input: FactorUpdateInput) -> VaultResult<()> {
        let key = self.session_key()?;
        let id = validate_id(id, "sign-in step id")?;
        let label = validate_label(&input.label)?;
        let device_id = validate_optional_id(input.device_id, "device id")?;
        let sealed = match input.secret.map(Zeroizing::new) {
            None => None,
            Some(secret) => {
                let (kind, _) =
                    self.with_database(|db| account_details::factor_payload(db.connection(), id))?;
                Some(seal_factor_secret(&kind, &secret, &key)?)
            }
        };
        let change = match &sealed {
            None => PayloadChange::Keep,
            Some(None) => PayloadChange::Clear,
            Some(Some(payload)) => PayloadChange::Set(payload),
        };
        self.with_database(|db| account_details::update_factor(db, id, &label, device_id, change))
    }

    pub fn delete_factor(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "sign-in step id")?;
        self.with_database(|db| account_details::delete_factor(db.connection(), id))
    }

    /// An authenticator's setup key, or the recovery codes.
    pub fn reveal_factor(&self, id: i64) -> VaultResult<RevealedSecret> {
        let key = self.session_key()?;
        let id = validate_id(id, "sign-in step id")?;
        let (_, payload) =
            self.with_database(|db| account_details::factor_payload(db.connection(), id))?;
        let payload =
            payload.ok_or_else(|| VaultError::not_found("Nothing secret is saved for this."))?;
        utf8(crypto::decrypt_bytes(&payload, &key)?)
    }

    /// The authenticator code to show now, from the saved setup key.
    pub fn factor_code(&self, id: i64) -> VaultResult<TotpCode> {
        let key = self.session_key()?;
        let id = validate_id(id, "sign-in step id")?;
        let (kind, payload) =
            self.with_database(|db| account_details::factor_payload(db.connection(), id))?;
        let payload = match (kind.as_str(), payload) {
            ("authenticator", Some(payload)) => payload,
            _ => return Err(VaultError::not_found("No setup key is saved for this.")),
        };
        let plain = crypto::decrypt_bytes(&payload, &key)?;
        let setup = std::str::from_utf8(&plain)
            .map_err(|_| VaultError::internal("A stored secret could not be decrypted."))?;
        Ok(Totp::parse(setup)?.now())
    }

    pub fn create_account_secret(
        &self,
        account_id: i64,
        input: AccountSecretInput,
    ) -> VaultResult<i64> {
        let key = self.session_key()?;
        let account_id = validate_id(account_id, "account id")?;
        let kind = validate_kind(&input.kind, ACCOUNT_SECRET_KINDS, "kind of secret")?;
        let name = validate_name(&input.name, "name", 200)?;
        let value = Zeroizing::new(input.value);
        validate_secret_value(&value)?;
        let payload = crypto::encrypt_bytes(value.as_bytes(), &key)?;
        self.with_database(|db| {
            account_details::insert_account_secret(
                db,
                account_id,
                kind,
                &name,
                value.len() as i64,
                &payload,
            )
        })
    }

    pub fn update_account_secret(
        &self,
        id: i64,
        input: AccountSecretUpdateInput,
    ) -> VaultResult<()> {
        let key = self.session_key()?;
        let id = validate_id(id, "secret id")?;
        let name = validate_name(&input.name, "name", 200)?;
        let sealed = match input.value.map(Zeroizing::new) {
            Some(value) => {
                validate_secret_value(&value)?;
                Some((
                    crypto::encrypt_bytes(value.as_bytes(), &key)?,
                    value.len() as i64,
                ))
            }
            None => None,
        };
        self.with_database(|db| {
            account_details::update_account_secret(
                db,
                id,
                &name,
                sealed
                    .as_ref()
                    .map(|(payload, size)| (payload.as_slice(), *size)),
            )
        })
    }

    pub fn reveal_account_secret(&self, id: i64) -> VaultResult<RevealedSecret> {
        let key = self.session_key()?;
        let id = validate_id(id, "secret id")?;
        let payload =
            self.with_database(|db| account_details::account_secret_payload(db.connection(), id))?;
        utf8(crypto::decrypt_bytes(&payload, &key)?)
    }

    pub fn delete_account_secret(&self, id: i64) -> VaultResult<()> {
        self.require_unlocked()?;
        let id = validate_id(id, "secret id")?;
        self.with_database(|db| account_details::delete_account_secret(db.connection(), id))
    }

    /// The group the account is shown in; None goes back to the guessed one.
    pub fn set_account_category(&self, account_id: i64, name: Option<&str>) -> VaultResult<()> {
        self.require_unlocked()?;
        let account_id = validate_id(account_id, "account id")?;
        let name = validate_category(name)?;
        self.with_database(|db| {
            account_details::set_account_category(db.connection(), account_id, name.as_deref())
        })
    }

    pub fn set_account_devices(&self, account_id: i64, device_ids: &[i64]) -> VaultResult<()> {
        self.require_unlocked()?;
        let account_id = validate_id(account_id, "account id")?;
        for &id in device_ids {
            validate_id(id, "device id")?;
        }
        self.with_database(|db| account_details::set_account_devices(db, account_id, device_ids))
    }

    /// Sign-in links, recovery links and devices in one transaction (the account form).
    pub fn set_account_connections(
        &self,
        account_id: i64,
        connections: Connections<'_>,
    ) -> VaultResult<()> {
        self.require_unlocked()?;
        let account_id = validate_id(account_id, "account id")?;
        for &id in connections.sign_in.iter().chain(connections.recovery) {
            validate_id(id, "account id")?;
        }
        for &id in connections.devices {
            validate_id(id, "device id")?;
        }
        self.with_database(|db| account_details::set_connections(db, account_id, connections))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use rusqlite::Connection;
    use std::path::Path;

    const MASTER: &str = "correct horse battery staple";

    fn new_vault() -> (tempfile::TempDir, Vault) {
        let directory = tempfile::tempdir().unwrap();
        let vault = Vault::open(directory.path().join("vaultkey.sqlite3"));
        (directory, vault)
    }

    fn unlocked_vault() -> (tempfile::TempDir, Vault) {
        let (directory, vault) = new_vault();
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsSignup);
        vault.create_vault(MASTER).unwrap();
        assert!(vault.unlock(MASTER).unwrap().valid);
        (directory, vault)
    }

    fn credential(domain_id: i64, email: &str, password: &str) -> CredentialInput {
        CredentialInput {
            domain_id,
            username: Some("alice".into()),
            email: email.into(),
            password: password.into(),
        }
    }

    fn code<T: std::fmt::Debug>(result: VaultResult<T>) -> ErrorCode {
        result.unwrap_err().code
    }

    #[test]
    fn creates_an_idempotent_fresh_vault_with_a_random_kdf_salt() {
        let (_directory, vault) = new_vault();
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsSignup);
        let first = vault
            .with_database(|db| Ok(store::read_kdf(db.connection())?.unwrap()))
            .unwrap();
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsSignup);
        let second = vault
            .with_database(|db| Ok(store::read_kdf(db.connection())?.unwrap()))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            (
                first.iterations,
                first.memory_kib,
                first.parallelism,
                first.hash_length
            ),
            (3, 65_536, 1, 32)
        );

        let (_other_directory, other) = new_vault();
        other.status().unwrap();
        let other_kdf = other
            .with_database(|db| Ok(store::read_kdf(db.connection())?.unwrap()))
            .unwrap();
        assert_ne!(first.salt, other_kdf.salt);
    }

    #[test]
    fn registers_and_verifies_without_storing_the_key() {
        let (_directory, vault) = new_vault();
        vault.status().unwrap();
        vault.create_vault(MASTER).unwrap();
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsLogin);
        assert!(
            !vault.is_unlocked(),
            "signup must not unlock (Electron behaviour)"
        );

        assert!(!vault.unlock("wrong password").unwrap().valid);
        assert!(!vault.is_unlocked());
        assert!(vault.unlock(MASTER).unwrap().valid);
        assert!(vault.is_unlocked());

        let stored = vault
            .with_database(|db| Ok(store::read_verifier(db.connection())?.unwrap()))
            .unwrap();
        assert_eq!((stored.salt.len(), stored.verifier.len()), (16, 32));
        assert_eq!(code(vault.create_vault(MASTER)), ErrorCode::AlreadyExists);
        assert_eq!(code(vault.create_vault("short")), ErrorCode::InvalidInput);
    }

    #[test]
    fn a_lock_during_an_in_flight_unlock_wins() {
        let (_directory, vault) = new_vault();
        vault.status().unwrap();
        vault.create_vault(MASTER).unwrap();
        let vault = std::sync::Arc::new(vault);

        // Park the unlock at the KDF gate, after it has sampled the session epoch.
        let gate = lock_or_recover(&vault.kdf_gate);
        let worker = {
            let vault = vault.clone();
            std::thread::spawn(move || vault.unlock(MASTER))
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        vault.lock(); // e.g. the page reloaded
        drop(gate);

        assert_eq!(code(worker.join().unwrap()), ErrorCode::VaultLocked);
        assert!(!vault.is_unlocked());
        assert!(
            vault.unlock(MASTER).unwrap().valid,
            "a fresh unlock still works"
        );
    }

    #[test]
    fn debug_output_never_contains_plaintext() {
        let shown = Credential {
            id: 1,
            username: None,
            email: "a@b.co".into(),
            password: "hunter2".into(),
        };
        assert!(!format!("{shown:?}").contains("hunter2"));
        assert!(!format!("{:?}", credential(1, "a@b.co", "hunter2")).contains("hunter2"));
        let update = CredentialUpdateInput {
            password: Some("hunter2".into()),
            ..Default::default()
        };
        assert!(!format!("{update:?}").contains("hunter2"));
    }

    #[test]
    fn refuses_tampered_kdf_parameters() {
        for tamper in [
            "argon2_hash_length = 4",
            "argon2_memory_size = 8",
            "argon2_iterations = 1",
            "argon2_memory_size = 4294967295",
            "argon2_parallelism = 1000",
        ] {
            let (_directory, vault) = new_vault();
            vault.status().unwrap();
            vault
                .with_database(|db| {
                    db.connection()
                        .execute(&format!("UPDATE vault_metadata SET {tamper}"), [])?;
                    Ok(())
                })
                .unwrap();
            assert_eq!(code(vault.status()), ErrorCode::Internal, "{tamper}");
            assert_eq!(
                code(vault.create_vault(MASTER)),
                ErrorCode::Internal,
                "{tamper}"
            );
        }
    }

    #[test]
    fn unlock_before_signup_is_not_found() {
        let (_directory, vault) = new_vault();
        vault.status().unwrap();
        assert_eq!(code(vault.unlock(MASTER)), ErrorCode::NotFound);
    }

    #[test]
    fn guards_every_vault_operation_behind_unlock() {
        let (_directory, vault) = unlocked_vault();
        vault.lock();
        assert_eq!(code(vault.list_domains()), ErrorCode::VaultLocked);
        assert_eq!(
            code(vault.create_domain("example.com")),
            ErrorCode::VaultLocked
        );
        assert_eq!(code(vault.delete_domain(1)), ErrorCode::VaultLocked);
        assert_eq!(code(vault.list_credentials(1)), ErrorCode::VaultLocked);
        assert_eq!(
            code(vault.create_credential(credential(1, "a@b.co", "x"))),
            ErrorCode::VaultLocked
        );
        assert_eq!(
            code(vault.update_credential(1, CredentialUpdateInput::default())),
            ErrorCode::VaultLocked
        );
        assert_eq!(code(vault.delete_credential(1)), ErrorCode::VaultLocked);
        // Schema v3: nothing about an account's second steps leaks while locked.
        assert_eq!(code(vault.account_details()), ErrorCode::VaultLocked);
        assert_eq!(code(vault.reveal_factor(1)), ErrorCode::VaultLocked);
        assert_eq!(code(vault.factor_code(1)), ErrorCode::VaultLocked);
        assert_eq!(code(vault.reveal_account_secret(1)), ErrorCode::VaultLocked);
        assert_eq!(code(vault.delete_device(1)), ErrorCode::VaultLocked);
        assert_eq!(
            code(vault.set_account_devices(1, &[])),
            ErrorCode::VaultLocked
        );
        assert_eq!(
            code(vault.set_account_links(1, "recovery", &[])),
            ErrorCode::VaultLocked
        );
        assert!(vault.unlock(MASTER).unwrap().valid);
        assert!(vault.list_domains().is_ok());
    }

    #[test]
    fn persists_auth_domains_and_credentials_after_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        {
            let vault = Vault::open(path.clone());
            vault.status().unwrap();
            vault.create_vault(MASTER).unwrap();
            assert!(vault.unlock(MASTER).unwrap().valid);
            vault.create_domain("example.com").unwrap();
            let domain = &vault.list_domains().unwrap().domains[0];
            vault
                .create_credential(credential(domain.id, "alice@example.com", "s3cret"))
                .unwrap();
            assert_eq!(
                vault.list_domains().unwrap().domains[0].count.credentials,
                1
            );
            vault.close();
        }
        let vault = Vault::open(path);
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsLogin);
        assert!(vault.unlock(MASTER).unwrap().valid);
        let domain = &vault.list_domains().unwrap().domains[0];
        assert_eq!(domain.name, "example.com");
        let credentials = vault.list_credentials(domain.id).unwrap().credentials;
        assert_eq!(credentials[0].password, "s3cret");
        assert_eq!(credentials[0].username.as_deref(), Some("alice"));
    }

    #[test]
    fn stores_only_ciphertext() {
        let (_directory, vault) = unlocked_vault();
        vault.create_domain("example.com").unwrap();
        let id = vault.list_domains().unwrap().domains[0].id;
        vault
            .create_credential(credential(id, "a@example.com", "plain-text-secret"))
            .unwrap();
        let raw = vault
            .with_database(|db| store::list_credentials(db.connection(), id))
            .unwrap();
        assert!(!raw[0].password.contains("plain-text-secret"));
        assert!(raw[0].password.len() >= 40 && raw[0].password.len() % 4 == 0);
    }

    #[test]
    fn enforces_uniqueness_partial_updates_and_cascade_deletion() {
        let (_directory, vault) = unlocked_vault();
        vault.create_domain("example.com").unwrap();
        assert_eq!(
            code(vault.create_domain("example.com")),
            ErrorCode::AlreadyExists
        );
        assert_eq!(code(vault.create_domain("   ")), ErrorCode::InvalidInput);
        let domain_id = vault.list_domains().unwrap().domains[0].id;

        vault
            .create_credential(credential(domain_id, "alice@example.com", "one"))
            .unwrap();
        vault
            .create_credential(credential(domain_id, "bob@example.com", "two"))
            .unwrap();
        assert_eq!(
            code(vault.create_credential(credential(domain_id, "alice@example.com", "dup"))),
            ErrorCode::AlreadyExists
        );
        assert_eq!(
            code(vault.create_credential(credential(domain_id, "not-an-email", "x"))),
            ErrorCode::InvalidInput
        );

        let credentials = vault.list_credentials(domain_id).unwrap().credentials;
        let alice = credentials[0].id;
        vault
            .update_credential(
                alice,
                CredentialUpdateInput {
                    username: Some("updated".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let after = vault.list_credentials(domain_id).unwrap().credentials;
        assert_eq!(after[0].username.as_deref(), Some("updated"));
        assert_eq!(
            after[0].password, "one",
            "partial update must keep the password"
        );

        vault
            .update_credential(
                alice,
                CredentialUpdateInput {
                    password: Some("rotated".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            vault.list_credentials(domain_id).unwrap().credentials[0].password,
            "rotated"
        );

        // Moving alice onto bob's email violates UNIQUE(email, domain_id).
        assert_eq!(
            code(vault.update_credential(
                alice,
                CredentialUpdateInput {
                    email: Some("bob@example.com".into()),
                    ..Default::default()
                }
            )),
            ErrorCode::AlreadyExists
        );
        assert_eq!(
            code(vault.update_credential(
                9_999,
                CredentialUpdateInput {
                    username: Some("x".into()),
                    ..Default::default()
                }
            )),
            ErrorCode::NotFound
        );

        vault.delete_credential(credentials[1].id).unwrap();
        assert_eq!(
            code(vault.delete_credential(credentials[1].id)),
            ErrorCode::NotFound
        );
        vault.delete_domain(domain_id).unwrap();
        assert!(
            vault
                .list_credentials(domain_id)
                .unwrap()
                .credentials
                .is_empty()
        );
        assert_eq!(code(vault.delete_domain(domain_id)), ErrorCode::NotFound);
    }

    #[test]
    fn lists_every_account_with_its_website_and_never_a_password() {
        let (_directory, vault) = unlocked_vault();
        vault.create_domain("Zeta.app").unwrap();
        vault.create_domain("alpha.com").unwrap();
        vault.create_domain("empty.org").unwrap();
        let domains = vault.list_domains().unwrap().domains;
        let id = |name: &str| domains.iter().find(|d| d.name == name).unwrap().id;
        vault
            .create_credential(credential(id("Zeta.app"), "z@example.com", "pw-zeta"))
            .unwrap();
        vault
            .create_credential(credential(id("alpha.com"), "b@example.com", "pw-b"))
            .unwrap();
        vault
            .create_credential(credential(id("alpha.com"), "A@example.com", "pw-a"))
            .unwrap();

        let accounts = vault.list_accounts().unwrap().accounts;
        let order: Vec<(&str, &str)> = accounts
            .iter()
            .map(|a| (a.domain_name.as_str(), a.email.as_str()))
            .collect();
        // Case-insensitive by website, then by email; empty websites have no rows.
        assert_eq!(
            order,
            [
                ("alpha.com", "A@example.com"),
                ("alpha.com", "b@example.com"),
                ("Zeta.app", "z@example.com")
            ]
        );
        assert_eq!(accounts[0].domain_id, id("alpha.com"));
        assert_eq!(accounts[0].username.as_deref(), Some("alice"));

        let json = serde_json::to_string(&vault.list_accounts().unwrap()).unwrap();
        assert!(
            !json.contains("pw-"),
            "no password, plaintext or encrypted, in the list"
        );
        let ciphertexts: Vec<String> = vault
            .with_database(|db| {
                let mut statement = db
                    .connection()
                    .prepare("SELECT password FROM credentials")?;
                Ok(statement
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .unwrap();
        assert!(
            ciphertexts.iter().all(|c| !json.contains(c.as_str())),
            "nor its ciphertext"
        );
        // The only password-related field is whether there is one.
        assert_eq!(
            json.to_lowercase().matches("password").count(),
            json.matches("\"hasPassword\":true").count()
        );
        assert!(json.contains("\"domainName\"") && json.contains("\"updatedAt\""));

        vault.lock();
        assert_eq!(code(vault.list_accounts()), ErrorCode::VaultLocked);
    }

    #[test]
    fn rolls_back_a_failed_credential_transaction() {
        let (_directory, vault) = unlocked_vault();
        assert_eq!(
            code(vault.create_credential(credential(999, "missing@example.com", "x"))),
            ErrorCode::NotFound
        );
        let count: i64 = vault
            .with_database(|db| {
                Ok(db
                    .connection()
                    .query_row("SELECT COUNT(*) FROM credentials", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn domain_counts_and_ordering_match_the_electron_query() {
        let (_directory, vault) = unlocked_vault();
        vault.create_domain("b.example").unwrap();
        vault.create_domain("a.example").unwrap();
        let domains = vault.list_domains().unwrap().domains;
        assert_eq!(
            domains.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["b.example", "a.example"]
        );
        vault
            .create_credential(credential(domains[1].id, "x@a.example", "p"))
            .unwrap();
        let domains = vault.list_domains().unwrap().domains;
        assert_eq!(
            (domains[0].count.credentials, domains[1].count.credentials),
            (0, 1)
        );
        let json = serde_json::to_value(&domains[1]).unwrap();
        assert_eq!(json["_count"]["credentials"], 1);
        assert!(json["createdAt"].is_string() && json["updatedAt"].is_string());
    }

    /// Writes a vault exactly as the Electron app left it: schema v1 only (none of the
    /// later migrations), rows produced by the Electron crypto code (crypto tests).
    fn write_electron_v1_vault(path: &Path) {
        use crate::crypto::tests::{CT1, VECTOR_SALT, VERIFIER, VERIFIER_SALT};
        use base64::Engine;

        let database = VaultDatabase::open_with(path, &crate::db::MIGRATIONS[..1], None).unwrap();
        let conn = database.connection();
        let salt = base64::engine::general_purpose::STANDARD
            .decode(VECTOR_SALT)
            .unwrap();
        let ts = "2026-07-15T19:44:45.457Z";
        conn.execute(
            "INSERT INTO vault_metadata VALUES (1, 2, ?1, 3, 65536, 1, 32, ?2, ?2)",
            rusqlite::params![salt, ts],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO auth_key VALUES (1, 1, ?1, ?2, ?3, ?3)",
            rusqlite::params![
                hex::decode(VERIFIER_SALT).unwrap(),
                hex::decode(VERIFIER).unwrap(),
                ts
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO domains (name, created_at, updated_at) VALUES ('github.com', ?1, ?1)",
            [ts],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO credentials (domain_id, username, email, password, created_at, updated_at, last_time_used)
             VALUES (1, NULL, 'me@example.com', ?1, ?2, ?2, ?2)",
            rusqlite::params![CT1, ts],
        )
        .unwrap();
        database.close();
    }

    /// The guarantee every migration, present and future, must keep: a vault the
    /// Electron app wrote upgrades to the latest schema, still unlocks with the same
    /// password, still decrypts, and every original row survives byte-for-byte.
    #[test]
    fn upgrades_and_opens_a_vault_written_by_the_electron_app() {
        use crate::crypto::tests::ASCII_PASSWORD;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        write_electron_v1_vault(&path);
        let before = directory.path().join("before.sqlite3");
        std::fs::copy(&path, &before).unwrap();

        let vault = Vault::open(path);
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsLogin);
        assert!(!vault.unlock("not the password").unwrap().valid);
        assert!(vault.unlock(ASCII_PASSWORD).unwrap().valid);
        let domains = vault.list_domains().unwrap().domains;
        assert_eq!(
            (domains[0].name.as_str(), domains[0].count.credentials),
            ("github.com", 1)
        );
        let credentials = vault.list_credentials(domains[0].id).unwrap().credentials;
        assert_eq!(credentials[0].password, "secret-password");
        assert_eq!(credentials[0].username, None);

        let latest = crate::db::MIGRATIONS.last().unwrap().version;
        assert_eq!(
            vault.with_database(|db| db.schema_version()).unwrap(),
            latest
        );
        let (checked, problems) = vault
            .with_database(|db| crate::db::rows_missing_after_migration(&before, db.connection()))
            .unwrap();
        assert!(
            problems.is_empty(),
            "a migration loses Electron-era data: {problems:?}"
        );
        assert_eq!(checked, 4, "metadata, verifier, one domain, one credential");
        if latest > 1 {
            let backed_up = std::fs::read_dir(directory.path().join("backups"))
                .unwrap()
                .any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with("vaultkey-v1-")
                });
            assert!(backed_up, "the v1 vault must be backed up before migrating");
        }
    }

    #[test]
    fn retries_opening_after_a_failed_start() {
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("not-a-directory");
        std::fs::write(&blocked, "file").unwrap();
        let vault = Vault::open(blocked.join("vaultkey.sqlite3"));
        assert_eq!(code(vault.status()), ErrorCode::DatabaseUnavailable);
        std::fs::remove_file(&blocked).unwrap();
        assert_eq!(vault.status().unwrap().status, AuthStatus::NeedsSignup);
    }

    /// v1 as it shipped, plus a hypothetical v2 (what a real future migration looks like).
    fn with_v2(v2_sql: &'static str) -> [crate::db::Migration; 2] {
        let v1 = &crate::db::MIGRATIONS[0];
        [
            crate::db::Migration {
                version: 1,
                name: v1.name,
                sql: v1.sql,
            },
            crate::db::Migration {
                version: 2,
                name: "future",
                sql: v2_sql,
            },
        ]
    }

    #[test]
    fn a_future_additive_migration_keeps_every_row_and_backs_up_first() {
        use crate::crypto::tests::ASCII_PASSWORD;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        write_electron_v1_vault(&path);
        let before = directory.path().join("before.sqlite3");
        std::fs::copy(&path, &before).unwrap();

        let migrations = with_v2(
            "ALTER TABLE credentials ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;",
        );
        let database = VaultDatabase::open_with(&path, &migrations, None).unwrap();
        assert_eq!(database.schema_version().unwrap(), 2);
        let (checked, problems) =
            crate::db::rows_missing_after_migration(&before, database.connection()).unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(checked, 4);
        database.close();

        // The pre-migration backup is a complete, openable v1 vault.
        let backup = std::fs::read_dir(directory.path().join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|p| p.extension().is_some_and(|e| e == "sqlite3"))
            .expect("a backup was written before migrating");
        let restored = Connection::open(&backup).unwrap();
        let version: i64 = restored
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1);
        let (_, problems) = crate::db::rows_missing_after_migration(&before, &restored).unwrap();
        assert!(
            problems.is_empty(),
            "the backup must hold every original row: {problems:?}"
        );
        drop(restored);

        // And the migrated vault still unlocks and decrypts.
        let vault = Vault {
            path: path.clone(),
            database: Mutex::new(Some(
                VaultDatabase::open_with(&path, &migrations, None).unwrap(),
            )),
            session: Mutex::new(Session::default()),
            kdf_gate: Mutex::new(()),
            dropped: Mutex::new(None),
        };
        assert!(vault.unlock(ASCII_PASSWORD).unwrap().valid);
        let domain = vault.list_domains().unwrap().domains[0].id;
        assert_eq!(
            vault.list_credentials(domain).unwrap().credentials[0].password,
            "secret-password"
        );
    }

    #[test]
    fn a_destructive_future_migration_is_caught() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        write_electron_v1_vault(&path);
        let before = directory.path().join("before.sqlite3");
        std::fs::copy(&path, &before).unwrap();

        let migrations = with_v2("UPDATE credentials SET password = 'oops'");
        let database = VaultDatabase::open_with(&path, &migrations, None).unwrap();
        let (_, problems) =
            crate::db::rows_missing_after_migration(&before, database.connection()).unwrap();
        assert_eq!(
            problems,
            vec!["1 of 1 rows in credentials changed or disappeared".to_owned()]
        );
    }

    fn project(vault: &Vault, name: &str) -> i64 {
        vault
            .create_project(&ProjectInput {
                name: name.into(),
                description: String::new(),
            })
            .unwrap()
    }

    fn account(vault: &Vault, website: &str, email: &str) -> i64 {
        let domain = match vault.create_domain(website) {
            Ok(id) => id,
            Err(_) => {
                vault
                    .list_domains()
                    .unwrap()
                    .domains
                    .iter()
                    .find(|d| d.name == website)
                    .unwrap()
                    .id
            }
        };
        vault
            .create_credential(credential(domain, email, "pw"))
            .unwrap()
    }

    #[test]
    fn projects_services_and_text_secrets_round_trip() {
        let (_directory, vault) = unlocked_vault();
        let google = account(&vault, "google.com", "me@gmail.com");

        let acme = vault
            .create_project(&ProjectInput {
                name: "  Acme Store ".into(),
                description: "Shop rebuild".into(),
            })
            .unwrap();
        let duplicate = vault.create_project(&ProjectInput {
            name: "Acme Store".into(),
            description: String::new(),
        });
        assert_eq!(
            duplicate.unwrap_err().message,
            "A project with that name already exists."
        );
        assert_eq!(
            code(vault.create_project(&ProjectInput {
                name: "   ".into(),
                description: String::new()
            })),
            ErrorCode::InvalidInput
        );

        let coolify = vault
            .create_service(
                acme,
                &ServiceInput {
                    name: "Coolify".into(),
                    url: "https://coolify.acme.dev".into(),
                    account_id: Some(google),
                },
            )
            .unwrap();
        assert_eq!(
            code(vault.create_service(
                acme,
                &ServiceInput {
                    name: "Coolify".into(),
                    url: String::new(),
                    account_id: None
                }
            )),
            ErrorCode::AlreadyExists
        );
        assert_eq!(
            code(vault.create_service(
                acme,
                &ServiceInput {
                    name: "Ghost".into(),
                    url: String::new(),
                    account_id: Some(9_999)
                }
            )),
            ErrorCode::NotFound
        );

        let key = vault
            .create_text_secret(
                acme,
                SecretInput {
                    name: "STRIPE_KEY".into(),
                    value: "sk_live_123".into(),
                    service_id: Some(coolify),
                },
            )
            .unwrap();
        let workspace = vault.workspace().unwrap();
        assert_eq!(workspace.projects[0].name, "Acme Store");
        assert_eq!(workspace.services[0].account_id, Some(google));
        let meta = &workspace.secrets[0];
        assert_eq!(
            (meta.kind.as_str(), meta.size, meta.service_id),
            ("text", 11, Some(coolify))
        );
        let listed = serde_json::to_string(&workspace).unwrap();
        assert!(
            !listed.contains("sk_live_123"),
            "listings never carry a secret"
        );
        let stored: Vec<u8> = vault
            .with_database(|db| {
                Ok(db
                    .connection()
                    .query_row("SELECT payload FROM secrets", [], |r| r.get(0))?)
            })
            .unwrap();
        assert!(
            !stored.windows(7).any(|w| w == b"sk_live"),
            "encrypted at rest"
        );
        assert_eq!(vault.reveal_secret(key).unwrap().value, "sk_live_123");

        vault
            .update_secret(
                key,
                SecretUpdateInput {
                    name: "STRIPE_SECRET".into(),
                    service_id: None,
                    value: Some("sk_live_456".into()),
                },
            )
            .unwrap();
        assert_eq!(vault.reveal_secret(key).unwrap().value, "sk_live_456");
        vault
            .update_secret(
                key,
                SecretUpdateInput {
                    name: "STRIPE_SECRET".into(),
                    service_id: Some(coolify),
                    value: None,
                },
            )
            .unwrap();
        assert_eq!(
            vault.reveal_secret(key).unwrap().value,
            "sk_live_456",
            "no value keeps the old one"
        );

        // A secret can't be attached to another project's service.
        let other = project(&vault, "Other");
        let elsewhere = vault
            .create_service(
                other,
                &ServiceInput {
                    name: "Vercel".into(),
                    url: String::new(),
                    account_id: None,
                },
            )
            .unwrap();
        assert_eq!(
            code(vault.create_text_secret(
                acme,
                SecretInput {
                    name: "X".into(),
                    value: "y".into(),
                    service_id: Some(elsewhere)
                }
            )),
            ErrorCode::InvalidInput
        );

        // Deleting the account unlinks the service; deleting the service keeps its secrets.
        vault.delete_credential(google).unwrap();
        assert_eq!(
            vault
                .workspace()
                .unwrap()
                .services
                .iter()
                .find(|s| s.id == coolify)
                .unwrap()
                .account_id,
            None
        );
        vault.delete_service(coolify).unwrap();
        let workspace = vault.workspace().unwrap();
        assert_eq!(
            workspace
                .secrets
                .iter()
                .find(|s| s.id == key)
                .unwrap()
                .service_id,
            None
        );

        // Deleting the project removes its services and secrets.
        vault.delete_project(acme).unwrap();
        let workspace = vault.workspace().unwrap();
        assert!(workspace.secrets.is_empty());
        assert_eq!(workspace.projects.len(), 1);

        vault.lock();
        assert_eq!(code(vault.workspace()), ErrorCode::VaultLocked);
        assert_eq!(code(vault.reveal_secret(key)), ErrorCode::VaultLocked);
        assert_eq!(
            code(vault.create_project(&ProjectInput {
                name: "Z".into(),
                description: String::new()
            })),
            ErrorCode::VaultLocked
        );
    }

    #[test]
    fn files_are_encrypted_on_import_shown_as_text_when_text_and_exported_intact() {
        let (directory, vault) = unlocked_vault();
        let acme = project(&vault, "Acme");
        let ssh = directory.path().join("id_ed25519");
        std::fs::write(&ssh, "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n").unwrap();
        let image = directory.path().join("logo.png");
        let image_bytes = [0x89, b'P', b'N', b'G', 0x00, 0xff, 0xfe, 0x10];
        std::fs::write(&image, image_bytes).unwrap();
        let folder = directory.path().join("folder");
        std::fs::create_dir(&folder).unwrap();
        let missing = directory.path().join("missing.txt");

        let report = vault
            .import_files(acme, None, &[ssh, image, folder, missing])
            .unwrap();
        assert_eq!(report.imported.len(), 2);
        let skipped: Vec<&str> = report.skipped.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(skipped, ["folder", "missing.txt"]);

        let workspace = vault.workspace().unwrap();
        let file = |name: &str| {
            workspace
                .secrets
                .iter()
                .find(|s| s.name == name)
                .unwrap()
                .clone()
        };
        assert_eq!(
            (
                file("logo.png").kind.as_str(),
                file("logo.png").size,
                file("logo.png").mime_type.as_str()
            ),
            ("file", 8, "image/png")
        );
        assert!(
            vault
                .reveal_secret(file("id_ed25519").id)
                .unwrap()
                .value
                .starts_with("-----BEGIN OPENSSH")
        );
        assert_eq!(
            code(vault.reveal_secret(file("logo.png").id)),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.update_secret(
                file("logo.png").id,
                SecretUpdateInput {
                    name: "logo.png".into(),
                    service_id: None,
                    value: Some("x".into())
                }
            )),
            ErrorCode::InvalidInput,
            "a file's content is replaced by adding it again, not edited as text"
        );

        let stored: Vec<Vec<u8>> = vault
            .with_database(|db| {
                Ok(db
                    .connection()
                    .prepare("SELECT payload FROM secrets")?
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .unwrap();
        assert!(
            stored
                .iter()
                .all(|p| !p.windows(7).any(|w| w == b"OPENSSH")),
            "encrypted at rest"
        );

        let out = directory.path().join("exported.png");
        vault.export_secret(file("logo.png").id, &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), image_bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&out).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn sign_in_links_are_replaced_atomically_and_follow_deletions() {
        let (_directory, vault) = unlocked_vault();
        let vercel = account(&vault, "vercel.com", "me@gmail.com");
        let google = account(&vault, "google.com", "me@gmail.com");
        let github = account(&vault, "github.com", "me@example.com");

        vault.set_sign_in_links(vercel, &[google, github]).unwrap();
        assert_eq!(vault.account_links().unwrap().links.len(), 2);
        vault.set_sign_in_links(vercel, &[google]).unwrap();
        let links = vault.account_links().unwrap().links;
        assert_eq!(
            (
                links.len(),
                links[0].linked_account_id,
                links[0].kind.as_str()
            ),
            (1, google, "sign_in")
        );

        // A bad request changes nothing.
        assert_eq!(
            code(vault.set_sign_in_links(vercel, &[github, vercel])),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.set_sign_in_links(vercel, &[9_999])),
            ErrorCode::NotFound
        );
        assert_eq!(
            vault.account_links().unwrap().links[0].linked_account_id,
            google
        );

        vault.delete_credential(google).unwrap();
        assert!(
            vault.account_links().unwrap().links.is_empty(),
            "links go with the account"
        );
    }

    #[test]
    fn dropped_files_are_imported_once() {
        let (directory, vault) = unlocked_vault();
        let acme = project(&vault, "Acme");
        let file = directory.path().join(".env");
        std::fs::write(&file, "TOKEN=1").unwrap();
        vault.remember_dropped(vec![file]);
        let paths = vault.take_dropped();
        assert_eq!(
            vault
                .import_files(acme, None, &paths)
                .unwrap()
                .imported
                .len(),
            1
        );
        assert!(
            vault.take_dropped().is_empty(),
            "a drop is consumed by one import"
        );
    }

    fn device(vault: &Vault, name: &str, kind: &str) -> i64 {
        vault
            .create_device(&DeviceInput {
                name: name.into(),
                kind: kind.into(),
                notes: String::new(),
            })
            .unwrap()
    }

    fn factor(
        kind: &str,
        label: &str,
        device_id: Option<i64>,
        secret: Option<&str>,
    ) -> FactorInput {
        FactorInput {
            kind: kind.into(),
            label: label.into(),
            device_id,
            secret: secret.map(Into::into),
        }
    }

    #[test]
    fn second_steps_keep_their_secrets_sealed_and_codes_live() {
        let (_directory, vault) = unlocked_vault();
        let github = account(&vault, "github.com", "me@example.com");
        let iphone = device(&vault, "iPhone", "phone");
        let yubikey = device(&vault, "YubiKey 5C", "security_key");
        assert_eq!(
            code(vault.create_device(&DeviceInput {
                name: "iPhone".into(),
                kind: "tablet".into(),
                notes: String::new()
            })),
            ErrorCode::AlreadyExists
        );
        assert_eq!(
            code(vault.create_device(&DeviceInput {
                name: "Pager".into(),
                kind: "pager".into(),
                notes: String::new()
            })),
            ErrorCode::InvalidInput
        );

        let app = vault
            .create_factor(
                github,
                factor(
                    "authenticator",
                    "Google Authenticator",
                    Some(iphone),
                    Some(" JBSWY3DPEHPK3PXP "),
                ),
            )
            .unwrap();
        let passkey = vault
            .create_factor(github, factor("passkey", "iCloud Keychain", None, None))
            .unwrap();
        vault
            .create_factor(github, factor("security_key", "", Some(yubikey), Some("")))
            .unwrap();
        let codes = vault
            .create_factor(
                github,
                factor("recovery_codes", "", None, Some("aaaa-1111\nbbbb-2222")),
            )
            .unwrap();

        // Each kind only takes what it can use.
        assert_eq!(
            code(vault.create_factor(
                github,
                factor("authenticator", "", None, Some("not a key!"))
            )),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.create_factor(github, factor("passkey", "", None, Some("secret")))),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.create_factor(github, factor("recovery_codes", "", None, Some("  ")))),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.create_factor(github, factor("carrier pigeon", "", None, None))),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.create_factor(github, factor("sms", "", Some(9_999), None))),
            ErrorCode::NotFound
        );
        assert_eq!(
            code(vault.create_factor(9_999, factor("sms", "", None, None))),
            ErrorCode::NotFound
        );

        let live = vault.factor_code(app).unwrap();
        assert_eq!(live.code.len(), 6);
        assert_eq!(
            live.code,
            Totp::parse("JBSWY3DPEHPK3PXP").unwrap().now().code
        );
        assert_eq!(code(vault.factor_code(passkey)), ErrorCode::NotFound);
        assert_eq!(vault.reveal_factor(app).unwrap().value, "JBSWY3DPEHPK3PXP");
        assert_eq!(
            vault.reveal_factor(codes).unwrap().value,
            "aaaa-1111\nbbbb-2222"
        );
        assert_eq!(code(vault.reveal_factor(passkey)), ErrorCode::NotFound);

        let details = vault.account_details().unwrap();
        let listed = serde_json::to_string(&details).unwrap();
        assert!(
            !listed.contains("JBSWY3DP") && !listed.contains("aaaa-1111"),
            "listings never carry a secret"
        );
        let flags: Vec<_> = details
            .factors
            .iter()
            .map(|f| (f.kind.as_str(), f.has_secret, f.device_id))
            .collect();
        assert_eq!(
            flags,
            [
                ("authenticator", true, Some(iphone)),
                ("passkey", false, None),
                ("security_key", false, Some(yubikey)),
                ("recovery_codes", true, None)
            ]
        );
        let at_rest: Vec<Vec<u8>> = vault
            .with_database(|db| {
                let mut statement = db
                    .connection()
                    .prepare("SELECT payload FROM account_factors WHERE payload IS NOT NULL")?;
                Ok(statement
                    .query_map([], |r| r.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .unwrap();
        assert_eq!(at_rest.len(), 2);
        assert!(
            at_rest
                .iter()
                .all(|p| !p.windows(4).any(|w| w == b"JBSW" || w == b"aaaa")),
            "encrypted at rest"
        );

        // Updating: no secret keeps it, an empty one removes an optional one.
        vault
            .update_factor(
                app,
                FactorUpdateInput {
                    label: "Authy".into(),
                    device_id: Some(iphone),
                    secret: None,
                },
            )
            .unwrap();
        assert!(vault.factor_code(app).is_ok());
        vault
            .update_factor(
                app,
                FactorUpdateInput {
                    label: "Authy".into(),
                    device_id: None,
                    secret: Some(String::new()),
                },
            )
            .unwrap();
        assert_eq!(code(vault.factor_code(app)), ErrorCode::NotFound);
        assert_eq!(
            code(vault.update_factor(
                codes,
                FactorUpdateInput {
                    label: String::new(),
                    device_id: None,
                    secret: Some(String::new())
                }
            )),
            ErrorCode::InvalidInput
        );
        vault
            .update_factor(
                codes,
                FactorUpdateInput {
                    label: "Printed".into(),
                    device_id: None,
                    secret: Some("cccc-3333".into()),
                },
            )
            .unwrap();
        assert_eq!(vault.reveal_factor(codes).unwrap().value, "cccc-3333");

        // A lost device leaves the steps that lived on it, untied.
        vault.delete_device(yubikey).unwrap();
        let details = vault.account_details().unwrap();
        assert_eq!(
            details
                .factors
                .iter()
                .filter(|f| f.device_id.is_some())
                .count(),
            0
        );
        assert_eq!(details.factors.len(), 4);

        vault.delete_factor(passkey).unwrap();
        assert_eq!(code(vault.delete_factor(passkey)), ErrorCode::NotFound);
    }

    #[test]
    fn accounts_keep_secrets_notes_devices_and_recovery_links() {
        let (_directory, vault) = unlocked_vault();
        let github = account(&vault, "github.com", "me@example.com");
        let gmail = account(&vault, "google.com", "me@gmail.com");
        let mac = device(&vault, "MacBook", "computer");
        let iphone = device(&vault, "iPhone", "phone");

        let token = vault
            .create_account_secret(
                github,
                AccountSecretInput {
                    kind: "secret".into(),
                    name: "PAT".into(),
                    value: "ghp_123".into(),
                },
            )
            .unwrap();
        let note = vault
            .create_account_secret(
                github,
                AccountSecretInput {
                    kind: "note".into(),
                    name: "Support PIN".into(),
                    value: "4421".into(),
                },
            )
            .unwrap();
        assert_eq!(
            code(vault.create_account_secret(
                github,
                AccountSecretInput {
                    kind: "file".into(),
                    name: "x".into(),
                    value: "y".into()
                }
            )),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.create_account_secret(
                github,
                AccountSecretInput {
                    kind: "note".into(),
                    name: "Empty".into(),
                    value: String::new()
                }
            )),
            ErrorCode::InvalidInput
        );
        assert_eq!(vault.reveal_account_secret(token).unwrap().value, "ghp_123");
        vault
            .update_account_secret(
                token,
                AccountSecretUpdateInput {
                    name: "Personal access token".into(),
                    value: Some("ghp_456".into()),
                },
            )
            .unwrap();
        vault
            .update_account_secret(
                note,
                AccountSecretUpdateInput {
                    name: "PIN".into(),
                    value: None,
                },
            )
            .unwrap();
        assert_eq!(vault.reveal_account_secret(token).unwrap().value, "ghp_456");
        assert_eq!(vault.reveal_account_secret(note).unwrap().value, "4421");
        let details = vault.account_details().unwrap();
        let names: Vec<_> = details
            .secrets
            .iter()
            .map(|s| (s.name.as_str(), s.kind.as_str(), s.size))
            .collect();
        assert_eq!(
            names,
            [("Personal access token", "secret", 7), ("PIN", "note", 4)]
        );
        assert!(!serde_json::to_string(&details).unwrap().contains("ghp_"));

        vault.set_account_devices(github, &[mac, iphone]).unwrap();
        vault.set_account_devices(gmail, &[iphone]).unwrap();
        assert_eq!(
            code(vault.set_account_devices(github, &[mac, 9_999])),
            ErrorCode::NotFound
        );
        assert_eq!(
            vault.account_details().unwrap().device_links.len(),
            3,
            "a bad request changes nothing"
        );
        vault.set_account_devices(github, &[mac]).unwrap();
        assert_eq!(vault.account_details().unwrap().device_links.len(), 2);

        vault
            .set_account_links(github, "recovery", &[gmail])
            .unwrap();
        vault
            .set_account_links(github, "sign_in", &[gmail])
            .unwrap();
        assert_eq!(
            code(vault.set_account_links(github, "recovery", &[github])),
            ErrorCode::InvalidInput
        );
        assert_eq!(
            code(vault.set_account_links(github, "owner", &[gmail])),
            ErrorCode::InvalidInput
        );
        vault.set_account_links(github, "sign_in", &[]).unwrap();
        let links = vault.account_links().unwrap().links;
        assert_eq!(links.len(), 1, "replacing one kind leaves the other");
        assert_eq!(
            (links[0].linked_account_id, links[0].kind.as_str()),
            (gmail, "recovery")
        );

        // Everything kept with an account goes with it; devices stay.
        vault
            .create_factor(github, factor("sms", "+33 6 12 34 56 78", None, None))
            .unwrap();
        vault.delete_credential(github).unwrap();
        let details = vault.account_details().unwrap();
        assert!(details.factors.is_empty() && details.secrets.is_empty());
        assert_eq!(details.device_links.len(), 1);
        assert_eq!(details.devices.len(), 2);
        assert!(vault.account_links().unwrap().links.is_empty());
    }

    #[test]
    fn an_accounts_connections_save_together_or_not_at_all() {
        let (_directory, vault) = unlocked_vault();
        let vercel = account(&vault, "vercel.com", "me@example.com");
        let github = account(&vault, "github.com", "me@example.com");
        let gmail = account(&vault, "google.com", "me@gmail.com");
        let mac = device(&vault, "MacBook", "computer");
        fn all<'a>(sign_in: &'a [i64], recovery: &'a [i64], devices: &'a [i64]) -> Connections<'a> {
            Connections {
                sign_in,
                recovery,
                devices,
            }
        }

        vault
            .set_account_connections(vercel, all(&[github], &[gmail], &[mac]))
            .unwrap();
        let state = |vault: &Vault| {
            let links = vault.account_links().unwrap().links;
            let devices = vault.account_details().unwrap().device_links;
            (links.len(), devices.len())
        };
        assert_eq!(state(&vault), (2, 1));

        // A device deleted elsewhere: nothing is half-saved.
        assert_eq!(
            code(vault.set_account_connections(vercel, all(&[], &[], &[9_999]))),
            ErrorCode::NotFound
        );
        assert_eq!(
            code(vault.set_account_connections(vercel, all(&[vercel], &[], &[]))),
            ErrorCode::InvalidInput
        );
        assert_eq!(state(&vault), (2, 1), "a failed save changes nothing");

        vault
            .set_account_connections(vercel, all(&[], &[], &[]))
            .unwrap();
        assert_eq!(state(&vault), (0, 0));
    }

    #[test]
    fn knows_which_accounts_have_a_password_without_decrypting() {
        let (_directory, vault) = unlocked_vault();
        let domain = vault.create_domain("vercel.com").unwrap();
        vault
            .create_credential(credential(domain, "a@b.co", ""))
            .unwrap();
        vault
            .create_credential(credential(domain, "b@b.co", "x"))
            .unwrap();
        vault
            .create_credential(credential(domain, "c@b.co", "xy"))
            .unwrap();
        let flags: Vec<_> = vault
            .list_accounts()
            .unwrap()
            .accounts
            .iter()
            .map(|a| a.has_password)
            .collect();
        assert_eq!(flags, [false, true, true]);
    }

    #[test]
    fn an_account_keeps_the_group_chosen_for_it() {
        let (_directory, vault) = unlocked_vault();
        let domain = vault.create_domain("battle.net").unwrap();
        let id = vault
            .create_credential(credential(domain, "a@b.co", "x"))
            .unwrap();
        let category = |vault: &Vault| vault.list_accounts().unwrap().accounts[0].category.clone();
        assert_eq!(category(&vault), None, "guessed until chosen");

        vault.set_account_category(id, Some("  Games ")).unwrap();
        assert_eq!(category(&vault).as_deref(), Some("Games"));
        vault.set_account_category(id, Some("Money")).unwrap();
        assert_eq!(category(&vault).as_deref(), Some("Money"));
        vault.set_account_category(id, Some("   ")).unwrap();
        assert_eq!(category(&vault), None, "blank goes back to the guess");

        let too_long = "x".repeat(41);
        assert_eq!(
            vault.set_account_category(id, Some(&too_long)).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            vault.set_account_category(id + 99, Some("Games")).unwrap_err().code,
            ErrorCode::NotFound
        );

        vault.set_account_category(id, Some("Games")).unwrap();
        vault.delete_credential(id).unwrap();
        let left: i64 = vault
            .with_database(|db| {
                Ok(db
                    .connection()
                    .query_row("SELECT COUNT(*) FROM account_categories", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(left, 0, "the choice goes with the account");
    }

    /// Rehearses the pending migrations on a *copy* of a real vault and proves nothing
    /// is lost. Run it through `pnpm vault:rehearse`, which makes a fresh copy (never
    /// the live file) and deletes it afterwards.
    #[test]
    #[ignore]
    fn migration_rehearsal() {
        let path = PathBuf::from(
            std::env::var_os("VAULTKEY_REHEARSAL_DB")
                .expect("run this through `pnpm vault:rehearse`"),
        );
        // Freeze the pre-migration state, folding in any write-ahead log the copy carried.
        let before = path.with_file_name("before-migration.sqlite3");
        Connection::open(&path)
            .unwrap()
            .execute("VACUUM INTO ?1", [before.to_str().unwrap()])
            .unwrap();
        let from: i64 = Connection::open(&before)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();

        let database = VaultDatabase::open(&path).expect("the migrations must apply to the vault");
        let to = database.schema_version().unwrap();
        let (checked, problems) =
            crate::db::rows_missing_after_migration(&before, database.connection()).unwrap();
        assert!(
            problems.is_empty(),
            "the migration would lose data: {problems:?}"
        );

        // Checks that need no password: KDF and verifier intact, every ciphertext well-formed.
        let conn = database.connection();
        let kdf = store::read_kdf(conn).unwrap().expect("metadata row");
        assert!(
            store::has_auth(conn).unwrap(),
            "the master-password verifier is intact"
        );
        let domains = store::list_domains(conn).unwrap();
        let mut credentials = 0;
        for domain in &domains {
            let rows = store::list_credentials(conn, domain.id).unwrap();
            assert_eq!(rows.len() as i64, domain.count.credentials);
            for row in &rows {
                let raw = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    &row.password,
                )
                .expect("ciphertext is canonical base64");
                assert!(raw.len() >= crypto::IV_LEN + crypto::TAG_LEN);
            }
            credentials += rows.len();
        }
        println!(
            "rehearsal OK: schema v{from} -> v{to}, all {checked} original rows intact; \
             {} domains, {credentials} credentials; kdf t={} m={}KiB p={}",
            domains.len(),
            kdf.iterations,
            kdf.memory_kib,
            kdf.parallelism
        );
        database.close();
    }
}
