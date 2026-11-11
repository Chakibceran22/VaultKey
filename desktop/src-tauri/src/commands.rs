//! Tauri commands: the IPC surface, replacing Electron's `ipcMain.handle` channels.
//!
//! Every command:
//! 1. rejects callers other than the main window (Electron's `assertTrusted`),
//! 2. runs the vault work on a blocking thread, so neither the UI thread nor the
//!    async runtime stalls during Argon2id/scrypt,
//! 3. logs failures (operation + code only) and returns `{ code, message }` errors.

use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::account_details::AccountDetails;
use crate::error::{VaultError, VaultResult, log_failure};
use crate::totp::TotpCode;
use crate::validation::{
    AccountSecretInput, AccountSecretUpdateInput, CredentialInput, CredentialUpdateInput,
    DeviceInput, DeviceLinkInput, FactorInput, FactorUpdateInput, ProjectInput, SecretInput,
    SecretUpdateInput, ServiceInput, StagedFileInput,
};
use crate::vault::{
    AccountList, Created, CredentialList, DomainList, ImportReport, LinkList, RevealedSecret,
    StagedList, UnlockResult, Vault, VaultStatus,
};
use crate::dotenv::{self, EnvFile, EnvText};
use crate::validation::EnvSecretInput;
use crate::vault::EnvImportReport;
use crate::workspace::Workspace;

pub const MAIN_WINDOW: &str = "main";

async fn run<T, F>(
    operation: &'static str,
    app: AppHandle,
    webview: Webview,
    job: F,
) -> VaultResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Vault) -> VaultResult<T> + Send + 'static,
{
    let outcome = if webview.label() != MAIN_WINDOW {
        Err(VaultError::locked("This window is not authorized."))
    } else {
        tauri::async_runtime::spawn_blocking(move || job(&app.state::<Vault>()))
            .await
            .unwrap_or_else(|error| {
                Err(VaultError::internal("The vault operation failed.").with_detail(error))
            })
    };
    if let Err(error) = &outcome {
        log_failure(operation, error);
    }
    outcome
}

/// Changes the master password: the vault key is wrapped again by the new one (the
/// data doesn't change). Other operations using the key wait until it's done.
#[tauri::command]
pub async fn change_master_password(
    app: AppHandle,
    webview: Webview,
    current_password: String,
    new_password: String,
) -> VaultResult<()> {
    let current_password = Zeroizing::new(current_password);
    let new_password = Zeroizing::new(new_password);
    run("master password change", app, webview, move |vault| {
        vault.change_master_password(&current_password, &new_password)
    })
    .await
}

/// A new recovery code to show once (kept in Rust until it is saved).
#[tauri::command]
pub async fn new_recovery_code(app: AppHandle, webview: Webview) -> VaultResult<crate::vault::RecoveryCode> {
    run("recovery code creation", app, webview, |vault| vault.new_recovery_code()).await
}

/// Saves the code just shown, once three of its words and the master password match.
#[tauri::command]
pub async fn save_recovery_code(
    app: AppHandle,
    webview: Webview,
    master_password: String,
    answers: Vec<crate::vault::RecoveryAnswer>,
) -> VaultResult<()> {
    let master_password = Zeroizing::new(master_password);
    run("recovery code save", app, webview, move |vault| {
        vault.save_recovery_code(&master_password, &answers)
    })
    .await
}

/// A forgotten master password: the recovery code sets a new one and unlocks.
#[tauri::command]
pub async fn recover_vault(
    app: AppHandle,
    webview: Webview,
    recovery_code: String,
    new_password: String,
) -> VaultResult<()> {
    let recovery_code = Zeroizing::new(recovery_code);
    let new_password = Zeroizing::new(new_password);
    run("vault recovery", app, webview, move |vault| {
        vault.recover(&recovery_code, &new_password)
    })
    .await
}

#[tauri::command]
pub async fn security_status(app: AppHandle, webview: Webview) -> VaultResult<crate::vault::SecurityStatus> {
    run("security status", app, webview, |vault| vault.security_status()).await
}

