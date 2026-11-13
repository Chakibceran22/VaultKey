//! Saving decrypted copies of many files at once (the Files list's "Download"), into a
//! new folder. This is the file-system half: names made safe for every system, and a
//! folder that appears whole or not at all. The vault decrypts (`Vault::export_files`);
//! where the folder goes comes from the native picker, in Rust, so the page names files
//! by id and never supplies a path.
//!
//! What a save promises:
//! - All or nothing. The copies are written into a hidden folder beside where they go,
//!   which takes its real name only once every file is in it. A failure, a cancel or the
//!   vault locking removes it with everything written so far.
//! - Nothing is overwritten. The result is always a new folder ("Acme files 2026-11-13",
//!   or "… (2)" when that exists), and two files of the same name in it are kept as
//!   "name.ext" and "name (2).ext".
//! - Readable by the user only: folders 0700 and files 0600 on macOS and Linux (on
//!   Windows, the access the chosen folder passes on, as for any file the user saves).
//! - Names from the vault are made safe before they reach the disk: no separators or
//!   characters Windows refuses, no reserved device names, no trailing dots or spaces,
//!   at most 255 bytes.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::random_bytes;
use crate::error::{VaultError, VaultResult};

/// How the copies are arranged in the new folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Layout {
    /// All in the folder itself.
    Flat,
    /// A folder per service; the whole project's files in the folder itself.
    ByService,
}

/// How far a save has come, sent to the page as it goes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveStatus {
    Saved,
    /// The folder picker was closed: nothing was written.
    Dismissed,
    /// Stopped part way: what was written is gone.
    Cancelled,
}

/// What a save did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFiles {
    pub status: SaveStatus,
    pub count: usize,
    pub bytes: u64,
    /// The new folder, to show (empty unless saved).
    pub folder: String,
    /// The same, for "Show in Finder"; kept in Rust.
    #[serde(skip)]
    pub path: Option<PathBuf>,
}

impl SavedFiles {
    pub fn nothing(status: SaveStatus) -> Self {
        Self {
            status,
            count: 0,
            bytes: 0,
            folder: String::new(),
            path: None,
        }
    }
}

/// The longest name most file systems take (APFS, ext4: bytes; NTFS: UTF-16 units, more).
const MAX_NAME_BYTES: usize = 255;
/// A dot and at most this much after it counts as an extension, kept when a name is cut.
const MAX_EXTENSION_BYTES: usize = 16;
/// Names Windows keeps for devices, whatever their extension ("NUL.txt" too).
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
/// "name (2)" up to this; past it, someone is making folders as fast as we name them.
const MAX_SUFFIX: usize = 1000;

/// `name`, safe to create on macOS, Windows and Linux; `fallback` when nothing is left.
pub fn safe_name(name: &str, fallback: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Windows drops trailing dots and spaces; "." and ".." are not names.
    let trimmed = replaced.trim_start().trim_end_matches(['.', ' ']);
    let mut safe = if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    };
    let device = safe.split('.').next().unwrap_or_default().trim_end();
    if RESERVED.iter().any(|reserved| reserved.eq_ignore_ascii_case(device)) {
        safe.insert(0, '_');
    }
    fit(&safe, "")
}

/// ("notes", ".txt") for "notes.txt"; a leading dot (".env") is part of the name.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot - 1 <= MAX_EXTENSION_BYTES && !name[dot..].contains(' ') => {
            name.split_at(dot)
        }
        _ => (name, ""),
    }
}

/// `name` with `suffix` before its extension, in at most `MAX_NAME_BYTES`: the part
/// before the extension is shortened (on a character boundary), never the extension.
fn fit(name: &str, suffix: &str) -> String {
    let (stem, extension) = split_extension(name);
    let budget = MAX_NAME_BYTES.saturating_sub(suffix.len() + extension.len());
    let mut end = stem.len().min(budget);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}{extension}", &stem[..end])
}

