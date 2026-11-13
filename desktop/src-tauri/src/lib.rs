//! VaultKey: Tauri shell around the vault service.

mod account_details;
mod background;
mod bridge;
mod browsers;
mod commands;
mod crypto;
mod db;
mod dotenv;
mod error;
mod export;
mod idle;
mod paths;
mod recovery;
mod rekey;
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

pub(crate) fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
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
    // Two-finger swipes go back and forward with Safari's own gesture: it knows when
    // the fingers touch and lift, so it never misses a quick swipe or counts one twice
    // (the page only sees anonymous scroll deltas). Other platforms: HistoryGestures.tsx.
    #[cfg(target_os = "macos")]
    if let Err(error) = window.with_webview(|webview| {
        // SAFETY: on macOS `inner()` is the window's live WKWebView, and `with_webview`
        // runs this on the main thread, where WKWebView may be used.
        unsafe {
            let wk = &*webview.inner().cast::<objc2_web_kit::WKWebView>();
            wk.setAllowsBackForwardNavigationGestures(true);
        }
    }) {
        eprintln!("[vault] could not enable swipe navigation: {error}");
    }
    let background = match window.theme() {
        Ok(Theme::Dark) => DARK_BG,
        _ => LIGHT_BG,
    };
    if let Err(error) = window.set_background_color(Some(background)) {
        eprintln!("[vault] could not set the window background: {error}");
    }
    Ok(())
}

/// The menu item Cmd+M triggers.
#[cfg(target_os = "macos")]
const TOGGLE_FULLSCREEN: &str = "toggle-fullscreen";

/// macOS's default menu, except that Cmd+M toggles full screen instead of minimizing
/// (the yellow window button still minimizes).
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, WINDOW_SUBMENU_ID};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(window_menu)) = menu.get(WINDOW_SUBMENU_ID) {
        // Minimize, which owns Cmd+M.
        window_menu.remove_at(0)?;
        let toggle = MenuItem::with_id(app, TOGGLE_FULLSCREEN, "Toggle Full Screen", true, Some("Cmd+M"))?;
        window_menu.insert(&toggle, 0)?;
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id() == TOGGLE_FULLSCREEN
            && let Some(window) = app.get_webview_window(MAIN_WINDOW)
        {
            let full = window.is_fullscreen().unwrap_or(false);
            if let Err(error) = window.set_fullscreen(!full) {
                eprintln!("[vault] could not toggle full screen: {error}");
            }
        }
    });
    let app = builder
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
            app.manage(commands::Exports::default());
            // Settings and the tray icon first: the idle timer reads the auto-lock delay.
            background::start(app.handle());
            idle::start(app.handle());
            bridge::start(app.handle());
            create_main_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            match event {
                // Background mode (`background.rs`): closing hides the window, and the vault
                // stays unlocked until it locks itself, so the browser extension keeps
                // working. The tray icon, the Dock and the extension bring it back.
                WindowEvent::CloseRequested { api, .. } if background::keeps_running(window.app_handle()) => {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("[vault] could not hide the window: {error}");
                    }
                }
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
            commands::vault_activity,
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
            commands::stage_files,
            commands::stage_dropped_files,
            commands::unstage_file,
            commands::clear_staged_files,
            commands::import_staged_files,
            commands::parse_env,
            commands::pick_env_file,
            commands::read_staged_env,
            commands::import_env,
            commands::reveal_service_login,
            commands::change_master_password,
            commands::new_recovery_code,
            commands::save_recovery_code,
            commands::recover_vault,
            commands::security_status,
            commands::export_secret,
            commands::export_files,
            commands::cancel_export,
            commands::reveal_exported,
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
            commands::set_account_category,
            commands::set_account_devices,
            commands::set_account_connections,
            bridge::commands::bridge_settings,
            bridge::commands::set_bridge_enabled,
            bridge::commands::revoke_browser,
            bridge::commands::pending_pairing,
            bridge::commands::answer_pairing,
            bridge::commands::unmatched_websites,
            bridge::commands::set_website_address,
            background::background_settings,
            background::set_background_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building VaultKey");

    app.run(|app, event| match event {
        // macOS, like Electron's `window-all-closed` + `activate`: closing the window
        // keeps the app in the Dock (vault locked, or unlocked with the window hidden in
        // background mode); clicking the Dock icon shows it again, made anew if it was
        // destroyed. `code: None` is only emitted when the last window closes; Cmd+Q /
        // Quit (the tray's too) go through `RunEvent::Exit` and still quit.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => background::show_main_window(app),
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
