//! The browser extension's way in (`extension/plans/`).
//!
//! Off until "Browser extension" is turned on in Settings. Then VaultKey listens for the
//! extension's bridge (`vaultkey_bridge::server`), registers the bridge program with the
//! installed browsers (`vaultkey_bridge::register`), and asks the user in a dialog before
//! any browser is paired. Locking and unlocking reach the extension at once.
//!
//! Dev builds (`tauri::is_dev()`) are the dev flavor: their own socket, host name and
//! extension ID, and the dev vault. They never meet the release extension.
//!
//! M2: a paired browser can ask for the cards of the page it's on, and one login or code
//! after a click (`vaultkey_bridge::api`). The app only hands over data: the matching, the
//! handles and the rate limits are in the bridge crate. Every fill is listed in Settings
//! ("Recent fills", memory only, cleared on lock).

use std::{
    collections::VecDeque,
    io,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};
use vaultkey_bridge::{
    address::{self, Flavor},
    api::{AuthCode, Entry, Fill, FillKind, Login},
    message::{Browser, VaultState},
    noise::{ClientId, PrivateKey, PublicKey},
    register::{self, BrowserStatus, Registrar},
    server::{self, App, PairingRequest, Refusal, Status},
};

use crate::commands::MAIN_WINDOW;
use crate::error::{ErrorCode, VaultError, VaultResult, log_failure};
use crate::vault::{PairedBrowser, Vault};

pub mod commands;

/// Shown in the window when a browser asks to pair.
pub const PAIRING_EVENT: &str = "bridge://pairing";
/// The dialog is over (answered, timed out, the browser gave up, or the vault locked).
pub const PAIRING_ENDED_EVENT: &str = "bridge://pairing-ended";

/// After a pairing request ends without approval, new ones are refused for this long,
/// doubling with each one in a row (up to the maximum): a program that keeps asking can't
/// keep a dialog in front of the user.
const COOLDOWN_FIRST: Duration = Duration::from_secs(30);
const COOLDOWN_MAX: Duration = Duration::from_secs(15 * 60);
/// After an approval too, briefly: a second dialog right after the first is the moment a
/// user is most likely to approve again without looking.
const COOLDOWN_AFTER_APPROVAL: Duration = Duration::from_secs(30);

/// What the pairing dialog shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPrompt {
    pub id: u64,
    pub name: String,
    pub browser: Browser,
    /// The 6-digit code the extension's popup shows too.
    pub code: String,
}

/// How a pairing dialog ended.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingEnded {
    pub id: u64,
    /// The browser is paired, and it knows.
    pub paired: bool,
}

/// Fills kept for "Recent fills".
const MAX_RECENT: usize = 50;

/// A fill, as Settings lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFill {
    pub at: String,
    pub browser: String,
    pub account: String,
    pub site: String,
    pub what: FillKind,
}

/// The accounts for matching, valid for one lock count and one database revision.
struct CachedIndex {
    locks: u64,
    revision: u64,
    entries: Arc<[Entry]>,
}

/// A fill as recorded (names are looked up when Settings asks).
struct Recorded {
    at: String,
    fill: Fill,
}

/// Settings → Browser extension.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSettings {
    pub enabled: bool,
    /// On, and listening for the browsers (false: it couldn't start, see the log).
    pub listening: bool,
    /// This build includes the bridge program (beside VaultKey's own).
    pub available: bool,
    /// A dev build: it pairs with the dev extension only.
    pub dev: bool,
    pub browsers: Vec<BrowserStatus>,
    pub paired: Vec<PairedBrowser>,
    /// Newest first; memory only, cleared on lock.
    pub recent: Vec<RecentFill>,
}

/// The pairing dialog, from the request until its task is done (the slot stays taken
/// after the click, while the browser is saved).
struct Pending {
    prompt: PairingPrompt,
    /// The user's click, for the task that saves the browser and answers the extension.
    /// `None` once answered.
    choice: Option<oneshot::Sender<bool>>,
}

/// Pairing requests that ended without approval, one after another.
#[derive(Default)]
struct Cooldown {
    until: Option<Instant>,
    refused: u32,
}