/// The first of "name", "name (2)", "name (3)"… not yet taken in a folder. Compared
/// without case: APFS and NTFS, as usually set up, don't tell "Key.pem" from "key.pem".
fn claim(taken: &mut HashSet<String>, name: &str) -> String {
    let mut candidate = fit(name, "");
    let mut n = 1;
    while !taken.insert(candidate.to_lowercase()) {
        n += 1;
        candidate = fit(name, &format!(" ({n})"));
    }
    candidate
}

fn make_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // Not recursive: fails if anything is already there.
    builder.create(path)
}

fn write_new_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

fn write_failure(name: &str, error: io::Error) -> VaultError {
    let message = match error.kind() {
        io::ErrorKind::StorageFull => "The disk is full. Nothing was saved.".to_owned(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => {
            "That folder can’t be written to. Choose another one.".to_owned()
        }
        _ => format!("Couldn’t write “{name}”. Nothing was saved."),
    };
    VaultError::internal(message).with_detail(error)
}

/// The new folder while it fills: hidden until [`NewFolder::finish`], and removed with
/// what is in it if dropped before.
pub struct NewFolder {
    parent: PathBuf,
    /// The name it takes when finished (or the first free "name (n)").
    name: String,
    staging: PathBuf,
    /// Names taken in each folder ("" for the new folder itself), lowercased.
    taken: HashMap<String, HashSet<String>>,
    /// Subfolders made so far: the group they hold, and the name they got.
    groups: HashMap<String, String>,
    finished: bool,
}

impl NewFolder {
    /// Starts a folder that will be called `name`, inside `parent`.
    pub fn create(parent: &Path, name: &str) -> VaultResult<Self> {
        let tag: String = random_bytes::<6>().iter().map(|b| format!("{b:02x}")).collect();
        let staging = parent.join(format!(".vaultkey-saving-{tag}"));
        make_private_dir(&staging).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => VaultError::not_found("That folder no longer exists. Choose another one."),
            _ => write_failure(name, error),
        })?;
        Ok(Self {
            parent: parent.to_owned(),
            name: safe_name(name, "VaultKey files"),
            staging,
            taken: HashMap::new(),
            groups: HashMap::new(),
            finished: false,
        })
    }

    /// Writes one file, readable by the user only: into the folder itself, or into the
    /// subfolder for `group` (made the first time). Returns where it went, relative to
    /// the new folder ("Coolify/id_ed25519").
    pub fn write(&mut self, group: Option<&str>, name: &str, bytes: &[u8]) -> VaultResult<String> {
        let directory = match group {
            Some(group) => self.subfolder(group)?,
            None => String::new(),
        };
        let name = claim(self.taken.entry(directory.clone()).or_default(), &safe_name(name, "file"));
        let (target, relative) = if directory.is_empty() {
            (self.staging.join(&name), name.clone())
        } else {
            (self.staging.join(&directory).join(&name), format!("{directory}/{name}"))
        };
        write_new_private(&target, bytes).map_err(|error| write_failure(&name, error))?;
        Ok(relative)
    }

    fn subfolder(&mut self, group: &str) -> VaultResult<String> {
        if let Some(made) = self.groups.get(group) {
            return Ok(made.clone());
        }
        // Shares the folder's names with its files: a file "Coolify" and a service
        // "Coolify" become "Coolify" and "Coolify (2)".
        let made = claim(self.taken.entry(String::new()).or_default(), &safe_name(group, "Service"));
        make_private_dir(&self.staging.join(&made)).map_err(|error| write_failure(&made, error))?;
        self.groups.insert(group.to_owned(), made.clone());
        Ok(made)
    }

    /// Gives the folder its name beside the others in its parent (`name`, or the first
    /// free "name (n)"). Replaces nothing: a name taken meanwhile moves on to the next.
    pub fn finish(mut self) -> VaultResult<PathBuf> {
        for n in 1..=MAX_SUFFIX {
            let candidate = if n == 1 { fit(&self.name, "") } else { fit(&self.name, &format!(" ({n})")) };
            let target = self.parent.join(candidate);
            if fs::symlink_metadata(&target).is_ok() {
                continue;
            }
            match fs::rename(&self.staging, &target) {
                Ok(()) => {
                    self.finished = true;
                    return Ok(target);
                }
                // Made there between the look and the move: try the next name.
                Err(_) if fs::symlink_metadata(&target).is_ok() => continue,
                Err(error) => return Err(write_failure(&self.name, error)),
            }
        }
        Err(VaultError::internal("Couldn’t name the new folder. Nothing was saved."))
    }
}

