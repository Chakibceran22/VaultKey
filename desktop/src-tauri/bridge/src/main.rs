//! `vaultkey-bridge`: the native-messaging host the browser starts for the VaultKey
//! extension. It relays frames between the extension (stdio) and the app (a private
//! socket or named pipe) and holds nothing itself.
//!
//! A debug build is the dev bridge: it reaches the dev app only (`address::Flavor`).

use vaultkey_bridge::{
    address::{self, Flavor},
    host,
};

fn main() {
    // The browser passes the caller's origin (Chrome) or manifest path and extension ID
    // (Firefox). Who may start us is already decided by the host manifest's allow list.
    let flavor = if cfg!(debug_assertions) { Flavor::Dev } else { Flavor::Release };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[vaultkey-bridge] could not start: {error}");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(async {
        let address = address::resolve_for_bridge(flavor)?;
        host::run(tokio::io::stdin(), tokio::io::stdout(), || host::connect(&address)).await
    });
    if let Err(error) = &result {
        // stderr ends up in the browser's log: the error only, never a frame.
        eprintln!("[vaultkey-bridge] stopped: {error}");
    }
    // stdin is read on a blocking thread; exit rather than wait for it to be joined.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}
