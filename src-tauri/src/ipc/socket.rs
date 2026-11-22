//! Where the control socket lives, how it is bound, and who may use it.
//!
//! The socket is `$VAAKORA_SOCKET` (when set and non-empty) or
//! `$XDG_RUNTIME_DIR/vaakora.sock`. It is created owner-only (0600) in a
//! directory only this user can enter, and the server answers only peers
//! running as this user (`SO_PEERCRED`). Binding never deletes a regular file,
//! a symlink, or a socket another live instance still answers on.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

/// Names the socket path; a lane, test or dev build sets it to keep off the user's socket.
pub const SOCKET_ENV: &str = "VAAKORA_SOCKET";

/// `sun_path` holds 108 bytes including the terminating NUL.
pub const MAX_PATH_BYTES: usize = 107;

#[derive(Debug, PartialEq, Eq)]
pub enum SocketPathError {
    /// Neither `$VAAKORA_SOCKET` nor `$XDG_RUNTIME_DIR` is set.
    NoRuntimeDir,
    /// The path is longer than [`MAX_PATH_BYTES`].
    TooLong,
}

/// The socket path from the two variables' values; empty values count as unset.
pub fn socket_path(
    socket_env: Option<OsString>,
    runtime_dir: Option<OsString>,
) -> Result<PathBuf, SocketPathError> {
    let set = |value: Option<OsString>| value.filter(|v| !v.is_empty());
    let path = match (set(socket_env), set(runtime_dir)) {
        (Some(socket), _) => PathBuf::from(socket),
        (None, Some(dir)) => {
            PathBuf::from(dir).join(format!("{}.sock", crate::brand::PACKAGE_NAME))
        }
        (None, None) => return Err(SocketPathError::NoRuntimeDir),
    };
    if path.as_os_str().len() > MAX_PATH_BYTES {
        return Err(SocketPathError::TooLong);
    }
    Ok(path)
}

/// [`socket_path`] from this process's environment.
pub fn socket_path_from_env() -> Result<PathBuf, SocketPathError> {
    socket_path(
        std::env::var_os(SOCKET_ENV),
        std::env::var_os("XDG_RUNTIME_DIR"),
    )
}

/// Why [`bind`] did not bind; nothing at the path was changed except a stale socket.
#[derive(Debug)]
pub enum BindError {
    /// Something other than a socket (a file, directory or symlink) is at the path.
    NotASocket,
    /// Another live instance answers on the socket at the path.
    InUse,
    /// The socket's directory is not this user's, or others can enter it.
    OpenDirectory,
    Io(io::Error),
}

impl BindError {
    /// A short name for logs; never a path or other user data.
    pub fn name(&self) -> String {
        match self {
            BindError::NotASocket => "not-a-socket".to_string(),
            BindError::InUse => "in-use".to_string(),
            BindError::OpenDirectory => "open-directory".to_string(),
            BindError::Io(e) => format!("io {:?}", e.kind()),
        }
    }
}

/// Binds the listening socket at `path`.
///
/// An existing path is replaced only when it is a socket that refuses
/// connections (left behind by a crash). Two instances starting at the same
/// moment could both find the old socket stale and the later one would replace
/// the earlier one's socket; the single-instance plugin prevents that in
/// normal use, and a lane or dev build uses its own `$VAAKORA_SOCKET`.
pub fn bind(path: &Path) -> Result<UnixListener, BindError> {
    check_directory(path)?;
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_socket() => return Err(BindError::NotASocket),
        Ok(_) => match UnixStream::connect(path) {
            Ok(_) => return Err(BindError::InUse),
            Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => {
                fs::remove_file(path).map_err(BindError::Io)?;
            }
            Err(e) => return Err(BindError::Io(e)),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(BindError::Io(e)),
    }
    bind_owner_only(path).map_err(BindError::Io)
}

/// The directory holding the socket must belong to this user and be closed to
/// group and others (0700, as `$XDG_RUNTIME_DIR` is).
fn check_directory(path: &Path) -> Result<(), BindError> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let meta = fs::metadata(dir).map_err(BindError::Io)?;
    if !meta.is_dir() || meta.uid() != own_uid() || meta.mode() & 0o077 != 0 {
        return Err(BindError::OpenDirectory);
    }
    Ok(())
}

/// `bind(2)` on a socket whose inode mode is already 0600: Linux creates the
/// socket file with that mode (less the umask), so the file is owner-only from
/// the moment it exists, with no window before a later chmod.
fn bind_owner_only(path: &Path) -> io::Result<UnixListener> {
    // SAFETY: sockaddr_un is plain old data; all zeroes is a valid value.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.len() >= addr.sun_path.len() || bytes.contains(&0) {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (dst, src) in addr.sun_path.iter_mut().zip(bytes) {
        *dst = *src as libc::c_char;
    }

    // SAFETY: plain syscall; the result is checked before use.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `raw` is a fresh descriptor that nothing else owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: `fd` is a valid open descriptor for the calls below.
    unsafe {
        if libc::fchmod(fd.as_raw_fd(), 0o600) != 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::bind(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_un).cast::<libc::sockaddr>(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        ) != 0
        {
            return Err(io::Error::last_os_error());
        }
        if libc::listen(fd.as_raw_fd(), 128) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(UnixListener::from(fd))
}

