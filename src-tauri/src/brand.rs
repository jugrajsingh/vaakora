//! The app's identity, read from `brand.json` by `build.rs` at compile time:
//! one source for the name, the app id, the install dir, the repository link
//! and the update channel. Files that cannot read it (`tauri.conf.json`,
//! `Cargo.toml`, `package.json`, `index.html`) carry literals that
//! `scripts/check-brand.ts` proves equal.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "APP_ID, LEGACY_APP_ID, INSTALL_DIR, WORKER_BINARY and UPDATE_ENDPOINT are read by tests now and by the first-start data copy and the updater gate (rebrand Tasks 7 and 8); the install paths read them through env! in const strings"
    )
)]

/// The product name shown to the user (window title, CLI help, notifications).
pub const DISPLAY_NAME: &str = env!("BRAND_DISPLAY_NAME");
/// The app id (`identifier` in `tauri.conf.json`); names the app data directory.
pub const APP_ID: &str = env!("BRAND_APP_ID");
/// The package and binary name (`vaakora`); names the log file.
pub const PACKAGE_NAME: &str = env!("BRAND_PACKAGE_NAME");
/// The previous app id whose data directory a first start may copy from.
pub const LEGACY_APP_ID: &str = env!("BRAND_LEGACY_APP_ID");
/// The directory the package installs the app's libraries and helpers into.
pub const INSTALL_DIR: &str = env!("BRAND_INSTALL_DIR");
/// The read-aloud worker's binary name inside `<INSTALL_DIR>/tts/`.
pub const WORKER_BINARY: &str = env!("BRAND_WORKER_BINARY");
/// The project's repository link, sent as the referrer of cloud requests.
pub const REPO_URL: &str = env!("BRAND_REPO_URL");
/// The update channel; `None` when no release channel exists.
pub const UPDATE_ENDPOINT: Option<&str> = match env!("BRAND_UPDATE_ENDPOINT").is_empty() {
    true => None,
    false => Some(env!("BRAND_UPDATE_ENDPOINT")),
};

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
}