pub struct Bridge {
    app: AppHandle,
    flavor: Flavor,
    enabled: AtomicBool,
    /// Times the extension was turned off: with the vault's locks, what ends sessions.
    disables: AtomicU64,
    status: watch::Sender<Status>,
    server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Bumped by each start and stop of the server: a task only counts while it's current.
    generation: AtomicU64,
    /// The generation that bound its address and accepts browsers (0: none).
    listening: AtomicU64,
    pending: Mutex<Option<Pending>>,
    cooldown: Mutex<Cooldown>,
    next_prompt: AtomicU64,
    /// The accounts, websites normalised (dropped on lock).
    index: Mutex<Option<CachedIndex>>,
    recent: Mutex<VecDeque<Recorded>>,
    /// When the extension last brought the window forward.
    shown: Mutex<VecDeque<Instant>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reads the setting, and starts listening if it's on. A failure is logged; the app
/// itself carries on.
pub fn start(app: &AppHandle) {
    let flavor = if tauri::is_dev() { Flavor::Dev } else { Flavor::Release };
    let vault = app.state::<Vault>();
    let enabled = vault.bridge_enabled().unwrap_or_else(|error| {
        log_failure("reading the browser extension setting", &error);
        false
    });
    let bridge = Arc::new(Bridge {
        app: app.clone(),
        flavor,
        enabled: AtomicBool::new(enabled),
        disables: AtomicU64::new(0),
        status: watch::Sender::new(Status { vault: VaultState::Disabled, pairings: 0, resets: 0 }),
        server: Mutex::new(None),
        generation: AtomicU64::new(0),
        listening: AtomicU64::new(0),
        pending: Mutex::new(None),
        cooldown: Mutex::new(Cooldown::default()),
        next_prompt: AtomicU64::new(0),
        index: Mutex::new(None),
        recent: Mutex::new(VecDeque::new()),
        shown: Mutex::new(VecDeque::new()),
    });
    bridge.refresh();
    app.manage(Arc::clone(&bridge));

    // Locking and unlocking reach every connected browser at once. Several changes in a
    // row may wake this once; `refresh` reads the lock count, so none is missed.
    let mut unlocked = vault.watch_unlocked();
    let forwarding = Arc::clone(&bridge);
    tauri::async_runtime::spawn(async move {
        while unlocked.changed().await.is_ok() {
            forwarding.refresh();
        }
    });

    if enabled {
        // An update can move the bridge program: the manifests are checked at each start.
        bridge.register();
        // Whether it binds is logged; nothing waits for it at start.
        drop(bridge.start_server());
    }
}

/// How a vault error reaches the extension: never its details.
fn refusal(error: VaultError) -> Refusal {
    match error.code {
        ErrorCode::VaultLocked => Refusal::Locked,
        ErrorCode::NotFound => Refusal::Disabled,
        _ => {
            log_failure("browser extension", &error);
            Refusal::Internal
        }
    }
}

impl Bridge {
    fn vault(&self) -> tauri::State<'_, Vault> {
        self.app.state::<Vault>()
    }

    /// Tells every connection the vault's state, if it changed or a lock happened.
    fn refresh(&self) {
        let vault = self.vault();
        let before = self.status.borrow().resets;
        // Read inside the status's own lock: two refreshes at once can't publish an older
        // reading after a newer one.
        self.status.send_if_modified(|status| {
            let (unlocked, locks) = vault.lock_state();
            let state = if !self.enabled.load(Ordering::SeqCst) {
                VaultState::Disabled
            } else if unlocked {
                VaultState::Unlocked
            } else {
                VaultState::Locked
            };
            let resets = locks.wrapping_add(self.disables.load(Ordering::SeqCst));
            let changed = status.vault != state || status.resets != resets;
            status.vault = state;
            status.resets = resets;
            changed
        });
        // Nothing from the vault outlives a lock, even one undone at once.
        let now = *self.status.borrow();
        if now.vault != VaultState::Unlocked || now.resets != before {
            *lock(&self.index) = None;
            lock(&self.recent).clear();
        }
    }

    /// The bridge program, if this build includes it.
    fn program(&self) -> Option<PathBuf> {
        std::env::current_exe().ok().as_deref().and_then(register::bridge_beside)
    }

    fn registrar(&self) -> Option<Registrar> {
        Registrar::for_user(self.flavor)
            .inspect_err(|error| eprintln!("[vault] browser extension: can't find the browsers: {error}"))
            .ok()
    }

    /// Writes the host manifests for the installed browsers (unchanged ones are left).
    fn register(&self) {
        if let (Some(program), Some(registrar)) = (self.program(), self.registrar())
            && let Err(error) = registrar.register(&program)
        {
            eprintln!("[vault] browser extension: registering the bridge failed: {error}");
        }
    }


