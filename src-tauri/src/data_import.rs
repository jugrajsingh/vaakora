//! First start: copy the previous app's data (settings, histories, recordings,
//! vocabulary, models, web storage) into this app's data dir.
//!
//! Runs in `run()` before the Tauri builder, so nothing has opened the new
//! data dir yet. The copy is built in a unique staging dir next to the new dir
//! and renamed into place, so a crash or an error never leaves a half-copied
//! data dir that a later start would take as the app's own. The old dir is
//! only ever read.

use crate::brand;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The report file in the new data dir: what was copied, or what failed.
pub const REPORT_FILE: &str = "handy-import.json";

/// The previous app's data dir and this app's (both under the same base dir).
#[derive(Clone, Debug, PartialEq)]
pub struct ImportPaths {
    pub old: PathBuf,
    pub new: PathBuf,
}

impl ImportPaths {
    /// `dirs::data_dir()` joined with the legacy and the current app id, the
    /// resolution Tauri uses for `app_data_dir` on Linux.
    pub fn resolve() -> Option<Self> {
        let base = dirs::data_dir()?;
        Some(Self {
            old: base.join(brand::LEGACY_APP_ID),
            new: base.join(brand::APP_ID),
        })
    }
}

#[derive(Serialize, Deserialize, Type, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImportStatus {
    Copied,
    Failed,
}

#[derive(Serialize, Deserialize, Type, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataImportReport {
    pub status: ImportStatus,
    /// Allowlist entries found in the old dir and copied, in allowlist order.
    pub items: Vec<String>,
    /// Bytes of every file written into the new dir.
    pub bytes_total: u64,
    /// The old data dir (the card names it by path only).
    pub from: String,
    /// The new data dir (the failure card says to delete it before retrying).
    pub to: String,
    pub error: Option<String>,
    /// Symlinks found under the allowlist and not followed.
    pub skipped: Vec<String>,
    pub dismissed: bool,
}

/// The old dir's entries the copy takes; everything else (logs, caches,
/// web cache, vocabulary backups) stays behind.
const ALLOWLIST: [&str; 7] = [
    SETTINGS_FILE,
    "history.db",
    "tts-history.db",
    "tts-vocabulary.json",
    "recordings",
    "models",
    "localstorage",
];
const SETTINGS_FILE: &str = "settings_store.json";
/// Copies of a file the old app may be rewriting (settings, WAL databases)
/// before the import gives up.
const ATTEMPTS: usize = 3;
/// How long a snapshot waits for a writer holding a database's write lock.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Copy the old dir into the new one when this is the first start: not
/// portable, the new dir absent (any entry counts, even an empty dir) and the
/// old settings file present. Builds the copy in a unique staging dir next to
/// the new dir, then renames it into place. On an error the staging dir goes
/// and the new dir is created holding only a failed report, unless the new
/// dir appeared meanwhile, which is then left untouched.
pub fn import_if_needed(
    paths: &ImportPaths,
    portable: bool,
    copy: &dyn Fn(&Path, &Path) -> io::Result<u64>,
) -> Option<DataImportReport> {
    if portable || exists(&paths.new) || !paths.old.join(SETTINGS_FILE).is_file() {
        return None;
    }
    let base = paths.new.parent()?;
    let name = paths.new.file_name()?.to_string_lossy().into_owned();
    let report = |status, error: Option<String>| DataImportReport {
        status,
        items: Vec::new(),
        bytes_total: 0,
        from: paths.old.display().to_string(),
        to: paths.new.display().to_string(),
        error,
        skipped: Vec::new(),
        dismissed: false,
    };
    // One importer at a time: a second start waits here, then finds the new
    // dir and skips. Holding the lock also makes every staging dir found
    // below a leftover of a start that died.
    let _lock = match lock(base, &name) {
        Ok(lock) => lock,
        Err(e) => return fail(paths, report(ImportStatus::Failed, Some(e.to_string()))),
    };
    if exists(&paths.new) {
        return None;
    }
    sweep_stale(base, &name);
    let staging = base.join(format!("{}{}", staging_prefix(&name), unique_suffix()));
    let mut copied = report(ImportStatus::Copied, None);
    let built = fs::create_dir(&staging)
        .map_err(|e| with_path(e, &staging))
        .and_then(|()| copy_allowlist(&paths.old, &staging, copy, &mut copied))
        .and_then(|()| write_report(&staging, &copied));
    let result = built.and_then(|()| {
        if exists(&paths.new) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} appeared during the copy", paths.new.display()),
            ));
        }
        fs::rename(&staging, &paths.new).map_err(|e| with_path(e, &paths.new))
    });
    match result {
        Ok(()) => Some(copied),
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            fail(paths, report(ImportStatus::Failed, Some(e.to_string())))
        }
    }
}

