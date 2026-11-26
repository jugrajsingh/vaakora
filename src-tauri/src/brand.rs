//! The app's identity, read from `brand.json` by `build.rs` at compile time:
//! one source for the name, the app id, the install dir, the repository link
//! and the update channel. Files that cannot read it (`tauri.conf.json`,
//! `Cargo.toml`, `package.json`, `index.html`) carry literals that
//! `scripts/check-brand.ts` proves equal.

/// The product name shown to the user (window title, CLI help, notifications).
pub const DISPLAY_NAME: &str = env!("BRAND_DISPLAY_NAME");
/// The app id (`identifier` in `tauri.conf.json`); names the app data directory.
pub const APP_ID: &str = env!("BRAND_APP_ID");
/// The package and binary name (`vaakora`); names the log file.
pub const PACKAGE_NAME: &str = env!("BRAND_PACKAGE_NAME");
/// The previous app id whose data directory a first start may copy from.
pub const LEGACY_APP_ID: &str = env!("BRAND_LEGACY_APP_ID");
/// The directory the .deb and .rpm install the app's libraries and helpers into.
pub const INSTALL_DIR: &str = env!("BRAND_INSTALL_DIR");
/// The read-aloud worker's binary name inside `<install_dir()>/tts/`.
pub const WORKER_BINARY: &str = env!("BRAND_WORKER_BINARY");
/// The project's repository link, sent as the referrer of cloud requests.
pub const REPO_URL: &str = env!("BRAND_REPO_URL");
/// The update channel; `None` when no release channel exists.
pub const UPDATE_ENDPOINT: Option<&str> = match env!("BRAND_UPDATE_ENDPOINT").is_empty() {
    true => None,
    false => Some(env!("BRAND_UPDATE_ENDPOINT")),
};

/// Where the bundled helpers (`llm/llama-server`, `tts/<WORKER_BINARY>`) live
/// for the running binary. An AppImage mounts at a new path on every start,
/// so a fixed `INSTALL_DIR` would miss the copies inside it.
pub fn install_dir() -> std::path::PathBuf {
    install_dir_from(std::env::current_exe().ok().as_deref())
}

/// `<exe dir>/../lib/<DISPLAY_NAME>` when that is a directory, else
/// `INSTALL_DIR`. The same rule tauri uses for the resource dir on Linux:
/// `/usr/bin/vaakora` gives `/usr/lib/Vaakora`, an AppImage's
/// `$APPDIR/usr/bin/vaakora` gives `$APPDIR/usr/lib/Vaakora`, and a cargo
/// build (no sibling `lib/`) falls back to `INSTALL_DIR`.
fn install_dir_from(exe: Option<&std::path::Path>) -> std::path::PathBuf {
    exe.and_then(std::path::Path::parent)
        .and_then(|bin| bin.join("../lib").join(DISPLAY_NAME).canonicalize().ok())
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(|| std::path::PathBuf::from(INSTALL_DIR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_come_from_brand_json() {
        assert_eq!(DISPLAY_NAME, "Vaakora");
        assert_eq!(APP_ID, "dev.jugraj.vaakora");
        assert_eq!(PACKAGE_NAME, "vaakora");
        assert_eq!(LEGACY_APP_ID, "com.pais.handy");
        assert_eq!(INSTALL_DIR, "/usr/lib/Vaakora");
        assert_eq!(WORKER_BINARY, "vaakora-tts");
        assert_eq!(REPO_URL, "https://github.com/jugrajsingh/vaakora");
        assert!(UPDATE_ENDPOINT.is_none());
    }

    /// Lays out `<d>/usr/bin/vaakora`, plus `<d>/usr/lib/Vaakora/` when `with_lib`.
    fn layout(with_lib: bool) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("usr/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(PACKAGE_NAME);
        std::fs::write(&exe, b"").unwrap();
        if with_lib {
            std::fs::create_dir_all(dir.path().join("usr/lib").join(DISPLAY_NAME)).unwrap();
        }
        (dir, exe)
    }

    #[test]
    fn install_dir_is_next_to_the_binary_when_present() {
        let (dir, exe) = layout(true);
        let expected = dir.path().join("usr/lib/Vaakora").canonicalize().unwrap();
        assert_eq!(install_dir_from(Some(&exe)), expected);
    }

    #[test]
    fn install_dir_falls_back_without_a_sibling_lib_dir() {
        let (_dir, exe) = layout(false);
        assert_eq!(
            install_dir_from(Some(&exe)),
            std::path::PathBuf::from("/usr/lib/Vaakora")
        );
    }

    #[test]
    fn install_dir_falls_back_when_the_sibling_is_a_file() {
        let (dir, exe) = layout(false);
        std::fs::create_dir_all(dir.path().join("usr/lib")).unwrap();
        std::fs::write(dir.path().join("usr/lib").join(DISPLAY_NAME), b"").unwrap();
        assert_eq!(
            install_dir_from(Some(&exe)),
            std::path::PathBuf::from("/usr/lib/Vaakora")
        );
    }

    #[test]
    fn install_dir_falls_back_without_an_exe() {
        assert_eq!(
            install_dir_from(None),
            std::path::PathBuf::from("/usr/lib/Vaakora")
        );
    }
}