    pub fn settings(&self) -> VaultResult<BridgeSettings> {
        let vault = self.vault();
        let enabled = vault.bridge_enabled()?;
        let program = self.program();
        let browsers = self.registrar().map(|registrar| registrar.status(program.as_deref())).unwrap_or_default();
        Ok(BridgeSettings {
            enabled,
            listening: enabled && self.is_listening(),
            available: program.is_some(),
            dev: self.flavor == Flavor::Dev,
            browsers,
            paired: vault.paired_browsers()?,
            recent: self.recent_fills()?,
        })
    }

    fn recent_fills(&self) -> VaultResult<Vec<RecentFill>> {
        let recorded: Vec<(String, Fill)> =
            lock(&self.recent).iter().rev().map(|entry| (entry.at.clone(), entry.fill.clone())).collect();
        if recorded.is_empty() {
            return Ok(Vec::new());
        }
        let vault = self.vault();
        let names = vault.paired_browser_names()?;
        let accounts = vault.extension_accounts()?;
        Ok(recorded
            .into_iter()
            .map(|(at, fill)| RecentFill {
                at,
                browser: names.get(&fill.client).cloned().unwrap_or_else(|| "A removed browser".into()),
                account: accounts
                    .iter()
                    .find(|account| account.id == fill.account)
                    .map_or_else(|| "A deleted account".into(), |account| format!("{} · {}", account.website.trim(), account.email)),
                site: fill.site,
                what: fill.what,
            })
            .collect())
    }

    /// On: registers the bridge and listens (again, if listening had failed). Off: every
    /// session ends, nothing listens, the registration is removed.
    pub fn set_enabled(self: &Arc<Self>, enabled: bool) -> VaultResult<BridgeSettings> {
        let vault = self.vault();
        if enabled {
            if self.program().is_none() {
                return Err(VaultError::not_found(if self.flavor == Flavor::Dev {
                    "Build the bridge first: cargo build -p vaultkey-bridge, in src-tauri."
                } else {
                    "This build of VaultKey doesn't include the browser bridge yet."
                }));
            }
            vault.set_bridge_enabled(true)?;
            self.enabled.store(true, Ordering::SeqCst);
            self.register();
            // Wait for the outcome (a bind retries for up to a second), so Settings says
            // whether it's really listening.
            let _ = self.start_server().recv_timeout(Duration::from_secs(3));
        } else {
            vault.set_bridge_enabled(false)?;
            self.enabled.store(false, Ordering::SeqCst);
            self.disables.fetch_add(1, Ordering::SeqCst);
            // Connected browsers hear "disabled" and are closed; then nothing listens.
            self.refresh();
            self.stop_server();
            if let Some(registrar) = self.registrar()
                && let Err(error) = registrar.unregister()
            {
                eprintln!("[vault] browser extension: removing the bridge's registration failed: {error}");
            }
        }
        self.refresh();
        self.settings()
    }

    /// Removes a pairing; that browser's live session ends at once.
    pub fn revoke(&self, id: i64) -> VaultResult<BridgeSettings> {
        self.vault().revoke_browser(id)?;
        self.status.send_modify(|status| status.pairings = status.pairings.wrapping_add(1));
        self.settings()
    }

    /// The dialog still waiting for a click, if any.
    pub fn pending_prompt(&self) -> Option<PairingPrompt> {
        lock(&self.pending)
            .as_ref()
            .filter(|pending| pending.choice.is_some())
            .map(|pending| pending.prompt.clone())
    }

    /// The user's click in the pairing dialog. The request keeps its slot until the
    /// browser is saved and told, so no other dialog can open in between.
    pub fn answer(&self, id: u64, approve: bool) -> VaultResult<()> {
        let mut pending = lock(&self.pending);
        match pending.as_mut().filter(|open| open.prompt.id == id).and_then(|open| open.choice.take()) {
            Some(choice) => {
                let _ = choice.send(approve);
                Ok(())
            }
            None => Err(VaultError::not_found("That pairing request has already ended.")),
        }
    }