/// The uid of the process at the other end, as the kernel recorded it at connect time.
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: u32::MAX,
        gid: u32::MAX,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for writes of the sizes given.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast::<libc::c_void>(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of::<libc::ucred>() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(cred.uid)
}

/// Only processes running as this user may use the socket.
pub fn authorized(peer_uid: u32, own_uid: u32) -> bool {
    peer_uid == own_uid
}

pub(crate) fn own_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    /// A temporary directory private to this user (0700), like `$XDG_RUNTIME_DIR`.
    fn private_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn socket_env_wins() {
        assert_eq!(
            socket_path(os("/a/b.sock"), os("/run/user/1000")),
            Ok(PathBuf::from("/a/b.sock"))
        );
    }

    #[test]
    fn runtime_dir_joins_package_socket() {
        assert_eq!(
            socket_path(None, os("/run/user/1000")),
            Ok(PathBuf::from("/run/user/1000/vaakora.sock"))
        );
    }

    #[test]
    fn empty_values_are_unset() {
        assert_eq!(
            socket_path(os(""), os("")),
            Err(SocketPathError::NoRuntimeDir)
        );
        assert_eq!(socket_path(None, None), Err(SocketPathError::NoRuntimeDir));
        assert_eq!(
            socket_path(os(""), os("/run/user/1000")),
            Ok(PathBuf::from("/run/user/1000/vaakora.sock"))
        );
    }

    #[test]
    fn long_path_is_refused() {
        let ok = format!("/{}", "a".repeat(106));
        let long = format!("/{}", "a".repeat(107));
        assert_eq!((ok.len(), long.len()), (107, 108));
        assert_eq!(socket_path(os(&long), None), Err(SocketPathError::TooLong));
        assert_eq!(socket_path(os(&ok), None), Ok(PathBuf::from(&ok)));
        let dir = format!("/{}", "d".repeat(100));
        assert_eq!(socket_path(None, os(&dir)), Err(SocketPathError::TooLong));
    }

    #[test]
    fn bind_sets_owner_only_mode() {
        let dir = private_dir();
        let path = dir.path().join("vaakora.sock");
        let _listener = bind(&path).unwrap();
        let meta = fs::symlink_metadata(&path).unwrap();
        assert!(meta.file_type().is_socket());
        assert_eq!(meta.mode() & 0o777, 0o600);
    }

    #[test]
    fn bind_replaces_a_stale_socket() {
        let dir = private_dir();
        let path = dir.path().join("vaakora.sock");
        drop(bind(&path).unwrap());
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        let listener = bind(&path).unwrap();
        let mut client = UnixStream::connect(&path).unwrap();
        client.write_all(b"x").unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        let mut byte = [0u8; 1];
        accepted.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"x");
    }

    #[test]
    fn bind_keeps_a_live_socket() {
        let dir = private_dir();
        let path = dir.path().join("vaakora.sock");
        let first = bind(&path).unwrap();
        assert!(matches!(bind(&path), Err(BindError::InUse)));
        let mut client = UnixStream::connect(&path).unwrap();
        client.write_all(b"x").unwrap();
        // The refused bind's probe connection is queued first; ours follows it.
        let (_probe, _) = first.accept().unwrap();
        let (mut accepted, _) = first.accept().unwrap();
        let mut byte = [0u8; 1];
        accepted.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"x");
    }

    #[test]
    fn bind_never_deletes_a_regular_file() {
        let dir = private_dir();
        let path = dir.path().join("vaakora.sock");
        fs::write(&path, "keep").unwrap();
        assert!(matches!(bind(&path), Err(BindError::NotASocket)));
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
    }

    #[test]
    fn bind_never_follows_a_symlink() {
        let dir = private_dir();
        let target = dir.path().join("target.txt");
        fs::write(&target, "keep").unwrap();
        let path = dir.path().join("vaakora.sock");
        symlink(&target, &path).unwrap();
        assert!(matches!(bind(&path), Err(BindError::NotASocket)));
        assert!(fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    }

    #[test]
    fn bind_refuses_a_directory_others_can_enter() {
        let dir = private_dir();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let path = dir.path().join("vaakora.sock");
        assert!(matches!(bind(&path), Err(BindError::OpenDirectory)));
        assert!(fs::symlink_metadata(&path).is_err());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(bind(&path).is_ok());
    }

    #[test]
    fn peer_uid_is_own_uid() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), unsafe { libc::getuid() });
    }

    #[test]
    fn authorized_only_for_same_uid() {
        assert!(authorized(1000, 1000));
        assert!(!authorized(0, 1000));
        assert!(!authorized(1001, 1000));
    }
}
