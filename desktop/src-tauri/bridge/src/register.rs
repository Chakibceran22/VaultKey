//! Registering the bridge with the browsers (`plans/06-desktop.md` §4).
//!
//! A native-messaging host manifest per installed Chromium browser names the bridge
//! program and the one extension allowed to start it: this flavor's, never the other's.
//! Per-user locations only, so no admin rights are needed. VaultKey writes them when
//! "Browser extension" is turned on, checks them at every start (an update can move the
//! program), and removes them when it's turned off.
//!
//! - macOS and Linux: one JSON file in each browser's `NativeMessagingHosts` folder.
//! - Windows: one JSON file under `%APPDATA%`, and a registry key per browser
//!   (`HKCU\Software\…\NativeMessagingHosts\<host>`) whose default value is its path.
//!
//! Firefox comes later (plans/07), with its own manifest shape.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::address::Flavor;

/// The bridge program's file name, next to VaultKey's own executable.
pub const BRIDGE_PROGRAM: &str = if cfg!(windows) { "vaultkey-bridge.exe" } else { "vaultkey-bridge" };

/// The bridge program beside `executable` (VaultKey's): in the app bundle, or in
/// `target/debug` for a dev build. `None` when this build doesn't include it.
pub fn bridge_beside(executable: &Path) -> Option<PathBuf> {
    let path = executable.parent()?.join(BRIDGE_PROGRAM);
    path.is_file().then_some(path)
}

/// One browser, as Settings shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BrowserStatus {
    pub name: &'static str,
    pub installed: bool,
    /// Its manifest is in place and current.
    pub registered: bool,
}

#[derive(Serialize)]
struct Manifest<'a> {
    name: &'a str,
    description: &'a str,
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    allowed_origins: [String; 1],
}

/// The host manifest for `flavor`'s bridge at `bridge`. The same text, byte for byte,
/// as `extension/scripts/register-dev-host.mjs` writes for the dev flavor.
pub fn manifest(flavor: Flavor, bridge: &Path) -> io::Result<String> {
    let path = bridge
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the bridge's path isn't UTF-8"))?;
    let manifest = Manifest {
        name: flavor.host_name(),
        description: match flavor {
            Flavor::Release => "VaultKey browser bridge",
            Flavor::Dev => "VaultKey browser bridge (dev)",
        },
        path,
        kind: "stdio",
        allowed_origins: [format!("chrome-extension://{}/", flavor.extension_id())],
    };
    Ok(format!("{}\n", serde_json::to_string_pretty(&manifest).map_err(io::Error::other)?))
}

/// Each browser's user-data folder under the config dir (it shows the browser is
/// installed); its manifests go in `NativeMessagingHosts` inside.
#[cfg(target_os = "macos")]
const FOLDER_BROWSERS: &[(&str, &str)] = &[
    ("Brave", "BraveSoftware/Brave-Browser"),
    ("Chrome", "Google/Chrome"),
    ("Edge", "Microsoft Edge"),
    ("Chromium", "Chromium"),
    ("Vivaldi", "Vivaldi"),
    ("Arc", "Arc/User Data"),
];
#[cfg(not(target_os = "macos"))]
const FOLDER_BROWSERS: &[(&str, &str)] = &[
    ("Brave", "BraveSoftware/Brave-Browser"),
    ("Chrome", "google-chrome"),
    ("Edge", "microsoft-edge"),
    ("Chromium", "chromium"),
    ("Vivaldi", "vivaldi"),
];

/// Windows: the user-data folder under `%LOCALAPPDATA%`, and the registry key (under
/// HKCU) that lists the browser's native hosts. Brave reads Chrome's key too; it gets
/// its own anyway (plans/07, risks: checked on a real install).
const REGISTRY_BROWSERS: &[(&str, &str, &str)] = &[
    ("Brave", r"BraveSoftware\Brave-Browser\User Data", r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"),
    ("Chrome", r"Google\Chrome\User Data", r"Software\Google\Chrome\NativeMessagingHosts"),
    ("Edge", r"Microsoft\Edge\User Data", r"Software\Microsoft\Edge\NativeMessagingHosts"),
    ("Chromium", r"Chromium\User Data", r"Software\Chromium\NativeMessagingHosts"),
];

/// The registry calls, so they can be faked in tests. Keys are under HKCU; values are
/// the key's default value.
pub trait Registry: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> io::Result<()>;
    fn remove(&self, key: &str) -> io::Result<()>;
}