#[tauri::command]
pub async fn vault_status(app: AppHandle, webview: Webview) -> VaultResult<VaultStatus> {
    run("vault status", app, webview, |vault| vault.status()).await
}

#[tauri::command]
pub async fn create_vault(
    app: AppHandle,
    webview: Webview,
    master_password: String,
) -> VaultResult<()> {
    let master_password = Zeroizing::new(master_password);
    run("vault creation", app, webview, move |vault| {
        vault.create_vault(&master_password)
    })
    .await
}

#[tauri::command]
pub async fn unlock_vault(
    app: AppHandle,
    webview: Webview,
    master_password: String,
) -> VaultResult<UnlockResult> {
    let master_password = Zeroizing::new(master_password);
    run("auth verification", app, webview, move |vault| {
        vault.unlock(&master_password)
    })
    .await
}

/// The window is in use (the page reports activity at most every 30 s): it pushes the
/// idle auto-lock back (`idle.rs`).
#[tauri::command]
pub fn vault_activity(app: AppHandle, webview: Webview) {
    if webview.label() == MAIN_WINDOW {
        app.state::<crate::idle::Idle>().touch();
    }
}

#[tauri::command]
pub async fn lock_vault(app: AppHandle, webview: Webview) -> VaultResult<()> {
    run("vault lock", app, webview, |vault| {
        vault.lock();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn fetch_domains(app: AppHandle, webview: Webview) -> VaultResult<DomainList> {
    run("domain fetch", app, webview, |vault| vault.list_domains()).await
}

#[tauri::command]
pub async fn register_domain(
    app: AppHandle,
    webview: Webview,
    name: String,
) -> VaultResult<Created> {
    run("domain registration", app, webview, move |vault| {
        vault.create_domain(&name).map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn delete_domain(app: AppHandle, webview: Webview, domain_id: i64) -> VaultResult<()> {
    run("domain deletion", app, webview, move |vault| {
        vault.delete_domain(domain_id)
    })
    .await
}

#[tauri::command]
pub async fn list_accounts(app: AppHandle, webview: Webview) -> VaultResult<AccountList> {
    run("account list", app, webview, |vault| vault.list_accounts()).await
}

#[tauri::command]
pub async fn fetch_credentials(
    app: AppHandle,
    webview: Webview,
    domain_id: i64,
) -> VaultResult<CredentialList> {
    run("credential fetch", app, webview, move |vault| {
        vault.list_credentials(domain_id)
    })
    .await
}

#[tauri::command]
pub async fn create_credential(
    app: AppHandle,
    webview: Webview,
    input: CredentialInput,
) -> VaultResult<Created> {
    run("credential creation", app, webview, move |vault| {
        vault.create_credential(input).map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_credential(
    app: AppHandle,
    webview: Webview,
    credential_id: i64,
    input: CredentialUpdateInput,
) -> VaultResult<()> {
    run("credential update", app, webview, move |vault| {
        vault.update_credential(credential_id, input)
    })
    .await
}

#[tauri::command]
pub async fn delete_credential(
    app: AppHandle,
    webview: Webview,
    credential_id: i64,
) -> VaultResult<()> {
    run("credential deletion", app, webview, move |vault| {
        vault.delete_credential(credential_id)
    })
    .await
}

// ── projects, services, secrets, files and links ────────────────────────────

#[tauri::command]
pub async fn load_workspace(app: AppHandle, webview: Webview) -> VaultResult<Workspace> {
    run("workspace load", app, webview, |vault| vault.workspace()).await
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    webview: Webview,
    input: ProjectInput,
) -> VaultResult<Created> {
    run("project creation", app, webview, move |vault| {
        vault.create_project(&input).map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_project(
    app: AppHandle,
    webview: Webview,
    project_id: i64,
    input: ProjectInput,
) -> VaultResult<()> {
    run("project update", app, webview, move |vault| {
        vault.update_project(project_id, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_project(app: AppHandle, webview: Webview, project_id: i64) -> VaultResult<()> {
    run("project deletion", app, webview, move |vault| {
        vault.delete_project(project_id)
    })
    .await
}

#[tauri::command]
pub async fn create_service(
    app: AppHandle,
    webview: Webview,
    project_id: i64,
    input: ServiceInput,
) -> VaultResult<Created> {
    run("service creation", app, webview, move |vault| {
        vault
            .create_service(project_id, &input)
            .map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_service(
    app: AppHandle,
    webview: Webview,
    service_id: i64,
    input: ServiceInput,
) -> VaultResult<()> {
    run("service update", app, webview, move |vault| {
        vault.update_service(service_id, &input)
    })
    .await
}

/// A service login's password, to copy or show.
#[tauri::command]
pub async fn reveal_service_login(
    app: AppHandle,
    webview: Webview,
    login_id: i64,
) -> VaultResult<RevealedSecret> {
    run("service login reveal", app, webview, move |vault| {
        vault.reveal_service_login(login_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_service(app: AppHandle, webview: Webview, service_id: i64) -> VaultResult<()> {
    run("service deletion", app, webview, move |vault| {
        vault.delete_service(service_id)
    })
    .await
}

#[tauri::command]
pub async fn create_secret(
    app: AppHandle,
    webview: Webview,
    project_id: i64,
    input: SecretInput,
) -> VaultResult<Created> {
    run("secret creation", app, webview, move |vault| {
        vault
            .create_text_secret(project_id, input)
            .map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_secret(
    app: AppHandle,
    webview: Webview,
    secret_id: i64,
    input: SecretUpdateInput,
) -> VaultResult<()> {
    run("secret update", app, webview, move |vault| {
        vault.update_secret(secret_id, input)
    })
    .await
}

#[tauri::command]
pub async fn reveal_secret(
    app: AppHandle,
    webview: Webview,
    secret_id: i64,
) -> VaultResult<RevealedSecret> {
    run("secret reveal", app, webview, move |vault| {
        vault.reveal_secret(secret_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_secret(app: AppHandle, webview: Webview, secret_id: i64) -> VaultResult<()> {
    run("secret deletion", app, webview, move |vault| {
        vault.delete_secret(secret_id)
    })
    .await
}

/// The upload dialog: opens the native file picker (from Rust, so the page never
/// supplies a path) and adds the chosen files to the dialog's list.
#[tauri::command]
pub async fn stage_files(app: AppHandle, webview: Webview) -> VaultResult<StagedList> {
    let dialogs = app.clone();
    run("file pick", app, webview, move |vault| {
        vault.require_unlocked()?;
        let picked = dialogs
            .dialog()
            .file()
            .set_title("Add files")
            .blocking_pick_files();
        let paths = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|path| path.into_path().ok())
            .collect();
        vault.stage_files(paths)
    })
    .await
}

/// Adds the files last dropped onto the window to the upload dialog. The paths come
/// from the OS drop event recorded in Rust, never from the page.
#[tauri::command]
pub async fn stage_dropped_files(app: AppHandle, webview: Webview) -> VaultResult<StagedList> {
    run("file drop", app, webview, move |vault| {
        let paths = vault.take_dropped();
        vault.stage_files(paths)
    })
    .await
}

#[tauri::command]
pub async fn unstage_file(app: AppHandle, webview: Webview, token: i64) -> VaultResult<StagedList> {
    run("file unstage", app, webview, move |vault| vault.unstage_file(token)).await
}

#[tauri::command]
pub async fn clear_staged_files(app: AppHandle, webview: Webview) -> VaultResult<()> {
    run("file unstage", app, webview, move |vault| {
        vault.clear_staged();
        Ok(())
    })
    .await
}

/// Encrypts the upload dialog's chosen files into the project, each with its description.
#[tauri::command]
pub async fn import_staged_files(
    app: AppHandle,
    webview: Webview,
    project_id: i64,
    service_id: Option<i64>,
    files: Vec<StagedFileInput>,
) -> VaultResult<ImportReport> {
    run("file import", app, webview, move |vault| {
        vault.require_project(project_id)?;
        vault.import_staged(project_id, service_id, &files)
    })
    .await
}

/// The secrets in pasted or read .env text, for the import dialog to show. Saves nothing.
#[tauri::command]
pub async fn parse_env(app: AppHandle, webview: Webview, text: String) -> VaultResult<EnvFile> {
    let text = Zeroizing::new(text);
    run("env reading", app, webview, move |vault| {
        vault.require_unlocked()?;
        Ok(dotenv::parse(&text))
    })
    .await
}

/// The native picker for a .env file (from Rust, so the page never supplies a path).
#[tauri::command]
pub async fn pick_env_file(app: AppHandle, webview: Webview) -> VaultResult<Option<EnvText>> {
    let dialogs = app.clone();
    run("env file pick", app, webview, move |vault| {
        vault.require_unlocked()?;
        let picked = dialogs
            .dialog()
            .file()
            .set_title("Choose a .env file")
            .blocking_pick_file();
        match picked.and_then(|path| path.into_path().ok()) {
            Some(path) => dotenv::read_text(&path).map(Some),
            None => Ok(None),
        }
    })
    .await
}

/// A file dropped onto the .env import dialog, read as text instead of uploaded.
#[tauri::command]
pub async fn read_staged_env(app: AppHandle, webview: Webview, token: i64) -> VaultResult<EnvText> {
    run("env file drop", app, webview, move |vault| vault.read_staged_env(token)).await
}

/// Saves the secrets chosen in the .env import dialog, all or none.
#[tauri::command]
pub async fn import_env(
    app: AppHandle,
    webview: Webview,
    project_id: i64,
    service_id: Option<i64>,
    secrets: Vec<EnvSecretInput>,
) -> VaultResult<EnvImportReport> {
    run("env import", app, webview, move |vault| {
        vault.import_env(project_id, service_id, secrets)
    })
    .await
}

#[derive(serde::Serialize)]
pub struct Exported {
    pub saved: bool,
}

/// Asks where to save (native dialog, from Rust) and writes the decrypted file there.
#[tauri::command]
pub async fn export_secret(
    app: AppHandle,
    webview: Webview,
    secret_id: i64,
) -> VaultResult<Exported> {
    let dialogs = app.clone();
    run("secret export", app, webview, move |vault| {
        let name = vault.secret_name(secret_id)?;
        let Some(target) = dialogs
            .dialog()
            .file()
            .set_title("Save decrypted copy")
            .set_file_name(&name)
            .blocking_save_file()
        else {
            return Ok(Exported { saved: false });
        };
        let path = target.into_path().map_err(|error| {
            VaultError::internal("That location can’t be written to.").with_detail(error)
        })?;
        vault.export_secret(secret_id, &path)?;
        Ok(Exported { saved: true })
    })
    .await
}

#[tauri::command]
pub async fn list_account_links(app: AppHandle, webview: Webview) -> VaultResult<LinkList> {
    run("account links", app, webview, |vault| vault.account_links()).await
}

#[tauri::command]
pub async fn set_sign_in_links(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    linked_account_ids: Vec<i64>,
) -> VaultResult<()> {
    run("sign-in links", app, webview, move |vault| {
        vault.set_sign_in_links(account_id, &linked_account_ids)
    })
    .await
}

#[tauri::command]
pub async fn set_account_links(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    kind: String,
    linked_account_ids: Vec<i64>,
) -> VaultResult<()> {
    run("account links update", app, webview, move |vault| {
        vault.set_account_links(account_id, &kind, &linked_account_ids)
    })
    .await
}

// ── devices, second steps, account secrets and notes ────────────────────────

#[tauri::command]
pub async fn load_account_details(app: AppHandle, webview: Webview) -> VaultResult<AccountDetails> {
    run("account details", app, webview, |vault| {
        vault.account_details()
    })
    .await
}

#[tauri::command]
pub async fn create_device(
    app: AppHandle,
    webview: Webview,
    input: DeviceInput,
) -> VaultResult<Created> {
    run("device creation", app, webview, move |vault| {
        vault.create_device(&input).map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_device(
    app: AppHandle,
    webview: Webview,
    device_id: i64,
    input: DeviceInput,
) -> VaultResult<()> {
    run("device update", app, webview, move |vault| {
        vault.update_device(device_id, &input)
    })
    .await
}

#[tauri::command]
pub async fn delete_device(app: AppHandle, webview: Webview, device_id: i64) -> VaultResult<()> {
    run("device deletion", app, webview, move |vault| {
        vault.delete_device(device_id)
    })
    .await
}

#[tauri::command]
pub async fn create_factor(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    input: FactorInput,
) -> VaultResult<Created> {
    run("sign-in step creation", app, webview, move |vault| {
        vault
            .create_factor(account_id, input)
            .map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_factor(
    app: AppHandle,
    webview: Webview,
    factor_id: i64,
    input: FactorUpdateInput,
) -> VaultResult<()> {
    run("sign-in step update", app, webview, move |vault| {
        vault.update_factor(factor_id, input)
    })
    .await
}

#[tauri::command]
pub async fn delete_factor(app: AppHandle, webview: Webview, factor_id: i64) -> VaultResult<()> {
    run("sign-in step deletion", app, webview, move |vault| {
        vault.delete_factor(factor_id)
    })
    .await
}

#[tauri::command]
pub async fn reveal_factor(
    app: AppHandle,
    webview: Webview,
    factor_id: i64,
) -> VaultResult<RevealedSecret> {
    run("sign-in step reveal", app, webview, move |vault| {
        vault.reveal_factor(factor_id)
    })
    .await
}

#[tauri::command]
pub async fn factor_code(
    app: AppHandle,
    webview: Webview,
    factor_id: i64,
) -> VaultResult<TotpCode> {
    run("authenticator code", app, webview, move |vault| {
        vault.factor_code(factor_id)
    })
    .await
}

#[tauri::command]
pub async fn create_account_secret(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    input: AccountSecretInput,
) -> VaultResult<Created> {
    run("account secret creation", app, webview, move |vault| {
        vault
            .create_account_secret(account_id, input)
            .map(|id| Created { id })
    })
    .await
}

#[tauri::command]
pub async fn update_account_secret(
    app: AppHandle,
    webview: Webview,
    secret_id: i64,
    input: AccountSecretUpdateInput,
) -> VaultResult<()> {
    run("account secret update", app, webview, move |vault| {
        vault.update_account_secret(secret_id, input)
    })
    .await
}

#[tauri::command]
pub async fn reveal_account_secret(
    app: AppHandle,
    webview: Webview,
    secret_id: i64,
) -> VaultResult<RevealedSecret> {
    run("account secret reveal", app, webview, move |vault| {
        vault.reveal_account_secret(secret_id)
    })
    .await
}

#[tauri::command]
pub async fn delete_account_secret(
    app: AppHandle,
    webview: Webview,
    secret_id: i64,
) -> VaultResult<()> {
    run("account secret deletion", app, webview, move |vault| {
        vault.delete_account_secret(secret_id)
    })
    .await
}

#[tauri::command]
pub async fn set_account_category(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    name: Option<String>,
) -> VaultResult<()> {
    run("account category", app, webview, move |vault| {
        vault.set_account_category(account_id, name.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn set_account_devices(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    device_ids: Vec<i64>,
) -> VaultResult<()> {
    run("account devices", app, webview, move |vault| {
        vault.set_account_devices(account_id, &device_ids)
    })
    .await
}

/// The account form's connections, saved in one transaction.
#[tauri::command]
pub async fn set_account_connections(
    app: AppHandle,
    webview: Webview,
    account_id: i64,
    sign_in: Vec<i64>,
    recovery: Vec<i64>,
    devices: Vec<DeviceLinkInput>,
) -> VaultResult<()> {
    run("account connections", app, webview, move |vault| {
        vault.set_account_connections(account_id, &sign_in, &recovery, &devices)
    })
    .await
}
