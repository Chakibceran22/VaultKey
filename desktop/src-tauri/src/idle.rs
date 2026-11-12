//! Auto-lock (`extension/plans/06-desktop.md` §3; decided): after `autoLockMinutes` without
//! use (5 by default, 1–60 in Settings, `background.rs`), and at once when the computer
//! sleeps or its screen locks.
//!
//! Use is: an unlock, activity in the window (the page reports it, at most every 30 s),
//! and a fill by the browser extension. While unlocked, the timer wakes at most every
//! 30 s; while locked, not at all. A new delay counts at once, from the last use.
//!
//! Time asleep counts: the monotonic clock stops while the computer sleeps, so the wall
//! clock is checked too. Where sleep isn't heard of directly, a laptop closed for an hour is
//! still locked within 30 s of waking.
//!
//! Sleep and screen lock, by platform:
//! - macOS: NSWorkspace's will-sleep and screens-did-sleep notifications, and the
//!   `com.apple.screenIsLocked` distributed notification (delivered even while VaultKey
//!   isn't the active app).
//! - Windows: not wired yet (`WTSRegisterSessionNotification` and power events need a
//!   window of their own to receive them); the idle timer covers it.
//! - Linux: not wired (logind's `PrepareForSleep` over D-Bus would be the way); the idle
//!   timer covers it.

use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::background::Background;
use crate::commands::MAIN_WINDOW;
use crate::vault::Vault;

/// Told to the window when the vault locked without being asked to in the window. The
/// payload says why: one of the `LOCKED_BY_*` below.
pub const LOCKED_EVENT: &str = "vault://locked";
pub const LOCKED_BY_IDLE: &str = "idle";
// Heard of on macOS only, for now (see the module comment).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LOCKED_BY_SLEEP: &str = "sleep";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LOCKED_BY_SCREEN_LOCK: &str = "screen-lock";
// No tray icon on Linux (`background.rs`).
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub const LOCKED_BY_TRAY: &str = "tray";

/// The longest the timer sleeps between checks while unlocked.
const CHECK_EVERY: Duration = Duration::from_secs(30);

pub struct Idle {
    /// The last use, on both clocks.
    last_use: Mutex<(Instant, SystemTime)>,
}

impl Idle {
    fn new() -> Self {
        Self { last_use: Mutex::new((Instant::now(), SystemTime::now())) }
    }

    pub fn touch(&self) {
        *self.last_use.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = (Instant::now(), SystemTime::now());
    }

    /// The longer of the two clocks' answers: the monotonic one stops during sleep, the wall
    /// clock can be set back.
    fn idle_for(&self) -> Duration {
        let (instant, wall) = *self.last_use.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        instant.elapsed().max(SystemTime::now().duration_since(wall).unwrap_or_default())
    }
}

/// How long to wait before looking again, or `None` when it's time to lock.
fn next_check(limit: Duration, idle_for: Duration) -> Option<Duration> {
    let left = limit.saturating_sub(idle_for);
    (!left.is_zero()).then(|| left.min(CHECK_EVERY))
}

/// Locks the vault now and tells the window why. Nothing happens (and nothing is said) if
/// it's locked already.
pub fn lock_now(app: &AppHandle, reason: &'static str) {
    let Some(vault) = app.try_state::<Vault>() else {
        return;
    };
    if !vault.lock_state().0 {
        return;
    }
    vault.lock();
    eprintln!("[vault] locked ({reason})");
    let _ = app.emit_to(MAIN_WINDOW, LOCKED_EVENT, reason);
}

/// Starts the timer, and listens for sleep and screen lock. Call on the main thread, after
/// the vault and the background settings are managed.
pub fn start(app: &AppHandle) {
    app.manage(Idle::new());
    #[cfg(target_os = "macos")]
    macos::watch(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut unlocked = app.state::<Vault>().watch_unlocked();
        let mut settings = app.state::<Background>().watch();
        loop {
            // Locked: nothing to time until the next unlock.
            while !*unlocked.borrow_and_update() {
                if unlocked.changed().await.is_err() {
                    return;
                }
            }
            app.state::<Idle>().touch();
            // The database may only have opened after start-up: read the delay again.
            let reload = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || crate::background::reload(&reload)).await;
            let idle = app.state::<Idle>();
            loop {
                let limit = settings.borrow_and_update().auto_lock_after();
                let Some(wait) = next_check(limit, idle.idle_for()) else {
                    lock_now(&app, LOCKED_BY_IDLE);
                    break;
                };
                tokio::select! {
                    () = tokio::time::sleep(wait) => {}
                    // A new delay: look again at once with it.
                    changed = settings.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                    changed = unlocked.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        // Locked meanwhile (by hand, sleep, the tray): wait for the next unlock.
                        if !*unlocked.borrow_and_update() {
                            break;
                        }
                    }
                }
            }
        }
    });
}

