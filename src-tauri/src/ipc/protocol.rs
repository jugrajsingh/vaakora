//! JSON-RPC 2.0 messages, limits and the stable error taxonomy of the local
//! control socket. Framing follows upstream PR #1906 (cjpais/Handy): one UTF-8
//! JSON message per `\n`-terminated line; a request without `id` is a
//! notification and gets no response. The client helpers at the end are shared
//! with the `vaakora <command>` client mode.

use serde::Deserialize;
use serde_json::{json, Value};

/// Protocol version spoken by this server. Additive changes do not bump it.
pub const PROTOCOL_VERSION: u64 = 1;

/// Hard cap on one request line, its `\n` included.
pub const MAX_LINE_BYTES: usize = 1_048_576;

/// An incoming request. `id` is absent for notifications.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

/// Stable failure kinds. The numeric code and the kebab-case kind are the
/// public contract; messages are not. Codes 1000-1007 keep PR #1906's numbers
/// (1003, `model-load-failed`, is reserved and unused); 1100+ are Vaakora's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    ParseError,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    Busy,
    SetupRequired,
    ModelNotInstalled,
    UnsupportedAudio,
    FileNotFound,
    Internal,
    ProtocolMismatch,
    TtsUnavailable,
    TtsModelNotInstalled,
}

const KINDS: [ErrorKind; 13] = [
    ErrorKind::ParseError,
    ErrorKind::InvalidRequest,
    ErrorKind::MethodNotFound,
    ErrorKind::InvalidParams,
    ErrorKind::Busy,
    ErrorKind::SetupRequired,
    ErrorKind::ModelNotInstalled,
    ErrorKind::UnsupportedAudio,
    ErrorKind::FileNotFound,
    ErrorKind::Internal,
    ErrorKind::ProtocolMismatch,
    ErrorKind::TtsUnavailable,
    ErrorKind::TtsModelNotInstalled,
];

impl ErrorKind {
    /// The JSON-RPC `error.code`.
    pub fn code(self) -> i64 {
        match self {
            ErrorKind::ParseError => -32700,
            ErrorKind::InvalidRequest => -32600,
            ErrorKind::MethodNotFound => -32601,
            ErrorKind::InvalidParams => -32602,
            ErrorKind::Busy => 1000,
            ErrorKind::SetupRequired => 1001,
            ErrorKind::ModelNotInstalled => 1002,
            ErrorKind::UnsupportedAudio => 1004,
            ErrorKind::FileNotFound => 1005,
            ErrorKind::Internal => 1006,
            ErrorKind::ProtocolMismatch => 1007,
            ErrorKind::TtsUnavailable => 1100,
            ErrorKind::TtsModelNotInstalled => 1101,
        }
    }

    /// The `error.data.kind` string.
    pub fn kind_str(self) -> &'static str {
        match self {
            ErrorKind::ParseError => "parse-error",
            ErrorKind::InvalidRequest => "invalid-request",
            ErrorKind::MethodNotFound => "method-not-found",
            ErrorKind::InvalidParams => "invalid-params",
            ErrorKind::Busy => "busy",
            ErrorKind::SetupRequired => "setup-required",
            ErrorKind::ModelNotInstalled => "model-not-installed",
            ErrorKind::UnsupportedAudio => "unsupported-audio",
            ErrorKind::FileNotFound => "file-not-found",
            ErrorKind::Internal => "internal-error",
            ErrorKind::ProtocolMismatch => "protocol-mismatch",
            ErrorKind::TtsUnavailable => "tts-unavailable",
            ErrorKind::TtsModelNotInstalled => "tts-model-not-installed",
        }
    }

    /// The kind named by an `error.data.kind` string, if this build knows it.
    pub fn from_kind_str(kind: &str) -> Option<Self> {
        KINDS.into_iter().find(|k| k.kind_str() == kind)
    }
}

/// A failure carried back to the client as a JSON-RPC error object with
/// `data.kind` set. The message is English and never quotes request text.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub kind: ErrorKind,
    pub message: String,
}

impl RpcError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// The response line (without newline) for a successful request `id`.
pub fn success_response(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// The response line (without newline) for a failed request `id`; `id` is
/// JSON `null` when the request could not be read.
pub fn error_response(id: &Value, error: &RpcError) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": error.kind.code(),
            "message": error.message,
            "data": { "kind": error.kind.kind_str() },
        },
    })
    .to_string()
}

