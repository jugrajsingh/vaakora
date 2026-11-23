//! One connection to the running app: `initialize`, then the method, then close.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::ipc::protocol::{parse_response, request_line, RpcError, PROTOCOL_VERSION};

/// Read and write limit of every call except `transcribe.file`.
pub(crate) const CALL_TIMEOUT: Duration = Duration::from_secs(10);

const INITIALIZE_ID: u64 = 1;
const METHOD_ID: u64 = 2;

/// Why a call did not return a result.
#[derive(Debug)]
pub(crate) enum CallError {
    /// Nothing listens at the socket path (missing, or left behind by a crashed app).
    NotRunning,
    /// Something is there but did not talk to us in time, or hung up.
    NoAnswer,
    /// The app answered with an error.
    Rpc(RpcError),
}

/// The request line (no newline) a call sends for `method`; the client checks its length
/// against the server's limit with the very function that builds it.
pub(crate) fn method_line(method: &str, params: Value) -> String {
    request_line(METHOD_ID, method, params)
}

/// Calls `method` on the app at `path`. `timeout` limits every read and write; `None` (for a job
/// that may wait behind a dictation) waits as long as the app takes to answer the method, while
/// the handshake that comes first still has the usual limit.
pub(crate) fn call(
    path: &Path,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, CallError> {
    call_with(
        path,
        method,
        params,
        timeout,
        timeout.unwrap_or(CALL_TIMEOUT),
    )
}

/// [`call`] with the write and handshake limit given (so tests need not wait ten seconds).
pub(crate) fn call_with(
    path: &Path,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
    handshake: Duration,
) -> Result<Value, CallError> {
    let stream = connect(path)?;
    stream
        .set_write_timeout(Some(handshake))
        .and_then(|()| stream.set_read_timeout(Some(handshake)))
        .map_err(|_| CallError::NoAnswer)?;
    let mut writer = stream.try_clone().map_err(|_| CallError::NoAnswer)?;
    let mut reader = BufReader::new(stream);

    let initialize = request_line(
        INITIALIZE_ID,
        "initialize",
        json!({
            "protocol_version": PROTOCOL_VERSION,
            "client": format!("vaakora-cli/{}", env!("CARGO_PKG_VERSION")),
        }),
    );
    exchange(&mut writer, &mut reader, &initialize, INITIALIZE_ID)?;

    reader
        .get_ref()
        .set_read_timeout(timeout)
        .map_err(|_| CallError::NoAnswer)?;
    exchange(
        &mut writer,
        &mut reader,
        &method_line(method, params),
        METHOD_ID,
    )
}

fn connect(path: &Path) -> Result<UnixStream, CallError> {
    UnixStream::connect(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => CallError::NotRunning,
        _ => CallError::NoAnswer,
    })
}

