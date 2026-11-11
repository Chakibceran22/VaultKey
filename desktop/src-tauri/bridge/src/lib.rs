//! The link between the VaultKey browser extension and the app (`desktop/extension/plans/`).
//!
//! ```text
//! extension ──native messaging (stdio)── vaultkey-bridge ──socket / named pipe── VaultKey
//!     └──────────────── Noise KK session, end to end (the bridge sees ciphertext) ──┘
//! ```
//!
//! - [`frame`]: length-prefixed JSON, as both hops carry it.
//! - [`message`]: the plaintext messages (none carry vault data).
//! - [`noise`]: the encrypted channel, and pairing's keys and codes.
//! - [`inner`]: what travels inside the channel; [`api`]: the methods it carries.
//! - [`matcher`]: which saved websites belong to a page (the security boundary of filling).
//! - [`address`]: where the app listens, per build flavor.
//! - [`server`]: the app's end: pairing, handshakes, sessions.
//! - [`register`]: the host manifests that let the browsers start the bridge.
//! - [`host`]: the bridge's relay (the `vaultkey-bridge` binary).

pub mod address;
pub mod api;
pub mod frame;
pub mod host;
pub mod inner;
pub mod matcher;
pub mod message;
pub mod noise;
pub mod register;
pub mod server;
#[cfg(windows)]
pub mod windows;
