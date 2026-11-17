use handy_tts_core::catalog;
use handy_tts_core::download::{
    Credentials, Downloader, HttpTransport, is_downloaded, verify_model,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for this opt-in test"))
}

fn largest_file(directory: &Path, files: &[handy_tts_core::catalog::ModelFile]) -> PathBuf {
    let file = files
        .iter()
        .max_by_key(|file| file.bytes)
        .expect("a catalog model has files");
    directory.join(&file.path)
}

#[test]
#[ignore = "downloads from Hugging Face; opt in with HANDY_TTS_IT=1"]
fn real_download_verifies_and_resumes() {
    assert_eq!(require_env("HANDY_TTS_IT"), "1");
    let entry = catalog::entry(&require_env("HANDY_TTS_DOWNLOAD_MODEL")).unwrap();
    let root = PathBuf::from(require_env("HANDY_TTS_DOWNLOAD_ROOT"));
    let transport = HttpTransport::new("https://huggingface.co").unwrap();
    let downloader = Downloader {
        credentials: Credentials::memory_only(),
    };
    let cancel = AtomicBool::new(false);
    downloader
        .download(&root, entry, &transport, &cancel, |_| {})
        .unwrap();
    assert!(is_downloaded(&root, entry));
    println!(
        "REAL_DOWNLOAD model={} files={} bytes={}",
        entry.id,
        entry.files.len(),
        entry.bytes
    );
    let largest = largest_file(&root.join(entry.id), &entry.files);
    let half = fs::metadata(&largest).unwrap().len() / 2;
    fs::OpenOptions::new()
        .write(true)
        .open(&largest)
        .unwrap()
        .set_len(half)
        .unwrap();
    assert!(
        !is_downloaded(&root, entry),
        "a truncated file is not available"
    );
    downloader
        .download(&root, entry, &transport, &cancel, |_| {})
        .unwrap();
    assert!(verify_model(&root, entry, &|| false).unwrap());
    println!("REAL_DOWNLOAD resumed {} verified", largest.display());
}
