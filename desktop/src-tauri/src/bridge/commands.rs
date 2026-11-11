//! Settings → Browser extension, and the pairing dialog. Like every command
//! (`commands.rs`): the main window only, the work on a blocking thread, failures logged
//! and returned as `{ code, message }`.

use std::sync::Arc;

use tauri::{AppHandle, Manager, Webview};

use super::{Bridge, BridgeSettings, PairingPrompt};
use crate::commands::MAIN_WINDOW;
use crate::error::{VaultError, VaultResult, log_failure};

async fn run<T, F>(operation: &'static str, app: AppHandle, webview: Webview, job: F) -> VaultResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Arc<Bridge>) -> VaultResult<T> + Send + 'static,
{
    let outcome = if webview.label() != MAIN_WINDOW {
        Err(VaultError::locked("This window is not authorized."))
    } else {
        tauri::async_runtime::spawn_blocking(move || job(&app.state::<Arc<Bridge>>()))
            .await
            .unwrap_or_else(|error| Err(VaultError::internal("The vault operation failed.").with_detail(error)))
    };
    if let Err(error) = &outcome {
        log_failure(operation, error);
    }
    outcome
}

#[tauri::command]
pub async fn bridge_settings(app: AppHandle, webview: Webview) -> VaultResult<BridgeSettings> {
    run("bridge_settings", app, webview, |bridge| bridge.settings()).await
}

/// Turns "Browser extension" on (registers the bridge with the browsers and listens) or
/// off (stops listening, ends every session and removes the registration).
#[tauri::command]
pub async fn set_bridge_enabled(app: AppHandle, webview: Webview, enabled: bool) -> VaultResult<BridgeSettings> {
    run("set_bridge_enabled", app, webview, move |bridge| bridge.set_enabled(enabled)).await
}

#[tauri::command]
pub async fn revoke_browser(app: AppHandle, webview: Webview, browser_id: i64) -> VaultResult<BridgeSettings> {
    run("revoke_browser", app, webview, move |bridge| bridge.revoke(browser_id)).await
}

/// The pairing dialog open now, if any (for a window that missed the event).
#[tauri::command]
pub async fn pending_pairing(app: AppHandle, webview: Webview) -> VaultResult<Option<PairingPrompt>> {
    run("pending_pairing", app, webview, |bridge| Ok(bridge.pending_prompt())).await
}

#[tauri::command]
pub async fn answer_pairing(app: AppHandle, webview: Webview, id: u64, approve: bool) -> VaultResult<()> {
    run("answer_pairing", app, webview, move |bridge| bridge.answer(id, approve)).await
}
