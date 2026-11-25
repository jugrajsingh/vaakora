//! Keeps OpenSSL and native-tls out of the Linux normal dependency graph.
//!
//! The guard lives in this crate because it compiles in seconds; `--workspace`
//! covers the app crate too.
//!
//! `openssl-sys` and `native-tls` stay in `Cargo.lock` through a
//! build-dependency (`ort-sys` -> `ureq` -> `native-tls`, a host build tool that
//! is not linked), so `cargo tree -i` exits 0 and prints `warning: nothing to
//! print.` on stderr. A crate absent from the lock exits non-zero with `did not
//! match any packages`. Either way the normal graph is clean; anything else
//! (a tree on stdout, an offline miss, a lock mismatch) fails the test.

use std::process::Command;

const FORBIDDEN: [&str; 3] = ["openssl-sys", "openssl", "native-tls"];

#[test]
fn no_openssl_or_native_tls_in_the_linux_graph() {
    for krate in FORBIDDEN {
        let output = Command::new(env!("CARGO"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args([
                "tree",
                "--workspace",
                "--locked",
                "--offline",
                "-e",
                "normal",
                "--target",
                "x86_64-unknown-linux-gnu",
                "-i",
                krate,
            ])
            .output()
            .expect("failed to run cargo tree");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let absent = output.status.success() && stdout.trim().is_empty();
        let not_in_lock = !output.status.success() && stderr.contains("did not match any packages");
        assert!(
            absent || not_in_lock,
            "{krate} is in the graph:\n{stdout}{stderr}"
        );
    }
}
