//! Accept loop, framing and dispatch. One thread per connection; requests on a
//! connection are answered in order. `initialize` is answered here, every other
//! method goes to [`Methods`].
//!
//! Logging: per request only [`request_summary`] (method name, outcome kind,
//! byte count). Request text, params, replies and serde's error text never
//! reach a log line or an error message.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::protocol::{
    error_response, success_response, ErrorKind, Request, RpcError, MAX_LINE_BYTES,
    PROTOCOL_VERSION,
};
use super::socket;

/// The app's methods (everything except `initialize`).
pub trait Methods: Send + Sync + 'static {
    fn call(&self, method: &str, params: Option<&Value>) -> Result<Value, RpcError>;
}

/// How long the server waits for the whole of the next request line.
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

const PARSE_ERROR_MESSAGE: &str = "invalid JSON";
const INVALID_REQUEST_MESSAGE: &str = "invalid request";
const LINE_TOO_LONG_MESSAGE: &str = "request line too long";
const MAX_LOGGED_METHOD_BYTES: usize = 64;
/// Stands in for the method in summaries of lines that are not requests.
const NO_METHOD: &str = "-";

/// Blocks, accepting connections. A peer that is not this user is dropped
/// without a reply.
pub fn serve(listener: UnixListener, methods: Arc<dyn Methods>) {
    let own_uid = socket::own_uid();
    for conn in listener.incoming() {
        let stream = match conn {
            Ok(stream) => stream,
            Err(e) => {
                log::warn!("IPC accept failed: {:?}", e.kind());
                // Errors such as EMFILE repeat at once; do not spin on them.
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let peer = socket::peer_uid(&stream);
        let shown = match &peer {
            Ok(uid) => uid.to_string(),
            Err(_) => "unknown".to_string(),
        };
        if !admit(peer, own_uid) {
            log::warn!("IPC refused a connection from uid {shown}");
            continue;
        }
        let methods = Arc::clone(&methods);
        let spawned = thread::Builder::new()
            .name("ipc-conn".into())
            .spawn(move || handle_connection(stream, methods.as_ref(), IDLE_TIMEOUT));
        if let Err(e) = spawned {
            log::warn!("IPC connection thread failed: {:?}", e.kind());
        }
    }
}

/// The accept decision: only a peer whose uid is known and equal to ours.
pub(crate) fn admit(peer: io::Result<u32>, own_uid: u32) -> bool {
    match peer {
        Ok(uid) => socket::authorized(uid, own_uid),
        Err(_) => false,
    }
}

/// Reads through a deadline: the whole next request must arrive within the
/// idle timeout, so a client sending one byte at a time cannot hold the
/// connection either.
struct DeadlineReader<'a> {
    stream: &'a UnixStream,
    deadline: Instant,
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(Some(left))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

pub(crate) fn handle_connection(stream: UnixStream, methods: &dyn Methods, idle: Duration) {
    if stream.set_write_timeout(Some(WRITE_TIMEOUT)).is_err() {
        return;
    }
    let mut reader = BufReader::new(DeadlineReader {
        stream: &stream,
        deadline: Instant::now() + idle,
    });
    let mut line = Vec::new();
    loop {
        reader.get_mut().deadline = Instant::now() + idle;
        line.clear();
        let read = (&mut reader)
            .take(MAX_LINE_BYTES as u64)
            .read_until(b'\n', &mut line);
        let bytes = match read {
            Ok(0) | Err(_) => return,
            Ok(bytes) => bytes,
        };
        if bytes >= MAX_LINE_BYTES && !line.ends_with(b"\n") {
            // No way to find the next line again: answer, then close.
            log::debug!(
                "{}",
                request_summary(NO_METHOD, Err(ErrorKind::InvalidRequest), bytes)
            );
            let error = RpcError::new(ErrorKind::InvalidRequest, LINE_TOO_LONG_MESSAGE);
            let _ = write_reply(&stream, &error_response(&Value::Null, &error));
            return;
        }
        let reply = match std::str::from_utf8(&line) {
            Ok(text) if text.trim().is_empty() => continue,
            Ok(text) => handle_line(methods, text),
            Err(_) => {
                log::debug!(
                    "{}",
                    request_summary(NO_METHOD, Err(ErrorKind::ParseError), bytes)
                );
                let error = RpcError::new(ErrorKind::ParseError, PARSE_ERROR_MESSAGE);
                Some(error_response(&Value::Null, &error))
            }
        };
        if let Some(reply) = reply {
            if write_reply(&stream, &reply).is_err() {
                return;
            }
        }
    }
}

fn write_reply(mut stream: &UnixStream, reply: &str) -> io::Result<()> {
    let mut out = Vec::with_capacity(reply.len() + 1);
    out.extend_from_slice(reply.as_bytes());
    out.push(b'\n');
    stream.write_all(&out)
}

/// Answers one request line (without framing). `None` for a notification.
/// Logs the line's summary.
pub(crate) fn handle_line(methods: &dyn Methods, line: &str) -> Option<String> {
    let (reply, method, outcome) = answer(methods, line);
    log::debug!("{}", request_summary(&method, outcome, line.len()));
    reply
}

fn answer(methods: &dyn Methods, line: &str) -> (Option<String>, String, Result<(), ErrorKind>) {
    let refuse = |id: Value, kind: ErrorKind, message: &str| {
        let reply = error_response(&id, &RpcError::new(kind, message));
        (Some(reply), NO_METHOD.to_string(), Err(kind))
    };
    // serde's error text can quote the input, so it is never used.
    let raw: Value = match serde_json::from_str(line) {
        Ok(raw) => raw,
        Err(_) => return refuse(Value::Null, ErrorKind::ParseError, PARSE_ERROR_MESSAGE),
    };
    if !raw.is_object() {
        return refuse(
            Value::Null,
            ErrorKind::InvalidRequest,
            INVALID_REQUEST_MESSAGE,
        );
    }
    let id = raw.get("id").cloned().unwrap_or(Value::Null);
    let request: Request = match serde_json::from_value(raw) {
        Ok(request) => request,
        Err(_) => return refuse(id, ErrorKind::InvalidRequest, INVALID_REQUEST_MESSAGE),
    };
    let result = if request.method == "initialize" {
        initialize(request.params.as_ref())
    } else {
        methods.call(&request.method, request.params.as_ref())
    };
    let outcome = result.as_ref().map(|_| ()).map_err(|e| e.kind);
    let reply = request.id.map(|id| match result {
        Ok(value) => success_response(&id, value),
        Err(error) => error_response(&id, &error),
    });
    (reply, request.method, outcome)
}

/// `{protocol_version?: u64, client?: string}`; a version other than ours is refused.
pub(crate) fn initialize(params: Option<&Value>) -> Result<Value, RpcError> {
    let invalid = || RpcError::new(ErrorKind::InvalidParams, "invalid params");
    let requested = match params {
        None => None,
        Some(Value::Object(fields)) => match fields.get("protocol_version") {
            None | Some(Value::Null) => None,
            Some(version) => Some(version.as_u64().ok_or_else(invalid)?),
        },
        Some(_) => return Err(invalid()),
    };
    if requested.is_some_and(|version| version != PROTOCOL_VERSION) {
        return Err(RpcError::new(
            ErrorKind::ProtocolMismatch,
            format!("unsupported protocol version; this app speaks version {PROTOCOL_VERSION}"),
        ));
    }
    Ok(json!({
        "server": crate::brand::PACKAGE_NAME,
        "protocol_version": PROTOCOL_VERSION,
        "app_version": env!("CARGO_PKG_VERSION"),
    }))
}

/// The only text the server logs per request. An unknown method is shown as
/// `<unknown>` and an over-long one as `<long>`, so a client cannot put text in
/// the log through the method name.
pub(crate) fn request_summary(
    method: &str,
    outcome: Result<(), ErrorKind>,
    bytes: usize,
) -> String {
    let shown = if outcome == Err(ErrorKind::MethodNotFound) {
        "<unknown>"
    } else if method.len() > MAX_LOGGED_METHOD_BYTES {
        "<long>"
    } else {
        method
    };
    let result = match outcome {
        Ok(()) => "ok",
        Err(kind) => kind.kind_str(),
    };
    format!("ipc {shown} {result} {bytes} bytes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::RpcError;
    use crate::ipc::socket;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{mpsc, Mutex};
    use std::time::Instant;

    /// Records every call and answers `{"method": <name>}`, or the configured error.
    struct Fake {
        calls: Mutex<Vec<String>>,
        error: Option<RpcError>,
    }

    impl Fake {
        fn ok() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                error: None,
            }
        }

        fn failing(error: RpcError) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                error: Some(error),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Methods for Fake {
        fn call(&self, method: &str, _params: Option<&Value>) -> Result<Value, RpcError> {
            self.calls.lock().unwrap().push(method.to_string());
            match &self.error {
                Some(error) => Err(error.clone()),
                None => Ok(json!({ "method": method })),
            }
        }
    }

    fn reply(methods: &dyn Methods, line: &str) -> (String, Value) {
        let raw = handle_line(methods, line).expect("a request with an id gets a reply");
        let value = serde_json::from_str(&raw).unwrap();
        (raw, value)
    }

    fn read_reply(lines: &mut impl BufRead) -> Value {
        let mut line = String::new();
        lines.read_line(&mut line).unwrap();
        assert!(line.ends_with('\n'), "reply is one line: {line:?}");
        serde_json::from_str(&line).unwrap()
    }

    /// Runs one connection on a socket pair; the receiver fires when the server side ends.
    fn connection(methods: Arc<dyn Methods>, idle: Duration) -> (UnixStream, mpsc::Receiver<()>) {
        let (server, client) = UnixStream::pair().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            handle_connection(server, methods.as_ref(), idle);
            let _ = done_tx.send(());
        });
        (client, done_rx)
    }

    fn closed(stream: &mut BufReader<UnixStream>) -> bool {
        let mut rest = String::new();
        match stream.read_line(&mut rest) {
            Ok(0) => true,
            Err(e) => e.kind() == std::io::ErrorKind::ConnectionReset,
            Ok(_) => false,
        }
    }

    #[test]
    fn notification_gets_no_reply() {
        let fake = Fake::ok();
        assert_eq!(
            handle_line(&fake, r#"{"jsonrpc":"2.0","method":"tts.stop"}"#),
            None
        );
        assert_eq!(fake.calls(), vec!["tts.stop".to_string()]);
    }

    #[test]
    fn method_results_and_errors_carry_the_id() {
        let fake = Fake::ok();
        let (_, v) = reply(&fake, r#"{"jsonrpc":"2.0","id":5,"method":"status"}"#);
        assert_eq!(v["id"], 5);
        assert_eq!(v["result"]["method"], "status");

        let busy = Fake::failing(RpcError::new(ErrorKind::Busy, "a dictation is in progress"));
        let (_, v) = reply(&busy, r#"{"jsonrpc":"2.0","id":"x","method":"tts.read"}"#);
        assert_eq!(v["id"], "x");
        assert_eq!(v["error"]["code"], 1000);
        assert_eq!(v["error"]["data"]["kind"], "busy");
        assert_eq!(v["error"]["message"], "a dictation is in progress");
    }

    #[test]
    fn parse_error_has_fixed_message() {
        let fake = Fake::ok();
        let (raw, v) = reply(
            &fake,
            r#"{"jsonrpc":"2.0","id":1,"method":"tts.read","params":{"text":"secret words""#,
        );
        assert_eq!(v["error"]["code"], -32700);
        assert_eq!(v["error"]["message"], "invalid JSON");
        assert_eq!(v["error"]["data"]["kind"], "parse-error");
        assert_eq!(v["id"], Value::Null);
        assert!(!raw.contains("secret"), "{raw}");
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn invalid_request_has_fixed_message() {
        let fake = Fake::ok();
        let (raw, v) = reply(&fake, r#"{"id":1,"params":{"text":"secret words"}}"#);
        assert_eq!(v["error"]["code"], -32600);
        assert_eq!(v["error"]["message"], "invalid request");
        assert_eq!(v["id"], 1);
        assert!(!raw.contains("secret"), "{raw}");

        let (raw, v) = reply(&fake, r#"{"id":2,"method":["secret words"]}"#);
        assert_eq!(v["error"]["message"], "invalid request");
        assert_eq!(v["id"], 2);
        assert!(!raw.contains("secret"), "{raw}");

        // A JSON value that is not an object (a batch, for example) is not a request.
        let (raw, v) = reply(&fake, r#"[1,"secret words",null]"#);
        assert_eq!(v["error"]["code"], -32600);
        assert_eq!(v["id"], Value::Null);
        assert!(!raw.contains("secret"), "{raw}");
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn initialize_reports_version() {
        let fake = Fake::ok();
        let (_, v) = reply(
            &fake,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_version":1,"client":"test"}}"#,
        );
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["server"], "vaakora");
        assert_eq!(v["result"]["protocol_version"], 1);
        assert_eq!(v["result"]["app_version"], env!("CARGO_PKG_VERSION"));
        assert!(
            fake.calls().is_empty(),
            "initialize is answered by the server"
        );
        assert!(initialize(None).is_ok());
        assert!(initialize(Some(&json!({}))).is_ok());
    }

    #[test]
    fn initialize_refuses_other_versions() {
        let refused = initialize(Some(&json!({ "protocol_version": 2 }))).unwrap_err();
        assert_eq!(refused.kind, ErrorKind::ProtocolMismatch);
        let fake = Fake::ok();
        let (_, v) = reply(
            &fake,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_version":2}}"#,
        );
        assert_eq!(v["error"]["code"], 1007);
        for bad in [json!({ "protocol_version": "1" }), json!([1])] {
            assert_eq!(
                initialize(Some(&bad)).unwrap_err().kind,
                ErrorKind::InvalidParams,
                "{bad}"
            );
        }
    }

    #[test]
    fn request_summary_names_no_params() {
        assert_eq!(
            request_summary("tts.read", Ok(()), 42),
            "ipc tts.read ok 42 bytes"
        );
        assert_eq!(
            request_summary("tts.read", Err(ErrorKind::Busy), 42),
            "ipc tts.read busy 42 bytes"
        );
        let edge = "m".repeat(64);
        assert_eq!(
            request_summary(&edge, Ok(()), 80),
            format!("ipc {edge} ok 80 bytes")
        );
        assert_eq!(
            request_summary(&"m".repeat(65), Ok(()), 80),
            "ipc <long> ok 80 bytes"
        );
    }

    #[test]
    fn unknown_methods_are_summarised_as_unknown() {
        assert_eq!(
            request_summary("secret words", Err(ErrorKind::MethodNotFound), 12),
            "ipc <unknown> method-not-found 12 bytes"
        );
    }

    #[test]
    fn admit_refuses_unknown_peers() {
        assert!(!admit(Err(std::io::Error::other("no credentials")), 1000));
        assert!(!admit(Ok(0), 1000));
        assert!(admit(Ok(1000), 1000));
    }

    #[test]
    fn serves_requests_over_a_real_socket() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("vaakora.sock");
        let listener = socket::bind(&path).unwrap();
        let fake = Arc::new(Fake::ok());
        let methods: Arc<dyn Methods> = fake.clone();
        std::thread::spawn(move || serve(listener, methods));

        let mut client = UnixStream::connect(&path).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n\n  \n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"status\"}\n",
            )
            .unwrap();
        let mut lines = BufReader::new(client);
        let first = read_reply(&mut lines);
        assert_eq!(first["id"], 1);
        assert_eq!(first["result"]["server"], "vaakora");
        let second = read_reply(&mut lines);
        assert_eq!(second["id"], 2);
        assert_eq!(second["result"]["method"], "status");
        assert_eq!(fake.calls(), vec!["status".to_string()]);
    }

    #[test]
    fn oversize_line_closes_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("vaakora.sock");
        let listener = socket::bind(&path).unwrap();
        let fake = Arc::new(Fake::ok());
        let methods: Arc<dyn Methods> = fake.clone();
        std::thread::spawn(move || serve(listener, methods));

        let mut client = UnixStream::connect(&path).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(&vec![b'a'; MAX_LINE_BYTES]).unwrap();
        let mut lines = BufReader::new(client);
        let mut raw = String::new();
        lines.read_line(&mut raw).unwrap();
        assert!(raw.contains("\"id\":null"), "{raw}");
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["error"]["code"], -32600);
        assert_eq!(v["error"]["message"], "request line too long");
        assert!(closed(&mut lines), "the server closes the connection");
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_full_size_line_is_served() {
        let prefix = r#"{"jsonrpc":"2.0","id":1,"method":"status","params":{"pad":""#;
        let suffix = r#""}}"#;
        let pad = MAX_LINE_BYTES - 1 - prefix.len() - suffix.len();
        let line = format!("{prefix}{}{suffix}\n", "a".repeat(pad));
        assert_eq!(line.len(), MAX_LINE_BYTES);

        let fake = Arc::new(Fake::ok());
        let (mut client, _done) = connection(fake.clone(), Duration::from_secs(5));
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(line.as_bytes()).unwrap();
        let mut lines = BufReader::new(client);
        let v = read_reply(&mut lines);
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["method"], "status");

        // One byte more and the same request is refused.
        let line = format!("{prefix}{}{suffix}\n", "a".repeat(pad + 1));
        let (mut client, _done) = connection(fake.clone(), Duration::from_secs(5));
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(line.as_bytes()).unwrap();
        let mut lines = BufReader::new(client);
        let v = read_reply(&mut lines);
        assert_eq!(v["error"]["message"], "request line too long");
        assert!(closed(&mut lines), "the server closes the connection");
        assert_eq!(fake.calls(), vec!["status".to_string()]);
    }

    #[test]
    fn invalid_utf8_is_a_parse_error() {
        let fake = Arc::new(Fake::ok());
        let (mut client, _done) = connection(fake.clone(), Duration::from_secs(5));
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .write_all(b"\xff\xfe\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"status\"}\n")
            .unwrap();
        let mut lines = BufReader::new(client);
        let first = read_reply(&mut lines);
        assert_eq!(first["error"]["code"], -32700);
        assert_eq!(first["error"]["message"], "invalid JSON");
        assert_eq!(first["id"], Value::Null);
        let second = read_reply(&mut lines);
        assert_eq!(second["id"], 2);
    }

    #[test]
    fn a_silent_client_is_disconnected() {
        let (client, done) = connection(Arc::new(Fake::ok()), Duration::from_millis(200));
        assert!(
            done.recv_timeout(Duration::from_secs(5)).is_ok(),
            "an idle connection is closed"
        );
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert!(closed(&mut BufReader::new(client)));
    }

    #[test]
    fn a_slow_client_is_disconnected() {
        // One byte every 50 ms never trips a per-read timeout of 300 ms; the per-request deadline does.
        let (mut client, done) = connection(Arc::new(Fake::ok()), Duration::from_millis(300));
        let started = Instant::now();
        let mut finished = false;
        for _ in 0..100 {
            if done.try_recv().is_ok() || client.write_all(b" ").is_err() {
                finished = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        finished = finished || done.try_recv().is_ok();
        assert!(
            finished,
            "a client sending one byte at a time held the connection for {:?}",
            started.elapsed()
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