impl Drop for NewFolder {
    fn drop(&mut self) {
        if !self.finished
            && let Err(error) = fs::remove_dir_all(&self.staging)
            && error.kind() != io::ErrorKind::NotFound
        {
            // The path stays out of the log, like everything about what is in the vault.
            eprintln!("[vault] could not remove an unfinished save: {}", error.kind());
        }
    }
}

/// Shows `path` in the system's file manager: selected in Finder or Explorer, opened
/// on Linux. The path is the one the last save made, kept in Rust.
pub fn reveal(path: &Path) -> VaultResult<()> {
    use std::process::{Command, Stdio};

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        // Explorer reads `/select,"C:\a b"` itself; the usual quoting of the whole
        // argument would make it open Documents instead.
        let mut command = Command::new("explorer");
        command.raw_arg(format!("/select,\"{}\"", path.display()));
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| VaultError::internal("Couldn’t open the folder.").with_detail(error))?;
    // Reaped in the background, so it never lingers as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names_in(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn names_are_made_safe_for_every_system() {
        assert_eq!(safe_name("id_ed25519", "file"), "id_ed25519");
        assert_eq!(safe_name(".env", "file"), ".env", "a dotfile keeps its dot");
        assert_eq!(safe_name("../../etc/passwd", "file"), ".._.._etc_passwd", "no separator survives");
        assert_eq!(safe_name("a\\b:c*d?e\"f<g>h|i", "file"), "a_b_c_d_e_f_g_h_i");
        assert_eq!(safe_name("tab\there\nnew", "file"), "tab_here_new");
        assert_eq!(safe_name("trailing. . ", "file"), "trailing");
        assert_eq!(safe_name("  leading", "file"), "leading");
        for nothing in ["", ".", "..", " . ", "   "] {
            assert_eq!(safe_name(nothing, "file"), "file", "{nothing:?}");
        }
        assert_eq!(safe_name("CON", "file"), "_CON");
        assert_eq!(safe_name("nul.txt", "file"), "_nul.txt");
        assert_eq!(safe_name("com1.tar.gz", "file"), "_com1.tar.gz");
        assert_eq!(safe_name("CONSOLE.log", "file"), "CONSOLE.log", "only the exact device names");
        assert_eq!(safe_name("clé privée.pem", "file"), "clé privée.pem");
    }

    #[test]
    fn long_names_are_cut_before_their_extension_on_a_character_boundary() {
        let long = format!("{}.pem", "é".repeat(200)); // 400 bytes before the extension
        let safe = safe_name(&long, "file");
        assert!(safe.len() <= MAX_NAME_BYTES, "{}", safe.len());
        assert!(safe.ends_with(".pem"));
        assert!(safe.trim_end_matches(".pem").chars().all(|c| c == 'é'));

        let mut taken = HashSet::new();
        claim(&mut taken, &safe);
        let second = claim(&mut taken, &safe);
        assert!(second.len() <= MAX_NAME_BYTES);
        assert!(second.ends_with(" (2).pem"), "{second}");

        // A long "extension" is just part of the name.
        assert_eq!(split_extension("backup.this-is-not-an-extension"), ("backup.this-is-not-an-extension", ""));
        assert_eq!(split_extension("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(split_extension("notes. draft"), ("notes. draft", ""));
    }

    #[test]
    fn same_names_are_numbered_without_regard_to_case() {
        let mut taken = HashSet::new();
        assert_eq!(claim(&mut taken, "key.pem"), "key.pem");
        assert_eq!(claim(&mut taken, "Key.pem"), "Key (2).pem");
        assert_eq!(claim(&mut taken, "KEY.PEM"), "KEY (3).PEM");
        assert_eq!(claim(&mut taken, ".env"), ".env");
        assert_eq!(claim(&mut taken, ".env"), ".env (2)");
    }

    #[test]
    fn a_finished_folder_appears_whole_and_private_and_replaces_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path();
        // One by that name already: it must stay as it was.
        fs::create_dir(parent.join("Acme files")).unwrap();
        fs::write(parent.join("Acme files").join("mine.txt"), "untouched").unwrap();

        let mut folder = NewFolder::create(parent, "Acme files").unwrap();
        assert_eq!(folder.write(None, "id_ed25519", b"key").unwrap(), "id_ed25519");
        assert_eq!(folder.write(None, "id_ed25519", b"other").unwrap(), "id_ed25519 (2)");
        assert_eq!(folder.write(Some("Coolify"), ".env", b"A=1").unwrap(), "Coolify/.env");
        assert_eq!(folder.write(Some("Coolify"), ".env", b"A=2").unwrap(), "Coolify/.env (2)");
        assert_eq!(folder.write(Some("a/b"), "x", b"x").unwrap(), "a_b/x", "a service name can't make a path");
        // Hidden until finished: only the existing folder and the staging one.
        let before = names_in(parent);
        assert_eq!(before.len(), 2);
        assert!(before.iter().any(|name| name.starts_with(".vaultkey-saving-")));

        let made = folder.finish().unwrap();
        assert_eq!(made, parent.join("Acme files (2)"));
        assert_eq!(names_in(parent), ["Acme files", "Acme files (2)"]);
        assert_eq!(fs::read_to_string(parent.join("Acme files").join("mine.txt")).unwrap(), "untouched");
        assert_eq!(names_in(&made), ["Coolify", "a_b", "id_ed25519", "id_ed25519 (2)"]);
        assert_eq!(fs::read(made.join("id_ed25519")).unwrap(), b"key");
        assert_eq!(fs::read(made.join("Coolify").join(".env (2)")).unwrap(), b"A=2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&made), 0o700);
            assert_eq!(mode(&made.join("Coolify")), 0o700);
            assert_eq!(mode(&made.join("id_ed25519")), 0o600);
            assert_eq!(mode(&made.join("Coolify").join(".env")), 0o600);
        }
    }

    #[test]
    fn an_unfinished_folder_leaves_nothing_behind() {
        let directory = tempfile::tempdir().unwrap();
        let mut folder = NewFolder::create(directory.path(), "Acme files").unwrap();
        folder.write(None, "secret.pem", b"-----BEGIN").unwrap();
        folder.write(Some("Vercel"), "token", b"t").unwrap();
        drop(folder);
        assert!(names_in(directory.path()).is_empty());
    }

    #[test]
    fn a_folder_and_a_file_of_the_same_name_both_keep_theirs() {
        let directory = tempfile::tempdir().unwrap();
        let mut folder = NewFolder::create(directory.path(), "Acme").unwrap();
        folder.write(None, "Coolify", b"file").unwrap();
        assert_eq!(folder.write(Some("Coolify"), "key", b"k").unwrap(), "Coolify (2)/key");
        let made = folder.finish().unwrap();
        assert_eq!(names_in(&made), ["Coolify", "Coolify (2)"]);
    }

    #[test]
    fn a_missing_parent_is_reported_and_creates_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let gone = directory.path().join("gone");
        let error = NewFolder::create(&gone, "Acme").err().unwrap();
        assert_eq!(error.code, crate::error::ErrorCode::NotFound);
        assert!(names_in(directory.path()).is_empty());
    }
}
