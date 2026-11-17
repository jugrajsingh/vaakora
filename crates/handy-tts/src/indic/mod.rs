//! Indic Tiny TTS for English, Hindi and Punjabi: the text frontend (textnorm, vocabulary filter, chunks, token
//! ids) and synthesis (text encoder, Euler loop on the flow decoder, Vocos vocoder, inverse STFT).
//! Ported from the `indic_tiny_tts` package at sulabhkatiyar/indic-tiny-tts-hindi@e15ac436560eb24d115d47c0783f62f10a02d30a (textnorm is identical in the pa and en packages), MIT, see INDIC-TINY-TTS-CODE-LICENSE.
mod acoustic;
pub(crate) mod engine;
pub(crate) mod english;
pub(crate) mod frontend;
pub(crate) mod guarded;
mod istft;
pub(crate) mod latin;
mod numbers;
pub(crate) mod textnorm;

use anyhow::{Result, bail};
use regex::Regex;
use std::sync::LazyLock;

/// A language an Indic Tiny model reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lang {
    En,
    Hi,
    Pa,
}

impl Lang {
    /// The language of a model config's `language` code.
    pub(crate) fn from_code(code: &str) -> Result<Self> {
        match code {
            "en" => Ok(Self::En),
            "hi" => Ok(Self::Hi),
            "pa" => Ok(Self::Pa),
            other => bail!("unsupported Indic Tiny language {other:?}"),
        }
    }

    /// The config `language` code.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Hi => "hi",
            Self::Pa => "pa",
        }
    }
}

/// Python's `str.isspace` (Rust's White_Space plus the separators U+001C-U+001F).
pub(super) fn is_py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python's `str.split()` without arguments.
pub(super) fn py_split(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_py_space).filter(|part| !part.is_empty())
}

/// Python's `str.strip()` without arguments.
pub(super) fn py_strip(text: &str) -> &str {
    text.trim_matches(is_py_space)
}

fn class(pattern: &str) -> Regex {
    Regex::new(pattern).expect("character class patterns are valid")
}

fn in_class(re: &Regex, c: char) -> bool {
    let mut buf = [0u8; 4];
    re.is_match(c.encode_utf8(&mut buf))
}

static LETTER: LazyLock<Regex> = LazyLock::new(|| class(r"^\p{L}$"));
static LETTER_OR_MARK: LazyLock<Regex> = LazyLock::new(|| class(r"^[\p{L}\p{M}]$"));
static LATIN_SCRIPT: LazyLock<Regex> = LazyLock::new(|| class(r"^\p{Latin}$"));
static MODIFIER_LETTER: LazyLock<Regex> = LazyLock::new(|| class(r"^\p{Lm}$"));

/// Python's `str.isalpha` (general category L*).
pub(super) fn is_alpha(c: char) -> bool {
    c.is_ascii_alphabetic() || (!c.is_ascii() && in_class(&LETTER, c))
}

/// General category L* or M*.
pub(super) fn is_letter_or_mark(c: char) -> bool {
    c.is_ascii_alphabetic() || (!c.is_ascii() && in_class(&LETTER_OR_MARK, c))
}

/// A letter whose Unicode name contains `LATIN` (the package's `_is_latin_letter`).
pub(super) fn is_latin_letter(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphabetic();
    }
    // Latin-script letters whose names lack LATIN: ordinal indicators, KELVIN SIGN, turned and reversed forms.
    if matches!(
        c,
        '\u{aa}' | '\u{ba}' | '\u{212a}' | '\u{2132}' | '\u{214e}' | '\u{2183}'
    ) {
        return false;
    }
    // Modifier letters are named MODIFIER LETTER, except the Latin subscript and superscript letters.
    if in_class(&MODIFIER_LETTER, c)
        && !matches!(c, '\u{1d62}'..='\u{1d65}' | '\u{2071}' | '\u{207f}' | '\u{2090}'..='\u{209c}' | '\u{2c7c}')
    {
        return false;
    }
    is_alpha(c) && in_class(&LATIN_SCRIPT, c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes_resolve_to_the_three_supported_languages() {
        assert_eq!(Lang::from_code("en").unwrap(), Lang::En);
        assert_eq!(Lang::from_code("hi").unwrap(), Lang::Hi);
        assert_eq!(Lang::from_code("pa").unwrap(), Lang::Pa);
        assert!(Lang::from_code("bn").is_err());
    }

    #[test]
    fn character_classes_follow_python() {
        assert!(is_alpha('क') && !is_alpha('\u{093e}') && !is_alpha('1'));
        assert!(is_letter_or_mark('\u{093e}') && !is_letter_or_mark('।'));
        assert!(is_latin_letter('é') && !is_latin_letter('क') && !is_latin_letter('\u{aa}'));
        assert!(is_py_space('\u{1f}') && is_py_space('\u{a0}') && !is_py_space('\u{200b}'));
    }
}
