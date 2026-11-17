//! The Linux PRIMARY selection (the text last highlighted, pasted with
//! middle-click). Shift+Insert reads it instead of the clipboard in many
//! terminals (kitty, Ghostty, Alacritty, foot, xterm, VTE/GNOME Terminal),
//! while GUI apps read the clipboard. Writing the transcript to both lets one
//! Shift+Insert paste it everywhere.
//!
//! Wayland uses wl-clipboard when it is installed (the same tool Handy uses for
//! the clipboard there); everything else goes through arboard.

use log::warn;
use std::process::{Command, ExitStatus};
use std::sync::Mutex;
use std::time::Duration;

use crate::utils::is_wayland;
use arboard::{ClearExtLinux, Clipboard, GetExtLinux, LinuxClipboardKind, SetExtLinux};

/// A frozen selection owner must not hang the paste: wl-paste waits for it.
const READ_TIMEOUT: Duration = Duration::from_millis(500);

/// The same limits as the clipboard's own helpers on the paste path.
const PROBE_TIMEOUT: Duration = crate::clipboard::PASTE_PROBE_TIMEOUT;
const WRITE_TIMEOUT: Duration = crate::clipboard::PASTE_TOOL_TIMEOUT;

/// arboard serves X11 selections from a background context that lives as
/// long as a `Clipboard` does, so keep one for the life of the process.
static ARBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);

/// What PRIMARY held before Handy wrote the transcript to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Saved {
    Empty,
    Text(String),
}

fn with_arboard<T>(
    f: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, String> {
    let mut guard = ARBOARD.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|e| format!("Failed to open clipboard: {e}"))?);
    }
    f(guard.as_mut().expect("initialized above")).map_err(|e| e.to_string())
}

/// Like [`with_arboard`], keeping `f`'s own error so callers can tell an empty selection apart.
fn with_arboard_raw<T>(
    f: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>,
) -> Result<Result<T, arboard::Error>, String> {
    with_arboard(|c| Ok(f(c)))
}

/// Whether PRIMARY goes through wl-clipboard; a `which` probe that does not answer is an error.
fn use_wl_clipboard() -> Result<bool, String> {
    Ok(is_wayland() && which("wl-copy")? && which("wl-paste")?)
}

fn which(tool: &str) -> Result<bool, String> {
    probe_with(Command::new("which").arg(tool), PROBE_TIMEOUT)
}

fn probe_with(command: &mut Command, timeout: Duration) -> Result<bool, String> {
    crate::clipboard::tool_available_with(command, timeout).map_err(|e| e.to_string())
}

/// Runs one wl-copy call under `timeout` with its output discarded.
fn run_wl_copy(command: &mut Command, timeout: Duration) -> Result<ExitStatus, String> {
    crate::clipboard::quiet_tool(command, timeout)
        .map(|output| output.status)
        .map_err(|e| format!("Failed to execute wl-copy: {e}"))
}

/// What PRIMARY holds now, or `Err` when it could not be saved.
pub fn read() -> Result<Saved, String> {
    if use_wl_clipboard()? {
        return wl_paste_read(Command::new("wl-paste"), READ_TIMEOUT);
    }
    match with_arboard_raw(|c| c.get().clipboard(LinuxClipboardKind::Primary).text()) {
        Ok(Ok(text)) => Ok(saved_text(text)),
        Ok(Err(arboard::Error::ContentNotAvailable)) => Ok(Saved::Empty),
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(e),
    }
}

fn saved_text(text: String) -> Saved {
    if text.is_empty() {
        Saved::Empty
    } else {
        Saved::Text(text)
    }
}

/// Reads PRIMARY with wl-paste; only its "Nothing is copied" exit counts as empty.
fn wl_paste_read(mut base: Command, timeout: Duration) -> Result<Saved, String> {
    let output = crate::clipboard::read_selection_tool(
        base.args(["--primary", "--no-newline", "--type", "text"]),
        timeout,
    )
    .map_err(|e| format!("wl-paste --primary failed: {e}"))?;
    if output.status.success() {
        return String::from_utf8(output.stdout)
            .map(saved_text)
            .map_err(|_| "wl-paste --primary returned text that is not UTF-8".into());
    }
    if String::from_utf8_lossy(&output.stderr).contains("Nothing is copied") {
        return Ok(Saved::Empty);
    }
    Err(format!("wl-paste --primary failed ({})", output.status))
}

