//! Auto-lock after 5 minutes without use (`extension/plans/06-desktop.md` §3; decided).
//!
//! Use is: an unlock, activity in the window (the page reports it, at most every 30 s),
//! and a fill by the browser extension. While unlocked, the timer wakes at most every
//! 30 s; while locked, not at all.
//!
//! Time asleep counts: the monotonic clock stops while the computer sleeps, so the wall
//! clock is checked too. A laptop closed for an hour is locked within 30 s of waking (until
//! M5 locks it on sleep itself).

use std::{
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::MAIN_WINDOW;
use crate::vault::Vault;

/// How long the vault stays unlocked without use.
pub const IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);

/// Told to the window when the vault locked by itself.
pub const LOCKED_EVENT: &str = "vault://locked";

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

/// Starts the timer (call after the vault is managed).
pub fn start(app: &AppHandle) {
    app.manage(Idle::new());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut unlocked = app.state::<Vault>().watch_unlocked();
        loop {
            // Locked: nothing to time until the next unlock.
            while !*unlocked.borrow_and_update() {
                if unlocked.changed().await.is_err() {
                    return;
                }
            }
            let idle = app.state::<Idle>();
            idle.touch();
            loop {
                let left = IDLE_LIMIT.saturating_sub(idle.idle_for());
                if left.is_zero() {
                    app.state::<Vault>().lock();
                    eprintln!("[vault] locked after {} minutes without use", IDLE_LIMIT.as_secs() / 60);
                    let _ = app.emit_to(MAIN_WINDOW, LOCKED_EVENT, "idle");
                    break;
                }
                tokio::select! {
                    () = tokio::time::sleep(left.min(CHECK_EVERY)) => {}
                    changed = unlocked.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        // Locked meanwhile (by hand): wait for the next unlock.
                        if !*unlocked.borrow_and_update() {
                            break;
                        }
                    }
                }
            }
        }
    });
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
}