enum Layout {
    /// macOS and Linux: `config` is the config dir (`~/Library/Application Support`,
    /// `~/.config`).
    #[cfg_attr(windows, allow(dead_code))]
    Folders { config: PathBuf },
    /// Windows: `%LOCALAPPDATA%` (to see what's installed) and `%APPDATA%` (for the file).
    /// Built on every platform, so the tests check it on any machine.
    #[cfg_attr(not(windows), allow(dead_code))]
    Registry { local: PathBuf, roaming: PathBuf, registry: Box<dyn Registry> },
}

/// Writes, checks and removes one flavor's host manifests for this user.
pub struct Registrar {
    flavor: Flavor,
    layout: Layout,
}

/// `a\b\c` (Windows-style, as the tables are written) under `base`.
fn under(base: &Path, relative: &str) -> PathBuf {
    relative.split('\\').fold(base.to_owned(), |path, part| path.join(part))
}

/// Writes `text` to `path` unless it's already there as is.
fn write_if_changed(path: &Path, text: &str) -> io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    fs::write(path, text)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

impl Registrar {
    /// The current user's browsers.
    pub fn for_user(flavor: Flavor) -> io::Result<Self> {
        #[cfg(unix)]
        let layout = Layout::Folders { config: crate::address::config_dir()? };
        #[cfg(windows)]
        let layout = {
            let folder = |name: &str| {
                std::env::var_os(name)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{name} is not set")))
            };
            Layout::Registry {
                local: folder("LOCALAPPDATA")?,
                roaming: folder("APPDATA")?,
                registry: Box::new(windows_registry::CurrentUser),
            }
        };
        Ok(Self { flavor, layout })
    }

    /// The manifest file (Windows: the one file every browser's key points at).
    fn shared_manifest(&self, roaming: &Path) -> PathBuf {
        roaming
            .join(self.flavor.folder())
            .join("native-messaging")
            .join(format!("{}.json", self.flavor.host_name()))
    }

    fn folder_manifest(&self, config: &Path, data: &str) -> PathBuf {
        config
            .join(data)
            .join("NativeMessagingHosts")
            .join(format!("{}.json", self.flavor.host_name()))
    }

    fn host_key(&self, key: &str) -> String {
        format!(r"{key}\{}", self.flavor.host_name())
    }

    /// Each browser: installed, and registered with the bridge at `bridge` (never
    /// registered when there's no bridge to point at).
    pub fn status(&self, bridge: Option<&Path>) -> Vec<BrowserStatus> {
        let expected = bridge.and_then(|bridge| manifest(self.flavor, bridge).ok());
        let current = |path: &Path| expected.as_deref().is_some_and(|text| fs::read_to_string(path).is_ok_and(|now| now == text));
        match &self.layout {
            Layout::Folders { config } => FOLDER_BROWSERS
                .iter()
                .map(|&(name, data)| BrowserStatus {
                    name,
                    installed: config.join(data).is_dir(),
                    registered: current(&self.folder_manifest(config, data)),
                })
                .collect(),
            Layout::Registry { local, roaming, registry } => {
                let file = self.shared_manifest(roaming);
                let file_current = current(&file);
                REGISTRY_BROWSERS
                    .iter()
                    .map(|&(name, data, key)| BrowserStatus {
                        name,
                        installed: under(local, data).is_dir(),
                        registered: file_current
                            && registry.get(&self.host_key(key)).is_some_and(|value| Path::new(&value) == file),
                    })
                    .collect()
            }
        }
    }

