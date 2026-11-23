//! Where `vaakora read` gets its text: a file or piped input, never an argument.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde_json::json;

use super::connection::method_line;
use crate::ipc::protocol::MAX_LINE_BYTES;

/// Why the text could not be used. Every one is a usage error (exit 2).
#[derive(Debug, PartialEq)]
pub(crate) enum InputError {
    /// No file, and stdin is a terminal.
    NoInput,
    /// The path is not a regular file (or does not exist).
    NotAFile,
    NotUtf8,
    Blank,
    TooLong,
    /// The file or stdin could not be read.
    Io,
}

/// The text to read aloud. A path other than `-` is a file; `-`, or no path with a stdin that is
/// not a terminal, is stdin. At most `MAX_LINE_BYTES + 1` bytes are read, and the `tts.read` line
/// built around the text, with its newline, must fit `MAX_LINE_BYTES` as the server requires.
pub(crate) fn read_text(
    path: Option<&Path>,
    stdin: &mut dyn Read,
    stdin_is_terminal: bool,
) -> Result<String, InputError> {
    let bytes = match path {
        Some(path) if path != Path::new("-") => read_file(path)?,
        None if stdin_is_terminal => return Err(InputError::NoInput),
        _ => read_capped(stdin)?,
    };
    let text = String::from_utf8(bytes).map_err(|_| InputError::NotUtf8)?;
    if text.trim().is_empty() {
        return Err(InputError::Blank);
    }
    if method_line("tts.read", json!({ "text": text })).len() + 1 > MAX_LINE_BYTES {
        return Err(InputError::TooLong);
    }
    Ok(text)
}

fn read_file(path: &Path) -> Result<Vec<u8>, InputError> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Err(InputError::NotAFile),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(InputError::NotAFile),
        Err(_) => return Err(InputError::Io),
    }
    let mut file = File::open(path).map_err(|_| InputError::Io)?;
    read_capped(&mut file)
}

/// Reads at most one byte more than the cap; more than the cap is `TooLong`.
fn read_capped(source: &mut dyn Read) -> Result<Vec<u8>, InputError> {
    let mut bytes = Vec::new();
    Read::take(&mut *source, MAX_LINE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| InputError::Io)?;
    if bytes.len() > MAX_LINE_BYTES {
        return Err(InputError::TooLong);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::connection::method_line;
    use serde_json::json;
    use std::io::Read;

    /// Length of the serialized `tts.read` line (no newline) around text of `len` plain bytes.
    fn overhead() -> usize {
        method_line("tts.read", json!({ "text": "" })).len()
    }

    fn read_stdin(bytes: &[u8], terminal: bool) -> Result<String, InputError> {
        let mut stdin = bytes;
        read_text(None, &mut stdin, terminal)
    }

    #[test]
    fn stdin_is_read_when_it_is_not_a_terminal() {
        assert_eq!(
            read_stdin(b"Hello there.", false),
            Ok("Hello there.".into())
        );
    }

    #[test]
    fn text_is_returned_unchanged() {
        let text = "  line one\r\nline two\n";
        assert_eq!(read_stdin(text.as_bytes(), false), Ok(text.into()));
    }

    #[test]
    fn no_path_with_a_terminal_is_no_input() {
        assert_eq!(read_stdin(b"never read", true), Err(InputError::NoInput));
    }

    #[test]
    fn a_dash_reads_stdin_even_on_a_terminal() {
        let mut stdin: &[u8] = b"piped";
        let got = read_text(Some(Path::new("-")), &mut stdin, true);
        assert_eq!(got, Ok("piped".into()));
    }

    #[test]
    fn a_file_is_read_and_stdin_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "from the file").unwrap();
        let mut stdin: &[u8] = b"from stdin";
        let got = read_text(Some(&file), &mut stdin, false);
        assert_eq!(got, Ok("from the file".into()));
        assert_eq!(stdin, b"from stdin", "stdin is not consumed");
    }

    #[test]
    fn a_directory_or_missing_path_is_not_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut stdin: &[u8] = b"";
        assert_eq!(
            read_text(Some(dir.path()), &mut stdin, false),
            Err(InputError::NotAFile)
        );
        assert_eq!(
            read_text(Some(&dir.path().join("missing.txt")), &mut stdin, false),
            Err(InputError::NotAFile)
        );
    }

    #[test]
    fn an_unreadable_file_is_an_io_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("locked.txt");
        std::fs::write(&file, "x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        // A superuser can read it anyway; the check is about a real refusal.
        if std::fs::File::open(&file).is_ok() {
            return;
        }
        let mut stdin: &[u8] = b"";
        assert_eq!(
            read_text(Some(&file), &mut stdin, false),
            Err(InputError::Io)
        );
    }

    #[test]
    fn a_failing_stdin_is_an_io_error() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("broken"))
            }
        }
        assert_eq!(read_text(None, &mut Broken, false), Err(InputError::Io));
    }

    #[test]
    fn blank_text_is_refused() {
        assert_eq!(read_stdin(b"", false), Err(InputError::Blank));
        assert_eq!(read_stdin(b" \n\t\r\n", false), Err(InputError::Blank));
    }

    #[test]
    fn text_that_is_not_utf8_is_refused() {
        assert_eq!(read_stdin(&[0xff, 0xfe], false), Err(InputError::NotUtf8));
        assert_eq!(read_stdin(b"ok \xc3\x28", false), Err(InputError::NotUtf8));
    }

    #[test]
    fn at_most_one_byte_over_the_cap_is_read() {
        // Four caps of input: the reader must stop one byte past the first.
        let mut source = std::io::repeat(b'a').take(4 * MAX_LINE_BYTES as u64);
        assert_eq!(
            read_text(None, &mut source, false),
            Err(InputError::TooLong)
        );
        assert_eq!(
            source.limit(),
            3 * MAX_LINE_BYTES as u64 - 1,
            "exactly MAX_LINE_BYTES + 1 bytes were taken"
        );
    }

    #[test]
    fn a_line_of_exactly_the_cap_is_accepted_and_one_more_byte_is_not() {
        // The request line plus its newline may be MAX_LINE_BYTES long, no longer.
        let fits = MAX_LINE_BYTES - 1 - overhead();
        let text = "a".repeat(fits);
        assert_eq!(read_stdin(text.as_bytes(), false), Ok(text.clone()));
        assert_eq!(
            method_line("tts.read", json!({ "text": text })).len() + 1,
            MAX_LINE_BYTES
        );

        let over = "a".repeat(fits + 1);
        assert_eq!(read_stdin(over.as_bytes(), false), Err(InputError::TooLong));
    }

    #[test]
    fn escaping_counts_toward_the_cap() {
        // Each quote becomes two bytes in the JSON line, so half the cap of quotes is too long
        // although the raw text is well under it.
        let quotes = "\"".repeat(MAX_LINE_BYTES / 2);
        assert!(quotes.len() < MAX_LINE_BYTES);
        assert_eq!(
            read_stdin(quotes.as_bytes(), false),
            Err(InputError::TooLong)
        );
    }

    #[test]
    fn a_file_over_the_cap_is_too_long() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.txt");
        std::fs::write(&file, vec![b'a'; MAX_LINE_BYTES]).unwrap();
        let mut stdin: &[u8] = b"";
        assert_eq!(
            read_text(Some(&file), &mut stdin, false),
            Err(InputError::TooLong)
        );
    }
}