    /// The dialog `id` is over: close it, and refuse new requests for a while (briefly
    /// after an approval; longer, doubling, after each refusal in a row).
    fn finish_prompt(&self, id: u64, paired: bool) {
        let mut cooldown = lock(&self.cooldown);
        let now = Instant::now();
        // Refusals long ago don't count against the next one.
        if cooldown.until.is_some_and(|until| now > until + COOLDOWN_MAX) {
            cooldown.refused = 0;
        }
        let wait = if paired {
            cooldown.refused = 0;
            COOLDOWN_AFTER_APPROVAL
        } else {
            cooldown.refused = cooldown.refused.saturating_add(1);
            COOLDOWN_FIRST.saturating_mul(1 << (cooldown.refused - 1).min(10)).min(COOLDOWN_MAX)
        };
        cooldown.until = Some(now + wait);
        drop(cooldown);
        let mut pending = lock(&self.pending);
        if pending.as_ref().is_some_and(|open| open.prompt.id == id) {
            *pending = None;
        }
        drop(pending);
        let _ = self.app.emit_to(MAIN_WINDOW, PAIRING_ENDED_EVENT, PairingEnded { id, paired });
    }

    fn show_prompt(&self, prompt: &PairingPrompt) {
        let _ = self.app.emit_to(MAIN_WINDOW, PAIRING_EVENT, prompt);
        // The user is in the browser: bring VaultKey forward so they see the dialog.
        self.bring_forward();
    }

