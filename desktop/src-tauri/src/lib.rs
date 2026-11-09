//! VaultKey: Tauri shell around the vault service.

mod account_details;
mod commands;
mod crypto;
mod db;
mod error;
mod paths;
mod store;
mod totp;
mod validation;
mod vault;
mod workspace;

use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, Theme, Url, WebviewWindowBuilder,
    WindowEvent,
};

use crate::commands::MAIN_WINDOW;
use crate::vault::Vault;

/// Only the app's own pages may load in the window, like the Electron `will-navigate`
/// guard. Bundled assets are served from exactly `tauri://localhost` (macOS/Linux) or
/// `http://tauri.localhost` (Windows): no other host, port or credentials. Dev builds
/// (`tauri dev`, including `--release`) also allow the Vite dev server's origin.
fn is_app_url(url: &Url, dev_server: Option<&Url>) -> bool {
    let (scheme, host) = if cfg!(windows) {
        ("http", "tauri.localhost")
    } else {
        ("tauri", "localhost")
    };
    let bundled = url.scheme() == scheme
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    bundled || (tauri::is_dev() && dev_server.is_some_and(|dev| dev.origin() == url.origin()))
}

#[derive(Clone, serde::Serialize)]
struct DragState {
    active: bool,
    count: usize,
}

#[derive(Clone, serde::Serialize)]
struct DroppedFiles {
    names: Vec<String>,
}

fn lock_vault(app: &AppHandle) {
    if let Some(vault) = app.try_state::<Vault>() {
        vault.lock();
    }
}

/// The theme canvas colours (src/assets/main.css `--background`), so the window
/// never flashes white before the page paints.
const LIGHT_BG: Color = Color(0xee, 0xf0, 0xf6, 0xff);
const DARK_BG: Color = Color(0x0e, 0x10, 0x17, 0xff);

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .expect("tauri.conf.json must declare the main window");
    let dev_server = app.config().build.dev_url.clone();
    let window = WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| is_app_url(url, dev_server.as_ref()))
        // Every fresh document starts locked: a reload (context menu, F5 on Windows,
        // WebKit restarting a crashed content process) shows the login screen, so the
        // key must not stay live behind it. Hash-route changes don't trigger this.
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Started {
                lock_vault(window.app_handle());
            }
        })
        .build()?;
    let background = match window.theme() {
        Ok(Theme::Dark) => DARK_BG,
        _ => LIGHT_BG,
    };
    if let Err(error) = window.set_background_color(Some(background)) {
        eprintln!("[vault] could not set the window background: {error}");
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database_path = paths::resolve_database_path(&app.path().config_dir()?);
            if tauri::is_dev() {
                eprintln!(
                    "[vault] dev build, database: {} (set {} to change)",
                    database_path.display(),
                    paths::DATA_DIR_ENV
                );
            }
            app.manage(Vault::open(database_path));
            create_main_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            match event {
                // Electron revoked the renderer's session when its window was destroyed.
                WindowEvent::Destroyed => lock_vault(window.app_handle()),
                // Files dragged onto the window: their paths stay in Rust. The page is
                // told the names only, and asks to import them into a project.
                WindowEvent::DragDrop(DragDropEvent::Enter { paths, .. }) => {
                    let _ = window.emit(
                        "vault://drag",
                        DragState {
                            active: true,
                            count: paths.len(),
                        },
                    );
                }
                WindowEvent::DragDrop(DragDropEvent::Leave) => {
                    let _ = window.emit(
                        "vault://drag",
                        DragState {
                            active: false,
                            count: 0,
                        },
                    );
                }
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    let names = paths
                        .iter()
                        .filter_map(|path| path.file_name())
                        .map(|name| name.to_string_lossy().into_owned())
                        .collect();
                    if let Some(vault) = window.app_handle().try_state::<Vault>() {
                        vault.remember_dropped(paths.clone());
                    }
                    let _ = window.emit(
                        "vault://drag",
                        DragState {
                            active: false,
                            count: 0,
                        },
                    );
                    let _ = window.emit("vault://drop", DroppedFiles { names });
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::create_vault,
            commands::unlock_vault,
            commands::lock_vault,
            commands::fetch_domains,
            commands::register_domain,
            commands::delete_domain,
            commands::list_accounts,
            commands::fetch_credentials,
            commands::create_credential,
            commands::update_credential,
            commands::delete_credential,
            commands::load_workspace,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::create_service,
            commands::update_service,
            commands::delete_service,
            commands::create_secret,
            commands::update_secret,
            commands::reveal_secret,
            commands::delete_secret,
            commands::import_files,
            commands::import_dropped_files,
            commands::export_secret,
            commands::list_account_links,
            commands::set_sign_in_links,
            commands::set_account_links,
            commands::load_account_details,
            commands::create_device,
            commands::update_device,
            commands::delete_device,
            commands::create_factor,
            commands::update_factor,
            commands::delete_factor,
            commands::reveal_factor,
            commands::factor_code,
            commands::create_account_secret,
            commands::update_account_secret,
            commands::reveal_account_secret,
            commands::delete_account_secret,
            commands::set_account_devices,
            commands::set_account_connections,
        ])
        .build(tauri::generate_context!())
        .expect("error while building VaultKey");

    app.run(|app, event| match event {
        // macOS, like Electron's `window-all-closed` + `activate`: closing the window
        // keeps the app in the Dock (vault locked); clicking the Dock icon reopens it.
        // `code: None` is only emitted when the last window closes; Cmd+Q / Quit go
        // through applicationWillTerminate → `RunEvent::Exit` and still quit.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            if app.get_webview_window(MAIN_WINDOW).is_none()
                && let Err(error) = create_main_window(app)
            {
                eprintln!("[vault] could not reopen the window: {error}");
            }
        }
        // Mirrors Electron's before-quit: zeroise the key, checkpoint and close SQLite.
        RunEvent::Exit => {
            if let Some(vault) = app.try_state::<Vault>() {
                vault.close();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_limited_to_the_app() {
        let dev: Url = "http://localhost:1420".parse().unwrap();
        let allowed = |url: &str| is_app_url(&url.parse().unwrap(), Some(&dev));
        let own = if cfg!(windows) {
            "http://tauri.localhost/#/vault"
        } else {
            "tauri://localhost/index.html"
        };
        assert!(allowed(own));
        for blocked in [
            "https://evil.example/",
            "tauri://evil/",
            "tauri://localhost.evil/",
            "tauri://localhost:8080/",
            "tauri://user:pw@localhost/",
            "http://tauri.localhost:1337/",
            "https://tauri.localhost/",
            "http://user:pw@tauri.localhost/",
            "file:///etc/passwd",
            "http://localhost:9999/",
        ] {
            assert!(!allowed(blocked), "{blocked} must be blocked");
        }
        // The dev server is only trusted in dev builds (cargo test is one).
        assert_eq!(allowed("http://localhost:1420/#/login"), tauri::is_dev());
    }
}
