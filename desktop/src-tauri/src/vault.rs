//! The vault service: database + unlocked session. Everything the UI can do goes
//! through here. It knows nothing about Tauri, so it is fully unit-testable.
//!
//! Locking discipline: the expensive KDF work (Argon2id, scrypt) runs with *no* lock
//! held, so a slow unlock never blocks other calls.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::cell::Cell;
use std::ops::Deref;
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::account_details::{self, AccountDetails, Connections, NewFactor, PayloadChange};
use crate::crypto::{self, KdfParams, SALT_LEN, SecretKey};
use crate::{recovery, rekey};
use crate::db::VaultDatabase;
use crate::error::{ErrorCode, VaultError, VaultResult, log_failure};
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
use crate::validation::{
    DeviceLinkInput, MAX_DESCRIPTION, MAX_DEVICE_NOTE, StagedFileInput, validate_file_name,
    validate_optional_text,
};
use crate::dotenv::{self, EnvText};
use crate::validation::{EnvSecretInput, MAX_ENV_SECRETS};
use crate::workspace::{self, AccountLink, NewSecret, Sealed, SealedLogin, SealedService, Workspace};
use crate::validation::validate_service_logins;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthStatus {
    NeedsSignup,
    NeedsLogin,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub status: AuthStatus,
    /// Whether "Forgot your master password?" can offer the recovery code.
    pub recovery_code: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    pub valid: bool,
    /// Set when this unlock moved a vault from before v7 to a vault key: the backup of
    /// the vault as it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgraded_backup: Option<String>,
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
    /// Held shared by every operation while it uses the vault key (see [`KeyGuard`]),
    /// and exclusively by a master password change: no value can be encrypted with
    /// the old key and written after the vault moved to the new one.
    key_gate: RwLock<()>,
    /// Files last dropped onto the window (paths from the OS, never from the page),
    /// waiting to be imported into a project.
    dropped: Mutex<Option<(Instant, Vec<PathBuf>)>>,
    /// Files in the upload dialog, waiting to be added. Paths come from the native
    /// picker or a drop, never from the page: it sees a token, a name and a size.
    staged: Mutex<Staged>,
    /// This process's hold on the vault (see [`lock_instance`]).
    instance: Mutex<Option<fs::File>>,
    /// A recovery code shown and waiting to be confirmed.
    pending_recovery: Mutex<Option<PendingRecovery>>,
}

#[derive(Default)]
struct Staged {
    next_token: i64,
    files: Vec<StagedFile>,
}

struct StagedFile {
    token: i64,
    path: PathBuf,
    name: String,
    size: u64,
}

/// A file in the upload dialog, as the page sees it.
#[derive(Debug, Clone, Serialize)]
pub struct StagedView {
    pub token: i64,
    pub name: String,
    pub size: u64,
}

/// The upload dialog's files, and those just refused (a folder, too large…).
/// What a .env import saved.
#[derive(Debug, Serialize)]
pub struct EnvImportReport {
    pub added: usize,
    pub updated: usize,
}

#[derive(Debug, Serialize)]
pub struct StagedList {
    pub files: Vec<StagedView>,
    pub skipped: Vec<SkippedFile>,
}

/// At most this many files wait in the upload dialog at once.
const MAX_STAGED: usize = 100;

/// A file to encrypt into a project: where it is, the name to keep it under (its
/// own when `None`), and its description.
struct Upload {
    path: PathBuf,
    name: Option<String>,
    description: String,
}

impl Staged {
    fn view(&self) -> Vec<StagedView> {
        self.files
            .iter()
            .map(|f| StagedView {
                token: f.token,
                name: f.name.clone(),
                size: f.size,
            })
            .collect()
    }
}

/// Seals a note (role, description) with the vault key; an empty one is no note.
fn seal_note(text: &str, key: &SecretKey) -> VaultResult<Sealed> {
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(crypto::encrypt_bytes(text.as_bytes(), key)?))
}

/// Opens a sealed note: "" for none.
fn open_note(sealed: Sealed, key: &SecretKey) -> VaultResult<String> {
    match sealed {
        None => Ok(String::new()),
        Some(bytes) => Ok(String::from_utf8_lossy(&crypto::decrypt_bytes(&bytes, key)?).into_owned()),
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_or_recover<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_or_recover<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

thread_local! {
    /// Whether this thread already holds the key gate (through a live [`KeyGuard`]),
    /// so a nested use doesn't wait on a password change that waits for it.
    static HOLDS_KEY_GATE: Cell<bool> = const { Cell::new(false) };
}

/// The vault key, for one operation. While it lives, the master password can't change
/// under it: a change waits for it, and it waits for a change in progress.
pub(crate) struct KeyGuard<'a> {
    key: SecretKey,
    gate: Option<RwLockReadGuard<'a, ()>>,
}

impl Deref for KeyGuard<'_> {
    type Target = SecretKey;

    fn deref(&self) -> &SecretKey {
        &self.key
    }
}

impl Drop for KeyGuard<'_> {
    fn drop(&mut self) {
        if self.gate.take().is_some() {
            HOLDS_KEY_GATE.set(false);
        }
    }
}

/// What seals the vault key in each slot (AES-256-GCM additional data): a wrapped key
/// can't be moved from one slot to the other.
pub(crate) const PASSWORD_LABEL: &[u8] = b"vaultkey/vault-key/password";
pub(crate) const RECOVERY_LABEL: &[u8] = b"vaultkey/vault-key/recovery";

/// How long a shown recovery code waits to be confirmed and saved.
const RECOVERY_CODE_TTL: Duration = Duration::from_secs(30 * 60);

/// A recovery code shown and not saved yet. Zeroised when dropped.
struct PendingRecovery {
    created: Instant,
    words: Zeroizing<Vec<String>>,
    entropy: recovery::Entropy,
}

/// A new recovery code, for the page to show once.
#[derive(Serialize)]
pub struct RecoveryCode {
    pub words: Vec<String>,
}

/// A word of the recovery code typed back: `position` from 1.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryAnswer {
    pub position: usize,
    pub word: String,
}

impl Drop for RecoveryAnswer {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.word);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    /// The data is under a random vault key (schema v7), not the password's key.
    pub vault_key: bool,
    pub recovery_code: bool,
    /// What keeps a vault from before v7 on its password's key: values that can't be
    /// read, named. Empty once it has moved.
    pub waiting_on: Vec<String>,
}

fn slot_mismatch() -> VaultError {
    VaultError::internal("The vault key didn't store correctly, so nothing was changed.")
}

/// A new master password's Argon2id parameters (a new salt, never weaker than
/// `current`'s or the defaults), key, verifier salt and verifier.
#[allow(clippy::type_complexity)]
fn new_password_material(
    password: &str,
    current: &KdfParams,
) -> VaultResult<(KdfParams, SecretKey, [u8; SALT_LEN], Zeroizing<[u8; crypto::VERIFIER_LEN]>)> {
    let defaults = KdfParams::generate();
    let kdf = KdfParams {
        salt: defaults.salt,
        iterations: current.iterations.max(defaults.iterations),
        memory_kib: current.memory_kib.max(defaults.memory_kib),
        parallelism: current.parallelism.max(defaults.parallelism),
        hash_length: defaults.hash_length,
    };
    let keys = crypto::derive_keys(password, &kdf)?;
    let verifier_salt: [u8; SALT_LEN] = crypto::random_bytes();
    let verifier = crypto::derive_verifier(keys.auth_key.as_ref(), &verifier_salt)?;
    Ok((kdf, keys.encryption_key, verifier_salt, verifier))
}