/// Create the new dir holding only `failed`, unless the new dir exists by now
/// (then it and its contents are left alone and nothing is reported).
fn fail(paths: &ImportPaths, failed: DataImportReport) -> Option<DataImportReport> {
    fs::create_dir(&paths.new).ok()?;
    if let Err(e) = write_report(&paths.new, &failed) {
        eprintln!("[data import] could not write the failure report: {e}");
    }
    Some(failed)
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn with_path(e: io::Error, path: &Path) -> io::Error {
    io::Error::new(e.kind(), format!("{}: {e}", path.display()))
}

fn staging_prefix(name: &str) -> String {
    format!(".{name}.import-")
}

fn unique_suffix() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{n}", std::process::id())
}

/// An exclusive lock on `<base>/.<name>.import.lock`, held until dropped.
fn lock(base: &Path, name: &str) -> io::Result<fs::File> {
    fs::create_dir_all(base).map_err(|e| with_path(e, base))?;
    let path = base.join(format!(".{name}.import.lock"));
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| with_path(e, &path))?;
    file.lock().map_err(|e| with_path(e, &path))?;
    Ok(file)
}

/// Remove staging dirs a start that died left behind (called with the lock
/// held and the new dir absent).
fn sweep_stale(base: &Path, name: &str) {
    let prefix = staging_prefix(name);
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn copy_allowlist(
    old: &Path,
    staging: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<u64>,
    report: &mut DataImportReport,
) -> io::Result<()> {
    for name in ALLOWLIST {
        let src = old.join(name);
        let meta = match fs::symlink_metadata(&src) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(with_path(e, &src)),
        };
        if meta.file_type().is_symlink() {
            report.skipped.push(src.display().to_string());
            continue;
        }
        let dst = staging.join(name);
        report.bytes_total += match name {
            SETTINGS_FILE => copy_settings(&src, &dst, copy)?,
            "history.db" | "tts-history.db" => copy_sqlite(&src, &dst, copy)?,
            "localstorage" => copy_tree(&src, &dst, copy, true, report)?,
            _ if meta.is_dir() => copy_tree(&src, &dst, copy, false, report)?,
            _ => copy(&src, &dst).map_err(|e| with_path(e, &src))?,
        };
        report.items.push(name.to_string());
    }
    Ok(())
}

/// Copy the settings file and parse it; a torn copy (the old app rewriting
/// it) is copied again. The copy turns this app's start at login off so two
/// apps do not start at login and answer one shortcut; every other value,
/// API keys included, stays as it was.
fn copy_settings(
    src: &Path,
    dst: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<u64>,
) -> io::Result<u64> {
    let mut last = String::new();
    for _ in 0..ATTEMPTS {
        copy(src, dst).map_err(|e| with_path(e, src))?;
        let bytes = fs::read(dst).map_err(|e| with_path(e, dst))?;
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(mut value) => {
                if let Some(settings) = value.get_mut("settings").and_then(|s| s.as_object_mut()) {
                    settings.insert("autostart_enabled".into(), serde_json::Value::Bool(false));
                }
                let out = serde_json::to_vec_pretty(&value).map_err(io::Error::other)?;
                fs::write(dst, &out).map_err(|e| with_path(e, dst))?;
                return Ok(out.len() as u64);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "{}: not valid JSON after {ATTEMPTS} copies: {last}",
            src.display()
        ),
    ))
}

/// Walk a directory: files through `copy`, symlinks skipped and listed.
/// With `sqlite`, SQLite files go through [`copy_sqlite`] and their -wal,
/// -shm and -journal companions are not copied on their own.
fn copy_tree(
    src: &Path,
    dst: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<u64>,
    sqlite: bool,
    report: &mut DataImportReport,
) -> io::Result<u64> {
    fs::create_dir(dst).map_err(|e| with_path(e, dst))?;
    let mut entries = fs::read_dir(src)
        .map_err(|e| with_path(e, src))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| with_path(e, src))?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut bytes = 0;
    for entry in entries {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| with_path(e, &from))?;
        if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) {
            report.skipped.push(from.display().to_string());
        } else if kind.is_dir() {
            bytes += copy_tree(&from, &to, copy, sqlite, report)?;
        } else if sqlite && is_sqlite_companion(&from) {
            continue;
        } else if sqlite && is_sqlite(&from)? {
            bytes += copy_sqlite(&from, &to, copy)?;
        } else {
            bytes += copy(&from, &to).map_err(|e| with_path(e, &from))?;
        }
    }
    Ok(bytes)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// A -wal, -shm or -journal file whose database sits beside it.
