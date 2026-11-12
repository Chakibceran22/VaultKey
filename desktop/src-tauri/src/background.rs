//! Background mode (`extension/plans/06-desktop.md` §3, `08-m4-m6-build.md` "M5 details").
//!
//! With "Keep VaultKey running in the background" on (the default), closing the window
//! hides it instead of destroying it: the vault stays unlocked until it locks itself
//! (`idle.rs`), so the browser extension keeps working. A tray / menu-bar icon offers
//! Open VaultKey, Lock and Quit. Off: closing destroys the window and locks, as before.
//!
//! The settings live in `app_settings` (schema v9): nothing secret, read before unlock.
//! They're held here in memory too, so closing the window never waits on the database and
//! the idle timer hears a new delay at once.
//!
//! Linux has no tray icon for now: Tauri's needs libayatana-appindicator at run time and
//! aborts the app without it, and a hidden window with no icon to bring it back would leave
//! the vault open and out of reach. So on Linux, closing the window always locks.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};
use tokio::sync::watch;

use crate::commands::MAIN_WINDOW;
use crate::db::now_iso;
use crate::error::{VaultError, VaultResult, log_failure};
use crate::vault::Vault;

/// Stored as "1" or "0".
const KEEP_RUNNING: &str = "keep_running";
/// Stored as a whole number of minutes.
const AUTO_LOCK_MINUTES: &str = "auto_lock_minutes";

pub const DEFAULT_KEEP_RUNNING: bool = true;
pub const DEFAULT_AUTO_LOCK_MINUTES: u32 = 5;
/// The auto-lock delays Settings may choose, in minutes.
pub const AUTO_LOCK_RANGE: std::ops::RangeInclusive<u32> = 1..=60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSettings {
    /// Closing the window hides it (the vault stays unlocked until auto-lock).
    pub keep_running: bool,
    /// Minutes without use before the vault locks itself.
    pub auto_lock_minutes: u32,
}

impl Default for BackgroundSettings {
    fn default() -> Self {
        Self { keep_running: DEFAULT_KEEP_RUNNING, auto_lock_minutes: DEFAULT_AUTO_LOCK_MINUTES }
    }
}

impl BackgroundSettings {
    /// Settings as the window sent them, checked.
    pub fn new(keep_running: bool, auto_lock_minutes: i64) -> VaultResult<Self> {
        let auto_lock_minutes = u32::try_from(auto_lock_minutes)
            .ok()
            .filter(|minutes| AUTO_LOCK_RANGE.contains(minutes))
            .ok_or_else(|| {
                VaultError::invalid_input(format!(
                    "Auto-lock must be between {} and {} minutes.",
                    AUTO_LOCK_RANGE.start(),
                    AUTO_LOCK_RANGE.end()
                ))
            })?;
        Ok(Self { keep_running, auto_lock_minutes })
    }

    /// Settings as stored. A key that's missing (nothing changed yet) or unreadable (a
    /// newer app's format) means its default, never a failure: the app must start.
    fn from_stored(stored: &BTreeMap<String, String>) -> Self {
        let defaults = Self::default();
        let keep_running = match stored.get(KEEP_RUNNING).map(String::as_str) {
            Some("1") => true,
            Some("0") => false,
            _ => defaults.keep_running,
        };
        let auto_lock_minutes = stored
            .get(AUTO_LOCK_MINUTES)
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|minutes| AUTO_LOCK_RANGE.contains(minutes))
            .unwrap_or(defaults.auto_lock_minutes);
        Self { keep_running, auto_lock_minutes }
    }

    fn to_stored(self) -> [(&'static str, String); 2] {
        [
            (KEEP_RUNNING, if self.keep_running { "1" } else { "0" }.to_owned()),
            (AUTO_LOCK_MINUTES, self.auto_lock_minutes.to_string()),
        ]
    }

    /// How long the vault stays unlocked without use.
    pub fn auto_lock_after(self) -> Duration {
        Duration::from_secs(u64::from(self.auto_lock_minutes) * 60)
    }
}

// ── storage (`vault.rs` "app settings" calls these) ─────────────────────────

/// Every stored setting.
pub(crate) fn read_settings(conn: &Connection) -> VaultResult<BTreeMap<String, String>> {
    let settings: BTreeMap<String, String> = conn
        .prepare("SELECT key, value FROM app_settings")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(settings)
}

pub(crate) fn write_settings(conn: &Connection, values: &[(&str, String)]) -> VaultResult<()> {
    let now = now_iso();
    for (key, value) in values {
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )?;
    }
    Ok(())
}

// ── in memory ───────────────────────────────────────────────────────────────

pub struct Background {
    settings: watch::Sender<BackgroundSettings>,
    /// Whether the tray icon is up: without it a hidden window couldn't be brought back.
    tray: AtomicBool,
}

impl Background {
    fn new(settings: BackgroundSettings) -> Self {
        Self { settings: watch::Sender::new(settings), tray: AtomicBool::new(false) }
    }