    fn bring_forward(&self) {
        if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    /// Whether the current server task bound its address (an older one, stopped while it
    /// was binding, doesn't count).
    fn is_listening(&self) -> bool {
        let listening = self.listening.load(Ordering::SeqCst);
        listening != 0 && listening == self.generation.load(Ordering::SeqCst)
    }

    /// Starts listening, unless it already does (a server that failed to start is
    /// started again). The receiver hears whether it's listening, once it knows.
    fn start_server(self: &Arc<Self>) -> std::sync::mpsc::Receiver<bool> {
        let (outcome, heard) = std::sync::mpsc::channel();
        let mut server = lock(&self.server);
        if server.as_ref().is_some_and(|task| !task.inner().is_finished()) {
            let _ = outcome.send(self.is_listening());
            return heard;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let bridge = Arc::clone(self);
        *server = Some(tauri::async_runtime::spawn(async move {
            let address = match address::resolve(bridge.flavor) {
                Ok(address) => address,
                Err(error) => {
                    eprintln!("[vault] browser extension: no address to listen at: {error}");
                    let _ = outcome.send(false);
                    return;
                }
            };
            // A server stopped a moment ago (the setting turned off and on) may still hold
            // the address for a few milliseconds: a Unix lock, or (Windows) a pipe instance
            // a closing connection still owns, which makes creating the first one fail.
            let mut attempts = 0;
            let listener = loop {
                match server::bind(&address) {
                    Ok(listener) => break listener,
                    Err(error)
                        if attempts < 20
                            && (error.kind() == io::ErrorKind::AddrInUse
                                || (cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied)) =>
                    {
                        attempts += 1;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(error) => {
                        eprintln!("[vault] browser extension: not listening at {address}: {error}");
                        let _ = outcome.send(false);
                        return;
                    }
                }
            };
            eprintln!("[vault] browser extension: listening at {address}");
            bridge.listening.store(generation, Ordering::SeqCst);
            let _ = outcome.send(true);
            server::serve(listener, Arc::clone(&bridge) as Arc<dyn App>).await;
        }));
        heard
    }

    fn stop_server(&self) {
        if let Some(task) = lock(&self.server).take() {
            task.abort();
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.listening.store(0, Ordering::SeqCst);
    }
}

impl App for Bridge {
    fn status(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }

    fn static_key(&self) -> Result<PrivateKey, Refusal> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Refusal::Disabled);
        }
        self.vault().bridge_private_key().map_err(refusal)
    }

    fn client_key(&self, client: &ClientId) -> Result<Option<PublicKey>, Refusal> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Refusal::Disabled);
        }
        self.vault().paired_browser_key(client).map_err(refusal)
    }

    fn ask_to_pair(&self, request: PairingRequest) -> Result<oneshot::Receiver<bool>, Refusal> {
        if lock(&self.cooldown).until.is_some_and(|until| Instant::now() < until) {
            return Err(Refusal::Busy);
        }
        let mut pending = lock(&self.pending);
        if pending.is_some() {
            return Err(Refusal::Busy);
        }
        let prompt = PairingPrompt {
            id: self.next_prompt.fetch_add(1, Ordering::SeqCst) + 1,
            name: request.name.clone(),
            browser: request.browser,
            code: request.code,
        };
        let (choice, chosen) = oneshot::channel();
        let (mut answer, answered) = oneshot::channel();
        *pending = Some(Pending { prompt: prompt.clone(), choice: Some(choice) });
        drop(pending);

        let app = self.app.clone();
        let (id, public_key, name) = (prompt.id, request.public_key, request.name);
        tauri::async_runtime::spawn(async move {
            let approved = tokio::select! {
                // Checked first: once the browser has given up (no answer in time, it went
                // away, the vault locked), it was told "no", and that stands.
                biased;
                () = answer.closed() => false,
                choice = chosen => choice.unwrap_or(false),
            };
            let vault = |job: fn(&Vault, &PublicKey, &str) -> VaultResult<()>| {
                let app = app.clone();
                let name = name.clone();
                async move {
                    tauri::async_runtime::spawn_blocking(move || job(&app.state::<Vault>(), &public_key, &name))
                        .await
                        .unwrap_or_else(|error| Err(VaultError::internal("The vault operation failed.").with_detail(error)))
                }
            };
            let mut paired = false;
            if approved && !answer.is_closed() {
                match vault(|vault, key, name| vault.pair_browser(key, name)).await {
                    Ok(()) => paired = true,
                    Err(error) => log_failure("pairing a browser", &error),
                }
            }
            // The browser stopped waiting while the pairing was saved: undo it, so no row
            // is left that no browser holds the keys for.
            if answer.send(paired).is_err() && paired {
                paired = false;
                if let Err(error) = vault(|vault, key, _| vault.forget_browser(key)).await {
                    log_failure("undoing a pairing", &error);
                }
            }
            if let Some(bridge) = app.try_state::<Arc<Bridge>>() {
                bridge.finish_prompt(id, paired);
            }
        });
        self.show_prompt(&prompt);
        Ok(answered)
    }

    fn seen(&self, client: &ClientId) {
        if let Err(error) = self.vault().browser_seen(client) {
            log_failure("noting a browser's visit", &error);
        }
    }

    fn accounts(&self) -> Result<Arc<[Entry]>, Refusal> {
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Refusal::Disabled);
        }
        let vault = self.vault();
        let (unlocked, locks) = vault.lock_state();
        if !unlocked {
            return Err(Refusal::Locked);
        }
        let revision = vault.revision().map_err(refusal)?;
        let mut index = lock(&self.index);
        if let Some(cached) = index.as_ref()
            && (cached.locks, cached.revision) == (locks, revision)
        {
            return Ok(Arc::clone(&cached.entries));
        }
        // Read after the revision: a write in between makes the next call rebuild.
        let entries: Arc<[Entry]> = vault.extension_accounts().map_err(refusal)?.into_iter().map(Entry::new).collect();
        *index = Some(CachedIndex { locks, revision, entries: Arc::clone(&entries) });
        Ok(entries)
    }

    fn login(&self, account: i64) -> Result<Option<Login>, Refusal> {
        self.vault().extension_login(account).map_err(refusal)
    }

    fn code(&self, account: i64) -> Result<Option<AuthCode>, Refusal> {
        self.vault().extension_code(account).map_err(refusal)
    }

    fn open_window(&self) {
        // A few a minute: a window brought forward over and over is a nuisance.
        {
            let mut shown = lock(&self.shown);
            let now = Instant::now();
            shown.retain(|at| now.duration_since(*at) < Duration::from_secs(60));
            if shown.len() >= 6 {
                return;
            }
            shown.push_back(now);
        }
        // The window lives on the main thread; this is called from the server's. Closed on
        // macOS (the app stays in the Dock): made again, as the Dock's Reopen does.
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if app.get_webview_window(MAIN_WINDOW).is_none()
                && let Err(error) = crate::create_main_window(&app)
            {
                eprintln!("[vault] could not reopen the window: {error}");
            }
            if let Some(bridge) = app.try_state::<Arc<Bridge>>() {
                bridge.bring_forward();
            }
        });
    }

    fn filled(&self, fill: Fill) {
        // A fill is use: the idle auto-lock waits again.
        if let Some(idle) = self.app.try_state::<crate::idle::Idle>() {
            idle.touch();
        }
        let mut recent = lock(&self.recent);
        if recent.len() >= MAX_RECENT {
            recent.pop_front();
        }
        recent.push_back(Recorded { at: crate::db::now_iso(), fill });
    }
}