    /// Registers the bridge at `bridge` with every installed browser; manifests already
    /// current are left alone. A browser that fails is reported unregistered.
    pub fn register(&self, bridge: &Path) -> io::Result<Vec<BrowserStatus>> {
        let text = manifest(self.flavor, bridge)?;
        match &self.layout {
            Layout::Folders { config } => {
                for &(_, data) in FOLDER_BROWSERS.iter().filter(|(_, data)| config.join(data).is_dir()) {
                    if let Err(error) = write_if_changed(&self.folder_manifest(config, data), &text) {
                        eprintln!("[bridge] could not register with {data}: {error}");
                    }
                }
            }
            Layout::Registry { local, roaming, registry } => {
                let file = self.shared_manifest(roaming);
                write_if_changed(&file, &text)?;
                let value = file.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "%APPDATA% isn't UTF-8"))?;
                for &(name, _, key) in REGISTRY_BROWSERS.iter().filter(|(_, data, _)| under(local, data).is_dir()) {
                    let key = self.host_key(key);
                    if registry.get(&key).as_deref() != Some(value)
                        && let Err(error) = registry.set(&key, value)
                    {
                        eprintln!("[bridge] could not register with {name}: {error}");
                    }
                }
            }
        }
        Ok(self.status(Some(bridge)))
    }

    /// Removes this flavor's manifests from every browser (installed or not).
    pub fn unregister(&self) -> io::Result<()> {
        let mut failed = None;
        match &self.layout {
            Layout::Folders { config } => {
                for &(_, data) in FOLDER_BROWSERS {
                    if let Err(error) = remove_if_present(&self.folder_manifest(config, data)) {
                        failed = Some(error);
                    }
                }
            }
            Layout::Registry { roaming, registry, .. } => {
                for &(_, _, key) in REGISTRY_BROWSERS {
                    let key = self.host_key(key);
                    if registry.get(&key).is_some()
                        && let Err(error) = registry.remove(&key)
                    {
                        failed = Some(error);
                    }
                }
                if let Err(error) = remove_if_present(&self.shared_manifest(roaming)) {
                    failed = Some(error);
                }
            }
        }
        failed.map_or(Ok(()), Err)
    }
}

#[cfg(windows)]
mod windows_registry {
    use std::io;

    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    pub struct CurrentUser;

    impl super::Registry for CurrentUser {
        fn get(&self, key: &str) -> Option<String> {
            RegKey::predef(HKEY_CURRENT_USER).open_subkey(key).ok()?.get_value("").ok()
        }

        fn set(&self, key: &str, value: &str) -> io::Result<()> {
            let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(key)?;
            key.set_value("", &value)
        }

        fn remove(&self, key: &str) -> io::Result<()> {
            RegKey::predef(HKEY_CURRENT_USER).delete_subkey(key)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    fn folders(config: &Path, flavor: Flavor) -> Registrar {
        Registrar { flavor, layout: Layout::Folders { config: config.to_owned() } }
    }

    fn installed(config: &Path, data: &str) {
        fs::create_dir_all(config.join(data)).unwrap();
    }

    fn bridge(dir: &Path) -> PathBuf {
        let path = dir.join("VaultKey.app").join("Contents").join("MacOS").join(BRIDGE_PROGRAM);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"#!").unwrap();
        path
    }

    #[test]
    fn the_manifest_allows_this_flavors_extension_only() {
        let text = manifest(Flavor::Release, Path::new("/Applications/VaultKey.app/Contents/MacOS/vaultkey-bridge")).unwrap();
        assert_eq!(
            text,
            r#"{
  "name": "com.chakibceran22.vaultkey",
  "description": "VaultKey browser bridge",
  "path": "/Applications/VaultKey.app/Contents/MacOS/vaultkey-bridge",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://dddbjiemkokijpjenkbhonalpmagoajd/"
  ]
}
"#
        );
        let dev = manifest(Flavor::Dev, Path::new("/x/vaultkey-bridge")).unwrap();
        assert!(dev.contains(r#""name": "com.chakibceran22.vaultkey.dev""#));
        assert!(dev.contains(Flavor::Dev.extension_id()));
        assert!(!dev.contains(Flavor::Release.extension_id()));
    }

    #[test]
    fn the_bridge_is_found_beside_vaultkey_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let program = bridge(dir.path());
        let vaultkey = program.with_file_name("vaultkey");
        assert_eq!(bridge_beside(&vaultkey), Some(program.clone()));
        fs::remove_file(&program).unwrap();
        assert_eq!(bridge_beside(&vaultkey), None);
    }

    #[test]
    fn registers_installed_browsers_and_removes_only_its_own() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("config");
        let (brave, chrome) = (FOLDER_BROWSERS[0].1, FOLDER_BROWSERS[1].1);
        installed(&config, brave);
        installed(&config, chrome);
        let program = bridge(home.path());
        let release = folders(&config, Flavor::Release);