    /// The settings now, and at each change (the idle timer).
    pub fn watch(&self) -> watch::Receiver<BackgroundSettings> {
        self.settings.subscribe()
    }

    /// Whether closing the window should hide it.
    fn keeps_running(&self) -> bool {
        self.tray.load(Ordering::SeqCst) && self.settings.borrow().keep_running
    }

    /// Only an actual change wakes the idle timer.
    fn apply(&self, new: BackgroundSettings) {
        self.settings.send_if_modified(|current| {
            let changed = *current != new;
            *current = new;
            changed
        });
    }
}

/// The settings as stored (defaults if they can't be read).
fn load(vault: &Vault) -> BackgroundSettings {
    match vault.app_settings() {
        Ok(stored) => BackgroundSettings::from_stored(&stored),
        Err(error) => {
            log_failure("background settings load", &error);
            BackgroundSettings::default()
        }
    }
}

/// Reads the settings again from the vault: at each unlock, in case the database only
/// opened after start-up (Retry on the error screen).
pub fn reload(app: &AppHandle) {
    if let (Some(vault), Some(background)) = (app.try_state::<Vault>(), app.try_state::<Background>()) {
        background.apply(load(&vault));
    }
}

/// Whether closing the main window should hide it rather than destroy it.
pub fn keeps_running(app: &AppHandle) -> bool {
    app.try_state::<Background>().is_some_and(|background| background.keeps_running())
}

/// Loads the settings and puts up the tray icon. Call after the vault is managed, before
/// the idle timer starts.
pub fn start(app: &AppHandle) {
    app.manage(Background::new(load(&app.state::<Vault>())));
    match tray::build(app) {
        Ok(up) => app.state::<Background>().tray.store(up, Ordering::SeqCst),
        // Then closing the window locks, as without background mode.
        Err(error) => eprintln!("[vault] could not show the tray icon: {error}"),
    }
}

/// Shows the main window, made again if it was destroyed (background mode off, or on
/// macOS where the app outlives its window). Main thread only.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub fn show_main_window(app: &AppHandle) {
    if app.get_webview_window(MAIN_WINDOW).is_none()
        && let Err(error) = crate::create_main_window(app)
    {
        eprintln!("[vault] could not reopen the window: {error}");
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "macos", windows))]
mod tray {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    use tauri::AppHandle;

    const OPEN: &str = "tray-open";
    const LOCK: &str = "tray-lock";
    const QUIT: &str = "tray-quit";