/// One request line for the client, without the trailing newline.
pub fn request_line(id: u64, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

const MALFORMED_RESPONSE: &str = "malformed response";

/// Reads the server's reply to request `id`. An error object maps through
/// `data.kind` (an unknown kind becomes `Internal` with the server's message);
/// bad JSON, another id, or neither `result` nor `error` is `Internal`
/// "malformed response".
pub fn parse_response(line: &str, id: u64) -> Result<Value, RpcError> {
    let malformed = || RpcError::new(ErrorKind::Internal, MALFORMED_RESPONSE);
    let mut reply: Value = serde_json::from_str(line).map_err(|_| malformed())?;
    if reply.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(malformed());
    }
    if let Some(error) = reply.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(MALFORMED_RESPONSE);
        let kind = error
            .pointer("/data/kind")
            .and_then(Value::as_str)
            .and_then(ErrorKind::from_kind_str)
            .unwrap_or(ErrorKind::Internal);
        return Err(RpcError::new(kind, message));
    }
    match reply.get_mut("result") {
        Some(result) => Ok(result.take()),
        None => Err(malformed()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_request_with_id_and_params() {
        let req: Request =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"method":"status","params":{}}"#)
                .unwrap();
        assert_eq!(req.method, "status");
        assert_eq!(req.id, Some(Value::from(7)));
        assert!(req.params.is_some());
    }

    #[test]
    fn parses_notification_without_id() {
        let req: Request = serde_json::from_str(r#"{"jsonrpc":"2.0","method":"status"}"#).unwrap();
        assert!(req.id.is_none());
        assert!(req.params.is_none());
    }

    #[test]
    fn error_response_carries_stable_kind() {
        let err = RpcError::new(ErrorKind::Busy, "a dictation is in progress");
        let raw = error_response(&Value::from(3), &err);
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 3);
        assert_eq!(v["error"]["code"], 1000);
        assert_eq!(v["error"]["message"], "a dictation is in progress");
        assert_eq!(v["error"]["data"]["kind"], "busy");
        assert!(v.get("result").is_none());
    }

    #[test]
    fn success_response_round_trips() {
        let raw = success_response(&Value::from("abc"), json!({ "text": "hi" }));
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], "abc");
        assert_eq!(v["result"]["text"], "hi");
        assert!(v.get("error").is_none());
    }

    #[test]
    fn codes_are_stable() {
        let table = [
            (ErrorKind::ParseError, -32700, "parse-error"),
            (ErrorKind::InvalidRequest, -32600, "invalid-request"),
            (ErrorKind::MethodNotFound, -32601, "method-not-found"),
            (ErrorKind::InvalidParams, -32602, "invalid-params"),
            (ErrorKind::Busy, 1000, "busy"),
            (ErrorKind::SetupRequired, 1001, "setup-required"),
            (ErrorKind::ModelNotInstalled, 1002, "model-not-installed"),
            (ErrorKind::UnsupportedAudio, 1004, "unsupported-audio"),
            (ErrorKind::FileNotFound, 1005, "file-not-found"),
            (ErrorKind::Internal, 1006, "internal-error"),
            (ErrorKind::ProtocolMismatch, 1007, "protocol-mismatch"),
            (ErrorKind::TtsUnavailable, 1100, "tts-unavailable"),
            (
                ErrorKind::TtsModelNotInstalled,
                1101,
                "tts-model-not-installed",
            ),
        ];
        for (kind, code, name) in table {
            assert_eq!(kind.code(), code, "{kind:?}");
            assert_eq!(kind.kind_str(), name, "{kind:?}");
            assert_eq!(ErrorKind::from_kind_str(kind.kind_str()), Some(kind));
        }
        let codes: std::collections::BTreeSet<i64> = table.iter().map(|t| t.1).collect();
        let names: std::collections::BTreeSet<&str> = table.iter().map(|t| t.2).collect();
        assert_eq!((codes.len(), names.len()), (13, 13));
        // 1003 (model-load-failed) is reserved by PR #1906 and unused here.
        assert_eq!(ErrorKind::from_kind_str("model-load-failed"), None);
        assert_eq!(ErrorKind::from_kind_str(""), None);
    }

    #[test]
    fn request_line_is_one_json_rpc_line() {
        let line = request_line(4, "tts.read", json!({ "text": "one\ntwo" }));
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 4);
        assert_eq!(v["method"], "tts.read");
        assert_eq!(v["params"]["text"], "one\ntwo");
    }

    #[test]
    fn parse_response_returns_the_result() {
        let line = success_response(&Value::from(1), json!({ "changed": true }));
        assert_eq!(parse_response(&line, 1), Ok(json!({ "changed": true })));
    }

    #[test]
    fn parse_response_maps_error_kind() {
        let line = error_response(
            &Value::from(1),
            &RpcError::new(
                ErrorKind::TtsModelNotInstalled,
                "the voice model is not downloaded",
            ),
        );
        assert_eq!(
            parse_response(&line, 1),
            Err(RpcError::new(
                ErrorKind::TtsModelNotInstalled,
                "the voice model is not downloaded"
            ))
        );
    }

    #[test]
    fn parse_response_maps_an_unknown_kind_to_internal() {
        let line = r#"{"jsonrpc":"2.0","id":1,"error":{"code":1200,"message":"newer server","data":{"kind":"from-the-future"}}}"#;
        assert_eq!(
            parse_response(line, 1),
            Err(RpcError::new(ErrorKind::Internal, "newer server"))
        );
    }

    #[test]
    fn parse_response_rejects_wrong_id() {
        let line = success_response(&Value::from(2), json!({}));
        assert_eq!(
            parse_response(&line, 1),
            Err(RpcError::new(ErrorKind::Internal, "malformed response"))
        );
    }

    #[test]
    fn parse_response_rejects_malformed_lines() {
        for line in [
            "not json",
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","result":{}}"#,
            r#"[1]"#,
        ] {
            assert_eq!(
                parse_response(line, 1),
                Err(RpcError::new(ErrorKind::Internal, "malformed response")),
                "{line}"
            );
        }
    }
}