        let statuses = release.register(&program).unwrap();
        assert_eq!(statuses.len(), FOLDER_BROWSERS.len());
        for status in &statuses {
            let expected = status.name == FOLDER_BROWSERS[0].0 || status.name == FOLDER_BROWSERS[1].0;
            assert_eq!((status.installed, status.registered), (expected, expected), "{}", status.name);
        }
        let file = release.folder_manifest(&config, brave);
        assert_eq!(fs::read_to_string(&file).unwrap(), manifest(Flavor::Release, &program).unwrap());
        // Nothing is created for a browser that isn't installed.
        assert!(!config.join(FOLDER_BROWSERS[2].1).exists());

        // The dev flavor sits beside it without touching it, and is removed alone.
        let dev = folders(&config, Flavor::Dev);
        dev.register(&program).unwrap();
        let foreign = config.join(brave).join("NativeMessagingHosts").join("com.example.other.json");
        fs::write(&foreign, "{}").unwrap();
        dev.unregister().unwrap();
        assert!(!dev.folder_manifest(&config, brave).exists());
        assert!(file.exists() && foreign.exists());

        // The app moved (an update): the next start finds the manifest stale, and fixes it.
        let moved = home.path().join("elsewhere").join(BRIDGE_PROGRAM);
        fs::create_dir_all(moved.parent().unwrap()).unwrap();
        fs::write(&moved, b"#!").unwrap();
        assert!(release.status(Some(&moved)).iter().all(|status| !status.registered));
        assert!(release.register(&moved).unwrap().iter().filter(|s| s.installed).all(|s| s.registered));

        // Turned off: gone, and reported so.
        release.unregister().unwrap();
        assert!(!file.exists());
        assert!(release.status(Some(&moved)).iter().all(|status| !status.registered));
        // Nothing to point at: never "registered".
        assert!(release.status(None).iter().all(|status| !status.registered));
        release.unregister().unwrap();
    }

    #[derive(Default)]
    struct FakeRegistry(Mutex<HashMap<String, String>>);

    impl Registry for FakeRegistry {
        fn get(&self, key: &str) -> Option<String> {
            self.0.lock().unwrap().get(key).cloned()
        }

        fn set(&self, key: &str, value: &str) -> io::Result<()> {
            self.0.lock().unwrap().insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        fn remove(&self, key: &str) -> io::Result<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    impl Registry for std::sync::Arc<FakeRegistry> {
        fn get(&self, key: &str) -> Option<String> {
            self.as_ref().get(key)
        }

        fn set(&self, key: &str, value: &str) -> io::Result<()> {
            self.as_ref().set(key, value)
        }

        fn remove(&self, key: &str) -> io::Result<()> {
            self.as_ref().remove(key)
        }
    }

    #[test]
    fn windows_registers_one_file_and_a_key_per_installed_browser() {
        let home = tempfile::tempdir().unwrap();
        let (local, roaming) = (home.path().join("Local"), home.path().join("Roaming"));
        fs::create_dir_all(under(&local, REGISTRY_BROWSERS[0].1)).unwrap();
        let registry = std::sync::Arc::new(FakeRegistry::default());
        let registrar = Registrar {
            flavor: Flavor::Release,
            layout: Layout::Registry { local, roaming: roaming.clone(), registry: Box::new(std::sync::Arc::clone(&registry)) },
        };
        let program = bridge(home.path());

        let statuses = registrar.register(&program).unwrap();
        assert_eq!(statuses.iter().filter(|s| s.registered).map(|s| s.name).collect::<Vec<_>>(), ["Brave"]);
        let file = roaming.join("vaultkey").join("native-messaging").join("com.chakibceran22.vaultkey.json");
        assert_eq!(fs::read_to_string(&file).unwrap(), manifest(Flavor::Release, &program).unwrap());
        assert_eq!(
            *registry.0.lock().unwrap(),
            HashMap::from([(
                r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.chakibceran22.vaultkey".to_owned(),
                file.to_str().unwrap().to_owned()
            )])
        );

        registrar.unregister().unwrap();
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(!file.exists());
        assert!(registrar.status(Some(&program)).iter().all(|status| !status.registered));
    }
}