/// Saves PRIMARY and puts `text` on it; returns what to restore, `None` when nothing is.
pub fn save_and_set(text: &str) -> Option<Saved> {
    save_and_set_with(read(), || write(text))
}

fn save_and_set_with(
    saved: Result<Saved, String>,
    set: impl FnOnce() -> Result<(), String>,
) -> Option<Saved> {
    let saved = saved
        .map_err(|e| {
            warn!("Primary selection could not be saved ({e}); the transcript stays on it")
        })
        .ok();
    match set() {
        Ok(()) => saved,
        Err(e) => {
            warn!("Could not put the transcript on the primary selection: {e}");
            None
        }
    }
}

/// Puts `text` on PRIMARY.
pub fn write(text: &str) -> Result<(), String> {
    if use_wl_clipboard()? {
        return wl_copy_set(Command::new("wl-copy"), text, WRITE_TIMEOUT);
    }
    with_arboard(|c| c.set().clipboard(LinuxClipboardKind::Primary).text(text))
}

/// Sets PRIMARY to `text`, sent on stdin so it never appears in a process's arguments.
fn wl_copy_set(mut base: Command, text: &str, timeout: Duration) -> Result<(), String> {
    let status = crate::clipboard::quiet_tool_with_input(
        base.args(["--primary", "--type", "text/plain;charset=utf-8"]),
        text.as_bytes().to_vec(),
        timeout,
    )
    .map(|output| output.status)
    .map_err(|e| format!("Failed to execute wl-copy: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("wl-copy --primary failed (does the compositor support the primary selection?)".into())
    }
}

/// Puts back what [`save_and_set`] saved, or empties PRIMARY if it was empty.
pub fn restore(saved: Saved) {
    restore_with(saved, write, clear);
}

fn restore_with(
    saved: Saved,
    set: impl FnOnce(&str) -> Result<(), String>,
    clear: impl FnOnce() -> Result<(), String>,
) {
    let result = match saved {
        Saved::Text(text) => set(&text),
        Saved::Empty => clear(),
    };
    if let Err(e) = result {
        warn!("Failed to restore the primary selection: {e}");
    }
}

fn clear() -> Result<(), String> {
    if use_wl_clipboard()? {
        let status = run_wl_copy(
            Command::new("wl-copy").args(["--primary", "--clear"]),
            WRITE_TIMEOUT,
        )?;
        return if status.success() {
            Ok(())
        } else {
            Err("wl-copy --primary --clear failed".into())
        };
    }
    with_arboard(|c| c.clear_with().clipboard(LinuxClipboardKind::Primary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    /// A helper that never answers, like `which` or `wl-copy` stuck on a frozen
    /// selection owner or a slow PATH mount.
    fn hung_tool() -> Command {
        let mut command = Command::new("sleep");
        command.arg("5");
        command
    }

    /// A fake wl-clipboard helper run through `sh`, so no freshly written file is executed.
    fn fake(dir: &Path, name: &str, body: &str) -> Command {
        let script = dir.join(name);
        std::fs::write(&script, body).unwrap();
        let mut command = Command::new("sh");
        command.arg(script);
        command
    }

    /// A fake wl-copy that records its arguments and its stdin.
    fn recording_wl_copy(dir: &Path) -> (Command, PathBuf, PathBuf) {
        let argv = dir.join("argv");
        let stdin = dir.join("stdin");
        let body = format!(
            "printf '%s\\n' \"$@\" > '{}'\ncat > '{}'\n",
            argv.display(),
            stdin.display()
        );
        (fake(dir, "wl-copy", &body), argv, stdin)
    }

    const PRIVATE: &str = "private words \u{e9} marker-7f3a";

    fn assert_sent_on_stdin_only(argv: &Path, stdin: &Path, text: &str) {
        assert_eq!(std::fs::read(stdin).unwrap(), text.as_bytes());
        let args = std::fs::read_to_string(argv).unwrap();
        assert!(
            !args.contains("marker-7f3a"),
            "selection text must not be a process argument: {args:?}"
        );
    }

    #[test]
    fn primary_write_sends_the_text_on_stdin_not_in_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let (wl_copy, argv, stdin) = recording_wl_copy(dir.path());
        wl_copy_set(wl_copy, PRIVATE, WRITE_TIMEOUT).unwrap();
        assert_sent_on_stdin_only(&argv, &stdin, PRIVATE);
    }

    #[test]
    fn restoring_a_saved_selection_sends_it_on_stdin_not_in_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let (wl_copy, argv, stdin) = recording_wl_copy(dir.path());
        restore_with(
            Saved::Text(PRIVATE.into()),
            |text| wl_copy_set(wl_copy, text, WRITE_TIMEOUT),
            || panic!("a saved selection is written back, not cleared"),
        );
        assert_sent_on_stdin_only(&argv, &stdin, PRIVATE);
    }

    #[test]
    fn a_selection_larger_than_a_pipe_is_read_and_restored_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = dir.path().join("selection");
        let text: String = (0..60_000).map(|n| format!("line {n} \u{e9}\n")).collect();
        assert!(text.len() > 512 * 1024, "larger than any pipe buffer");
        std::fs::write(&fixture, &text).unwrap();
        let wl_paste = fake(
            dir.path(),
            "wl-paste",
            &format!("cat '{}'\n", fixture.display()),
        );
        let saved = wl_paste_read(wl_paste, READ_TIMEOUT).unwrap();
        assert_eq!(saved, Saved::Text(text.clone()));
        let (wl_copy, _, stdin) = recording_wl_copy(dir.path());
        restore_with(
            saved,
            |text| wl_copy_set(wl_copy, text, WRITE_TIMEOUT),
            || panic!("a saved selection is written back, not cleared"),
        );
        assert_eq!(std::fs::read(stdin).unwrap(), text.as_bytes());
    }

    #[test]
    fn an_empty_selection_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let wl_paste = fake(
            dir.path(),
            "wl-paste",
            "echo 'Nothing is copied' >&2\nexit 1\n",
        );
        assert_eq!(wl_paste_read(wl_paste, READ_TIMEOUT), Ok(Saved::Empty));
    }

    #[test]
    fn an_unsaved_selection_still_gets_the_transcript_and_is_not_restored() {
        let dir = tempfile::tempdir().unwrap();
        let wl_paste = fake(
            dir.path(),
            "wl-paste",
            "echo 'Failed to connect to a Wayland server' >&2\nexit 1\n",
        );
        let read = wl_paste_read(wl_paste, READ_TIMEOUT);
        assert!(
            read.is_err(),
            "a failed read is not an empty selection: {read:?}"
        );
        let mut written = false;
        let restore = save_and_set_with(read, || {
            written = true;
            Ok(())
        });
        assert!(
            written,
            "dictation wins: the transcript goes on PRIMARY anyway"
        );
        assert_eq!(
            restore, None,
            "an unsaved selection is neither restored nor cleared after the paste"
        );
    }

    #[test]
    fn a_hung_tool_probe_is_an_error_within_its_deadline() {
        let started = Instant::now();
        let result = probe_with(&mut hung_tool(), Duration::from_millis(200));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "probe outlived its deadline"
        );
        assert!(
            result.is_err(),
            "a timed-out probe must not read as a present or missing tool"
        );
    }

    #[test]
    fn a_hung_wl_copy_fails_within_its_deadline() {
        let started = Instant::now();
        let result = run_wl_copy(&mut hung_tool(), Duration::from_millis(200));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "wl-copy outlived its deadline"
        );
        assert!(result.is_err());
    }

    #[test]
    fn a_tool_that_answers_reports_its_status() {
        assert_eq!(
            probe_with(&mut Command::new("true"), PROBE_TIMEOUT),
            Ok(true)
        );
        assert_eq!(
            probe_with(&mut Command::new("false"), PROBE_TIMEOUT),
            Ok(false)
        );
        assert!(run_wl_copy(&mut Command::new("true"), WRITE_TIMEOUT).is_ok_and(|s| s.success()));
    }
}
