//! `vaakora <command>`: the client mode of the app's binary. It runs before Tauri, the
//! single-instance plugin or GTK start (`main.rs`), talks to the running app over its control
//! socket and exits with a code a script can act on. It never starts the app and starts no
//! process of its own.

mod connection;
mod input;
mod output;

use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::cli::Command;
use crate::ipc::protocol::{ErrorKind, RpcError};
use crate::ipc::socket::{socket_path_from_env, SocketPathError};
use connection::{call, CallError, CALL_TIMEOUT};
use input::{read_text, InputError};

pub(crate) const EXIT_OK: i32 = 0;
pub(crate) const EXIT_APP: i32 = 1;
pub(crate) const EXIT_USAGE: i32 = 2;
pub(crate) const EXIT_UNREACHABLE: i32 = 3;
pub(crate) const EXIT_BUSY: i32 = 4;
pub(crate) const EXIT_SETUP: i32 = 5;

/// Runs `command` against the app on the real stdin, stdout and stderr; returns the exit code.
pub fn run(command: Command) -> i32 {
    let stdin = std::io::stdin();
    let is_terminal = stdin.is_terminal();
    run_with(
        command,
        socket_path_from_env(),
        &mut stdin.lock(),
        is_terminal,
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    )
}

/// [`run`] with its surroundings given. Work that needs no app (the text for `read`, the path for
/// `transcribe`) is done before the socket path is looked at, so such a problem is reported as
/// itself even when the socket path cannot be found.
pub(crate) fn run_with(
    command: Command,
    socket: Result<PathBuf, SocketPathError>,
    stdin: &mut dyn Read,
    stdin_is_terminal: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let timeout = call_timeout(&command);
    let (method, params, reply) = match &command {
        Command::Read { path } => {
            let text = match read_text(path.as_deref(), stdin, stdin_is_terminal) {
                Ok(text) => text,
                Err(e) => return fail(err, EXIT_USAGE, &input_message(&e, path.as_deref())),
            };
            ("tts.read", json!({ "text": text }), Reply::Nothing)
        }
        Command::Pause => ("tts.pause", json!({}), Reply::Changed("nothing is reading")),
        Command::Resume => ("tts.resume", json!({}), Reply::Changed("nothing is paused")),
        Command::Stop => ("tts.stop", json!({}), Reply::Changed("nothing is reading")),
        Command::Status { json } => ("status", json!({}), Reply::Report(*json, status)),
        Command::Voices { json } => ("tts.voices", json!({}), Reply::Report(*json, voices)),
        Command::Dictate {
            post_process,
            cancel,
        } => {
            if *cancel {
                ("dictation.cancel", json!({}), Reply::Nothing)
            } else {
                (
                    "dictation.toggle",
                    json!({ "post_process": post_process }),
                    Reply::Nothing,
                )
            }
        }
        Command::Transcribe { path, json } => {
            let path = match absolute_path(path) {
                Ok(path) => path,
                Err(message) => return fail(err, EXIT_USAGE, message),
            };
            (
                "transcribe.file",
                json!({ "path": path }),
                Reply::Transcript(*json),
            )
        }
    };

    let socket = match socket {
        Ok(path) => path,
        Err(SocketPathError::NoRuntimeDir) => {
            return fail(
                err,
                EXIT_UNREACHABLE,
                "XDG_RUNTIME_DIR is not set; set VAAKORA_SOCKET to the socket path.",
            )
        }
        Err(SocketPathError::TooLong) => {
            return fail(
                err,
                EXIT_UNREACHABLE,
                "the socket path is too long; set VAAKORA_SOCKET to a shorter path.",
            )
        }
    };
    match call(&socket, method, params, timeout) {
        Ok(result) => reply.show(&result, out, err),
        Err(CallError::NotRunning) => fail(
            err,
            EXIT_UNREACHABLE,
            "Vaakora is not running. Start it, then try again.",
        ),
        Err(CallError::NoAnswer) => fail(err, EXIT_UNREACHABLE, "Vaakora did not answer in time."),
        Err(CallError::Rpc(RpcError { kind, message })) => fail(err, exit_code(kind), &message),
    }
}