    /// Whether the icon is up.
    pub fn build(app: &AppHandle) -> tauri::Result<bool> {
        let Some(icon) = app.default_window_icon().cloned() else {
            return Ok(false);
        };
        let open = MenuItem::with_id(app, OPEN, "Open VaultKey", true, None::<&str>)?;
        let lock = MenuItem::with_id(app, LOCK, "Lock", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, QUIT, "Quit VaultKey", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&open, &lock, &separator, &quit])?;
        TrayIconBuilder::with_id("vaultkey")
            .icon(icon)
            .tooltip("VaultKey")
            .menu(&menu)
            .show_menu_on_left_click(true)
            // Called for every menu event (the app menu's too): only ours are handled.
            .on_menu_event(|app, event| {
                let id = event.id();
                if id == OPEN {
                    super::show_main_window(app);
                } else if id == LOCK {
                    crate::idle::lock_now(app, crate::idle::LOCKED_BY_TRAY);
                } else if id == QUIT {
                    // The usual exit: `RunEvent::Exit` locks and closes the vault.
                    app.exit(0);
                }
            })
            .build(app)?;
        Ok(true)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod tray {
    /// No tray icon here (see the module comment).
    pub fn build(_app: &tauri::AppHandle) -> tauri::Result<bool> {
        Ok(false)
    }
}

// ── commands (main window only, like `commands.rs`) ─────────────────────────

async fn run<T, F>(operation: &'static str, app: AppHandle, webview: Webview, job: F) -> VaultResult<T>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> VaultResult<T> + Send + 'static,
{
    let outcome = if webview.label() != MAIN_WINDOW {
        Err(VaultError::locked("This window is not authorized."))
    } else {
        tauri::async_runtime::spawn_blocking(move || job(&app))
            .await
            .unwrap_or_else(|error| Err(VaultError::internal("The vault operation failed.").with_detail(error)))
    };
    if let Err(error) = &outcome {
        log_failure(operation, error);
    }
    outcome
}

/// `{ keepRunning, autoLockMinutes }`, as stored. Works while locked.
#[tauri::command]
pub async fn background_settings(app: AppHandle, webview: Webview) -> VaultResult<BackgroundSettings> {
    run("background settings", app, webview, |app| {
        let settings = BackgroundSettings::from_stored(&app.state::<Vault>().app_settings()?);
        app.state::<Background>().apply(settings);
        Ok(settings)
    })
    .await
}

/// Saves both settings (unlocked only) and applies them at once: a shorter auto-lock
/// counts from the last use, not from now. Returns them as saved.
#[tauri::command]
pub async fn set_background_settings(
    app: AppHandle,
    webview: Webview,
    keep_running: bool,
    auto_lock_minutes: i64,
) -> VaultResult<BackgroundSettings> {
    run("background settings change", app, webview, move |app| {
        let settings = BackgroundSettings::new(keep_running, auto_lock_minutes)?;
        app.state::<Vault>().set_app_settings(&settings.to_stored())?;
        app.state::<Background>().apply(settings);
        Ok(settings)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const MASTER: &str = "correct horse battery staple";

    fn unlocked_vault() -> (tempfile::TempDir, std::path::PathBuf, Vault) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vaultkey.sqlite3");
        let vault = Vault::open(path.clone());
        vault.status().unwrap();
        vault.create_vault(MASTER).unwrap();
        assert!(vault.unlock(MASTER).unwrap().valid);
        (directory, path, vault)
    }

    fn stored(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[test]
    fn defaults_until_something_is_saved() {
        let defaults = BackgroundSettings::default();
        assert_eq!((defaults.keep_running, defaults.auto_lock_minutes), (true, 5));
        assert_eq!(defaults.auto_lock_after(), Duration::from_secs(300));
        assert_eq!(BackgroundSettings::from_stored(&BTreeMap::new()), defaults);
        assert_eq!(
            serde_json::to_value(defaults).unwrap(),
            serde_json::json!({ "keepRunning": true, "autoLockMinutes": 5 })
        );
    }

    #[test]
    fn unreadable_stored_values_fall_back_to_their_defaults() {
        let defaults = BackgroundSettings::default();
        for (keep, minutes) in [("yes", "0"), ("", "61"), ("2", "-1"), ("true", "five"), ("1 ", "1.5")] {
            assert_eq!(
                BackgroundSettings::from_stored(&stored(&[(KEEP_RUNNING, keep), (AUTO_LOCK_MINUTES, minutes)])),
                defaults,
                "{keep:?} {minutes:?}"
            );
        }
        let read = BackgroundSettings::from_stored(&stored(&[(KEEP_RUNNING, "0"), (AUTO_LOCK_MINUTES, "60"), ("later", "x")]));
        assert_eq!(read, BackgroundSettings { keep_running: false, auto_lock_minutes: 60 });
    }

    #[test]
    fn auto_lock_must_be_between_one_and_sixty_minutes() {
        for minutes in [1, 5, 59, 60] {
            let settings = BackgroundSettings::new(false, minutes).unwrap();
            assert_eq!(settings.auto_lock_minutes, minutes as u32);
            assert_eq!(settings.auto_lock_after(), Duration::from_secs(minutes as u64 * 60));
        }
        for minutes in [0, -1, 61, 1440, i64::from(u32::MAX) + 1, i64::MIN] {
            let error = BackgroundSettings::new(true, minutes).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{minutes}");
        }
    }

    #[test]
    fn settings_round_trip_and_stay_readable_while_locked() {
        let (_directory, path, vault) = unlocked_vault();
        assert_eq!(load(&vault), BackgroundSettings::default());

        let chosen = BackgroundSettings::new(false, 17).unwrap();
        vault.set_app_settings(&chosen.to_stored()).unwrap();
        assert_eq!(load(&vault), chosen);
        // Saved again: one row per key, the latest value.
        let changed = BackgroundSettings::new(true, 60).unwrap();
        vault.set_app_settings(&changed.to_stored()).unwrap();
        assert_eq!(load(&vault), changed);

        // Locked: still readable, no longer writable.
        vault.lock();
        assert_eq!(load(&vault), changed);
        let refused = vault.set_app_settings(&chosen.to_stored()).unwrap_err();
        assert_eq!(refused.code, ErrorCode::VaultLocked);
        assert_eq!(load(&vault), changed);

        // Kept across a restart, in plain text (nothing sealed).
        vault.close();
        // Its hold on the file (one app per vault) goes with it.
        drop(vault);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(
            read_settings(&conn).unwrap(),
            stored(&[(AUTO_LOCK_MINUTES, "60"), (KEEP_RUNNING, "1")])
        );
        drop(conn);
        let reopened = Vault::open(path);
        assert_eq!(load(&reopened), changed);
    }

    #[test]
    fn only_a_real_change_wakes_the_idle_timer() {
        let background = Background::new(BackgroundSettings::default());
        let mut watch = background.watch();
        watch.borrow_and_update();
        background.apply(BackgroundSettings::default());
        assert!(!watch.has_changed().unwrap());
        background.apply(BackgroundSettings { auto_lock_minutes: 1, ..BackgroundSettings::default() });
        assert!(watch.has_changed().unwrap());
        assert_eq!(watch.borrow_and_update().auto_lock_minutes, 1);
    }

    #[test]
    fn closing_hides_only_with_the_tray_up() {
        let background = Background::new(BackgroundSettings::default());
        assert!(!background.keeps_running(), "no tray icon: closing must lock");
        background.tray.store(true, Ordering::SeqCst);
        assert!(background.keeps_running());
        background.apply(BackgroundSettings { keep_running: false, ..BackgroundSettings::default() });
        assert!(!background.keeps_running());
    }
}
