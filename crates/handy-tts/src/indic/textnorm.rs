//! Port of `indic_tiny_tts/textnorm/core.py` at sulabhkatiyar/indic-tiny-tts-hindi@e15ac436560eb24d115d47c0783f62f10a02d30a, MIT, see INDIC-TINY-TTS-CODE-LICENSE.
//! NORMALIZATION_VERSION "4", the en, hi and pa steps only.
use super::{Lang, guarded::replace_guarded, is_letter_or_mark, is_py_space, numbers, py_split};
use regex::{Captures, Regex};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

const ZWJ: char = '\u{200d}';
const ZWNJ: char = '\u{200c}';
/// ZERO WIDTH SPACE, BOM, WORD JOINER, SOFT HYPHEN (`INVISIBLE_CHARS`).
const INVISIBLE_CHARS: [char; 4] = ['\u{200b}', '\u{feff}', '\u{2060}', '\u{ad}'];
const DEV_NUKTA: char = '\u{093c}';
/// क ख ग ज ड ढ फ (`HI_NUKTA_BASES`).
const HI_NUKTA_BASES: [char; 7] = [
    '\u{0915}', '\u{0916}', '\u{0917}', '\u{091c}', '\u{0921}', '\u{0922}', '\u{092b}',
];
/// Legacy two-sign vowels, then the two typo pairs (`HI_TWO_SIGN_VOWELS + HI_TYPO_SIGN_PAIRS`).
const HI_SIGN_PAIRS: [(&str, &str); 10] = [
    ("\u{093e}\u{0945}", "\u{0949}"),
    ("\u{0945}\u{093e}", "\u{0949}"),
    ("\u{093e}\u{0949}", "\u{0949}"),
    ("\u{0947}\u{093e}", "\u{094b}"),
    ("\u{093e}\u{0947}", "\u{094b}"),
    ("\u{0948}\u{093e}", "\u{094c}"),
    ("\u{093e}\u{0948}", "\u{094c}"),
    ("\u{093e}\u{094c}", "\u{094c}"),
    ("\u{0940}\u{0947}", "\u{0940}"),
    ("\u{0947}\u{0948}", "\u{0947}"),
];
/// Indic dependent vowel signs U+0900-0DFF (`INDIC_VOWEL_SIGNS`).
const INDIC_VOWEL_SIGNS: [(char, char); 39] = [
    ('\u{093a}', '\u{093b}'),
    ('\u{093e}', '\u{094c}'),
    ('\u{094e}', '\u{094f}'),
    ('\u{0955}', '\u{0957}'),
    ('\u{0962}', '\u{0963}'),
    ('\u{09be}', '\u{09c4}'),
    ('\u{09c7}', '\u{09c8}'),
    ('\u{09cb}', '\u{09cc}'),
    ('\u{09e2}', '\u{09e3}'),
    ('\u{0a3e}', '\u{0a42}'),
    ('\u{0a47}', '\u{0a48}'),
    ('\u{0a4b}', '\u{0a4c}'),
    ('\u{0abe}', '\u{0ac5}'),
    ('\u{0ac7}', '\u{0ac9}'),
    ('\u{0acb}', '\u{0acc}'),
    ('\u{0ae2}', '\u{0ae3}'),
    ('\u{0b3e}', '\u{0b44}'),
    ('\u{0b47}', '\u{0b48}'),
    ('\u{0b4b}', '\u{0b4c}'),
    ('\u{0b62}', '\u{0b63}'),
    ('\u{0bbe}', '\u{0bc2}'),
    ('\u{0bc6}', '\u{0bc8}'),
    ('\u{0bca}', '\u{0bcc}'),
    ('\u{0c3e}', '\u{0c44}'),
    ('\u{0c46}', '\u{0c48}'),
    ('\u{0c4a}', '\u{0c4c}'),
    ('\u{0c62}', '\u{0c63}'),
    ('\u{0cbe}', '\u{0cc4}'),
    ('\u{0cc6}', '\u{0cc8}'),
    ('\u{0cca}', '\u{0ccc}'),
    ('\u{0ce2}', '\u{0ce3}'),
    ('\u{0d3e}', '\u{0d44}'),
    ('\u{0d46}', '\u{0d48}'),
    ('\u{0d4a}', '\u{0d4c}'),
    ('\u{0d62}', '\u{0d63}'),
    ('\u{0dcf}', '\u{0dd4}'),
    ('\u{0dd6}', '\u{0dd6}'),
    ('\u{0dd8}', '\u{0ddf}'),
    ('\u{0df2}', '\u{0df3}'),
];
/// Bracketed non-speech event tags (`NONSPEECH_TAGS`).
const NONSPEECH_TAGS: [&str; 20] = [
    "noise",
    "uhh",
    "ugh",
    "umm",
    "talking",
    "horn",
    "unintelligible",
    "stammers",
    "buzz",
    "buzzer",
    "music",
    "singing",
    "popping",
    "breathing",
    "inhaling",
    "laugh",
    "bird_squawk",
    "throat_clearing",
    "child_talking",
    "phone_vibrating",
];
/// Python's `\s` as a regex class.
const WS: &str = r"[\s\x1C-\x1F]";
/// The package's `_LATIN` letters.
const LATIN: &str = "A-Za-z\u{c0}-\u{d6}\u{d8}-\u{f6}\u{f8}-\u{24f}";

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("textnorm patterns are valid")
}

static TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"{WS}*(?:\[{WS}*([A-Za-z_]+){WS}*\]|\({WS}*([a-z_]+){WS}*\))"
    ))
});
static TAG_COMPOUND_RE: LazyLock<Regex> = LazyLock::new(|| regex(r"^[a-z]+(?:_[a-z]+)+$"));
static GLOSS_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"{WS}*(\[[{LATIN} .'\u{{2019}}\&/\-]*\]|\([{LATIN} .'\u{{2019}}\&/\-]*\))"
    ))
});
static HAS_LATIN_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("[{LATIN}]")));
static LATIN_LETTER_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^[{LATIN}]$")));
static PA_I_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("({WS}*)I")));
static HI_I_RE: LazyLock<Regex> = LazyLock::new(|| regex("I"));
static HTML_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(r"&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);"));
static EN_AMPERSAND_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!("{WS}*[&\u{ff06}\u{fe60}]{WS}*")));

/// NFC, then Python's whitespace split and single-space join (`nfc_whitespace`).
pub(super) fn nfc_whitespace(text: &str) -> String {
    let nfc: String = text.nfc().collect();
    py_split(&nfc).collect::<Vec<_>>().join(" ")
}

/// Character-path canonical text (`textnorm.text_for_chars`).
pub(crate) fn text_for_chars(text: &str, lang: Lang) -> String {
    let mut current = nfc_whitespace(text);
    current = nfc_whitespace(&current.replace(ZWJ, ""));
    current = nfc_whitespace(&current.replace(ZWNJ, ""));
    current = nfc_whitespace(&current.replace(INVISIBLE_CHARS, ""));
    if lang == Lang::Hi {
        current = nfc_whitespace(&hi_nukta_matra(&current));
    }
    if lang == Lang::Pa {
        current = nfc_whitespace(&current.replace("\u{0a21}\u{0a3c}", "\u{0a5c}"));
        current = nfc_whitespace(&collapse_repeated(&current, is_indic_vowel_sign));
    }
    current = nfc_whitespace(&strip_nonspeech_tags(&current));
    if lang == Lang::Hi {
        current = nfc_whitespace(&strip_latin_gloss(&current));
    }
    if lang == Lang::Pa {
        current = nfc_whitespace(&latin_i_danda(&current, &PA_I_RE, '\u{0a00}'..='\u{0a7f}'));
    }
    if lang == Lang::Hi {
        current = nfc_whitespace(&latin_i_danda(&current, &HI_I_RE, '\u{0900}'..='\u{097f}'));
    }
    if lang == Lang::En {
        current = nfc_whitespace(&en_ampersand(&current));
    }
    nfc_whitespace(&numbers::verbalize_digits(&current, lang))
}

fn is_dev_vowel_sign(c: char) -> bool {
    matches!(c, '\u{093a}' | '\u{093b}' | '\u{093e}'..='\u{094c}' | '\u{094e}' | '\u{094f}' | '\u{0955}'..='\u{0957}' | '\u{0962}' | '\u{0963}')
}

fn is_dev_modifier(c: char) -> bool {
    matches!(c, '\u{0900}'..='\u{0903}')
}

fn is_indic_vowel_sign(c: char) -> bool {
    INDIC_VOWEL_SIGNS
        .iter()
        .any(|(first, last)| (*first..=*last).contains(&c))
}

/// An exactly repeated sign of `is_sign` collapses to one (`([signs])\1+` -> `\1`).
fn collapse_repeated(text: &str, is_sign: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous = None;
    for ch in text.chars() {
        if !(is_sign(ch) && previous == Some(ch)) {
            out.push(ch);
        }
        previous = Some(ch);
    }
    out
}