/// macOS: lock when the computer is about to sleep, its displays sleep, or the screen locks.
#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::NSObject;
    use objc2::{AnyThread, DefinedClass, define_class, msg_send, sel};
    use objc2_app_kit::{NSWorkspace, NSWorkspaceScreensDidSleepNotification, NSWorkspaceWillSleepNotification};
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSNotificationSuspensionBehavior, NSString,
    };
    use tauri::AppHandle;

    use super::{LOCKED_BY_SCREEN_LOCK, LOCKED_BY_SLEEP, lock_now};

    /// Posted by the login window when the screen locks (not public API, but stable for
    /// years and what every Mac password manager listens to).
    const SCREEN_IS_LOCKED: &str = "com.apple.screenIsLocked";

    struct Ivars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and `SleepObserver` doesn't
        // implement Drop.
        #[unsafe(super(NSObject))]
        #[ivars = Ivars]
        struct SleepObserver;

        impl SleepObserver {
            #[unsafe(method(willSleep:))]
            fn will_sleep(&self, _notification: &NSNotification) {
                lock_now(&self.ivars().app, LOCKED_BY_SLEEP);
            }

            #[unsafe(method(screensDidSleep:))]
            fn screens_did_sleep(&self, _notification: &NSNotification) {
                lock_now(&self.ivars().app, LOCKED_BY_SLEEP);
            }

            #[unsafe(method(screenLocked:))]
            fn screen_locked(&self, _notification: &NSNotification) {
                lock_now(&self.ivars().app, LOCKED_BY_SCREEN_LOCK);
            }
        }
    );

    /// Main thread only (both centers deliver there).
    pub fn watch(app: &AppHandle) {
        let observer = SleepObserver::alloc().set_ivars(Ivars { app: app.clone() });
        let observer: Retained<SleepObserver> = unsafe { msg_send![super(observer), init] };
        let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
        let screen_is_locked = NSString::from_str(SCREEN_IS_LOCKED);
        // SAFETY: each selector is a method of `observer` above taking one NSNotification;
        // the names are NSStrings, and `observer` is never released (below).
        unsafe {
            workspace.addObserver_selector_name_object(
                &observer,
                sel!(willSleep:),
                Some(NSWorkspaceWillSleepNotification),
                None,
            );
            workspace.addObserver_selector_name_object(
                &observer,
                sel!(screensDidSleep:),
                Some(NSWorkspaceScreensDidSleepNotification),
                None,
            );
            // AppKit holds distributed notifications back while the app is inactive (as it
            // is when the user is in a browser): this one must arrive at once.
            NSDistributedNotificationCenter::defaultCenter().addObserver_selector_name_object_suspensionBehavior(
                &observer,
                sel!(screenLocked:),
                Some(&*screen_is_locked),
                None,
                NSNotificationSuspensionBehavior::DeliverImmediately,
            );
        }
        // Notification centers don't keep observers alive, and this one is needed until the
        // app ends.
        std::mem::forget(observer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_asleep_counts() {
        let idle = Idle::new();
        assert!(idle.idle_for() < Duration::from_secs(1));
        // As after a sleep: the wall clock moved on, the monotonic one didn't.
        idle.last_use.lock().unwrap().1 = SystemTime::now() - Duration::from_secs(3600);
        assert!(idle.idle_for() >= Duration::from_secs(3600));
        // The wall clock set back: the monotonic clock still counts.
        let mut last = idle.last_use.lock().unwrap();
        *last = (Instant::now() - Duration::from_secs(120), SystemTime::now() + Duration::from_secs(600));
        drop(last);
        assert!(idle.idle_for() >= Duration::from_secs(120));
        idle.touch();
        assert!(idle.idle_for() < Duration::from_secs(1));
    }

    #[test]
    fn wakes_at_most_every_30_seconds_and_locks_on_time() {
        let minutes = |n: u64| Duration::from_secs(n * 60);
        // Just used: the next look is 30 s away, however long the delay.
        assert_eq!(next_check(minutes(5), Duration::ZERO), Some(CHECK_EVERY));
        assert_eq!(next_check(minutes(60), Duration::ZERO), Some(CHECK_EVERY));
        // Close to the limit: wakes exactly at it.
        assert_eq!(next_check(minutes(5), minutes(5) - Duration::from_secs(7)), Some(Duration::from_secs(7)));
        // At or past it (a long sleep included): lock now.
        assert_eq!(next_check(minutes(5), minutes(5)), None);
        assert_eq!(next_check(minutes(5), minutes(600)), None);
    }

    #[test]
    fn a_shorter_delay_counts_from_the_last_use() {
        let minutes = |n: u64| Duration::from_secs(n * 60);
        let idle_for = minutes(4);
        // Four minutes idle under a 60-minute delay: keep waiting.
        assert!(next_check(minutes(60), idle_for).is_some());
        // Changed to 3 minutes: already past it, so it locks at the next look (at once).
        assert_eq!(next_check(minutes(3), idle_for), None);
        // Changed to 5: one minute left, still looked at every 30 s.
        assert_eq!(next_check(minutes(5), idle_for), Some(CHECK_EVERY));
    }
}
