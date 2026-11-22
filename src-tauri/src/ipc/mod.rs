//! Local control socket: JSON-RPC 2.0 over a Unix socket, one message per
//! line, in the shape of upstream PR #1906 (cjpais/Handy) plus `tts.*`. Only
//! processes running as this user can connect. See `socket` for where it lives
//! and `server` for framing and logging.

pub mod protocol;
pub mod server;
pub mod socket;

use std::sync::Arc;

/// Starts the server on a background thread. Any failure is one `warn` line
/// naming the error kind, and the app runs on without the socket.
pub fn start(methods: Arc<dyn server::Methods>) {
    let path = match socket::socket_path_from_env() {
        Ok(path) => path,
        Err(e) => {
            log::warn!("IPC server not started: socket path {e:?}");
            return;
        }
    };
    // Binding probes an existing socket with a connect, so it runs off the
    // caller's thread.
    let spawned = std::thread::Builder::new()
        .name("ipc-server".into())
        .spawn(move || match socket::bind(&path) {
            Ok(listener) => {
                log::info!("IPC listening on {}", path.display());
                server::serve(listener, methods);
            }
            Err(e) => log::warn!("IPC server not started: {}", e.name()),
        });
    if let Err(e) = spawned {
        log::warn!("IPC server not started: thread {:?}", e.kind());
    }
}
