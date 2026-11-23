//! The real `vaakora` binary in client mode, with no display. Every test points
//! `VAAKORA_SOCKET` into its own temporary directory, so the user's own socket is never touched.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use vaakora_app_lib::ipc::protocol::RpcError;
use vaakora_app_lib::ipc::server::{serve, Methods};
use vaakora_app_lib::ipc::socket::bind;

const DEADLINE: Duration = Duration::from_secs(20);

struct Ran {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs the binary with the display variables removed and waits at most `DEADLINE`; a child still
/// running then is killed and the test fails.
fn run_client(args: &[&str], socket: &Path, stdin: &[u8]) -> Ran {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vaakora"))
        .args(args)
        .env("VAAKORA_SOCKET", socket)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the vaakora binary starts");
    let pid = child.id();
    let mut pipe = child.stdin.take().unwrap();
    pipe.write_all(stdin).unwrap();
    drop(pipe);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(DEADLINE) {
        Ok(output) => output.unwrap(),
        Err(_) => {
            // SAFETY: kill(2) with a pid this test spawned and has not yet reaped.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            let output = rx.recv().unwrap().unwrap();
            panic!(
                "vaakora {args:?} still running after {DEADLINE:?}; stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    };
    Ran {
        code: output.status.code(),
        stdout: String::from_utf8(output.stdout).unwrap(),
        stderr: String::from_utf8(output.stderr).unwrap(),
    }
}

fn no_app() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("none.sock");
    (dir, socket)
}

#[test]
fn status_without_app_exits_3() {
    let (_dir, socket) = no_app();
    let ran = run_client(&["status"], &socket, b"");
    assert_eq!(ran.code, Some(3), "stderr: {}", ran.stderr);
    assert!(ran.stderr.contains("not running"), "{}", ran.stderr);
    assert!(!ran.stderr.contains("Gtk"), "{}", ran.stderr);
    assert!(!ran.stderr.contains("panicked"), "{}", ran.stderr);
    assert_eq!(ran.stdout, "");
}

#[test]
fn every_command_without_app_exits_3() {
    let (_dir, socket) = no_app();
    let cases: [(&[&str], &[u8]); 8] = [
        (&["read", "-"], b"Hello."),
        (&["read"], b"Hello."),
        (&["pause"], b""),
        (&["resume"], b""),
        (&["stop"], b""),
        (&["voices"], b""),
        (&["dictate", "--post-process"], b""),
        (&["transcribe", "/nonexistent/a.wav"], b""),
    ];
    for (args, stdin) in cases {
        let ran = run_client(args, &socket, stdin);
        assert_eq!(ran.code, Some(3), "{args:?}: {}", ran.stderr);
        assert!(
            ran.stderr.contains("not running"),
            "{args:?}: {}",
            ran.stderr
        );
        assert!(!ran.stderr.contains("Gtk"), "{args:?}: {}", ran.stderr);
    }
}

#[test]
fn read_with_blank_input_exits_2_before_the_app_is_needed() {
    let (_dir, socket) = no_app();
    let ran = run_client(&["read"], &socket, b"  \n");
    assert_eq!(ran.code, Some(2), "{}", ran.stderr);
    assert!(ran.stderr.contains("nothing to read"), "{}", ran.stderr);
}

#[test]
fn read_has_no_text_option() {
    let (_dir, socket) = no_app();
    let ran = run_client(&["read", "--text", "secret words"], &socket, b"");
    assert_eq!(ran.code, Some(2), "{}", ran.stderr);
    assert!(ran.stderr.contains("--text"), "{}", ran.stderr);
}

#[test]
fn help_lists_the_commands() {
    let (_dir, socket) = no_app();
    let ran = run_client(&["--help"], &socket, b"");
    assert_eq!(ran.code, Some(0), "{}", ran.stderr);
    for name in [
        "read",
        "pause",
        "resume",
        "stop",
        "status",
        "voices",
        "dictate",
        "transcribe",
    ] {
        assert!(
            ran.stdout.lines().any(|l| l.trim_start().starts_with(name)),
            "--help does not list {name}:\n{}",
            ran.stdout
        );
    }
}

struct Recording {
    calls: Mutex<Vec<(String, Option<Value>)>>,
}

impl Methods for Recording {
    fn call(&self, method: &str, params: Option<&Value>) -> Result<Value, RpcError> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.cloned()));
        match method {
            "status" => Ok(json!({
                "server": "vaakora",
                "protocol_version": 1,
                "app_version": "9.9.9",
                "dictation": "idle",
                "reading": { "state": "idle", "visible": false },
                "tts": { "available": true, "model_id": "pocket-en", "voice": "alba", "installed": true },
                "stt": { "selected_model": "parakeet", "installed": true },
            })),
            _ => Ok(json!({})),
        }
    }
}

#[test]
fn the_binary_talks_to_a_running_app_without_a_display() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = dir.path().join("vaakora.sock");
    let listener = bind(&socket).unwrap();
    let app = Arc::new(Recording {
        calls: Mutex::new(Vec::new()),
    });
    let methods: Arc<dyn Methods> = app.clone();
    std::thread::spawn(move || serve(listener, methods));

    let status = run_client(&["status"], &socket, b"");
    assert_eq!(status.code, Some(0), "{}", status.stderr);
    assert!(
        status.stdout.starts_with("Vaakora 9.9.9 (protocol 1)\n"),
        "{}",
        status.stdout
    );

    let read = run_client(&["read"], &socket, b"Hello from a pipe.");
    assert_eq!(read.code, Some(0), "{}", read.stderr);
    assert_eq!((read.stdout.as_str(), read.stderr.as_str()), ("", ""));

    let calls = app.calls.lock().unwrap().clone();
    assert_eq!(calls[0].0, "status");
    assert_eq!(
        calls[1],
        (
            "tts.read".to_string(),
            Some(json!({ "text": "Hello from a pipe." }))
        )
    );
}
