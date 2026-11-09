//! Where the vault lives.
//!
//! The Electron app stored it at `app.getPath('userData')/vaultkey.sqlite3`. Electron
//! names `userData` after `package.json` `name`, which is lowercase `vaultkey` (there is
//! no top-level `productName`; electron-builder's `build.productName` does not affect
//! it). So the vault is `<appData>/vaultkey/vaultkey.sqlite3`. Electron's `appData` is
//! the same directory as Tauri's `config_dir()` on every platform:
//!
//! - macOS:   `~/Library/Application Support`
//! - Windows: `%APPDATA%` (Roaming)
//! - Linux:   `$XDG_CONFIG_HOME` or `~/.config`
//!
//! We deliberately do NOT use Tauri's `app_data_dir()` (keyed on the bundle identifier).
//! That would open a brand-new empty vault instead of the existing one.

use std::path::{Path, PathBuf};

pub const DATABASE_FILE: &str = "vaultkey.sqlite3";
/// Dev-only override, as in the Electron app. Ignored in packaged builds.
pub const DATA_DIR_ENV: &str = "VAULTKEY_DATA_DIR";
/// Dev builds use their own vault by default, so in-progress code (new migrations in
/// particular) can never alter the real one.
const DEV_DIR_NAME: &str = "vaultkey-dev";

/// The real Electron folder first. `VaultKey` is only a fallback for an unusual
/// install; on case-insensitive filesystems (default macOS/Windows) both are one folder.
const ELECTRON_DIR_NAMES: [&str; 2] = ["vaultkey", "VaultKey"];

pub fn resolve_database_path(config_dir: &Path) -> PathBuf {
    // `is_dev()` = not a packaged build, the equivalent of Electron's `!app.isPackaged`.
    if tauri::is_dev() {
        if let Some(directory) = std::env::var_os(DATA_DIR_ENV).filter(|value| !value.is_empty()) {
            let directory = PathBuf::from(directory);
            let directory = std::path::absolute(&directory).unwrap_or(directory);
            return directory.join(DATABASE_FILE);
        }
        return config_dir.join(DEV_DIR_NAME).join(DATABASE_FILE);
    }
    electron_database_path(config_dir)
}

fn electron_database_path(config_dir: &Path) -> PathBuf {
    ELECTRON_DIR_NAMES
        .iter()
        .map(|name| config_dir.join(name).join(DATABASE_FILE))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| config_dir.join(ELECTRON_DIR_NAMES[0]).join(DATABASE_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_the_electron_folder_name() {
        let base = tempfile::tempdir().unwrap();
        assert_eq!(
            electron_database_path(base.path()),
            base.path().join("vaultkey").join(DATABASE_FILE)
        );
    }

    #[test]
    fn prefers_the_real_electron_vault_over_a_stray_capitalised_one() {
        let base = tempfile::tempdir().unwrap();
        let real = base.path().join("vaultkey");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join(DATABASE_FILE), b"").unwrap();
        let stray = base.path().join("VaultKey");
        let _ = std::fs::create_dir_all(&stray);
        let _ = std::fs::write(stray.join(DATABASE_FILE), b"");
        // Case-sensitive FS: two files, the lowercase one wins. Case-insensitive: one file.
        assert_eq!(
            electron_database_path(base.path()),
            real.join(DATABASE_FILE)
        );
    }

    #[test]
    fn finds_a_capitalised_vault_when_it_is_the_only_one() {
        let base = tempfile::tempdir().unwrap();
        let only = base.path().join("VaultKey");
        std::fs::create_dir_all(&only).unwrap();
        std::fs::write(only.join(DATABASE_FILE), b"").unwrap();
        assert!(electron_database_path(base.path()).is_file());
    }

    #[test]
    fn dev_builds_never_default_to_the_real_vault() {
        // cargo test is a dev (non-packaged) build.
        if std::env::var_os(DATA_DIR_ENV).is_none() {
            let base = tempfile::tempdir().unwrap();
            assert_eq!(
                resolve_database_path(base.path()),
                base.path().join(DEV_DIR_NAME).join(DATABASE_FILE)
            );
        }
    }
}