fn is_sqlite_companion(path: &Path) -> bool {
    let name = path.to_string_lossy();
    ["-wal", "-shm", "-journal"].iter().any(|suffix| {
        name.strip_suffix(suffix)
            .is_some_and(|db| Path::new(db).is_file())
    })
}

/// The first 100 bytes of a file (a SQLite header), or what there is.
fn header(path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::with_capacity(100);
    fs::File::open(path)
        .and_then(|file| file.take(100).read_to_end(&mut head))
        .map_err(|e| with_path(e, path))?;
    Ok(head)
}

fn is_sqlite(path: &Path) -> io::Result<bool> {
    Ok(header(path)?.starts_with(b"SQLite format 3\0"))
}

/// Copy a SQLite database as one consistent snapshot and check it.
///
/// Rollback-journal databases (the histories): `VACUUM INTO` from a read-only
/// connection, which takes only SQLite's shared read lock, so a live writer's
/// uncommitted transaction never reaches the copy. WAL databases (web
/// storage): any SQLite connection to them, read-only included, writes the
/// source's -shm, so their files are copied as bytes (the database, then its
/// -wal), again while the source changed across the copy, and the WAL is
/// applied in the staging copy.
fn copy_sqlite(
    src: &Path,
    dst: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<u64>,
) -> io::Result<u64> {
    let wal_mode = header(src)?.get(18) == Some(&2);
    if wal_mode {
        snapshot_wal(src, dst, copy)?;
    } else {
        let conn = rusqlite::Connection::open_with_flags(
            src,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| sqlite_error(e, src))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| sqlite_error(e, src))?;
        let target = dst.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{}: not UTF-8", dst.display()),
            )
        })?;
        conn.execute("VACUUM INTO ?1", [target])
            .map_err(|e| sqlite_error(e, src))?;
    }
    let conn = rusqlite::Connection::open(dst).map_err(|e| sqlite_error(e, dst))?;
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| sqlite_error(e, dst))?;
    drop(conn);
    if check != "ok" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{}: copy failed integrity_check: {check}", src.display()),
        ));
    }
    fs::metadata(dst)
        .map(|meta| meta.len())
        .map_err(|e| with_path(e, dst))
}

fn sqlite_error(e: rusqlite::Error, path: &Path) -> io::Error {
    io::Error::other(format!("{}: {e}", path.display()))
}

/// Length and modification time: what a writer changes.
type Stamp = Option<(u64, std::time::SystemTime)>;