/// The exit code for an error the app answered with (spec section 6): `busy` is 4, a missing
/// setup is 5, and every other kind is an app error, 1.
pub(crate) fn exit_code(kind: ErrorKind) -> i32 {
    match kind {
        ErrorKind::Busy => EXIT_BUSY,
        ErrorKind::SetupRequired
        | ErrorKind::ModelNotInstalled
        | ErrorKind::TtsUnavailable
        | ErrorKind::TtsModelNotInstalled => EXIT_SETUP,
        ErrorKind::ParseError
        | ErrorKind::InvalidRequest
        | ErrorKind::MethodNotFound
        | ErrorKind::InvalidParams
        | ErrorKind::UnsupportedAudio
        | ErrorKind::FileNotFound
        | ErrorKind::Internal
        | ErrorKind::ProtocolMismatch => EXIT_APP,
    }
}

/// How long a command waits for the app: `transcribe` has no limit (a job may wait behind a
/// dictation), everything else the usual 10 seconds.
fn call_timeout(command: &Command) -> Option<Duration> {
    match command {
        Command::Transcribe { .. } => None,
        _ => Some(CALL_TIMEOUT),
    }
}

/// What a command prints when the call succeeds.
enum Reply {
    /// Nothing (`read`, `dictate`).
    Nothing,
    /// `pause`, `resume`, `stop`: nothing, or this notice on stderr when `changed` is false.
    Changed(&'static str),
    /// `status`, `voices`: the result as JSON, or as text.
    Report(bool, fn(&Value) -> String),
    /// `transcribe`: the text, or the result as JSON.
    Transcript(bool),
}

impl Reply {
    fn show(&self, result: &Value, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
        match self {
            Reply::Nothing => EXIT_OK,
            Reply::Changed(unchanged) => match result.get("changed").and_then(Value::as_bool) {
                Some(true) => EXIT_OK,
                Some(false) => {
                    let _ = writeln!(err, "vaakora: {unchanged}");
                    EXIT_OK
                }
                None => fail(err, EXIT_APP, MALFORMED),
            },
            Reply::Report(true, _) => print(out, err, &result.to_string()),
            Reply::Report(false, text) => print(out, err, &text(result)),
            Reply::Transcript(true) => print(out, err, &result.to_string()),
            Reply::Transcript(false) => match result.get("text").and_then(Value::as_str) {
                Some(text) => print(out, err, text),
                None => fail(err, EXIT_APP, MALFORMED),
            },
        }
    }
}

const MALFORMED: &str = "malformed response";

fn status(result: &Value) -> String {
    output::status_text(result)
}

fn voices(result: &Value) -> String {
    output::voices_text(result)
}

/// Prints `text` and a newline; an output that cannot be written (a closed pipe) is an app error.
fn print(out: &mut dyn Write, err: &mut dyn Write, text: &str) -> i32 {
    match writeln!(out, "{text}").and_then(|()| out.flush()) {
        Ok(()) => EXIT_OK,
        Err(_) => fail(err, EXIT_APP, "could not write the output."),
    }
}

/// Prints `vaakora: <message>` on stderr and returns `code`.
fn fail(err: &mut dyn Write, code: i32, message: &str) -> i32 {
    let _ = writeln!(err, "vaakora: {message}");
    code
}

/// The path as the app needs it: absolute and UTF-8. The app's working directory is not ours.
fn absolute_path(path: &Path) -> Result<String, &'static str> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "could not find the current directory")?
            .join(path)
    };
    absolute
        .into_os_string()
        .into_string()
        .map_err(|_| "the file path is not UTF-8")
}