/// Reads back, inside the transaction, what the next unlock will read, and checks it
/// opens to the vault key with the new password.
fn check_stored_password(
    tx: &rusqlite::Connection,
    kdf: &KdfParams,
    verifier_salt: &[u8; SALT_LEN],
    verifier: &[u8; crypto::VERIFIER_LEN],
    password_key: &SecretKey,
    vault_key: &SecretKey,
) -> VaultResult<()> {
    let stored_verifier = store::read_verifier(tx)?;
    let slot = store::read_slot(tx, store::PASSWORD_SLOT)?.ok_or_else(slot_mismatch)?;
    let ok = store::read_kdf(tx)?.as_ref() == Some(kdf)
        && stored_verifier.is_some_and(|v| v.salt == verifier_salt[..] && v.verifier == verifier[..])
        && crypto::same_key(&crypto::unwrap_key(&slot.wrapped, password_key, PASSWORD_LABEL)?, vault_key);
    if !ok {
        return Err(slot_mismatch());
    }
    Ok(())
}

/// Only one app at a time may open a vault: another one, unlocked on the same file,
/// could write with a key this one has replaced. The lock (`<vault>.lock`) is held for
/// the life of the process; the OS releases it when the process ends, however it ends.
fn lock_instance(path: &Path, held: &Mutex<Option<fs::File>>) -> VaultResult<()> {
    let mut held = lock_or_recover(held);
    if held.is_some() {
        return Ok(());
    }
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(PathBuf::from(name))?;
    match file.try_lock() {
        Ok(()) => {
            *held = Some(file);
            Ok(())
        }
        Err(fs::TryLockError::WouldBlock) => Err(VaultError::new(
            ErrorCode::DatabaseUnavailable,
            "VaultKey is already open in another window. Close it, then try again.",
        )),
        Err(fs::TryLockError::Error(error)) => Err(error.into()),
    }
}


impl Vault {
    /// Opens the database at `path`. A failure is logged and remembered rather than
    /// fatal: the UI shows its "Local Vault Error" screen, and Retry reopens.
    pub fn open(path: PathBuf) -> Self {
        let instance = Mutex::new(None);
        let database = match lock_instance(&path, &instance).and_then(|()| VaultDatabase::open(&path)) {
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
            key_gate: RwLock::new(()),
            dropped: Mutex::new(None),
            staged: Mutex::new(Staged::default()),
            instance,
            pending_recovery: Mutex::new(None),
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

    /// The vault key, held for the caller's operation (see [`KeyGuard`]).
    fn session_key(&self) -> VaultResult<KeyGuard<'_>> {
        // A thread already holding the gate takes the key without waiting again.
        let gate = (!HOLDS_KEY_GATE.get()).then(|| read_or_recover(&self.key_gate));
        let key = lock_or_recover(&self.session)
            .key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or_else(|| VaultError::locked("Unlock the vault first."))?;
        if gate.is_some() {
            HOLDS_KEY_GATE.set(true);
        }
        Ok(KeyGuard { key, gate })
    }

    pub(crate) fn require_unlocked(&self) -> VaultResult<()> {
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
            // Retry after a failed start-up (e.g. the disk was unavailable, or another
            // copy of the app had the vault open).
            lock_instance(&self.path, &self.instance)?;
            *guard = Some(VaultDatabase::open(&self.path)?);
        }
        let database = guard.as_mut().ok_or_else(VaultError::unavailable)?;
        store::ensure_metadata(database)?;
        let status = if store::has_auth(database.connection())? {
            AuthStatus::NeedsLogin
        } else {
            AuthStatus::NeedsSignup
        };
        let recovery_code = store::read_slot(database.connection(), store::RECOVERY_SLOT)?.is_some();
        Ok(VaultStatus { status, recovery_code })
    }