fn stamp(path: &Path) -> io::Result<Stamp> {
    match fs::metadata(path) {
        Ok(meta) => Ok(Some((meta.len(), meta.modified()?))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(with_path(e, path)),
    }
}

fn snapshot_wal(
    src: &Path,
    dst: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<u64>,
) -> io::Result<()> {
    let (src_wal, dst_wal) = (sidecar(src, "-wal"), sidecar(dst, "-wal"));
    for _ in 0..ATTEMPTS {
        let before = (stamp(src)?, stamp(&src_wal)?);
        copy(src, dst).map_err(|e| with_path(e, src))?;
        if before.1.is_some() {
            copy(&src_wal, &dst_wal).map_err(|e| with_path(e, &src_wal))?;
        }
        if (stamp(src)?, stamp(&src_wal)?) == before {
            // Apply the WAL here, in the copy; closing the last connection
            // removes the copy's -wal and -shm.
            let conn = rusqlite::Connection::open(dst).map_err(|e| sqlite_error(e, dst))?;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .map_err(|e| sqlite_error(e, dst))?;
            return Ok(());
        }
        let _ = fs::remove_file(dst);
        let _ = fs::remove_file(&dst_wal);
    }
    Err(io::Error::other(format!(
        "{}: changed during each of {ATTEMPTS} copies",
        src.display()
    )))
}

fn write_report(dir: &Path, report: &DataImportReport) -> io::Result<()> {
    let path = dir.join(REPORT_FILE);
    let temp = dir.join(format!("{REPORT_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(report).map_err(io::Error::other)?;
    fs::write(&temp, bytes).map_err(|e| with_path(e, &temp))?;
    fs::rename(&temp, &path).map_err(|e| with_path(e, &path))
}

fn read_report(dir: &Path) -> Option<DataImportReport> {
    serde_json::from_slice(&fs::read(dir.join(REPORT_FILE)).ok()?).ok()
}

/// Resolve the paths and import with `std::fs::copy` (copy_file_range, which
/// shares blocks where the filesystem allows); the caller logs the result from
/// `setup` (logging before the builder goes nowhere).
pub fn import_on_first_start() -> Option<DataImportReport> {
    let paths = ImportPaths::resolve()?;
    import_if_needed(&paths, crate::portable::is_portable(), &|src, dst| {
        fs::copy(src, dst)
    })
}

/// The report in `dir`, if any and not dismissed.
pub fn visible_report(dir: &Path) -> Option<DataImportReport> {
    read_report(dir).filter(|report| !report.dismissed)
}

/// Rewrite the report in `dir` with `dismissed = true` (atomic rename); no
/// report is nothing to do.
pub fn dismiss(dir: &Path) -> io::Result<()> {
    match read_report(dir) {
        Some(report) => write_report(
            dir,
            &DataImportReport {
                dismissed: true,
                ..report
            },
        ),
        None => Ok(()),
    }
}

/// The notification sentence (a tray string, `{path}` marks the old path).
pub fn notification_text(template: &str, from: &str) -> String {
    template.replace("{path}", from)
}

/// After an import this start: tell the owner on the desktop that the
/// settings came over and the other app must be quit first. Sent from a
/// thread so a slow or absent notification service never holds up startup.
pub fn notify_copied(locale: &str, report: &DataImportReport) {
    let strings = crate::tray_i18n::get_tray_translations(Some(locale.to_string()));
    let body = notification_text(&strings.import_notice, &report.from);
    std::thread::spawn(
        move || match send_notification(brand::DISPLAY_NAME, &body) {
            Ok(()) => log::info!("data import: desktop notification sent"),
            Err(e) => log::warn!("data import: desktop notification failed: {e}"),
        },
    );
}

/// org.freedesktop.Notifications.Notify on the session bus (GIO, already
/// linked through GTK).
#[cfg(target_os = "linux")]
fn send_notification(summary: &str, body: &str) -> Result<(), String> {
    use gtk::gio;
    use gtk::glib::{self, ToVariant};
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|e| e.to_string())?;
    let hints = std::collections::HashMap::<String, glib::Variant>::new();
    let params = (
        brand::DISPLAY_NAME,
        0u32,
        brand::PACKAGE_NAME,
        summary,
        body,
        Vec::<String>::new(),
        hints,
        -1i32,
    )
        .to_variant();
    bus.call_sync(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        Some(&params),
        None,
        gio::DBusCallFlags::NONE,
        5000,
        gio::Cancellable::NONE,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn send_notification(_summary: &str, _body: &str) -> Result<(), String> {
    Err("desktop notifications are sent on Linux only".into())
}

#[tauri::command]
#[specta::specta]
pub fn get_data_import_report(app: AppHandle) -> Option<DataImportReport> {
    let dir = crate::portable::app_data_dir(&app).ok()?;
    visible_report(&dir)
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_data_import_report(app: AppHandle) -> Result<(), String> {
    let dir = crate::portable::app_data_dir(&app).map_err(|e| e.to_string())?;
    dismiss(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    const SETTINGS: &str = r#"{
  "settings": {
    "bindings": {
      "transcribe_with_post_process": {
        "id": "transcribe_with_post_process",
        "default_binding": "",
        "current_binding": "super+alt+d"
      }
    },
    "autostart_enabled": true,
    "start_hidden": true,
    "post_process_provider_id": "local",
    "local_llm_model_id": "s1-mini-q4km",
    "keyboard_implementation": "handy_keys",
    "post_process_api_keys": { "openai": "sk-fixture-not-a-key" },
    "audio_feedback_volume": 0.8
  }
}"#;

    const ALLOWLIST_NAMES: [&str; 7] = [
        "settings_store.json",
        "history.db",
        "tts-history.db",
        "tts-vocabulary.json",
        "recordings",
        "models",
        "localstorage",
    ];

    struct Fixture {
        _root: TempDir,
        base: PathBuf,
        paths: ImportPaths,
    }

    fn fs_copy(src: &Path, dst: &Path) -> io::Result<u64> {
        fs::copy(src, dst)
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn make_db(path: &Path, rows: &[&str]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT)").unwrap();
        for row in rows {
            conn.execute("INSERT INTO t (v) VALUES (?1)", [row])
                .unwrap();
        }
    }

    fn rows(path: &Path) -> Vec<String> {
        let conn = Connection::open(path).unwrap();
        let mut stmt = conn.prepare("SELECT v FROM t ORDER BY rowid").unwrap();
        let out = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        out
    }

    /// The old dir as the owner's looks: two rollback-journal databases,
    /// web storage in WAL mode with its -wal and -shm, models, recordings,
    /// and entries the copy leaves behind.
    fn fixture() -> Fixture {
        let root = TempDir::new().unwrap();
        let base = root.path().join("share");
        let old = base.join("old.app");
        write(&old.join("settings_store.json"), SETTINGS.as_bytes());
        make_db(
            &old.join("history.db"),
            &["first dictation", "second dictation"],
        );
        make_db(&old.join("tts-history.db"), &["a read"]);
        write(
            &old.join("tts-vocabulary.json"),
            br#"{"words":["Vaakora"]}"#,
        );
        write(&old.join("recordings/a.wav"), b"RIFF fixture audio");
        write(&old.join("models/llm/m/x.gguf"), &[7u8; 4096]);
        write(&old.join("models/tts/v/y.onnx"), &[9u8; 2048]);
        // Web storage in WAL mode, left with a -wal holding its only row and a
        // -shm, as a live app has them: the files are set aside while the
        // connection is open and put back after its close checkpointed them.
        let ls_dir = old.join("localstorage");
        fs::create_dir_all(&ls_dir).unwrap();
        let ls = ls_dir.join("tauri_localhost_0.localstorage");
        let aside = root.path().join("aside");
        fs::create_dir_all(&aside).unwrap();
        {
            let conn = Connection::open(&ls).unwrap();
            conn.pragma_update(None, "journal_mode", "wal").unwrap();
            conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
            conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('theme=dark');")
                .unwrap();
            for suffix in ["", "-wal", "-shm"] {
                let name = format!("tauri_localhost_0.localstorage{suffix}");
                fs::copy(ls_dir.join(&name), aside.join(&name)).unwrap();
            }
        }
        for suffix in ["", "-wal", "-shm"] {
            let name = format!("tauri_localhost_0.localstorage{suffix}");
            fs::copy(aside.join(&name), ls_dir.join(&name)).unwrap();
        }
        write(&ls_dir.join("f"), b"plain file");
        write(&old.join("logs/handy.log"), b"old log");
        write(&old.join("WebKitCache/x"), b"cache");
        write(&old.join("tts-vocabulary.json.bak-1"), b"backup");
        let paths = ImportPaths {
            old,
            new: base.join("new.app"),
        };
        Fixture {
            _root: root,
            base,
            paths,
        }
    }

    /// (path, len, mtime, mode, sha256) of every entry under `dir`.
    fn manifest(dir: &Path) -> BTreeMap<String, (u64, u128, u32, String)> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(&current).unwrap() {
                let entry = entry.unwrap();
                let meta = fs::symlink_metadata(entry.path()).unwrap();
                let mtime = meta
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let hash = if meta.is_file() {
                    format!("{:x}", Sha256::digest(fs::read(entry.path()).unwrap()))
                } else {
                    String::new()
                };
                let rel = entry
                    .path()
                    .strip_prefix(dir)
                    .unwrap()
                    .display()
                    .to_string();
                out.insert(rel, (meta.len(), mtime, meta.permissions().mode(), hash));
                if meta.is_dir() {
                    stack.push(entry.path());
                }
            }
        }
        out
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn staging_left(base: &Path) -> Vec<String> {
        listing(base)
            .into_iter()
            .filter(|name| name.contains(".import-"))
            .collect()
    }

    fn settings_json(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn failing_on(name: &'static str) -> impl Fn(&Path, &Path) -> io::Result<u64> {
        move |src: &Path, dst: &Path| {
            if src.ends_with(name) {
                return Err(io::Error::other(format!("injected failure on {name}")));
            }
            fs::copy(src, dst)
        }
    }

    #[test]
    fn copies_the_allowlist_when_new_dir_is_absent() {
        let f = fixture();
        let report = import_if_needed(&f.paths, false, &fs_copy).expect("an import");
        assert_eq!(report.status, ImportStatus::Copied);
        assert_eq!(report.items, ALLOWLIST_NAMES);
        assert_eq!(report.error, None);
        assert_eq!(report.from, f.paths.old.display().to_string());
        assert_eq!(report.to, f.paths.new.display().to_string());
        assert!(!report.dismissed);
        let new = &f.paths.new;
        assert_eq!(
            rows(&new.join("history.db")),
            ["first dictation", "second dictation"]
        );
        assert_eq!(rows(&new.join("tts-history.db")), ["a read"]);
        assert_eq!(
            rows(&new.join("localstorage/tauri_localhost_0.localstorage")),
            ["theme=dark"],
            "the WAL frames reach the copy"
        );
        for rel in [
            "tts-vocabulary.json",
            "recordings/a.wav",
            "models/llm/m/x.gguf",
            "models/tts/v/y.onnx",
            "localstorage/f",
        ] {
            assert_eq!(
                fs::read(new.join(rel)).unwrap(),
                fs::read(f.paths.old.join(rel)).unwrap(),
                "{rel} byte-equal"
            );
        }
        for rel in ["logs", "WebKitCache", "tts-vocabulary.json.bak-1"] {
            assert!(!new.join(rel).exists(), "{rel} is not copied");
        }
        let mut expected = ALLOWLIST_NAMES.to_vec();
        expected.push(REPORT_FILE);
        expected.sort();
        assert_eq!(listing(new), expected);
        assert_eq!(
            listing(&new.join("localstorage")),
            ["f", "tauri_localhost_0.localstorage"],
            "no -wal or -shm carried over"
        );
        let written: u64 = manifest(new)
            .iter()
            .filter(|(rel, _)| rel.as_str() != REPORT_FILE)
            .filter(|(_, (_, _, mode, _))| mode & 0o170000 == 0o100000)
            .map(|(_, (len, _, _, _))| len)
            .sum();
        assert_eq!(report.bytes_total, written);
        assert!(staging_left(&f.base).is_empty());
        let stored: DataImportReport =
            serde_json::from_slice(&fs::read(new.join(REPORT_FILE)).unwrap()).unwrap();
        assert_eq!(stored, report);
    }

    #[test]
    fn copy_turns_off_autostart_and_keeps_every_other_setting() {
        let f = fixture();
        import_if_needed(&f.paths, false, &fs_copy).expect("an import");
        let old = settings_json(&f.paths.old.join("settings_store.json"));
        let new = settings_json(&f.paths.new.join("settings_store.json"));
        assert_eq!(new["settings"]["autostart_enabled"], false);
        let mut expected = old.clone();
        expected["settings"]["autostart_enabled"] = serde_json::Value::Bool(false);
        assert_eq!(
            new, expected,
            "every other setting, API keys included, as it was"
        );
        assert_eq!(
            new["settings"]["bindings"]["transcribe_with_post_process"]["current_binding"],
            "super+alt+d"
        );
        assert_eq!(
            new["settings"]["post_process_api_keys"]["openai"],
            "sk-fixture-not-a-key"
        );
    }

    #[test]
    fn old_dir_is_never_modified() {
        let f = fixture();
        let before = manifest(&f.paths.old);
        let report = import_if_needed(&f.paths, false, &fs_copy).expect("an import");
        assert_eq!(report.status, ImportStatus::Copied);
        assert_eq!(
            manifest(&f.paths.old),
            before,
            "success leaves the old dir as it was"
        );

        let g = fixture();
        let before = manifest(&g.paths.old);
        let report = import_if_needed(&g.paths, false, &failing_on("y.onnx")).expect("a report");
        assert_eq!(report.status, ImportStatus::Failed);
        assert_eq!(
            manifest(&g.paths.old),
            before,
            "failure leaves the old dir as it was"
        );
    }

    #[test]
    fn no_import_when_new_dir_exists() {
        let f = fixture();
        fs::create_dir_all(&f.paths.new).unwrap();
        assert_eq!(import_if_needed(&f.paths, false, &fs_copy), None);
        assert!(listing(&f.paths.new).is_empty(), "the new dir stays empty");
    }

    #[test]
    fn no_import_without_old_settings() {
        let f = fixture();
        fs::remove_file(f.paths.old.join("settings_store.json")).unwrap();
        assert_eq!(import_if_needed(&f.paths, false, &fs_copy), None);
        assert!(!f.paths.new.exists());
    }

    #[test]
    fn portable_skips() {
        let f = fixture();
        assert_eq!(import_if_needed(&f.paths, true, &fs_copy), None);
        assert!(!f.paths.new.exists());
    }

    #[test]
    fn failure_leaves_no_partial_copy() {
        let f = fixture();
        let report = import_if_needed(&f.paths, false, &failing_on("y.onnx")).expect("a report");
        assert_eq!(report.status, ImportStatus::Failed);
        let error = report.error.clone().expect("the error");
        assert!(error.contains("injected failure on y.onnx"), "{error}");
        assert!(report.items.is_empty());
        assert_eq!(report.bytes_total, 0);
        assert_eq!(listing(&f.paths.new), [REPORT_FILE]);
        assert!(staging_left(&f.base).is_empty());
        let stored: DataImportReport =
            serde_json::from_slice(&fs::read(f.paths.new.join(REPORT_FILE)).unwrap()).unwrap();
        assert_eq!(stored, report);
        // A later start does not retry while the failed report's dir exists.
        assert_eq!(import_if_needed(&f.paths, false, &fs_copy), None);
        // After the owner deletes the new dir, the next start imports.
        fs::remove_dir_all(&f.paths.new).unwrap();
        let retried = import_if_needed(&f.paths, false, &fs_copy).expect("a retry");
        assert_eq!(retried.status, ImportStatus::Copied);
    }

    #[test]
    fn failure_never_touches_a_new_dir_that_appeared() {
        let f = fixture();
        let new = f.paths.new.clone();
        let racing = move |src: &Path, dst: &Path| {
            if src.ends_with("y.onnx") {
                fs::create_dir_all(&new).unwrap();
                fs::write(new.join("someone-else.txt"), b"theirs").unwrap();
                return Err(io::Error::other("injected failure"));
            }
            fs::copy(src, dst)
        };
        assert_eq!(import_if_needed(&f.paths, false, &racing), None);
        assert_eq!(
            listing(&f.paths.new),
            ["someone-else.txt"],
            "no report written"
        );
        assert!(staging_left(&f.base).is_empty());
    }

    #[test]
    fn a_torn_settings_copy_is_retried_then_fails() {
        // A copy taken while the old app rewrites its settings file can be
        // torn; it is copied again, three times at most.
        let f = fixture();
        let attempts = std::cell::Cell::new(0);
        let torn_twice = |src: &Path, dst: &Path| {
            if src.ends_with("settings_store.json") {
                attempts.set(attempts.get() + 1);
                if attempts.get() <= 2 {
                    fs::write(dst, b"{\"settings\": {\"bind")?;
                    return Ok(18);
                }
            }
            fs::copy(src, dst)
        };
        let report = import_if_needed(&f.paths, false, &torn_twice).expect("an import");
        assert_eq!(report.status, ImportStatus::Copied);
        assert_eq!(attempts.get(), 3);

        let g = fixture();
        let attempts = std::cell::Cell::new(0);
        let always_torn = |src: &Path, dst: &Path| {
            if src.ends_with("settings_store.json") {
                attempts.set(attempts.get() + 1);
                fs::write(dst, b"{\"settings\": {\"bind")?;
                return Ok(18);
            }
            fs::copy(src, dst)
        };
        let report = import_if_needed(&g.paths, false, &always_torn).expect("a report");
        assert_eq!(report.status, ImportStatus::Failed);
        assert_eq!(attempts.get(), 3);
        assert!(report.error.unwrap().contains("settings_store.json"));
        assert_eq!(listing(&g.paths.new), [REPORT_FILE]);
    }

    #[test]
    fn two_starts_race_to_one_copy() {
        let f = fixture();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let paths = f.paths.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    import_if_needed(&paths, false, &fs_copy)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let copied = results
            .iter()
            .filter(|r| matches!(r, Some(report) if report.status == ImportStatus::Copied))
            .count();
        let none = results.iter().filter(|r| r.is_none()).count();
        assert_eq!((copied, none), (1, 1), "{results:?}");
        assert!(staging_left(&f.base).is_empty());
        assert_eq!(rows(&f.paths.new.join("history.db")).len(), 2);
    }

    #[test]
    fn stale_staging_is_swept_only_while_new_is_absent() {
        let f = fixture();
        let stale = f.base.join(".new.app.import-1-1");
        write(&stale.join("history.db"), b"half a copy");
        // While the new dir exists nothing runs, the sweep included.
        fs::create_dir_all(&f.paths.new).unwrap();
        assert_eq!(import_if_needed(&f.paths, false, &fs_copy), None);
        assert!(stale.exists());
        // With the new dir absent the next start sweeps it and imports.
        fs::remove_dir_all(&f.paths.new).unwrap();
        let report = import_if_needed(&f.paths, false, &fs_copy).expect("an import");
        assert_eq!(report.status, ImportStatus::Copied);
        assert!(!stale.exists());
        assert!(staging_left(&f.base).is_empty());
    }

    #[test]
    fn snapshot_ignores_an_open_writer() {
        let f = fixture();
        let writer = Connection::open(f.paths.old.join("history.db")).unwrap();
        writer
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO t (v) VALUES ('uncommitted');")
            .unwrap();
        let report = import_if_needed(&f.paths, false, &fs_copy).expect("an import");
        assert_eq!(report.status, ImportStatus::Copied);
        let copy = Connection::open(f.paths.new.join("history.db")).unwrap();
        let check: String = copy
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(check, "ok");
        assert_eq!(
            rows(&f.paths.new.join("history.db")),
            ["first dictation", "second dictation"]
        );
        writer.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn a_crashed_writer_never_reaches_the_copy() {
        // The old app died in the middle of a large transaction: its changed
        // pages are in the database file and the originals in a hot journal.
        // The copy must hold the committed rows, or the import fails.
        let f = fixture();
        let db = f.paths.old.join("history.db");
        let aside = f.base.join("crash");
        fs::create_dir_all(&aside).unwrap();
        {
            let writer = Connection::open(&db).unwrap();
            writer.pragma_update(None, "cache_size", 2).unwrap();
            writer
                .execute_batch(
                    "BEGIN IMMEDIATE; UPDATE t SET v = 'uncommitted ' || v; CREATE TABLE filler (v TEXT);",
                )
                .unwrap();
            for _ in 0..400 {
                writer
                    .execute("INSERT INTO filler (v) VALUES (?1)", [&"x".repeat(1200)])
                    .unwrap();
            }
            fs::copy(&db, aside.join("history.db")).unwrap();
            fs::copy(sidecar(&db, "-journal"), aside.join("history.db-journal")).unwrap();
            writer.execute_batch("ROLLBACK").unwrap();
        }
        // Precondition: the database file alone carries the uncommitted rows.
        let probe = f.base.join("probe.db");
        fs::copy(aside.join("history.db"), &probe).unwrap();
        let first = Connection::open(&probe)
            .unwrap()
            .query_row("SELECT v FROM t ORDER BY rowid LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        assert!(first.starts_with("uncommitted"), "{first}");
        fs::copy(aside.join("history.db"), &db).unwrap();
        fs::copy(aside.join("history.db-journal"), sidecar(&db, "-journal")).unwrap();

        let before = manifest(&f.paths.old);
        let report = import_if_needed(&f.paths, false, &fs_copy).expect("a report");
        match report.status {
            ImportStatus::Copied => assert_eq!(
                rows(&f.paths.new.join("history.db")),
                ["first dictation", "second dictation"]
            ),
            ImportStatus::Failed => assert_eq!(listing(&f.paths.new), [REPORT_FILE]),
        }
        assert_eq!(
            manifest(&f.paths.old),
            before,
            "the hot journal is left alone"
        );
    }

    #[test]
    fn a_second_start_waits_for_the_first() {
        let f = fixture();
        let name = f
            .paths
            .new
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let held = lock(&f.base, &name).unwrap();
        let paths = f.paths.clone();
        let second = std::thread::spawn(move || import_if_needed(&paths, false, &fs_copy));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!second.is_finished(), "the second start waits for the lock");
        assert!(!f.paths.new.exists());
        // The first start finishes its import, then lets go.
        fs::create_dir(&f.paths.new).unwrap();
        drop(held);
        assert_eq!(second.join().unwrap(), None, "and then finds the new dir");
        assert!(listing(&f.paths.new).is_empty());
    }

    #[test]
    fn dismiss_hides_the_report() {
        let f = fixture();
        let report = import_if_needed(&f.paths, false, &fs_copy).expect("an import");
        assert_eq!(visible_report(&f.paths.new), Some(report.clone()));
        dismiss(&f.paths.new).unwrap();
        assert_eq!(visible_report(&f.paths.new), None);
        let stored: DataImportReport =
            serde_json::from_slice(&fs::read(f.paths.new.join(REPORT_FILE)).unwrap()).unwrap();
        assert_eq!(
            stored,
            DataImportReport {
                dismissed: true,
                ..report
            }
        );
    }

    #[test]
    fn notification_names_the_path_and_not_the_old_app() {
        let english = crate::tray_i18n::get_tray_translations(Some("en".into()));
        let text = notification_text(&english.import_notice, "/home/u/.local/share/old.app");
        assert_eq!(
            text,
            "Imported your settings from /home/u/.local/share/old.app. Quit the other app before dictating; both use the same shortcut."
        );
        for (lang, strings) in crate::tray_i18n::TRANSLATIONS.iter() {
            let text = notification_text(&strings.import_notice, "/p/x");
            assert!(text.contains("/p/x"), "{lang}: {text}");
            assert!(!text.contains("{path}"), "{lang}: {text}");
            assert!(!text.to_lowercase().contains("handy"), "{lang}: {text}");
        }
    }
}