/// Hindi nukta placement, legacy two-sign vowels and repeated signs (`_hi_nukta_matra`).
fn hi_nukta_matra(text: &str) -> String {
    let mut out: Vec<char> = Vec::with_capacity(text.len());
    for ch in text.chars() {
        if ch != DEV_NUKTA {
            out.push(ch);
            continue;
        }
        if out.last().is_some_and(|c| HI_NUKTA_BASES.contains(c)) {
            out.push(ch);
            continue;
        }
        let base = out
            .iter()
            .rposition(|&c| !(is_dev_vowel_sign(c) || is_dev_modifier(c)));
        if let Some(j) = base
            && j + 1 < out.len()
            && HI_NUKTA_BASES.contains(&out[j])
            && out[j + 1] != DEV_NUKTA
        {
            out.insert(j + 1, DEV_NUKTA);
        }
    }
    deva_vowel_signs(&out.into_iter().collect::<String>())
}

fn deva_vowel_signs(text: &str) -> String {
    let mut text = text.to_string();
    for (legacy, sign) in HI_SIGN_PAIRS {
        text = text.replace(legacy, sign);
    }
    collapse_repeated(&text, is_dev_vowel_sign)
}

fn strip_nonspeech_tags(text: &str) -> String {
    TAG_RE
        .replace_all(text, |caps: &Captures| {
            let word = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map_or("", |m| m.as_str());
            let lower = word.to_ascii_lowercase();
            if NONSPEECH_TAGS.contains(&lower.as_str()) || TAG_COMPOUND_RE.is_match(&lower) {
                " ".to_string()
            } else {
                caps[0].to_string()
            }
        })
        .into_owned()
}

fn is_indic_word_char(c: char) -> bool {
    ('\u{0900}'..='\u{0dff}').contains(&c) && is_letter_or_mark(c)
}

fn strip_latin_gloss_once(text: &str) -> String {
    GLOSS_RE
        .replace_all(text, |caps: &Captures| {
            let start = caps.get(0).expect("group 0 is the whole match").start();
            let after_native = text[..start]
                .chars()
                .next_back()
                .is_some_and(is_indic_word_char);
            if after_native && HAS_LATIN_RE.is_match(&caps[1]) {
                String::new()
            } else {
                caps[0].to_string()
            }
        })
        .into_owned()
}

/// Glosses removed to a fixpoint (`_strip_latin_gloss`).
fn strip_latin_gloss(text: &str) -> String {
    let mut text = text.to_string();
    loop {
        let new = nfc_whitespace(&strip_latin_gloss_once(&text));
        if new == text {
            return text;
        }
        text = new;
    }
}

/// `_I_DANDA_TAIL`: after optional whitespace, the end or a character that is not Latin, `.`, `-`, an apostrophe
/// or an ASCII digit.
fn i_danda_tail(text: &str, end: usize) -> bool {
    match text[end..].chars().find(|c| !is_py_space(*c)) {
        None => true,
        Some(c) => {
            !(matches!(c, '.' | '-' | '\'' | '\u{2019}' | '0'..='9')
                || LATIN_LETTER_RE.is_match(c.encode_utf8(&mut [0u8; 4])))
        }
    }
}

/// A Latin `I` typed for a danda after a native letter becomes `।` (`pa_latin_i_danda`, `hi_latin_i_danda`).
fn latin_i_danda(text: &str, re: &Regex, script: std::ops::RangeInclusive<char>) -> String {
    replace_guarded(
        text,
        re,
        |t, start, end| {
            t[..start]
                .chars()
                .next_back()
                .is_some_and(|c| script.contains(&c))
                && i_danda_tail(t, end)
        },
        |caps| format!("{}\u{0964}", caps.get(1).map_or("", |m| m.as_str())),
    )
}

/// `&` read "and" after HTML character references are decoded (`_en_ampersand`).
fn en_ampersand(text: &str) -> String {
    let decoded = HTML_REF_RE.replace_all(text, |caps: &Captures| html_reference(&caps[0][1..]));
    EN_AMPERSAND_RE.replace_all(&decoded, " and ").into_owned()
}

/// Windows-1252 readings of the C1 references and the other `html._invalid_charrefs`.
fn invalid_charref(num: u128) -> Option<&'static str> {
    Some(match num {
        0x00 => "\u{fffd}",
        0x0d => "\r",
        0x80 => "\u{20ac}",
        0x81 => "\u{81}",
        0x82 => "\u{201a}",
        0x83 => "\u{0192}",
        0x84 => "\u{201e}",
        0x85 => "\u{2026}",
        0x86 => "\u{2020}",
        0x87 => "\u{2021}",
        0x88 => "\u{02c6}",
        0x89 => "\u{2030}",
        0x8a => "\u{0160}",
        0x8b => "\u{2039}",
        0x8c => "\u{0152}",
        0x8d => "\u{8d}",
        0x8e => "\u{017d}",
        0x8f => "\u{8f}",
        0x90 => "\u{90}",
        0x91 => "\u{2018}",
        0x92 => "\u{2019}",
        0x93 => "\u{201c}",
        0x94 => "\u{201d}",
        0x95 => "\u{2022}",
        0x96 => "\u{2013}",
        0x97 => "\u{2014}",
        0x98 => "\u{02dc}",
        0x99 => "\u{2122}",
        0x9a => "\u{0161}",
        0x9b => "\u{203a}",
        0x9c => "\u{0153}",
        0x9d => "\u{9d}",
        0x9e => "\u{017e}",
        0x9f => "\u{0178}",
        _ => return None,
    })
}