fn input_message(error: &InputError, path: Option<&Path>) -> String {
    match error {
        InputError::NoInput => {
            "give a file to read, or pipe text in: echo 'text' | vaakora read".to_string()
        }
        InputError::NotAFile => format!(
            "{} is not a file; to read text, pipe it in: echo 'text' | vaakora read",
            path.map_or_else(String::new, |p| p.display().to_string())
        ),
        InputError::NotUtf8 => "the text is not UTF-8".to_string(),
        InputError::Blank => "there is nothing to read".to_string(),
        InputError::TooLong => "the text is too long (at most 1 MiB)".to_string(),
        InputError::Io => "could not read the text".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::{ErrorKind, MAX_LINE_BYTES};
    use crate::ipc::server::{serve, Methods};
    use crate::ipc::socket::{bind, SocketPathError};
    use serde_json::{json, Value};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    /// A recording stand-in for the app's methods. `initialize` is answered by the server itself and
    /// is not seen here (`connection::tests` checks that line).
    struct Fake {
        calls: Mutex<Vec<(String, Option<Value>)>>,
        reply: Mutex<Result<Value, RpcError>>,
    }

    impl Methods for Fake {
        fn call(&self, method: &str, params: Option<&Value>) -> Result<Value, RpcError> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params.cloned()));
            self.reply.lock().unwrap().clone()
        }
    }

    impl Fake {
        fn calls(&self) -> Vec<(String, Option<Value>)> {
            self.calls.lock().unwrap().clone()
        }

        fn methods(&self) -> Vec<String> {
            self.calls().into_iter().map(|c| c.0).collect()
        }
    }

    struct App {
        _dir: tempfile::TempDir,
        path: PathBuf,
        fake: Arc<Fake>,
    }

    fn app(reply: Result<Value, RpcError>) -> App {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("vaakora.sock");
        let listener = bind(&path).unwrap();
        let fake = Arc::new(Fake {
            calls: Mutex::new(Vec::new()),
            reply: Mutex::new(reply),
        });
        let methods: Arc<dyn Methods> = fake.clone();
        std::thread::spawn(move || serve(listener, methods));
        App {
            _dir: dir,
            path,
            fake,
        }
    }

    struct Ran {
        code: i32,
        out: String,
        err: String,
    }

    fn run_on(
        command: Command,
        socket: Result<PathBuf, SocketPathError>,
        stdin: &[u8],
        terminal: bool,
    ) -> Ran {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut stdin = stdin;
        let code = run_with(command, socket, &mut stdin, terminal, &mut out, &mut err);
        Ran {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    fn run_app(app: &App, command: Command) -> Ran {
        run_on(command, Ok(app.path.clone()), b"", false)
    }

    fn read(path: Option<&str>) -> Command {
        Command::Read {
            path: path.map(PathBuf::from),
        }
    }

    fn ok_app() -> App {
        app(Ok(json!({})))
    }

    fn failing_app(kind: ErrorKind) -> App {
        app(Err(RpcError::new(kind, "the app said no")))
    }

    // ---- read ----

    #[test]
    fn read_from_stdin_sends_tts_read() {
        let app = ok_app();
        let ran = run_on(read(None), Ok(app.path.clone()), b"Hello there.", false);
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(ran.out, "");
        assert_eq!(ran.err, "");
        assert_eq!(
            app.fake.calls(),
            vec![(
                "tts.read".to_string(),
                Some(json!({ "text": "Hello there." }))
            )]
        );
        let again = run_on(read(Some("-")), Ok(app.path.clone()), b"Second.", true);
        assert_eq!(again.code, EXIT_OK);
        assert_eq!(app.fake.calls()[1].1, Some(json!({ "text": "Second." })));
    }

    #[test]
    fn read_file_sends_its_text() {
        let app = ok_app();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plan.md");
        std::fs::write(&file, "# Plan\nDo it.\n").unwrap();
        let ran = run_on(
            Command::Read { path: Some(file) },
            Ok(app.path.clone()),
            b"stdin is ignored",
            false,
        );
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(
            app.fake.calls(),
            vec![(
                "tts.read".to_string(),
                Some(json!({ "text": "# Plan\nDo it.\n" }))
            )]
        );
    }

    #[test]
    fn read_with_terminal_stdin_and_no_path_is_usage() {
        let app = ok_app();
        let ran = run_on(read(None), Ok(app.path.clone()), b"typed", true);
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(ran.out, "");
        assert_eq!(
            ran.err,
            "vaakora: give a file to read, or pipe text in: echo 'text' | vaakora read\n"
        );
        assert!(app.fake.calls().is_empty());
    }

    #[test]
    fn read_path_that_is_not_a_file_is_usage() {
        let app = ok_app();
        let dir = tempfile::tempdir().unwrap();
        let ran = run_on(
            Command::Read {
                path: Some(dir.path().to_path_buf()),
            },
            Ok(app.path.clone()),
            b"",
            false,
        );
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(
            ran.err,
            format!(
                "vaakora: {} is not a file; to read text, pipe it in: echo 'text' | vaakora read\n",
                dir.path().display()
            )
        );
        assert!(ran.err.contains("pipe it in"));
        assert!(app.fake.calls().is_empty());
    }

    #[test]
    fn read_blank_is_usage() {
        let app = ok_app();
        let ran = run_on(read(None), Ok(app.path.clone()), b" \n\t", false);
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(ran.err, "vaakora: there is nothing to read\n");
        assert!(app.fake.calls().is_empty());
    }

    #[test]
    fn read_not_utf8_is_usage() {
        let app = ok_app();
        let ran = run_on(read(None), Ok(app.path.clone()), &[0xff, 0xfe], false);
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(ran.err, "vaakora: the text is not UTF-8\n");
        assert!(app.fake.calls().is_empty());
    }

    #[test]
    fn read_too_long_is_usage() {
        let app = ok_app();
        let text = vec![b'a'; MAX_LINE_BYTES];
        let ran = run_on(read(None), Ok(app.path.clone()), &text, false);
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(ran.err, "vaakora: the text is too long (at most 1 MiB)\n");
        assert!(app.fake.calls().is_empty());
    }

    #[test]
    fn read_unreadable_input_is_a_usage_error() {
        struct Broken;
        impl std::io::Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("broken"))
            }
        }
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with(
            read(None),
            Err(SocketPathError::NoRuntimeDir),
            &mut Broken,
            false,
            &mut out,
            &mut err,
        );
        assert_eq!(code, EXIT_USAGE);
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "vaakora: could not read the text\n"
        );
    }

    #[test]
    fn a_line_of_exactly_the_cap_is_served_end_to_end() {
        let app = ok_app();
        let overhead = connection::method_line("tts.read", json!({ "text": "" })).len();
        let fits = MAX_LINE_BYTES - 1 - overhead;
        let text = "a".repeat(fits);
        let ran = run_on(read(None), Ok(app.path.clone()), text.as_bytes(), false);
        assert_eq!((ran.code, ran.err.as_str()), (EXIT_OK, ""));
        let calls = app.fake.calls();
        assert_eq!(calls.len(), 1, "the server took the largest line");
        assert_eq!(calls[0].1, Some(json!({ "text": text })));
    }

    #[test]
    fn one_byte_more_than_the_cap_is_refused_by_the_client() {
        let app = ok_app();
        let overhead = connection::method_line("tts.read", json!({ "text": "" })).len();
        let text = "a".repeat(MAX_LINE_BYTES - overhead);
        let ran = run_on(read(None), Ok(app.path.clone()), text.as_bytes(), false);
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(ran.err, "vaakora: the text is too long (at most 1 MiB)\n");
        assert!(app.fake.calls().is_empty(), "nothing was sent");
    }

    #[test]
    fn input_errors_win_over_a_missing_socket_path() {
        // Local work is done before the socket is looked up: a command that needs no app
        // reports its own problem, not "XDG_RUNTIME_DIR is not set".
        let no_dir = || Err(SocketPathError::NoRuntimeDir);
        assert_eq!(run_on(read(None), no_dir(), b" ", false).code, EXIT_USAGE);
        assert_eq!(run_on(read(None), no_dir(), b"x", true).code, EXIT_USAGE);
        assert_eq!(
            run_on(read(None), no_dir(), b"text", false).code,
            EXIT_UNREACHABLE
        );
    }

    // ---- reaching the app ----

    #[test]
    fn missing_socket_exits_3() {
        let dir = tempfile::tempdir().unwrap();
        let ran = run_on(
            Command::Status { json: false },
            Ok(dir.path().join("none.sock")),
            b"",
            false,
        );
        assert_eq!(ran.code, EXIT_UNREACHABLE);
        assert_eq!(ran.out, "");
        assert_eq!(
            ran.err,
            "vaakora: Vaakora is not running. Start it, then try again.\n"
        );
    }

    #[test]
    fn stale_socket_exits_3() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("vaakora.sock");
        drop(bind(&path).unwrap());
        assert!(path.exists(), "the socket file is left behind");
        let ran = run_on(Command::Stop, Ok(path), b"", false);
        assert_eq!(ran.code, EXIT_UNREACHABLE);
        assert!(ran.err.contains("not running"), "{}", ran.err);
    }

    #[test]
    fn no_runtime_dir_exits_3() {
        let ran = run_on(
            Command::Pause,
            Err(SocketPathError::NoRuntimeDir),
            b"",
            false,
        );
        assert_eq!(ran.code, EXIT_UNREACHABLE);
        assert_eq!(
            ran.err,
            "vaakora: XDG_RUNTIME_DIR is not set; set VAAKORA_SOCKET to the socket path.\n"
        );
    }

    #[test]
    fn a_too_long_socket_path_exits_3() {
        let ran = run_on(Command::Pause, Err(SocketPathError::TooLong), b"", false);
        assert_eq!(ran.code, EXIT_UNREACHABLE);
        assert_eq!(
            ran.err,
            "vaakora: the socket path is too long; set VAAKORA_SOCKET to a shorter path.\n"
        );
    }

    #[test]
    fn busy_exits_4() {
        let app = failing_app(ErrorKind::Busy);
        let ran = run_on(read(None), Ok(app.path.clone()), b"text", false);
        assert_eq!(ran.code, EXIT_BUSY);
        assert_eq!(ran.err, "vaakora: the app said no\n");
        assert_eq!(ran.out, "");
    }

    #[test]
    fn setup_kinds_exit_5() {
        for kind in [
            ErrorKind::SetupRequired,
            ErrorKind::ModelNotInstalled,
            ErrorKind::TtsUnavailable,
            ErrorKind::TtsModelNotInstalled,
        ] {
            let app = failing_app(kind);
            let ran = run_app(&app, Command::Status { json: false });
            assert_eq!(ran.code, EXIT_SETUP, "{kind:?}");
            assert_eq!(ran.err, "vaakora: the app said no\n", "{kind:?}");
        }
    }

    #[test]
    fn app_errors_exit_1() {
        for kind in [
            ErrorKind::Internal,
            ErrorKind::UnsupportedAudio,
            ErrorKind::FileNotFound,
            ErrorKind::MethodNotFound,
            ErrorKind::ProtocolMismatch,
            ErrorKind::ParseError,
            ErrorKind::InvalidRequest,
            ErrorKind::InvalidParams,
        ] {
            let app = failing_app(kind);
            let ran = run_app(&app, Command::Stop);
            assert_eq!(ran.code, EXIT_APP, "{kind:?}");
            assert_eq!(ran.err, "vaakora: the app said no\n", "{kind:?}");
        }
    }

    #[test]
    fn every_error_kind_has_its_exit_code() {
        let table = [
            (ErrorKind::ParseError, EXIT_APP),
            (ErrorKind::InvalidRequest, EXIT_APP),
            (ErrorKind::MethodNotFound, EXIT_APP),
            (ErrorKind::InvalidParams, EXIT_APP),
            (ErrorKind::Busy, EXIT_BUSY),
            (ErrorKind::SetupRequired, EXIT_SETUP),
            (ErrorKind::ModelNotInstalled, EXIT_SETUP),
            (ErrorKind::UnsupportedAudio, EXIT_APP),
            (ErrorKind::FileNotFound, EXIT_APP),
            (ErrorKind::Internal, EXIT_APP),
            (ErrorKind::ProtocolMismatch, EXIT_APP),
            (ErrorKind::TtsUnavailable, EXIT_SETUP),
            (ErrorKind::TtsModelNotInstalled, EXIT_SETUP),
        ];
        for (kind, code) in table {
            assert_eq!(exit_code(kind), code, "{kind:?}");
        }
        assert_eq!(
            (
                EXIT_OK,
                EXIT_APP,
                EXIT_USAGE,
                EXIT_UNREACHABLE,
                EXIT_BUSY,
                EXIT_SETUP
            ),
            (0, 1, 2, 3, 4, 5)
        );
    }

    #[test]
    fn only_transcribe_waits_without_a_limit() {
        let transcribe = Command::Transcribe {
            path: PathBuf::from("a.wav"),
            json: false,
        };
        assert_eq!(call_timeout(&transcribe), None);
        for command in [
            read(None),
            Command::Pause,
            Command::Resume,
            Command::Stop,
            Command::Status { json: false },
            Command::Voices { json: false },
            Command::Dictate {
                post_process: false,
                cancel: false,
            },
        ] {
            assert_eq!(call_timeout(&command), Some(CALL_TIMEOUT), "{command:?}");
        }
    }

    // ---- pause, resume, stop ----

    #[test]
    fn pause_resume_and_stop_call_their_methods() {
        let app = app(Ok(json!({ "changed": true })));
        for (command, method) in [
            (Command::Pause, "tts.pause"),
            (Command::Resume, "tts.resume"),
            (Command::Stop, "tts.stop"),
        ] {
            let ran = run_app(&app, command);
            assert_eq!(
                (ran.code, ran.out.as_str(), ran.err.as_str()),
                (EXIT_OK, "", "")
            );
            assert_eq!(app.fake.methods().last().unwrap(), method);
        }
    }

    #[test]
    fn pause_with_nothing_reading_says_so() {
        let app = app(Ok(json!({ "changed": false })));
        let ran = run_app(&app, Command::Pause);
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(ran.out, "");
        assert_eq!(ran.err, "vaakora: nothing is reading\n");
        let ran = run_app(&app, Command::Stop);
        assert_eq!(
            (ran.code, ran.err.as_str()),
            (EXIT_OK, "vaakora: nothing is reading\n")
        );
        let ran = run_app(&app, Command::Resume);
        assert_eq!(
            (ran.code, ran.err.as_str()),
            (EXIT_OK, "vaakora: nothing is paused\n")
        );
    }

    #[test]
    fn a_reply_without_changed_is_malformed() {
        let app = ok_app();
        let ran = run_app(&app, Command::Pause);
        assert_eq!(ran.code, EXIT_APP);
        assert_eq!(ran.err, "vaakora: malformed response\n");
    }

    // ---- status, voices ----

    fn status_reply() -> Value {
        json!({
            "server": "vaakora",
            "protocol_version": 1,
            "app_version": "0.2.0",
            "dictation": "idle",
            "reading": { "state": "paused", "visible": true },
            "tts": { "available": true, "model_id": "pocket-en", "voice": "alba", "installed": true },
            "stt": { "selected_model": "", "installed": false },
        })
    }

    #[test]
    fn status_prints_lines() {
        let app = app(Ok(status_reply()));
        let ran = run_app(&app, Command::Status { json: false });
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(ran.err, "");
        assert_eq!(
            ran.out,
            "Vaakora 0.2.0 (protocol 1)\n\
             Dictation: idle\n\
             Read aloud: paused, reader open\n\
             Voice: pocket-en, alba (installed)\n\
             Speech to text: none (not downloaded)\n"
        );
        assert_eq!(app.fake.methods(), ["status"]);
    }

    #[test]
    fn status_json_prints_the_result() {
        let app = app(Ok(status_reply()));
        let ran = run_app(&app, Command::Status { json: true });
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(ran.out, format!("{}\n", status_reply()));
        let back: Value = serde_json::from_str(&ran.out).unwrap();
        assert_eq!(back, status_reply());
    }

    fn voices_reply() -> Value {
        json!({
            "model_id": "kokoro",
            "voice": "af_bella",
            "models": [
                { "id": "pocket-en", "name": "Pocket TTS", "voices": ["alba"], "default_voice": "alba" },
                { "id": "kokoro", "name": "Kokoro", "voices": ["af_heart", "af_bella"], "default_voice": "af_heart" },
            ],
        })
    }

    #[test]
    fn voices_marks_the_selection() {
        let app = app(Ok(voices_reply()));
        let ran = run_app(&app, Command::Voices { json: false });
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(
            ran.out,
            "pocket-en: alba\n* kokoro: af_heart, af_bella (selected)\n"
        );
        assert_eq!(app.fake.methods(), ["tts.voices"]);
        let json_run = run_app(&app, Command::Voices { json: true });
        assert_eq!(json_run.out, format!("{}\n", voices_reply()));
    }

    // ---- transcribe, dictate ----

    #[test]
    fn transcribe_sends_an_absolute_path() {
        let app = app(Ok(json!({ "text": "hello world", "history_id": 7 })));
        let relative = run_app(
            &app,
            Command::Transcribe {
                path: PathBuf::from("a.wav"),
                json: false,
            },
        );
        assert_eq!(relative.code, EXIT_OK);
        assert_eq!(relative.out, "hello world\n");
        let cwd = std::env::current_dir().unwrap();
        let sent = app.fake.calls()[0].clone();
        assert_eq!(sent.0, "transcribe.file");
        assert_eq!(
            sent.1,
            Some(json!({ "path": cwd.join("a.wav").to_str().unwrap() }))
        );

        let absolute = cwd.join("sub").join("b.wav");
        let ran = run_app(
            &app,
            Command::Transcribe {
                path: absolute.clone(),
                json: true,
            },
        );
        assert_eq!(ran.code, EXIT_OK);
        assert_eq!(
            app.fake.calls()[1].1,
            Some(json!({ "path": absolute.to_str().unwrap() })),
            "an absolute path goes unchanged"
        );
        assert_eq!(
            ran.out,
            format!("{}\n", json!({ "text": "hello world", "history_id": 7 }))
        );
    }

    #[test]
    fn transcribe_path_that_is_not_utf8_is_usage() {
        use std::os::unix::ffi::OsStrExt;
        let app = ok_app();
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\xff.wav"));
        let ran = run_app(&app, Command::Transcribe { path, json: false });
        assert_eq!(ran.code, EXIT_USAGE);
        assert_eq!(ran.err, "vaakora: the file path is not UTF-8\n");
        assert!(app.fake.calls().is_empty());
    }

    #[test]
    fn transcribe_reply_without_text_is_malformed() {
        let app = app(Ok(json!({ "history_id": 7 })));
        let ran = run_app(
            &app,
            Command::Transcribe {
                path: PathBuf::from("/a.wav"),
                json: false,
            },
        );
        assert_eq!((ran.code, ran.out.as_str()), (EXIT_APP, ""));
        assert_eq!(ran.err, "vaakora: malformed response\n");
    }

    #[test]
    fn dictate_variants() {
        let app = ok_app();
        let cases = [
            (
                false,
                false,
                "dictation.toggle",
                json!({ "post_process": false }),
            ),
            (
                true,
                false,
                "dictation.toggle",
                json!({ "post_process": true }),
            ),
            (false, true, "dictation.cancel", json!({})),
        ];
        for (n, (post_process, cancel, method, params)) in cases.into_iter().enumerate() {
            let ran = run_app(
                &app,
                Command::Dictate {
                    post_process,
                    cancel,
                },
            );
            assert_eq!(
                (ran.code, ran.out.as_str(), ran.err.as_str()),
                (EXIT_OK, "", "")
            );
            assert_eq!(app.fake.calls()[n], (method.to_string(), Some(params)));
        }
    }

    // ---- no process, ever ----

    fn source_files(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                source_files(&path, found);
            } else {
                found.push(path);
            }
        }
    }

    #[test]
    fn client_starts_no_process() {
        // Needles are assembled so that this file does not contain them itself.
        let needles = [
            format!("{}::{}", "process", "Command"),
            format!("{}::new(", "Command"),
        ];
        let mut files = Vec::new();
        source_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src/client"),
            &mut files,
        );
        assert!(files.len() >= 4, "{files:?}");
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap();
            for needle in &needles {
                assert!(
                    !source.contains(needle.as_str()),
                    "{} starts a process ({needle})",
                    file.display()
                );
            }
        }
    }
}
