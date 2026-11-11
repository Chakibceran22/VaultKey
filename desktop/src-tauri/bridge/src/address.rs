//! Where the app listens and the bridge connects (`extension/plans/06-desktop.md`).
//!
//! Release and dev builds use different places and host names, so a dev build never
//! talks to the release extension or reaches the real vault.

use std::{fmt, io};

#[cfg(unix)]
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Release,
    Dev,
}

impl Flavor {
    /// The native-messaging host name the extension asks the browser for.
    pub const fn host_name(self) -> &'static str {
        match self {
            Flavor::Release => "com.chakibceran22.vaultkey",
            Flavor::Dev => "com.chakibceran22.vaultkey.dev",
        }
    }

    /// The only extension allowed to start this flavor's bridge (the host manifest's
    /// `allowed_origins`). Fixed by the public key in the build's manifest
    /// (`extension/dev-key.json`, `extension/release-key.json`).
    pub const fn extension_id(self) -> &'static str {
        match self {
            Flavor::Release => "dddbjiemkokijpjenkbhonalpmagoajd",
            Flavor::Dev => "djicgglacmoknplomflnngemodfomkkg",
        }
    }

    /// The folder under the config dir, the same one the vault uses (`paths.rs`).
    pub const fn folder(self) -> &'static str {
        match self {
            Flavor::Release => "vaultkey",
            Flavor::Dev => "vaultkey-dev",
        }
    }
}

/// A Unix socket path, or a Windows named pipe name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Address {
    #[cfg(unix)]
    Socket(PathBuf),
    #[cfg(windows)]
    Pipe(String),
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(unix)]
            Address::Socket(path) => write!(f, "{}", path.display()),
            #[cfg(windows)]
            Address::Pipe(name) => f.write_str(name),
        }
    }
}

/// Read by a debug **bridge** only ([`resolve_for_bridge`]): tests point it at a
/// throwaway address. The app never reads it, so it only ever creates, chmods or
/// replaces files in its own `bridge` folder.
pub const ADDRESS_ENV: &str = "VAULTKEY_BRIDGE_ADDRESS";

/// Where the app listens: always the flavor's fixed address.
pub fn resolve(flavor: Flavor) -> io::Result<Address> {
    default_address(flavor)
}

/// Where the bridge connects: the flavor's address, or in a debug build the one in
/// [`ADDRESS_ENV`]. The bridge only connects there; it never creates or removes anything.
pub fn resolve_for_bridge(flavor: Flavor) -> io::Result<Address> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os(ADDRESS_ENV).filter(|value| !value.is_empty()) {
        #[cfg(unix)]
        return Ok(Address::Socket(PathBuf::from(value)));
        #[cfg(windows)]
        return Ok(Address::Pipe(value.to_string_lossy().into_owned()));
    }
    resolve(flavor)
}

/// `<config dir>/<folder>/bridge/socket`. The `bridge` folder is the app's own and is
/// kept `0700`, so the socket is private from the moment it exists.
#[cfg(unix)]
fn default_address(flavor: Flavor) -> io::Result<Address> {
    Ok(Address::Socket(
        config_dir()?.join(flavor.folder()).join("bridge").join("socket"),
    ))
}

/// The same directory as Tauri's `config_dir()`, which `paths.rs` uses for the vault
/// (and where the browsers keep their user data on macOS and Linux).
#[cfg(target_os = "macos")]
pub(crate) fn config_dir() -> io::Result<PathBuf> {
    Ok(home()?.join("Library").join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn config_dir() -> io::Result<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        Some(directory) if directory.is_absolute() => Ok(directory),
        _ => Ok(home()?.join(".config")),
    }
}

#[cfg(unix)]
fn home() -> io::Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))
}

/// Named pipes are machine-wide, so the name carries the user's SID (unique per account,
/// unlike the user name). Who may open it is the pipe's own security (`windows.rs`).
#[cfg(windows)]
fn default_address(flavor: Flavor) -> io::Result<Address> {
    let sid = crate::windows::current_user_sid_string()?;
    Ok(Address::Pipe(format!(r"\\.\pipe\{}-bridge-{}", flavor.folder(), pipe_safe(&sid))))
}

/// Letters, digits, `-` and `_` as they are; any other byte as `.xx` (hex), so two
/// different names never map to the same pipe.
#[cfg(any(windows, test))]
fn pipe_safe(name: &str) -> String {
    let mut safe = String::with_capacity(name.len());
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            safe.push(char::from(byte));
        } else {
            safe.push_str(&format!(".{byte:02x}"));
        }
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The IDs the host manifests allow are the ones the builds' public keys give
    /// (extension/tests/manifest.test.ts checks the keys against the same IDs).
    #[test]
    fn each_flavor_allows_its_own_extension_only() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../extension/tests/fixtures/protocol/outer.json")).unwrap();
        let key = |file: &str| -> serde_json::Value { serde_json::from_str(file).unwrap() };
        let release = key(include_str!("../../../extension/release-key.json"));
        let dev = key(include_str!("../../../extension/dev-key.json"));
        assert_eq!(fixture["extensionIds"]["release"], Flavor::Release.extension_id());
        assert_eq!(fixture["extensionIds"]["dev"], Flavor::Dev.extension_id());
        assert_eq!(release["extensionId"], Flavor::Release.extension_id());
        assert_eq!(dev["extensionId"], Flavor::Dev.extension_id());
        assert_ne!(Flavor::Release.extension_id(), Flavor::Dev.extension_id());
    }

    #[test]
    fn dev_and_release_never_share_a_host_name() {
        // The same names the extension asks the browser for (extension/lib/host.ts).
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../extension/tests/fixtures/protocol/outer.json")).unwrap();
        assert_eq!(fixture["hostNames"]["release"], Flavor::Release.host_name());
        assert_eq!(fixture["hostNames"]["dev"], Flavor::Dev.host_name());
        assert_ne!(Flavor::Release.host_name(), Flavor::Dev.host_name());
        for flavor in [Flavor::Release, Flavor::Dev] {
            let name = flavor.host_name();
            // Chrome: lowercase letters, digits, `_` and `.`, no leading, trailing or double dot.
            assert!(name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.'));
            assert!(!name.starts_with('.') && !name.ends_with('.') && !name.contains(".."));
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_sits_in_the_flavor_folder() {
        let Address::Socket(release) = default_address(Flavor::Release).unwrap();
        let Address::Socket(dev) = default_address(Flavor::Dev).unwrap();
        assert!(release.ends_with("vaultkey/bridge/socket"));
        assert!(dev.ends_with("vaultkey-dev/bridge/socket"));
        // sun_path is 104 bytes on macOS (108 on Linux), including the final NUL.
        assert!(release.as_os_str().len() < 104 && dev.as_os_str().len() < 104);
    }

    #[test]
    fn pipe_names_keep_users_apart() {
        assert_eq!(pipe_safe("S-1-5-21-1004336348-1177238915-682003330-512"), "S-1-5-21-1004336348-1177238915-682003330-512");
        assert_eq!(pipe_safe("Chakib_01-x"), "Chakib_01-x");
        assert_eq!(pipe_safe("a.b"), "a.2eb");
        assert_ne!(pipe_safe("a.b"), pipe_safe("a_b"));
        assert_eq!(pipe_safe("Zoë"), "Zo.c3.ab");
    }
}