    /// First-run signup: stores a verifier of the derived auth key, and a new random
    /// vault key wrapped by the password's key. Like the Electron app, this does not
    /// unlock; the user logs in afterwards.
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
        let vault_key = crypto::new_vault_key();
        let (verifier, wrapped) = {
            let _gate = lock_or_recover(&self.kdf_gate);
            let keys = crypto::derive_keys(master_password, &kdf)?;
            (
                crypto::derive_verifier(keys.auth_key.as_ref(), &salt)?,
                crypto::wrap_key(&vault_key, &keys.encryption_key, PASSWORD_LABEL)?,
            )
        };
        self.with_database(|database| store::insert_verifier(database, &salt, &verifier, &wrapped))
    }

    /// Reads, in one go, what opening the vault with its master password needs.
    fn password_material(&self) -> VaultResult<(KdfParams, store::StoredVerifier, Option<store::KeySlot>)> {
        self.with_database(|database| {
            let conn = database.connection();
            let missing = || VaultError::not_found("The vault has not been initialized.");
            let kdf = store::read_kdf(conn)?.ok_or_else(missing)?;
            let stored = store::read_verifier(conn)?.ok_or_else(missing)?;
            Ok((kdf, stored, store::read_slot(conn, store::PASSWORD_SLOT)?))
        })
    }

    pub fn unlock(&self, master_password: &str) -> VaultResult<UnlockResult> {
        validation::validate_master_password(master_password)?;
        let epoch = lock_or_recover(&self.session).epoch;
        let (kdf, stored, slot) = self.password_material()?;
        let (keys, valid) = {
            let _gate = lock_or_recover(&self.kdf_gate);
            let keys = crypto::derive_keys(master_password, &kdf)?;
            let derived = crypto::derive_verifier(keys.auth_key.as_ref(), &stored.salt)?;
            let valid = crypto::verifier_matches(&stored.verifier, derived.as_ref());
            (keys, valid)
        };
        if !valid {
            return Ok(UnlockResult { valid: false, upgraded_backup: None });
        }
        let (key, upgraded_backup) = match slot {
            Some(slot) => (crypto::unwrap_key(&slot.wrapped, &keys.encryption_key, PASSWORD_LABEL)?, None),
            // A vault from before v7: its data is still under the password's key.
            None => self.upgrade_to_vault_key(&keys.encryption_key)?,
        };
        let mut session = lock_or_recover(&self.session);
        if session.epoch != epoch {
            // The vault was locked while we were deriving keys (e.g. the page
            // reloaded). Honour the lock; the UI will ask for the password again.
            return Err(VaultError::locked("The vault was locked during unlock."));
        }
        session.key = Some(key);
        Ok(UnlockResult { valid: true, upgraded_backup })
    }

    fn backups_directory(&self) -> VaultResult<PathBuf> {
        self.path
            .parent()
            .map(|directory| directory.join("backups"))
            .ok_or_else(|| VaultError::unavailable().with_detail("the vault has no folder"))
    }

    /// The first unlock of a vault from before v7 moves its data from the password's
    /// key to a new random vault key, wrapped by the password's key: after a verified
    /// backup of the vault as it was, in one transaction (`rekey.rs`). The password
    /// stays the same. Returns the key to unlock with, and the backup's path if it moved.
    ///
    /// If a value can't be read with the password's key, or the file has a column this
    /// app doesn't know, nothing moves: the vault unlocks under the password's key as
    /// before, and [`Vault::security_status`] says what holds the move back. It tries
    /// again at the next unlock.
    fn upgrade_to_vault_key(&self, password_key: &SecretKey) -> VaultResult<(SecretKey, Option<String>)> {
        let _exclusive = write_or_recover(&self.key_gate);
        let backups = self.backups_directory()?;
        self.with_database(|database| {
            // Another unlock may have just done it.
            if let Some(slot) = store::read_slot(database.connection(), store::PASSWORD_SLOT)? {
                return Ok((crypto::unwrap_key(&slot.wrapped, password_key, PASSWORD_LABEL)?, None));
            }
            let blocked = rekey::check_schema(database.connection()).is_err()
                || !rekey::unreadable(database.connection(), password_key)?.is_empty();
            if blocked {
                return Ok((Zeroizing::new(**password_key), None));
            }
            database.assert_integrity()?;
            let backup = database.backup_before(&backups, "vault-key")?;
            let vault_key = crypto::new_vault_key();
            let moved = database.transaction(|tx| {
                rekey::rekey(tx, password_key, &vault_key)?;
                store::write_slot(tx, store::PASSWORD_SLOT, None, &crypto::wrap_key(&vault_key, password_key, PASSWORD_LABEL)?)?;
                // What the next unlock reads opens to this key.
                let stored = store::read_slot(tx, store::PASSWORD_SLOT)?.ok_or_else(slot_mismatch)?;
                if !crypto::same_key(&crypto::unwrap_key(&stored.wrapped, password_key, PASSWORD_LABEL)?, &vault_key) {
                    return Err(slot_mismatch());
                }
                Ok(())
            });
            if let Err(error) = moved {
                // Nothing changed: no copy left behind.
                let _ = fs::remove_file(&backup);
                return Err(VaultError::internal(format!(
                    "The vault couldn't move to its new encryption, so nothing was changed and your password still works. Unlock again to retry. ({})",
                    error.message
                )));
            }
            database.checkpoint();
            Ok((vault_key, Some(backup.display().to_string())))
        })
    }

    /// Changes the master password. The data doesn't change: its vault key is wrapped
    /// again by the new password's key, in one transaction with the new password's
    /// salt and verifier, then read back as the next unlock will read it. The recovery
    /// code keeps working.
    pub fn change_master_password(&self, current: &str, new: &str) -> VaultResult<()> {
        validation::validate_master_password(current)?;
        validation::validate_new_master_password(new)?;
        if current == new {
            return Err(VaultError::invalid_input("The new password is the same as the current one."));
        }
        if HOLDS_KEY_GATE.get() {
            return Err(VaultError::internal("A master password change can't start inside another operation."));
        }
        let _exclusive = write_or_recover(&self.key_gate);
        let vault_key = self.current_key()?;
        let (kdf, stored, slot) = self.password_material()?;
        let slot = slot.ok_or_else(|| {
            VaultError::invalid_input(
                "Your vault hasn’t moved to its new encryption yet, so its password can’t be changed. Fix what it lists, then unlock again.",
            )
        })?;
        let (new_kdf, new_key, verifier_salt, verifier) = {
            let _gate = lock_or_recover(&self.kdf_gate);
            self.check_password(current, &kdf, &stored, &slot, &vault_key)?;
            new_password_material(new, &kdf)?
        };
        let wrapped = crypto::wrap_key(&vault_key, &new_key, PASSWORD_LABEL)?;
        let saved = self.with_database(|database| {
            database.transaction(|tx| {
                // Still the password just checked.
                let unchanged = store::read_kdf(tx)?.as_ref() == Some(&kdf)
                    && store::read_verifier(tx)?.is_some_and(|now| now.salt == stored.salt && now.verifier == stored.verifier)
                    && store::read_slot(tx, store::PASSWORD_SLOT)?.as_ref() == Some(&slot);
                if !unchanged {
                    return Err(VaultError::internal("The master password changed meanwhile, so nothing was changed."));
                }
                store::write_password(tx, &new_kdf, &verifier_salt, &verifier)?;
                store::write_slot(tx, store::PASSWORD_SLOT, None, &wrapped)?;
                check_stored_password(tx, &new_kdf, &verifier_salt, &verifier, &new_key, &vault_key)
            })
        });
        if saved.is_err() {
            // Whatever happened, the next unlock reads what is on disk.
            self.lock();
        }
        saved
    }

    /// The session's key, read under the exclusive gate held by the caller.
    fn current_key(&self) -> VaultResult<SecretKey> {
        lock_or_recover(&self.session)
            .key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or_else(|| VaultError::locked("Unlock the vault first."))
    }

    /// The master password, checked like an unlock, and its slot opening to the
    /// session's vault key. Call under the KDF gate.
    fn check_password(
        &self,
        password: &str,
        kdf: &KdfParams,
        stored: &store::StoredVerifier,
        slot: &store::KeySlot,
        vault_key: &SecretKey,
    ) -> VaultResult<()> {
        let keys = crypto::derive_keys(password, kdf)?;
        let derived = crypto::derive_verifier(keys.auth_key.as_ref(), &stored.salt)?;
        if !crypto::verifier_matches(&stored.verifier, derived.as_ref()) {
            return Err(VaultError::new(ErrorCode::AuthFailed, "The master password is wrong."));
        }
        let opened = crypto::unwrap_key(&slot.wrapped, &keys.encryption_key, PASSWORD_LABEL)?;
        if !crypto::same_key(&opened, vault_key) {
            return Err(VaultError::internal(
                "This session's key doesn't match the vault. Lock the vault, unlock it, and try again.",
            ));
        }
        Ok(())
    }

    // ── recovery code ───────────────────────────────────────────────────────

    /// A new recovery code, shown once. It is kept in memory only, until the user proves
    /// they wrote it down ([`Vault::save_recovery_code`]), for at most 30 minutes.
    pub fn new_recovery_code(&self) -> VaultResult<RecoveryCode> {
        self.require_unlocked()?;
        if self.with_database(|db| store::read_slot(db.connection(), store::PASSWORD_SLOT))?.is_none() {
            return Err(VaultError::invalid_input(
                "Your vault hasn’t moved to its new encryption yet. Fix what it lists, then unlock again.",
            ));
        }
        let (words, entropy) = recovery::generate();
        let shown = words.to_vec();
        *lock_or_recover(&self.pending_recovery) = Some(PendingRecovery { created: Instant::now(), words, entropy });
        Ok(RecoveryCode { words: shown })
    }

    /// Saves the code from [`Vault::new_recovery_code`] once the words asked for match
    /// and the master password is right (so nobody passing by an unlocked vault can
    /// give themselves a way in). It replaces any previous code.
    pub fn save_recovery_code(&self, master_password: &str, answers: &[RecoveryAnswer]) -> VaultResult<()> {
        validation::validate_master_password(master_password)?;
        if HOLDS_KEY_GATE.get() {
            return Err(VaultError::internal("A recovery code can't be saved inside another operation."));
        }
        let _exclusive = write_or_recover(&self.key_gate);
        let entropy = {
            let pending = lock_or_recover(&self.pending_recovery);
            let pending = pending
                .as_ref()
                .filter(|p| p.created.elapsed() < RECOVERY_CODE_TTL)
                .ok_or_else(|| VaultError::invalid_input("This recovery code expired. Create a new one."))?;
            let mut asked: Vec<usize> = answers.iter().map(|a| a.position).collect();
            asked.sort_unstable();
            asked.dedup();
            if asked.len() < 3 || asked.len() != answers.len() || asked.iter().any(|&p| p == 0 || p > recovery::WORDS) {
                return Err(VaultError::invalid_input("Type back three different words of the code."));
            }
            for answer in answers {
                if !recovery::word_matches(&pending.words[answer.position - 1], &answer.word) {
                    return Err(VaultError::invalid_input(format!(
                        "Word {} doesn’t match. Check what you wrote down.",
                        answer.position
                    )));
                }
            }
            Zeroizing::new(*pending.entropy)
        };
        let vault_key = self.current_key()?;
        let (kdf, stored, slot) = self.password_material()?;
        let slot = slot.ok_or_else(|| VaultError::invalid_input("Your vault hasn’t moved to its new encryption yet."))?;
        let (code_kdf, code_key) = {
            let _gate = lock_or_recover(&self.kdf_gate);
            self.check_password(master_password, &kdf, &stored, &slot, &vault_key)?;
            let code_kdf = KdfParams::generate();
            let code_key = crypto::derive_keys_from_bytes(entropy.as_ref(), &code_kdf)?.encryption_key;
            (code_kdf, code_key)
        };
        let wrapped = crypto::wrap_key(&vault_key, &code_key, RECOVERY_LABEL)?;
        self.with_database(|database| {
            database.transaction(|tx| {
                store::write_slot(tx, store::RECOVERY_SLOT, Some(&code_kdf), &wrapped)?;
                let stored = store::read_slot(tx, store::RECOVERY_SLOT)?.ok_or_else(slot_mismatch)?;
                let opens = stored.kdf.as_ref() == Some(&code_kdf)
                    && crypto::same_key(&crypto::unwrap_key(&stored.wrapped, &code_key, RECOVERY_LABEL)?, &vault_key);
                if !opens {
                    return Err(slot_mismatch());
                }
                Ok(())
            })
        })?;
        *lock_or_recover(&self.pending_recovery) = None;
        Ok(())
    }

    /// A forgotten master password: the recovery code opens the vault key, a new
    /// master password replaces the old one, and the vault unlocks. The code stays
    /// valid until a new one replaces it (the app asks for one right away).
    pub fn recover(&self, code: &str, new_password: &str) -> VaultResult<()> {
        validation::validate_new_master_password(new_password)?;
        let entropy = recovery::parse(code)?;
        if HOLDS_KEY_GATE.get() {
            return Err(VaultError::internal("Recovery can't start inside another operation."));
        }
        let _exclusive = write_or_recover(&self.key_gate);
        let (kdf, stored, slot) = self.password_material()?;
        let code_slot = self
            .with_database(|db| store::read_slot(db.connection(), store::RECOVERY_SLOT))?
            .ok_or_else(|| VaultError::not_found("This vault has no recovery code."))?;
        let code_kdf = code_slot.kdf.clone().ok_or_else(slot_mismatch)?;
        let (vault_key, new_kdf, new_key, verifier_salt, verifier) = {
            let _gate = lock_or_recover(&self.kdf_gate);
            let code_key = crypto::derive_keys_from_bytes(entropy.as_ref(), &code_kdf)?.encryption_key;
            let vault_key = crypto::unwrap_key(&code_slot.wrapped, &code_key, RECOVERY_LABEL)
                .map_err(|_| VaultError::new(ErrorCode::AuthFailed, "That recovery code doesn’t open this vault."))?;
            let (new_kdf, new_key, verifier_salt, verifier) = new_password_material(new_password, &kdf)?;
            (vault_key, new_kdf, new_key, verifier_salt, verifier)
        };
        let wrapped = crypto::wrap_key(&vault_key, &new_key, PASSWORD_LABEL)?;
        let saved = self.with_database(|database| {
            database.transaction(|tx| {
                let unchanged = store::read_kdf(tx)?.as_ref() == Some(&kdf)
                    && store::read_verifier(tx)?.is_some_and(|now| now.salt == stored.salt && now.verifier == stored.verifier)
                    && store::read_slot(tx, store::PASSWORD_SLOT)? == slot
                    && store::read_slot(tx, store::RECOVERY_SLOT)?.as_ref() == Some(&code_slot);
                if !unchanged {
                    return Err(VaultError::internal("The vault changed meanwhile, so nothing was changed."));
                }
                store::write_password(tx, &new_kdf, &verifier_salt, &verifier)?;
                store::write_slot(tx, store::PASSWORD_SLOT, None, &wrapped)?;
                check_stored_password(tx, &new_kdf, &verifier_salt, &verifier, &new_key, &vault_key)
            })
        });
        let mut session = lock_or_recover(&self.session);
        session.epoch = session.epoch.wrapping_add(1);
        session.key = None;
        saved?;
        session.key = Some(vault_key);
        drop(session);
        *lock_or_recover(&self.pending_recovery) = None;
        Ok(())
    }

    /// How the vault is protected: whether it has moved to a vault key (and if not,
    /// what holds the move back), and whether it has a recovery code.
    pub fn security_status(&self) -> VaultResult<SecurityStatus> {
        let key = self.session_key()?;
        self.with_database(|database| {
            let conn = database.connection();
            let vault_key = store::read_slot(conn, store::PASSWORD_SLOT)?.is_some();
            let recovery_code = store::read_slot(conn, store::RECOVERY_SLOT)?.is_some();
            let mut waiting_on = Vec::new();
            if !vault_key {
                if let Err(error) = rekey::check_schema(conn) {
                    waiting_on.push(error.message);
                }
                waiting_on.extend(rekey::unreadable(conn, &key)?);
            }
            Ok(SecurityStatus { vault_key, recovery_code, waiting_on })
        })
    }

    /// A vault as before v7, for tests: no vault key, so what is written next goes
    /// under the password's key. Call on a new, empty, unlocked vault.
    #[cfg(test)]
    pub(crate) fn make_legacy(&self, password: &str) {
        let kdf = self.with_database(|db| Ok(store::read_kdf(db.connection())?.unwrap())).unwrap();
        let keys = crypto::derive_keys(password, &kdf).unwrap();
        self.with_database(|db| Ok(db.connection().execute("DELETE FROM key_slots", [])?)).unwrap();
        lock_or_recover(&self.session).key = Some(keys.encryption_key);
    }

    pub fn lock(&self) {
        let mut session = lock_or_recover(&self.session);
        // Dropping the key zeroises it.
        session.key = None;
        session.epoch = session.epoch.wrapping_add(1);
        drop(session);
        // Nothing waits to be imported into a locked vault.
        *lock_or_recover(&self.staged) = Staged::default();
        *lock_or_recover(&self.dropped) = None;
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
        let key = self.session_key()?;
        let open = |sealed: Sealed| open_note(sealed, &key);
        self.with_database(|db| workspace::load_workspace(db.connection(), &open))
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

    /// The service's accounts as `(id, sealed role)`.
    fn seal_service(input: &ServiceInput, key: &SecretKey) -> VaultResult<SealedService> {
        let (name, url, accounts) = validate_service(input)?;
        let accounts = accounts
            .iter()
            .map(|(id, role)| Ok((*id, seal_note(role, key)?)))
            .collect::<VaultResult<_>>()?;
        let logins = validate_service_logins(&input.logins)?
            .into_iter()
            .map(|login| {
                let password = match login.password {
                    // A new login without a password keeps none.
                    None if login.id.is_none() => Some(None),
                    None => None,
                    Some(password) => Some(seal_note(password, key)?),
                };
                Ok(SealedLogin {
                    id: login.id,
                    username: crypto::encrypt_bytes(login.username.as_bytes(), key)?,
                    password,
                    note: seal_note(&login.note, key)?,
                })
            })
            .collect::<VaultResult<_>>()?;
        Ok(SealedService { name, url, accounts, logins })
    }

    pub fn create_service(&self, project_id: i64, input: &ServiceInput) -> VaultResult<i64> {
        let key = self.session_key()?;
        let project_id = validate_id(project_id, "project id")?;
        let service = Self::seal_service(input, &key)?;
        self.with_database(|db| workspace::create_service(db, project_id, &service))
    }

    pub fn update_service(&self, id: i64, input: &ServiceInput) -> VaultResult<()> {
        let key = self.session_key()?;
        let id = validate_id(id, "service id")?;
        let service = Self::seal_service(input, &key)?;
        self.with_database(|db| workspace::update_service(db, id, &service))
    }

    /// A service login's password, decrypted to be copied or shown.
    pub fn reveal_service_login(&self, id: i64) -> VaultResult<RevealedSecret> {
        let key = self.session_key()?;
        let id = validate_id(id, "login id")?;
        let sealed = self.with_database(|db| workspace::service_login_password(db.connection(), id))?;
        let sealed = sealed.ok_or_else(|| VaultError::not_found("This login has no password."))?;
        utf8(crypto::decrypt_bytes(&sealed, &key)?)
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
        let description = validate_optional_text(&input.description, "description", MAX_DESCRIPTION)?;
        let description = seal_note(&description, &key)?;
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
                    description: description.as_deref(),
                },
            )
        })
    }

    /// Secrets read from a .env file, saved together (all or none): each one added to
    /// the project (and to the service, if one is chosen), or the new value and
    /// description of the existing text secret it replaces.
    pub fn import_env(
        &self,
        project_id: i64,
        service_id: Option<i64>,
        entries: Vec<EnvSecretInput>,
    ) -> VaultResult<EnvImportReport> {
        let key = self.session_key()?;
        let project_id = validate_id(project_id, "project id")?;
        let service_id = validate_optional_id(service_id, "service id")?;
        if entries.is_empty() {
            return Err(VaultError::invalid_input("Choose at least one secret to import."));
        }
        if entries.len() > MAX_ENV_SECRETS {
            return Err(VaultError::invalid_input(format!(
                "Import at most {MAX_ENV_SECRETS} secrets at once."
            )));
        }
        let secrets = entries
            .into_iter()
            .map(|entry| {
                let value = Zeroizing::new(entry.value);
                let name = validate_name(&entry.name, "name", 200)?;
                if value.is_empty() {
                    return Err(VaultError::invalid_input(format!("{name} has no value.")));
                }
                if value.len() > MAX_SECRET_TEXT_BYTES {
                    return Err(VaultError::invalid_input(format!(
                        "{name} is longer than 64 KB. Add it as a file instead."
                    )));
                }
                let description =
                    validate_optional_text(&entry.description, "description", MAX_DESCRIPTION)?;
                Ok(workspace::EnvSecret {
                    size: value.len() as i64,
                    payload: crypto::encrypt_bytes(value.as_bytes(), &key)?,
                    description: seal_note(&description, &key)?,
                    replace: validate_optional_id(entry.replace, "secret id")?,
                    name,
                })
            })
            .collect::<VaultResult<Vec<_>>>()?;
        let (added, updated) =
            self.with_database(|db| workspace::import_env(db, project_id, service_id, &secrets))?;
        Ok(EnvImportReport { added, updated })
    }

    /// The text of a file dropped onto the .env import dialog. It is read, not
    /// uploaded, so the upload list is emptied.
    pub fn read_staged_env(&self, token: i64) -> VaultResult<EnvText> {
        self.require_unlocked()?;
        let path = {
            let mut staged = lock_or_recover(&self.staged);
            let path = staged.files.iter().find(|f| f.token == token).map(|f| f.path.clone());
            staged.files.clear();
            path
        };
        let path = path.ok_or_else(|| VaultError::invalid_input("That file is no longer there. Drop it again."))?;
        dotenv::read_text(&path)
    }

    pub fn update_secret(&self, id: i64, input: SecretUpdateInput) -> VaultResult<()> {
        let key = self.session_key()?;
        let id = validate_id(id, "secret id")?;
        let name = validate_name(&input.name, "name", 200)?;
        let service_id = validate_optional_id(input.service_id, "service id")?;
        let description: Option<Sealed> = input
            .description
            .as_deref()
            .map(|text| {
                let text = validate_optional_text(text, "description", MAX_DESCRIPTION)?;
                seal_note(&text, &key)
            })
            .transpose()?;
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
                description.as_ref().map(|d| d.as_deref()),
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
    /// Files straight into a project, without descriptions (tests; the app goes
    /// through the upload dialog: `stage_files` then `import_staged`).
    #[cfg(test)]
    pub fn import_files(
        &self,
        project_id: i64,
        service_id: Option<i64>,
        paths: &[PathBuf],
    ) -> VaultResult<ImportReport> {
        let files: Vec<Upload> = paths
            .iter()
            .map(|path| Upload {
                path: path.clone(),
                name: None,
                description: String::new(),
            })
            .collect();
        self.import_described(project_id, service_id, &files)
    }

    /// Encrypts files into a project, each with its name (its own, or the one given in
    /// the upload dialog) and its description (sealed too). Names and descriptions are
    /// all checked before anything is added.
    fn import_described(
        &self,
        project_id: i64,
        service_id: Option<i64>,
        files: &[Upload],
    ) -> VaultResult<ImportReport> {
        let key = self.session_key()?;
        let project_id = validate_id(project_id, "project id")?;
        let service_id = validate_optional_id(service_id, "service id")?;
        let checked = files
            .iter()
            .map(|file| {
                let name = match &file.name {
                    Some(name) => validate_file_name(name)?,
                    None => file
                        .path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "file".to_owned()),
                };
                let description = validate_optional_text(&file.description, "description", MAX_DESCRIPTION)?;
                Ok((&file.path, name, seal_note(&description, &key)?))
            })
            .collect::<VaultResult<Vec<_>>>()?;
        let mut report = ImportReport::default();
        for (path, name, description) in checked {
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
                        description: description.as_deref(),
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

    // ── the upload dialog ───────────────────────────────────────────────────

    /// Adds files to the upload dialog. Folders, unreadable and oversized files are
    /// refused and reported; a file already in the list is not added twice.
    pub fn stage_files(&self, paths: Vec<PathBuf>) -> VaultResult<StagedList> {
        self.require_unlocked()?;
        let mut skipped = Vec::new();
        let mut staged = lock_or_recover(&self.staged);
        for path in paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".to_owned());
            let refuse = |reason: &str| SkippedFile {
                name: name.clone(),
                reason: reason.to_owned(),
            };
            match fs::metadata(&path) {
                Ok(meta) if !meta.is_file() => skipped.push(refuse("Only files can be added, not folders.")),
                Ok(meta) if meta.len() > MAX_FILE_BYTES => skipped.push(refuse("Files can be at most 25 MB.")),
                Ok(_) if staged.files.iter().any(|f| f.path == path) => {}
                Ok(_) if staged.files.len() >= MAX_STAGED => {
                    skipped.push(refuse("At most 100 files can be added at once."))
                }
                Ok(meta) => {
                    staged.next_token += 1;
                    let token = staged.next_token;
                    staged.files.push(StagedFile {
                        token,
                        path,
                        name,
                        size: meta.len(),
                    });
                }
                Err(_) => skipped.push(refuse("The file couldn’t be read.")),
            }
        }
        Ok(StagedList {
            files: staged.view(),
            skipped,
        })
    }

    pub fn unstage_file(&self, token: i64) -> VaultResult<StagedList> {
        self.require_unlocked()?;
        let mut staged = lock_or_recover(&self.staged);
        staged.files.retain(|f| f.token != token);
        Ok(StagedList {
            files: staged.view(),
            skipped: Vec::new(),
        })
    }

    /// Empties the upload dialog (closed, or cancelled).
    pub fn clear_staged(&self) {
        *lock_or_recover(&self.staged) = Staged::default();
    }

    /// Encrypts the chosen files of the upload dialog into the project, each with
    /// its description, and takes them out of the dialog.
    pub fn import_staged(
        &self,
        project_id: i64,
        service_id: Option<i64>,
        chosen: &[StagedFileInput],
    ) -> VaultResult<ImportReport> {
        self.require_unlocked()?;
        let files: Vec<Upload> = {
            let staged = lock_or_recover(&self.staged);
            chosen
                .iter()
                .map(|c| {
                    staged
                        .files
                        .iter()
                        .find(|f| f.token == c.token)
                        .map(|f| Upload {
                            path: f.path.clone(),
                            // Unchanged in the dialog: keep its own name.
                            name: c.name.clone().filter(|name| *name != f.name),
                            description: c.description.clone(),
                        })
                        .ok_or_else(|| VaultError::invalid_input("A file is no longer in the list. Add it again."))
                })
                .collect::<VaultResult<_>>()?
        };
        let report = self.import_described(project_id, service_id, &files)?;
        lock_or_recover(&self.staged)
            .files
            .retain(|f| !chosen.iter().any(|c| c.token == f.token));
        Ok(report)
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
        let key = self.session_key()?;
        let open = |sealed: Sealed| open_note(sealed, &key);
        self.with_database(|db| account_details::load(db.connection(), &open))
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

    /// Sign-in links, recovery links and devices (each with its note, sealed) in one
    /// transaction (the account form).
    pub fn set_account_connections(
        &self,
        account_id: i64,
        sign_in: &[i64],
        recovery: &[i64],
        devices: &[DeviceLinkInput],
    ) -> VaultResult<()> {
        let key = self.session_key()?;
        let account_id = validate_id(account_id, "account id")?;
        for &id in sign_in.iter().chain(recovery) {
            validate_id(id, "account id")?;
        }
        let mut sealed: Vec<(i64, Sealed)> = Vec::with_capacity(devices.len());
        for device in devices {
            let id = validate_id(device.device_id, "device id")?;
            if sealed.iter().any(|(seen, _)| *seen == id) {
                return Err(VaultError::invalid_input("That device is listed twice."));
            }
            let note = validate_optional_text(&device.note, "device note", MAX_DEVICE_NOTE)?;
            sealed.push((id, seal_note(&note, &key)?));
        }
        self.with_database(|db| {
            account_details::set_connections(
                db,
                account_id,
                Connections {
                    sign_in,
                    recovery,
                    devices: &sealed,
                },
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::validation::ServiceAccountInput;
    use crate::workspace::ServiceAccount;
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

        // Opening ran every schema migration, and they kept every original row.
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

        // The first unlock, with the same password, moves its data to a vault key.
        assert!(!vault.unlock("not the password").unwrap().valid);
        let unlocked = vault.unlock(ASCII_PASSWORD).unwrap();
        assert!(unlocked.valid && unlocked.upgraded_backup.is_some());
        assert!(vault.security_status().unwrap().vault_key);
        let domains = vault.list_domains().unwrap().domains;
        assert_eq!(
            (domains[0].name.as_str(), domains[0].count.credentials),
            ("github.com", 1)
        );
        let credentials = vault.list_credentials(domains[0].id).unwrap().credentials;
        assert_eq!(credentials[0].password, "secret-password");
        assert_eq!(credentials[0].username, None);
        vault.lock();
        assert!(vault.unlock(ASCII_PASSWORD).unwrap().upgraded_backup.is_none());
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
    /// Every real migration, then a future one.
    fn with_future(sql: &'static str) -> Vec<crate::db::Migration> {
        let mut migrations: Vec<crate::db::Migration> = crate::db::MIGRATIONS
            .iter()
            .map(|m| crate::db::Migration { version: m.version, name: m.name, sql: m.sql })
            .collect();
        migrations.push(crate::db::Migration { version: future_version(), name: "future", sql });
        migrations
    }

    fn future_version() -> i64 {
        crate::db::MIGRATIONS.last().unwrap().version + 1
    }

    #[test]
    fn a_future_additive_migration_keeps_every_row_and_backs_up_first() {
        use crate::crypto::tests::ASCII_PASSWORD;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        write_electron_v1_vault(&path);
        let before = directory.path().join("before.sqlite3");
        std::fs::copy(&path, &before).unwrap();

        let migrations = with_future(
            "ALTER TABLE credentials ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;",
        );
        let database = VaultDatabase::open_with(&path, &migrations, None).unwrap();
        assert_eq!(database.schema_version().unwrap(), future_version());
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
            key_gate: RwLock::new(()),
            dropped: Mutex::new(None),
            staged: Mutex::new(Staged::default()),
            instance: Mutex::new(None),
            pending_recovery: Mutex::new(None),
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

        let migrations = with_future("UPDATE credentials SET password = 'oops'");
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
    fn a_second_app_cant_open_the_same_vault() {
        let (directory, vault) = unlocked_vault();
        let second = Vault::open(directory.path().join("vaultkey.sqlite3"));
        assert!(second.status().unwrap_err().message.contains("already open"));
        assert!(second.unlock(MASTER).is_err());
        // Once the first one is gone, it opens.
        drop(vault);
        assert_eq!(second.status().unwrap().status, AuthStatus::NeedsLogin);
        assert!(second.unlock(MASTER).unwrap().valid);
    }

    #[test]
    fn a_password_change_waits_for_operations_using_the_key() {
        let (_directory, vault) = unlocked_vault();
        let shop = project(&vault, "Shaba");
        let secret = |value: &str| SecretInput {
            name: value.into(),
            value: value.into(),
            service_id: None,
            description: String::new(),
        };
        const NEW: &str = "a brand new passphrase";
        std::thread::scope(|scope| {
            // An operation in flight, holding the current key.
            let held = vault.session_key().unwrap();
            let change = scope.spawn(|| vault.change_master_password(MASTER, NEW));
            std::thread::sleep(Duration::from_millis(300));
            assert!(!change.is_finished(), "the change waits for the operation");
            // The operation finishes with the key it holds (no deadlock on this thread).
            let written = vault.create_text_secret(shop, secret("written meanwhile")).unwrap();
            drop(held);
            change.join().unwrap().unwrap();
            assert_eq!(vault.reveal_secret(written).unwrap().value, "written meanwhile");
        });

        // Writers racing a change: whichever side of it they land on, every value they
        // wrote opens with the new password.
        const NEWER: &str = "and another one after that";
        let ids = std::sync::Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for writer in 0..6 {
                let (vault, ids) = (&vault, &ids);
                scope.spawn(move || {
                    for n in 0..15 {
                        let value = format!("w{writer}-{n}");
                        let id = vault.create_text_secret(shop, secret(&value)).unwrap();
                        ids.lock().unwrap().push((id, value));
                    }
                });
            }
            scope.spawn(|| vault.change_master_password(NEW, NEWER).unwrap());
        });
        vault.lock();
        assert!(!vault.unlock(NEW).unwrap().valid);
        assert!(vault.unlock(NEWER).unwrap().valid);
        let ids = ids.into_inner().unwrap();
        assert_eq!(ids.len(), 90);
        for (id, value) in ids {
            assert_eq!(vault.reveal_secret(id).unwrap().value, value);
        }
    }

    #[test]
    fn service_logins_are_sealed_kept_and_replaced() {
        use crate::validation::ServiceLoginInput;
        let (directory, vault) = unlocked_vault();
        let shop = project(&vault, "Shaba");
        let login = |id: Option<i64>, username: &str, password: Option<&str>, note: &str| ServiceLoginInput {
            id,
            username: username.into(),
            password: password.map(Into::into),
            note: note.into(),
        };
        let input = |logins: Vec<ServiceLoginInput>| ServiceInput {
            name: "Prod server".into(),
            url: "203.0.113.7:22".into(),
            accounts: Vec::new(),
            logins,
        };
        let server = vault
            .create_service(shop, &input(vec![login(None, " root ", Some("hunter2"), "full access"), login(None, "deploy", None, "")]))
            .unwrap();
        let logins = || vault.workspace().unwrap().services.into_iter().find(|s| s.id == server).unwrap().logins;
        let shape = |logins: &[workspace::ServiceLogin]| -> Vec<(String, String, bool)> {
            logins.iter().map(|l| (l.username.clone(), l.note.clone(), l.has_password)).collect()
        };
        let saved = logins();
        assert_eq!(shape(&saved), [("root".into(), "full access".into(), true), ("deploy".into(), String::new(), false)]);
        assert_eq!(vault.reveal_service_login(saved[0].id).unwrap().value, "hunter2");
        assert_eq!(code(vault.reveal_service_login(saved[1].id)), ErrorCode::NotFound);

        // Nothing of it is readable in the file.
        let conn = Connection::open(directory.path().join("vaultkey.sqlite3")).unwrap();
        let (username, password, note): (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>) = conn
            .query_row("SELECT username, password, note FROM service_logins WHERE id = ?1", [saved[0].id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        let raw = [username, password.unwrap(), note.unwrap()].concat();
        for plain in [&b"root"[..], b"hunter2", b"full access"] {
            assert!(!raw.windows(plain.len()).any(|w| w == plain), "{} is stored in clear", String::from_utf8_lossy(plain));
        }

        // Kept without re-sending its password; one removed, one added; the order is the list's.
        let root = saved[0].id;
        vault
            .update_service(server, &input(vec![login(None, "backup", Some("b4ckup"), ""), login(Some(root), "root", None, "sudo")]))
            .unwrap();
        let updated = logins();
        assert_eq!(shape(&updated), [("backup".into(), String::new(), true), ("root".into(), "sudo".into(), true)]);
        assert_eq!(updated[1].id, root);
        assert_eq!(vault.reveal_service_login(root).unwrap().value, "hunter2");

        // An empty password clears it; another service's login can't be claimed.
        vault.update_service(server, &input(vec![login(Some(root), "root", Some(""), "")])).unwrap();
        assert!(!logins()[0].has_password);
        assert_eq!(code(vault.update_service(server, &input(vec![login(Some(root + 99), "x", None, "")]))), ErrorCode::NotFound);
        assert_eq!(code(vault.update_service(server, &input(vec![login(None, "  ", None, "")]))), ErrorCode::InvalidInput);

        // Deleting the service deletes its logins.
        vault.delete_service(server).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM service_logins", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn env_import_adds_replaces_and_rolls_back() {
        let (_directory, vault) = unlocked_vault();
        let shop = project(&vault, "Shaba");
        let old = vault
            .create_text_secret(shop, SecretInput { name: "DATABASE_URL".into(), value: "postgres://old".into(), service_id: None, description: "old db".into() })
            .unwrap();
        let file = dotenv::parse("DATABASE_URL=postgres://new # production db\nSTRIPE_KEY=sk_live_1 # live payments\n");
        let chosen = |replace: Option<i64>| -> Vec<EnvSecretInput> {
            file.entries
                .iter()
                .map(|e| EnvSecretInput {
                    name: e.name.clone(),
                    value: e.value.clone(),
                    description: e.comment.clone(),
                    replace: (e.name == "DATABASE_URL").then_some(replace).flatten(),
                })
                .collect()
        };

        // A replaced secret that no longer matches: nothing at all is saved.
        assert_eq!(code(vault.import_env(shop, None, chosen(Some(old + 100)))), ErrorCode::NotFound);
        assert_eq!(vault.workspace().unwrap().secrets.len(), 1);

        let report = vault.import_env(shop, None, chosen(Some(old))).unwrap();
        assert_eq!((report.added, report.updated), (1, 1));
        let secrets = vault.workspace().unwrap().secrets;
        let by_name = |name: &str| secrets.iter().find(|s| s.name == name).unwrap();
        assert_eq!(by_name("DATABASE_URL").id, old);
        assert_eq!(by_name("DATABASE_URL").description, "production db");
        assert_eq!(vault.reveal_secret(old).unwrap().value, "postgres://new");
        let stripe = by_name("STRIPE_KEY");
        assert_eq!((stripe.description.as_str(), stripe.kind.as_str()), ("live payments", "text"));
        assert_eq!(vault.reveal_secret(stripe.id).unwrap().value, "sk_live_1");

        assert_eq!(code(vault.import_env(shop, None, Vec::new())), ErrorCode::InvalidInput);
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
                    logins: Vec::new(),
                    name: "Coolify".into(),
                    url: "https://coolify.acme.dev".into(),
                    accounts: vec![ServiceAccountInput {
                        account_id: google,
                        role: "admin, root on the server".into(),
                    }],
                },
            )
            .unwrap();
        assert_eq!(
            code(vault.create_service(
                acme,
                &ServiceInput {
                    logins: Vec::new(),
                    name: "Coolify".into(),
                    url: String::new(),
                    accounts: Vec::new()
                }
            )),
            ErrorCode::AlreadyExists
        );
        assert_eq!(
            code(vault.create_service(
                acme,
                &ServiceInput {
                    logins: Vec::new(),
                    name: "Ghost".into(),
                    url: String::new(),
                    accounts: vec![ServiceAccountInput {
                        account_id: 9_999,
                        role: String::new()
                    }]
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
                    description: "Live mode, full write access".into(),
                },
            )
            .unwrap();
        let workspace = vault.workspace().unwrap();
        assert_eq!(workspace.projects[0].name, "Acme Store");
        assert_eq!(
            workspace.services[0].accounts,
            vec![ServiceAccount {
                account_id: google,
                role: "admin, root on the server".into()
            }]
        );
        let meta = &workspace.secrets[0];
        assert_eq!(
            (meta.kind.as_str(), meta.size, meta.service_id, meta.description.as_str()),
            ("text", 11, Some(coolify), "Live mode, full write access")
        );
        // Roles and descriptions are sealed at rest, like the secrets themselves.
        let (role, description): (Vec<u8>, Vec<u8>) = vault
            .with_database(|db| {
                let conn = db.connection();
                Ok((
                    conn.query_row("SELECT role FROM service_accounts", [], |r| r.get(0))?,
                    conn.query_row("SELECT description FROM secrets", [], |r| r.get(0))?,
                ))
            })
            .unwrap();
        assert!(!role.windows(5).any(|w| w == b"admin"), "role sealed");
        assert!(!description.windows(4).any(|w| w == b"Live"), "description sealed");
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
                    description: None,
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
                    description: Some(String::new()),
                },
            )
            .unwrap();
        assert_eq!(
            vault.reveal_secret(key).unwrap().value,
            "sk_live_456",
            "no value keeps the old one"
        );
        assert_eq!(
            vault.workspace().unwrap().secrets[0].description,
            "",
            "an empty description clears it"
        );

        // A secret can't be attached to another project's service.
        let other = project(&vault, "Other");
        let elsewhere = vault
            .create_service(
                other,
                &ServiceInput {
                    logins: Vec::new(),
                    name: "Vercel".into(),
                    url: String::new(),
                    accounts: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(
            code(vault.create_text_secret(
                acme,
                SecretInput {
                    name: "X".into(),
                    value: "y".into(),
                    service_id: Some(elsewhere),
                    description: String::new()
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
                .accounts,
            Vec::new()
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
                    value: Some("x".into()),
                    description: None
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
        let on = |ids: &[i64]| -> Vec<DeviceLinkInput> {
            ids.iter()
                .map(|&device_id| DeviceLinkInput {
                    device_id,
                    note: String::new(),
                })
                .collect()
        };

        vault
            .set_account_connections(vercel, &[github], &[gmail], &on(&[mac]))
            .unwrap();
        let state = |vault: &Vault| {
            let links = vault.account_links().unwrap().links;
            let devices = vault.account_details().unwrap().device_links;
            (links.len(), devices.len())
        };
        assert_eq!(state(&vault), (2, 1));

        // A device deleted elsewhere: nothing is half-saved.
        assert_eq!(
            code(vault.set_account_connections(vercel, &[], &[], &on(&[9_999]))),
            ErrorCode::NotFound
        );
        assert_eq!(
            code(vault.set_account_connections(vercel, &[vercel], &[], &[])),
            ErrorCode::InvalidInput
        );
        assert_eq!(state(&vault), (2, 1), "a failed save changes nothing");

        vault
            .set_account_connections(vercel, &[], &[], &[])
            .unwrap();
        assert_eq!(state(&vault), (0, 0));
    }

    #[test]
    fn device_notes_are_sealed_and_kept_when_only_ids_change() {
        let (_directory, vault) = unlocked_vault();
        let github = account(&vault, "github.com", "me@example.com");
        let phone = device(&vault, "iPhone", "phone");
        let mac = device(&vault, "MacBook", "computer");
        let note = DeviceLinkInput {
            device_id: phone,
            note: "mobile app + authenticator".into(),
        };
        vault.set_account_connections(github, &[], &[], &[note]).unwrap();
        let links = vault.account_details().unwrap().device_links;
        assert_eq!(links[0].note, "mobile app + authenticator");
        let stored: Vec<u8> = vault
            .with_database(|db| Ok(db.connection().query_row("SELECT note FROM account_devices", [], |r| r.get(0))?))
            .unwrap();
        assert!(!stored.windows(6).any(|w| w == b"mobile"), "note sealed");

        // Adding a device by id alone keeps the phone's note.
        vault.set_account_devices(github, &[phone, mac]).unwrap();
        let links = vault.account_details().unwrap().device_links;
        let phone_link = links.iter().find(|l| l.device_id == phone).unwrap();
        assert_eq!(phone_link.note, "mobile app + authenticator");
        assert_eq!(links.len(), 2);

        let twice = [
            DeviceLinkInput { device_id: phone, note: String::new() },
            DeviceLinkInput { device_id: phone, note: String::new() },
        ];
        assert_eq!(code(vault.set_account_connections(github, &[], &[], &twice)), ErrorCode::InvalidInput);
    }

    #[test]
    fn a_service_uses_several_accounts_in_order() {
        let (_directory, vault) = unlocked_vault();
        let acme = project(&vault, "Acme");
        let admin = account(&vault, "coolify.acme.dev", "admin@acme.dev");
        let deploy = account(&vault, "coolify.acme.dev", "deploy@acme.dev");
        let input = |accounts: Vec<ServiceAccountInput>| ServiceInput {
            logins: Vec::new(),
            name: "Coolify".into(),
            url: String::new(),
            accounts,
        };
        let both = || {
            vec![
                ServiceAccountInput { account_id: deploy, role: "deploy only".into() },
                ServiceAccountInput { account_id: admin, role: "admin".into() },
            ]
        };
        let coolify = vault.create_service(acme, &input(both())).unwrap();
        let roles = |vault: &Vault| -> Vec<(i64, String)> {
            vault.workspace().unwrap().services[0]
                .accounts
                .iter()
                .map(|a| (a.account_id, a.role.clone()))
                .collect()
        };
        assert_eq!(roles(&vault), vec![(deploy, "deploy only".into()), (admin, "admin".into())]);
        // The pre-v5 column follows the first account.
        let first: Option<i64> = vault
            .with_database(|db| Ok(db.connection().query_row("SELECT account_id FROM services", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(first, Some(deploy));

        // Listed twice, or an unknown account: refused, nothing changes.
        let twice = vec![
            ServiceAccountInput { account_id: admin, role: String::new() },
            ServiceAccountInput { account_id: admin, role: String::new() },
        ];
        assert_eq!(code(vault.update_service(coolify, &input(twice))), ErrorCode::InvalidInput);
        let ghost = vec![ServiceAccountInput { account_id: 9_999, role: String::new() }];
        assert_eq!(code(vault.update_service(coolify, &input(ghost))), ErrorCode::NotFound);
        assert_eq!(roles(&vault).len(), 2, "a failed save changes nothing");

        // Deleting one account leaves the other.
        vault.delete_credential(deploy).unwrap();
        assert_eq!(roles(&vault), vec![(admin, "admin".into())]);
    }

    #[test]
    fn the_upload_dialog_imports_only_what_it_was_given() {
        let (directory, vault) = unlocked_vault();
        let acme = project(&vault, "Acme");
        let write = |name: &str, body: &[u8]| {
            let path = directory.path().join(name);
            fs::write(&path, body).unwrap();
            path
        };
        let key = write("id_ed25519", b"-----BEGIN OPENSSH PRIVATE KEY-----");
        let env = write("prod.env", b"DATABASE_URL=postgres://x");
        let staged = vault
            .stage_files(vec![key.clone(), env.clone(), key.clone(), directory.path().to_path_buf()])
            .unwrap();
        assert_eq!(staged.files.len(), 2, "a file is listed once");
        assert_eq!(staged.skipped.len(), 1, "a folder is refused");
        let token = |name: &str| staged.files.iter().find(|f| f.name == name).unwrap().token;

        // A name with a separator is refused before anything is added.
        assert_eq!(
            code(vault.import_staged(
                acme,
                None,
                &[StagedFileInput { token: token("id_ed25519"), description: String::new(), name: Some("../keys/x".into()) }],
            )),
            ErrorCode::InvalidInput
        );
        assert!(vault.workspace().unwrap().secrets.is_empty());

        // Only the key, renamed, with its description; the .env stays in the dialog.
        let report = vault
            .import_staged(
                acme,
                None,
                &[StagedFileInput {
                    token: token("id_ed25519"),
                    description: "root SSH key for prod".into(),
                    name: Some("  prod_root_ed25519 ".into()),
                }],
            )
            .unwrap();
        assert_eq!(report.imported.len(), 1);
        let secrets = vault.workspace().unwrap().secrets;
        assert_eq!(
            (secrets[0].name.as_str(), secrets[0].description.as_str()),
            ("prod_root_ed25519", "root SSH key for prod"),
            "renamed in the dialog (trimmed)"
        );
        assert_eq!(vault.unstage_file(-1).unwrap().files.len(), 1);

        // Its own name, unchanged in the dialog, is kept as it is.
        vault
            .import_staged(acme, None, &[StagedFileInput { token: token("prod.env"), description: String::new(), name: Some("prod.env".into()) }])
            .unwrap();
        assert!(vault.workspace().unwrap().secrets.iter().any(|s| s.name == "prod.env"));
        let staged = vault.stage_files(vec![key.clone()]).unwrap();
        let token = |name: &str| staged.files.iter().find(|f| f.name == name).unwrap().token;

        // A token not (or no longer) in the list imports nothing.
        assert_eq!(
            code(vault.import_staged(acme, None, &[StagedFileInput { token: token("id_ed25519") + 1000, description: String::new(), name: None }])),
            ErrorCode::InvalidInput
        );

        // Locking empties the dialog.
        vault.lock();
        assert!(lock_or_recover(&vault.staged).files.is_empty());
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