/// `html._invalid_codepoints`: references that decode to nothing.
fn is_invalid_codepoint(num: u128) -> bool {
    matches!(num, 0x1..=0x8 | 0xb | 0xe..=0x1f | 0x7f..=0x9f | 0xfdd0..=0xfdef)
        || (num <= 0x10ffff && (num & 0xfffe) == 0xfffe)
}

/// HTML named references without a semicolon (`html.entities.html5` legacy names) for Latin-1 U+00A0-U+00FF.
const LATIN1_NAMES: [&str; 96] = [
    "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf",
    "laquo", "not", "shy", "reg", "macr", "deg", "plusmn", "sup2", "sup3", "acute", "micro",
    "para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
    "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute",
    "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml", "ETH", "Ntilde", "Ograve", "Oacute",
    "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute",
    "THORN", "szlig", "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
    "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml", "eth", "ntilde",
    "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc",
    "uuml", "yacute", "thorn", "yuml",
];

/// The other legacy names without a semicolon.
const LEGACY_NAMES: [(&str, char); 10] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("AMP", '&'),
    ("LT", '<'),
    ("GT", '>'),
    ("QUOT", '"'),
    ("COPY", '\u{a9}'),
    ("REG", '\u{ae}'),
];

/// Named references with a semicolon beyond the legacy names (a subset of `html.entities.html5`).
const SEMICOLON_NAMES: [(&str, char); 21] = [
    ("apos", '\''),
    ("hellip", '\u{2026}'),
    ("mdash", '\u{2014}'),
    ("ndash", '\u{2013}'),
    ("lsquo", '\u{2018}'),
    ("rsquo", '\u{2019}'),
    ("sbquo", '\u{201a}'),
    ("ldquo", '\u{201c}'),
    ("rdquo", '\u{201d}'),
    ("bdquo", '\u{201e}'),
    ("bull", '\u{2022}'),
    ("euro", '\u{20ac}'),
    ("trade", '\u{2122}'),
    ("minus", '\u{2212}'),
    ("dagger", '\u{2020}'),
    ("Dagger", '\u{2021}'),
    ("permil", '\u{2030}'),
    ("lsaquo", '\u{2039}'),
    ("rsaquo", '\u{203a}'),
    ("ensp", '\u{2002}'),
    ("emsp", '\u{2003}'),
];

fn legacy_name(name: &str) -> Option<char> {
    if let Some(i) = LATIN1_NAMES.iter().position(|n| *n == name) {
        return char::from_u32(0xa0 + i as u32);
    }
    LEGACY_NAMES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, c)| *c)
}

/// `html.unescape` of one reference; `body` is the text after `&`, ending in `;`.
fn html_reference(body: &str) -> String {
    if let Some(number) = body.strip_prefix('#') {
        let digits = number.trim_end_matches(';');
        let parsed = match digits.strip_prefix(['x', 'X']) {
            Some(hex) => u128::from_str_radix(hex, 16),
            None => digits.parse::<u128>(),
        };
        let num = parsed.unwrap_or(u128::MAX);
        if let Some(text) = invalid_charref(num) {
            return text.to_string();
        }
        if (0xd800..=0xdfff).contains(&num) || num > 0x10ffff {
            return "\u{fffd}".to_string();
        }
        if is_invalid_codepoint(num) {
            return String::new();
        }
        return u32::try_from(num)
            .ok()
            .and_then(char::from_u32)
            .map_or_else(|| "\u{fffd}".to_string(), String::from);
    }
    let name = &body[..body.len() - 1];
    if let Some(c) = legacy_name(name).or_else(|| {
        SEMICOLON_NAMES
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, c)| *c)
    }) {
        return c.to_string();
    }
    // The longest legacy name that prefixes the reference, the rest kept as written.
    for cut in (2..body.len()).rev() {
        if !body.is_char_boundary(cut) {
            continue;
        }
        if let Some(c) = legacy_name(&body[..cut]) {
            return format!("{c}{}", &body[cut..]);
        }
    }
    format!("&{body}")
}