/// Sends one request line and reads its reply line.
fn exchange(
    writer: &mut UnixStream,
    reader: &mut BufReader<UnixStream>,
    line: &str,
    id: u64,
) -> Result<Value, CallError> {
    writer
        .write_all(line.as_bytes())
        .and_then(|()| writer.write_all(b"\n"))
        .map_err(|_| CallError::NoAnswer)?;
    let mut reply = String::new();
    match reader.read_line(&mut reply) {
        Ok(0) | Err(_) => Err(CallError::NoAnswer),
        Ok(_) => parse_response(&reply, id).map_err(CallError::Rpc),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::{error_response, success_response, ErrorKind};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread::JoinHandle;

    const SHORT: Duration = Duration::from_millis(200);

    /// A scripted server: `script` gets the request lines it reads from the one connection it accepts.
    struct Scripted {
        _dir: tempfile::TempDir,
        path: PathBuf,
        thread: JoinHandle<()>,
    }

    fn scripted(script: impl FnOnce(&mut Lines, &mut UnixStream) + Send + 'static) -> Scripted {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream);
            script(&mut lines, &mut writer);
        });
        Scripted {
            _dir: dir,
            path,
            thread,
        }
    }

    type Lines = BufReader<UnixStream>;

    fn next_line(lines: &mut Lines) -> Value {
        let mut raw = String::new();
        lines.read_line(&mut raw).unwrap();
        assert!(raw.ends_with('\n'), "a request is one line: {raw:?}");
        serde_json::from_str(&raw).unwrap()
    }

    fn send(writer: &mut UnixStream, line: &str) {
        writer.write_all(line.as_bytes()).unwrap();
        writer.write_all(b"\n").unwrap();
    }

    fn init_reply() -> String {
        success_response(
            &json!(1),
            json!({ "server": "vaakora", "protocol_version": 1 }),
        )
    }

    #[test]
    fn the_call_timeout_is_ten_seconds() {
        assert_eq!(CALL_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn call_sends_initialize_then_the_method_on_one_connection() {
        let (tx, rx) = mpsc::channel();
        let server = scripted(move |lines, writer| {
            let first = next_line(lines);
            send(writer, &init_reply());
            let second = next_line(lines);
            send(
                writer,
                &success_response(&json!(2), json!({ "changed": true })),
            );
            tx.send((first, second)).unwrap();
        });
        let got = call(&server.path, "tts.pause", json!({}), Some(CALL_TIMEOUT)).unwrap();
        assert_eq!(got, json!({ "changed": true }));
        server.thread.join().unwrap();
        let (first, second) = rx.recv().unwrap();
        assert_eq!(first["jsonrpc"], "2.0");
        assert_eq!(first["id"], 1);
        assert_eq!(first["method"], "initialize");
        assert_eq!(
            first["params"],
            json!({
                "protocol_version": 1,
                "client": format!("vaakora-cli/{}", env!("CARGO_PKG_VERSION")),
            })
        );
        assert_eq!(second["id"], 2);
        assert_eq!(second["method"], "tts.pause");
        assert_eq!(second["params"], json!({}));
    }

    #[test]
    fn method_line_is_the_line_that_is_sent() {
        let params = json!({ "text": "one\ntwo" });
        let line = method_line("tts.read", params.clone());
        assert_eq!(line, request_line(2, "tts.read", params));
        assert!(!line.contains('\n'), "a newline in the text is escaped");
    }

    #[test]
    fn a_missing_socket_is_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let got = call(
            &dir.path().join("none.sock"),
            "status",
            json!({}),
            Some(SHORT),
        );
        assert!(matches!(got, Err(CallError::NotRunning)), "{got:?}");
    }

    #[test]
    fn a_stale_socket_is_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale.sock");
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists(), "the socket file is left behind");
        let got = call(&path, "status", json!({}), Some(SHORT));
        assert!(matches!(got, Err(CallError::NotRunning)), "{got:?}");
    }

    #[test]
    fn another_connect_error_is_no_answer() {
        // A path longer than a socket address allows is refused by the connect call itself.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x".repeat(200));
        let got = call(&path, "status", json!({}), Some(SHORT));
        assert!(matches!(got, Err(CallError::NoAnswer)), "{got:?}");
    }

    #[test]
    fn a_server_that_never_answers_times_out() {
        let (release, wait) = mpsc::channel::<()>();
        let server = scripted(move |lines, _| {
            next_line(lines);
            let _ = wait.recv();
        });
        let started = std::time::Instant::now();
        let got = call(&server.path, "status", json!({}), Some(SHORT));
        assert!(matches!(got, Err(CallError::NoAnswer)), "{got:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
        release.send(()).unwrap();
        server.thread.join().unwrap();
    }

    #[test]
    fn a_method_reply_slower_than_the_timeout_is_no_answer() {
        let (release, wait) = mpsc::channel::<()>();
        let server = scripted(move |lines, writer| {
            next_line(lines);
            send(writer, &init_reply());
            next_line(lines);
            let _ = wait.recv();
        });
        let got = call_with(&server.path, "status", json!({}), Some(SHORT), SHORT);
        assert!(matches!(got, Err(CallError::NoAnswer)), "{got:?}");
        release.send(()).unwrap();
        server.thread.join().unwrap();
    }

    #[test]
    fn no_timeout_waits_for_a_slow_method_reply() {
        let server = scripted(|lines, writer| {
            next_line(lines);
            send(writer, &init_reply());
            next_line(lines);
            std::thread::sleep(SHORT * 4);
            send(
                writer,
                &success_response(&json!(2), json!({ "text": "done" })),
            );
        });
        // The handshake limit is SHORT; the method reply takes four times that.
        let got = call_with(&server.path, "transcribe.file", json!({}), None, SHORT);
        assert_eq!(got.unwrap(), json!({ "text": "done" }));
        server.thread.join().unwrap();
    }

    #[test]
    fn no_timeout_still_bounds_the_handshake() {
        let (release, wait) = mpsc::channel::<()>();
        let server = scripted(move |lines, _| {
            next_line(lines);
            let _ = wait.recv();
        });
        let got = call_with(&server.path, "transcribe.file", json!({}), None, SHORT);
        assert!(matches!(got, Err(CallError::NoAnswer)), "{got:?}");
        release.send(()).unwrap();
        server.thread.join().unwrap();
    }

    #[test]
    fn a_server_that_hangs_up_is_no_answer() {
        let server = scripted(|lines, _| {
            next_line(lines);
        });
        let got = call(&server.path, "status", json!({}), Some(CALL_TIMEOUT));
        assert!(matches!(got, Err(CallError::NoAnswer)), "{got:?}");
        server.thread.join().unwrap();
    }

    #[test]
    fn an_error_reply_carries_its_kind() {
        let server = scripted(|lines, writer| {
            next_line(lines);
            send(writer, &init_reply());
            next_line(lines);
            let error = RpcError::new(ErrorKind::Busy, "a dictation is in progress");
            send(writer, &error_response(&json!(2), &error));
        });
        match call(&server.path, "tts.read", json!({}), Some(CALL_TIMEOUT)) {
            Err(CallError::Rpc(e)) => {
                assert_eq!(e.kind, ErrorKind::Busy);
                assert_eq!(e.message, "a dictation is in progress");
            }
            other => panic!("{other:?}"),
        }
        server.thread.join().unwrap();
    }

    #[test]
    fn a_refused_initialize_stops_before_the_method() {
        let (tx, rx) = mpsc::channel();
        let server = scripted(move |lines, writer| {
            next_line(lines);
            let error = RpcError::new(ErrorKind::ProtocolMismatch, "unsupported protocol version");
            send(writer, &error_response(&json!(1), &error));
            let mut rest = String::new();
            tx.send(lines.read_line(&mut rest).unwrap()).unwrap();
        });
        match call(&server.path, "status", json!({}), Some(CALL_TIMEOUT)) {
            Err(CallError::Rpc(e)) => assert_eq!(e.kind, ErrorKind::ProtocolMismatch),
            other => panic!("{other:?}"),
        }
        server.thread.join().unwrap();
        assert_eq!(
            rx.recv().unwrap(),
            0,
            "the client sent no method after the refusal"
        );
    }

    #[test]
    fn a_reply_that_is_not_json_rpc_is_malformed() {
        let server = scripted(|lines, writer| {
            next_line(lines);
            send(writer, "this is not json");
        });
        match call(&server.path, "status", json!({}), Some(CALL_TIMEOUT)) {
            Err(CallError::Rpc(e)) => {
                assert_eq!(e.kind, ErrorKind::Internal);
                assert_eq!(e.message, "malformed response");
            }
            other => panic!("{other:?}"),
        }
        server.thread.join().unwrap();
    }
}
