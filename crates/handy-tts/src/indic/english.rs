//! Port of `indic_tiny_tts/frontend/en_infer.py` at sulabhkatiyar/indic-tiny-tts-english@eea5d4a578c0f18173825a037487cf9c47ed4247 (the Hindi package carries the same file), MIT, see INDIC-TINY-TTS-CODE-LICENSE.
//! Lookbehinds are checked on the text before a match start. A trailing lookahead is a group named `la`
//! (`la2`, `la3`) that consumes what the lookahead inspects; the match ends where that group starts.
use super::{guarded::replace_guarded, is_py_space, py_strip};
use regex::{Captures, NoExpand, Regex};
use std::sync::LazyLock;

/// Passes of `one_pass` at most before `normalize_en` returns.
const MAX_PASSES: usize = 4;

/// Python's `\s` as a regex class.
const WS: &str = r"[\s\x1C-\x1F]";
/// `[A-Za-z]` under `re.IGNORECASE` (also U+0130, U+0131, U+017F and U+212A).
const LETTERS_CI: &str = "A-Za-z\u{130}\u{131}\u{17f}\u{212a}";
/// The letter `i` under `re.IGNORECASE`.
const I_CI: &str = "[iI\u{130}\u{131}]";
/// Python's `\w` as a class body.
const WORD: &str = r"\p{L}\p{N}_";
const RUPEE: char = '\u{20b9}';
const EN_DASH: char = '\u{2013}';
/// ' and RIGHT SINGLE QUOTATION MARK.
const APOSTROPHES: &str = "'\u{2019}";
/// ' and both single quotation marks (`_Q`).
const QUOTES: &str = "'\u{2019}\u{2018}";
/// Characters stripped from the end of a URL or e-mail span (`_URL_TRAIL`).
const URL_TRAIL: &[char] = &[
    '.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"', '\u{2019}', '\u{201d}',
];
const TLD: &str = "com|org|net|in|gov|edu|co|io|info|ai|uk|us|me|tv|biz|nic|ac";

/// ALLCAPS tokens read as words, kept as written (`ACRONYM_WORDS`).
const ACRONYM_WORDS: &[&str] = &[
    "AIDS", "AIIMS", "OK", "SARS", "ISIS", "NABARD", "ISRO", "NASA", "UNESCO", "UNICEF", "FIFA",
    "OPEC", "SEBI", "NEET", "IKEA", "BHIM", "RERA", "NOTA", "POTA", "POCSO", "NITI", "LASIK",
    "SWAT", "BAFTA", "OPPO", "JIPMER", "IGNOU", "CRISIL", "PIN", "SIM", "PAN", "VAT", "UDAN",
    "SWAYAM", "AYUSH", "AMRUT", "HRIDAY", "UJALA", "CIDCO", "CREDAI", "NACO", "MARPOL", "RITES",
    "ISIL", "FEMA", "RAHAT", "SKIMS", "SAT", "FOBO", "LUX", "GIFT", "SAFTA", "JAXA", "FINRA",
    "SCOBY", "SNAP", "CAMS", "NATO", "COVID", "ASEAN", "SAARC", "BRICS", "FICCI", "SAIL", "GAIL",
    "NALCO", "ULFA",
];
/// Common words typed in capitals for emphasis, lowercased (`CAPS_COMMON_WORDS`).
const CAPS_COMMON_WORDS: &[&str] = &[
    "THE", "AND", "OF", "TO", "IN", "ON", "AT", "BY", "FOR", "FROM", "WITH", "INTO", "IS", "ARE",
    "WAS", "WERE", "BE", "BEEN", "HAS", "HAVE", "HAD", "WILL", "NOT", "NO", "YES", "YOU", "YOUR",
    "MY", "ME", "WE", "OUR", "HE", "SHE", "HIS", "HER", "THEY", "THEM", "THIS", "THAT", "THESE",
    "WHAT", "WHY", "HOW", "WHEN", "WHERE", "ALL", "ANY", "SOME", "ONE", "TWO", "NEW", "NEWS",
    "LIVE", "WATCH", "READ", "ALSO", "ALERT", "NOW", "TOP", "HOT", "BIG", "SALE", "FREE", "OFF",
    "LOVE", "HAPPY", "THANK", "THANKS", "PLEASE", "STOP", "HELP", "NOTE", "MUST", "NEXT", "LIST",
    "POST", "EACH", "CHECK", "UPDATE", "VIDEO", "PHOTO", "PHOTOS", "OPEN", "CLOSED", "DAY",
    "TODAY", "WORLD", "STATE", "CITY", "GOOD", "BEST", "WIN", "WINS", "WON", "LOST", "DEATH",
    "SCHOOL", "LIFE", "TIME", "POWER", "OPINION", "MORE", "MOST", "VERY", "JUST", "ONLY", "OVER",
    "AFTER", "BEFORE", "SAYS", "SAID",
];
/// Place names typed in capitals, title-cased (`CAPS_PLACE_NAMES`).
const CAPS_PLACE_NAMES: &[&str] = &[
    "INDIA", "DELHI", "MUMBAI", "PANAJI", "PUNE", "GOA", "PATNA", "AGRA", "JAIPUR", "BHOPAL",
    "KOCHI", "NAGPUR", "SURAT", "INDORE", "RANCHI", "SHIMLA", "MARGAO", "MAPUSA", "KOHIMA",
    "IMPHAL", "ASSAM", "KERALA", "BIHAR", "PUNJAB", "NEPAL", "CHINA", "JAPAN", "LONDON", "PARIS",
    "DHAKA",
];
const ROMAN_NUMERALS: &[&str] = &[
    "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "XIII", "XIV", "XV", "XX",
];
/// Initialisms of seven or more letters that are spelled (`LONG_ACRONYMS`).
const LONG_ACRONYMS: &[&str] = &["MGNREGA", "MGNREGS", "APSPDCL"];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("pre-pass patterns are valid")
}

static DECIMAL: LazyLock<Regex> = LazyLock::new(|| regex(r"^\d$"));
static PY_WORD: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^[{WORD}]$")));
static TITLECASE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\p{Lt}$"));

static KEEP_STOP_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^{WS}+[A-Z]")));
static SPELLED_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "(?:[A-Z](?: [A-Z]){{2,}}|[B-HJ-Z] [A-Z])(?P<la>$|[^A-Za-z{APOSTROPHES}])"
    ))
});
static WORD2_RE: LazyLock<Regex> = LazyLock::new(|| regex("[A-Za-z]{2,}"));
static LONE_I_RE: LazyLock<Regex> = LazyLock::new(|| regex(r"i(?P<la>$|[^A-Za-z.])"));
static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+"));
static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?i:https?://|www\.)[^\s\x1C-\x1F]+|(?:[A-Za-z0-9\-]+\.)+(?:{TLD})(?:/[^\s\x1C-\x1F]*|(?P<la>$|[^A-Za-z0-9\-/]))"
    ))
});
static SCHEME_RE: LazyLock<Regex> = LazyLock::new(|| regex("^(?i:https?://)"));
static HANDLE_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("@[{WORD}]+")));
static AT_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("{WS}*@{WS}*")));
static ABBR_DOTTED_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<w>(?i:Dr|Mr|Mrs)|(?P<ms>Ms)|(?i:Prof|Sr{I_CI}|Shr{I_CI}|Smt))\."
    ))
});
static ABBR_NODOT_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!("(?P<w>Dr|Prof|Smt)(?P<la>{WS}+[A-Z])")));
static SERIAL_NO_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!(r"(?i:Sr)\.?{WS}?(?i:No)\.?{WS}?(?P<la>\d)")));
static TITLES_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(concat!(
        r"(?P<t1>Lt|Col|Capt|Gen|Maj|Brig|Mt|Jr|Sr|Ltd|Pvt)\.(?P<la>$|[^A-Za-z])",
        r"|(?P<t2>Ltd|Pvt)(?P<la2>$|[^A-Za-z.])",
        r"|(?P<t3>Pvt)\.(?P<la3>Ltd)",
    ))
});
static NAME_BEFORE_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("[A-Z][a-z]+{WS}+$")));
static GOVT_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!(r"(?i:Govt)(?P<dot>\.)?(?P<la>$|[^{LETTERS_CI}])")));
static ETC_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!(r"(?i:etc)(?P<dot>\.)?(?P<la>$|[^{LETTERS_CI}])")));
static VS_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(r"(?:[vV]s\.?|VS\.|[vV]/[sS])(?P<la>$|[^A-Za-z])"));
static EG_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<w>(?i:e\.g|{I_CI}\.e))\.(?P<la>$|[^{LETTERS_CI}])"
    ))
});
static NO_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!(r"(?i:No)\.{WS}?(?P<la>\d)")));
static ST_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!(r"(?i:St)(?P<dot>\.)?(?P<la>$|[^{LETTERS_CI}])")));
static NEXT_LETTER_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^{WS}+([A-Za-z])")));
static PREV_WORD_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!("([A-Za-z][A-Za-z{APOSTROPHES}]*){WS}+$")));
static CUR_AFTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<amt>\d[\d,]*(?:\.\d+)?){WS}?(?P<code>(?i:USD|{I_CI}NR))(?P<la>$|[^{LETTERS_CI}])"
    ))
});
static CUR_RANGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?:(?P<usd>(?i:US)\$|\$)|(?i:Rs)\.?|{RUPEE}){WS}?(?P<a>\d+(?:,\d+)*){WS}?(?:-|{EN_DASH}|(?i:to)){WS}?(?:\$|(?i:Rs)\.?{WS}?|{RUPEE})?(?P<b>\d+(?:,\d+)*)"
    ))
});
static CURRENCY_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?:(?i:Rs)\.?|(?i:{I_CI}NR)|{RUPEE}|(?P<usd>(?i:US)\$|\$|(?i:USD))){WS}?(?P<amt>\d[\d,]*\.\d+|\d(?:[\d,]*\d)?)"
    ))
});
static SCALE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "^{WS}*(?P<scale>(?i:lakhs?|lacs?|crores?|crs?|thousand|m{I_CI}ll{I_CI}ons?|b{I_CI}ll{I_CI}ons?))(?P<la>$|[^{WORD}])"
    ))
});
static SCALE2_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "^{WS}+(?P<scale>(?i:crores?|crs?))(?P<la>$|[^{WORD}])"
    ))
});
static DASH_RE: LazyLock<Regex> = LazyLock::new(|| regex(&format!("^{WS}*/-")));
static UNIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<n>\d[\d,]*(?:\.\d+)?)(?:{WS}?(?P<u>km/h|kmph|kms|km|Kms|Km|kgs|kg|Kgs|Kg|cm|mm|ft|ml|mg|gms|gm)|{WS}(?P<g>g))(?P<la>$|[^A-Za-z\d/])"
    ))
});
static INDIAN_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(r"(?P<n>\d{1,2}(?:,\d{2})+,\d{3})(?:\.(?P<frac>\d+))?(?P<la>$|[^\d,.]|[,.](?:$|\D))")
});
static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?P<d>\d{1,2})(?:/(?P<m1>\d{1,2})/|\.(?P<m2>\d{1,2})\.|-(?P<m3>\d{1,2})-)(?P<y>\d{4})(?P<la>$|[^\d/.\-]|[/.\-](?:$|\D))",
    )
});
static ISO_DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(r"(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})(?P<la>$|[^\d/.\-]|[/.\-](?:$|\D))")
});
static DECADE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<c>1\d|20)(?P<d>\d)0[{QUOTES}]?s(?P<la>$|[^A-Za-z])"
    ))
});
static SHORT_DECADE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "[{QUOTES}]?(?P<d>[2-9])0[{QUOTES}]?s(?P<la>$|[^A-Za-z])"
    ))
});
static TIME_RE: LazyLock<Regex> = LazyLock::new(|| regex(r"(?P<h>\d{1,2}):(?P<m>\d{2})"));
static AMPM_TAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"^{WS}?(?P<ap>[AaPp])(?P<dot>\.)?{WS}?[Mm](?P<dot2>\.)?(?P<la>$|[^A-Za-z])"
    ))
});
static DOT_TIME_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<h>\d{{1,2}})\.(?P<m>\d{{2}}){WS}?(?P<ap>[AaPp])(?P<dot>\.)?{WS}?[Mm](?P<dot2>\.)?(?P<la>$|[^A-Za-z])"
    ))
});
static HOUR_AMPM_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<h>\d{{1,2}}){WS}?(?P<ap>[AaPp])(?P<dot>\.)?{WS}?[Mm](?P<dot2>\.)?(?P<la>$|[^A-Za-z])"
    ))
});
static DEGREE_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(r"(?P<p>Ph|M|B)\.?(?P<s>D|Sc|Tech|Com|Phil)(?P<dot>\.)?(?P<la>$|[^A-Za-z])")
});
static DOTTED_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        r"(?P<l>[A-Z](?:\.{WS}?[A-Z])+)(?P<dot>\.)?(?P<la>$|[^A-Za-z])"
    ))
});
static CAPS_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "(?P<w>[A-Z]{{2,6}})(?P<s>[{APOSTROPHES}]s|s)?(?P<la>$|[^A-Za-z])"
    ))
});
static LETTER_RUN_RE: LazyLock<Regex> =
    LazyLock::new(|| regex(&format!("[A-Z](?: [A-Z])+(?P<la>$|[^A-Za-z{APOSTROPHES}])")));
static LONG_CAPS_RE: LazyLock<Regex> = LazyLock::new(|| {
    regex(&format!(
        "(?P<w>[A-Z]{{7,}})(?P<s>[{APOSTROPHES}]s)?(?P<la>$|[^A-Za-z])"
    ))
});
static SPACES_RE: LazyLock<Regex> = LazyLock::new(|| regex("[ \t]+"));

// ------------------------------------------------------------------ characters

fn char_in(re: &Regex, c: char) -> bool {
    let mut buf = [0u8; 4];
    re.is_match(c.encode_utf8(&mut buf))
}

/// Python's `\d` and `str.isdecimal` (general category Nd).
fn is_decimal(c: char) -> bool {
    c.is_ascii_digit() || (!c.is_ascii() && char_in(&DECIMAL, c))
}

/// The value of a decimal digit: Nd digits come in runs of ten starting at zero.
fn decimal_value(c: char) -> u32 {
    if let Some(d) = c.to_digit(10) {
        return d;
    }
    let mut zero = u32::from(c);
    while let Some(before) = zero.checked_sub(1).and_then(char::from_u32) {
        if !is_decimal(before) {
            break;
        }
        zero -= 1;
    }
    (u32::from(c) - zero) % 10
}

/// Python's `int()` of at most four decimal digits.
fn int_value(digits: &str) -> u32 {
    digits.chars().fold(0, |n, c| n * 10 + decimal_value(c))
}

/// Python's `str.isdigit` (decimals plus the digit-valued No characters).
fn is_py_digit(c: char) -> bool {
    is_decimal(c)
        || matches!(
            c,
            '\u{b2}'..='\u{b3}'
                | '\u{b9}'
                | '\u{1369}'..='\u{1371}'
                | '\u{19da}'
                | '\u{2070}'
                | '\u{2074}'..='\u{2079}'
                | '\u{2080}'..='\u{2089}'
                | '\u{2460}'..='\u{2468}'
                | '\u{2474}'..='\u{247c}'
                | '\u{2488}'..='\u{2490}'
                | '\u{24ea}'
                | '\u{24f5}'..='\u{24fd}'
                | '\u{24ff}'
                | '\u{2776}'..='\u{277e}'
                | '\u{2780}'..='\u{2788}'
                | '\u{278a}'..='\u{2792}'
                | '\u{10a40}'..='\u{10a43}'
                | '\u{10e60}'..='\u{10e68}'
                | '\u{11052}'..='\u{1105a}'
                | '\u{1f100}'..='\u{1f10a}'
        )
}

/// Python's `\w`.
fn is_py_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || (!c.is_ascii() && char_in(&PY_WORD, c))
}

/// `[A-Za-z]`, under `re.IGNORECASE` when `ignore_case`.
fn is_ascii_letter(c: char, ignore_case: bool) -> bool {
    c.is_ascii_alphabetic()
        || (ignore_case && matches!(c, '\u{130}' | '\u{131}' | '\u{17f}' | '\u{212a}'))
}

fn is_apostrophe(c: char) -> bool {
    APOSTROPHES.contains(c)
}

/// Python's `str.isupper`: a cased character and no lowercase or titlecase one.
fn py_isupper(text: &str) -> bool {
    let mut cased = false;
    for c in text.chars() {
        if c.is_lowercase() || (!c.is_ascii() && char_in(&TITLECASE, c)) {
            return false;
        }
        cased |= c.is_uppercase();
    }
    cased
}

/// Lowercase key of a word matched under `re.IGNORECASE`.
fn fold(word: &str) -> String {
    word.to_lowercase()
        .replace("i\u{307}", "i")
        .replace(['\u{131}'], "i")
        .replace(['\u{17f}'], "s")
}

fn prev_char(text: &str, at: usize) -> Option<char> {
    text[..at].chars().next_back()
}

fn char_at(text: &str, at: usize) -> Option<char> {
    text[at..].chars().next()
}

fn ascii_title(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase()
    })
}

// ------------------------------------------------------------------ matching

fn start_of(caps: &Captures) -> usize {
    caps.get(0).expect("group 0 is the whole match").start()
}

/// End of Python's match: where the consumed lookahead group starts, else the regex match end.
fn la_end(caps: &Captures) -> usize {
    ["la", "la2", "la3"]
        .iter()
        .find_map(|name| caps.name(name))
        .map_or_else(
            || caps.get(0).expect("group 0 is the whole match").end(),
            |la| la.start(),
        )
}

/// Python's matches of a translated pattern in scan order: `accept` returns the end of Python's match at a
/// candidate's start, or `None` where Python finds none there; the scan resumes as `re.finditer` does.
fn py_matches<'t>(
    text: &'t str,
    re: &Regex,
    accept: impl Fn(&str, &Captures) -> Option<usize>,
) -> Vec<(Captures<'t>, usize)> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(caps) = re.captures_at(text, at) {
        let start = start_of(&caps);
        let next = start + char_at(text, start).map_or(1, char::len_utf8);
        match accept(text, &caps) {
            Some(end) => {
                at = if end > start { end } else { next };
                found.push((caps, end));
            }
            None => at = next,
        }
        if at > text.len() {
            break;
        }
    }
    found
}

/// `re.sub` of a translated pattern; `with(text, caps, end)` builds the replacement of Python's match.
fn py_sub(
    text: &str,
    re: &Regex,
    accept: impl Fn(&str, &Captures) -> Option<usize>,
    with: impl Fn(&str, &Captures, usize) -> String,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (caps, end) in py_matches(text, re, accept) {
        out.push_str(&text[copied..start_of(&caps)]);
        out.push_str(&with(text, &caps, end));
        copied = end;
    }
    out.push_str(&text[copied..]);
    out
}

/// Accepts a candidate unless the character before it satisfies `before` (a one-character lookbehind).
fn not_after_char(before: impl Fn(char) -> bool) -> impl Fn(&str, &Captures) -> Option<usize> {
    move |text: &str, caps: &Captures| {
        (!prev_char(text, start_of(caps)).is_some_and(&before)).then(|| la_end(caps))
    }
}

/// Captures of `re` (anchored with `^`) at byte `at`; offsets are relative to `at`.
fn anchored<'t>(re: &Regex, text: &'t str, at: usize) -> Option<Captures<'t>> {
    re.captures(&text[at..])
}

fn group_end(caps: &Captures, name: &str) -> usize {
    caps.name(name).expect("the group always takes part").end()
}

// ------------------------------------------------------------------ shared helpers

fn letter_name(c: char) -> String {
    match c {
        'W' => "doubleyou".to_string(),
        'U' => "you".to_string(),
        'Y' => "why".to_string(),
        'Q' => "cue".to_string(),
        other => other.to_string(),
    }
}

/// `"BJP"` -> `"B J P"`, or a whole-acronym override (`spell`).
fn spell(letters: &str) -> String {
    let upper = letters.to_uppercase();
    if upper == "HDFC" {
        return "aitch dee eff see".to_string();
    }
    upper.chars().map(letter_name).collect::<Vec<_>>().join(" ")
}

/// The abbreviation dot is also a full stop: end of text or a capital after whitespace (`_keep_stop`).
fn keep_stop(text: &str, end: usize) -> bool {
    let rest = &text[end..];
    py_strip(rest).is_empty() || KEEP_STOP_RE.is_match(rest)
}

/// `_SENT_START_RE.search(prefix)`: empty, a lone newline, or a sentence end and whitespace.
fn sentence_start(prefix: &str) -> bool {
    if prefix.is_empty() || prefix == "\n" {
        return true;
    }
    let trimmed = prefix.trim_end_matches(is_py_space);
    trimmed.len() < prefix.len() && trimmed.ends_with(['.', '?', '!'])
}

/// `word` capitalised at a sentence start (`_cap`).
fn cap(word: &str, text: &str, start: usize) -> String {
    if sentence_start(&text[..start]) {
        ascii_title_first(word)
    } else {
        word.to_string()
    }
}

fn ascii_title_first(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}

// ------------------------------------------------------------------ 0. mostly-uppercase sentences

fn mostly_upper(sentence: &str) -> bool {
    let words: Vec<&str> = WORD2_RE.find_iter(sentence).map(|m| m.as_str()).collect();
    let caps = words
        .iter()
        .filter(|w| w.bytes().all(|b| b.is_ascii_uppercase()))
        .count();
    caps >= 2 && caps as f64 >= 0.8 * words.len() as f64
}

fn lone_i(text: &str) -> String {
    py_sub(
        text,
        &LONE_I_RE,
        not_after_char(|c| c.is_ascii_alphabetic() || c == '.' || is_apostrophe(c)),
        |_, _, _| "I".to_string(),
    )
}

/// Lowercases a sentence but keeps pre-spaced letter runs (`_lower_keep_spelled`).
fn lower_keep_spelled(sentence: &str) -> String {
    let mut out = String::with_capacity(sentence.len());
    let mut pos = 0;
    let spelled = py_matches(
        sentence,
        &SPELLED_RE,
        not_after_char(|c| c.is_ascii_alphabetic() || is_apostrophe(c)),
    );
    for (caps, end) in spelled {
        let start = start_of(&caps);
        out.push_str(&lone_i(&sentence[pos..start].to_lowercase()));
        out.push_str(&sentence[start..end]);
        pos = end;
    }
    out.push_str(&lone_i(&sentence[pos..].to_lowercase()));
    out
}

fn lower_if_shouting(sentence: &str) -> String {
    if mostly_upper(sentence) {
        lower_keep_spelled(sentence)
    } else {
        sentence.to_string()
    }
}

/// `_lower_shouting`: sentences split at whitespace after `.?!` or at a newline run.
fn lower_shouting(text: &str) -> String {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = String::with_capacity(text.len());
    let mut piece = 0;
    let mut k = 0;
    while k < chars.len() {
        let (pos, c) = chars[k];
        let after_stop = k > 0 && matches!(chars[k - 1].1, '.' | '?' | '!');
        let in_run: fn(char) -> bool = if after_stop && is_py_space(c) {
            is_py_space
        } else if c == '\n' {
            |ch: char| ch == '\n'
        } else {
            k += 1;
            continue;
        };
        let mut j = k;
        while j < chars.len() && in_run(chars[j].1) {
            j += 1;
        }
        let end = chars.get(j).map_or(text.len(), |(at, _)| *at);
        out.push_str(&lower_if_shouting(&text[piece..pos]));
        out.push_str(&text[pos..end]);
        piece = end;
        k = j;
    }
    out.push_str(&lower_if_shouting(&text[piece..]));
    out
}

// ------------------------------------------------------------------ 1. URLs and e-mails

fn separator_word(token: &str) -> Option<&'static str> {
    match token {
        "." => Some("dot"),
        "/" => Some("slash"),
        "@" => Some("at"),
        "_" => Some("underscore"),
        "-" => Some("dash"),
        _ => None,
    }
}

/// `re.split(r"([./@_-])", span)`: tokens and the separators between them.
fn split_separators(span: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut from = 0;
    for (at, c) in span.char_indices() {
        if matches!(c, '.' | '/' | '@' | '_' | '-') {
            tokens.push(&span[from..at]);
            tokens.push(&span[at..at + 1]);
            from = at + 1;
        }
    }
    tokens.push(&span[from..]);
    tokens
}

/// An address read aloud (`_speak_url`).
fn speak_url(span: &str) -> String {
    let span = SCHEME_RE.replace(span, "");
    let (host, rest) = span.split_at(span.find('/').unwrap_or(span.len()));
    let span = if py_isupper(&span) {
        span.to_lowercase()
    } else if py_isupper(host) {
        host.to_lowercase() + rest
    } else {
        span.to_string()
    };
    let mut words = Vec::new();
    for token in split_separators(&span) {
        if token.is_empty() {
            continue;
        }
        if let Some(word) = separator_word(token) {
            words.push(word.to_string());
        } else if token.to_lowercase() == "www" {
            words.push(spell("www"));
        } else {
            words.extend(
                token
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .filter(|part| !part.is_empty())
                    .map(str::to_string),
            );
        }
    }
    words.join(" ")
}

/// A matched span without its trailing punctuation, read aloud, then that punctuation.
fn speak_span(span: &str) -> String {
    let trimmed = span.trim_end_matches(URL_TRAIL);
    let tail = &span[trimmed.len()..];
    let spoken = if trimmed.is_empty() {
        String::new()
    } else {
        speak_url(trimmed)
    };
    spoken + tail
}

fn urls(text: &str) -> String {
    let text = replace_guarded(
        text,
        &EMAIL_RE,
        |t, start, _| !prev_char(t, start).is_some_and(|c| is_py_word(c) || c == '.' || c == '@'),
        |caps| speak_span(&caps[0]),
    );
    let text = py_sub(
        &text,
        &URL_RE,
        not_after_char(|c| is_py_word(c) || c == '@'),
        |t, caps, end| speak_span(&t[start_of(caps)..end]),
    );
    let text = HANDLE_RE.replace_all(&text, |caps: &Captures| {
        caps[0].replace('_', " underscore ")
    });
    AT_RE.replace_all(&text, NoExpand(" at ")).into_owned()
}

// ------------------------------------------------------------------ 2. abbreviations

/// `_NOT_AFTER`: not inside a word and not after a digit and a space.
fn not_after(text: &str, start: usize, ignore_case: bool) -> bool {
    let mut before = text[..start].chars().rev();
    let (first, second) = (before.next(), before.next());
    let in_word =
        first.is_some_and(|c| is_ascii_letter(c, ignore_case) || c.is_ascii_digit() || c == '.');
    let after_number = first == Some(' ') && second.is_some_and(is_decimal);
    !in_word && !after_number
}

fn not_after_ci(text: &str, caps: &Captures) -> Option<usize> {
    not_after(text, start_of(caps), true).then(|| la_end(caps))
}

fn not_after_cs(text: &str, caps: &Captures) -> Option<usize> {
    not_after(text, start_of(caps), false).then(|| la_end(caps))
}

/// `_TITLE_NOT_AFTER`: not after a letter, digit or dot.
fn title_not_after(text: &str, caps: &Captures) -> Option<usize> {
    not_after_char(|c| c.is_ascii_alphanumeric() || c == '.')(text, caps)
}

/// A capital and a space right before `start` (`(?<![A-Z] )`).
fn capital_space_before(text: &str, start: usize) -> bool {
    let mut before = text[..start].chars().rev();
    before.next() == Some(' ') && before.next().is_some_and(|c| c.is_ascii_uppercase())
}

fn dotted_title(word: &str) -> Option<&'static str> {
    match fold(word).as_str() {
        "dr" => Some("Doctor"),
        "mr" => Some("Mister"),
        "mrs" => Some("Missus"),
        "ms" => Some("Miss"),
        "prof" => Some("Professor"),
        "sri" | "shri" => Some("Shri"),
        "smt" => Some("Shrimati"),
        _ => None,
    }
}

fn title_word(word: &str) -> &'static str {
    match word {
        "Lt" => "Lieutenant",
        "Col" => "Colonel",
        "Capt" => "Captain",
        "Gen" => "General",
        "Maj" => "Major",
        "Brig" => "Brigadier",
        "Mt" => "Mount",
        "Jr" => "Junior",
        "Sr" => "Senior",
        "Ltd" => "Limited",
        _ => "Private",
    }
}

fn titles(text: &str, caps: &Captures, end: usize) -> String {
    if caps.name("t3").is_some() {
        return "Private ".to_string();
    }
    let t1 = caps.name("t1").map(|m| m.as_str());
    let word = t1
        .or_else(|| caps.name("t2").map(|m| m.as_str()))
        .expect("one title alternative matched");
    let stop = match t1 {
        Some("Ltd") => keep_stop(text, end),
        Some("Jr" | "Sr") => {
            py_strip(&text[end..]).is_empty()
                || (NAME_BEFORE_RE.is_match(&text[..start_of(caps)]) && keep_stop(text, end))
        }
        _ => false,
    };
    format!("{}{}", title_word(word), if stop { "." } else { "" })
}

fn with_stop(word: &str, caps: &Captures, text: &str, end: usize) -> String {
    let stop = caps.name("dot").is_some() && keep_stop(text, end);
    format!("{word}{}", if stop { "." } else { "" })
}

fn saint_street(text: &str, caps: &Captures, end: usize) -> String {
    let start = start_of(caps);
    let next_cap = NEXT_LETTER_RE
        .captures(&text[end..])
        .is_some_and(|next| next[1].starts_with(|c: char| c.is_ascii_uppercase()));
    let prev = PREV_WORD_RE.captures(&text[..start]);
    let prev_cap = prev.as_ref().is_some_and(|prev| {
        let word = prev.get(1).expect("group 1 always takes part");
        word.as_str().starts_with(|c: char| c.is_ascii_uppercase())
            && !sentence_start(&text[..word.start()])
    });
    if caps.name("dot").is_none() {
        return if next_cap && !prev_cap {
            "Saint".to_string()
        } else {
            text[start..end].to_string()
        };
    }
    if prev.is_some() && !next_cap {
        return format!("Street{}", if keep_stop(text, end) { "." } else { "" });
    }
    "Saint".to_string()
}

fn abbreviations(text: &str) -> String {
    let text = py_sub(
        text,
        &ABBR_DOTTED_RE,
        |text, caps| {
            let start = start_of(caps);
            let ms_after_capital = caps.name("ms").is_some() && capital_space_before(text, start);
            (not_after(text, start, true) && !ms_after_capital).then(|| la_end(caps))
        },
        |t, caps, end| {
            dotted_title(&caps["w"])
                .map_or_else(|| t[start_of(caps)..end].to_string(), str::to_string)
        },
    );
    let text = py_sub(&text, &ABBR_NODOT_RE, not_after_cs, |t, caps, end| {
        dotted_title(&caps["w"]).map_or_else(|| t[start_of(caps)..end].to_string(), str::to_string)
    });
    let text = py_sub(&text, &SERIAL_NO_RE, title_not_after, |t, caps, _| {
        cap("serial number", t, start_of(caps)) + " "
    });
    let text = py_sub(&text, &TITLES_RE, title_not_after, titles);
    let text = py_sub(&text, &EG_RE, not_after_ci, |_, caps, _| {
        if fold(&caps["w"]) == "e.g" {
            "for example".to_string()
        } else {
            "that is".to_string()
        }
    });
    let text = py_sub(&text, &GOVT_RE, not_after_ci, |t, caps, end| {
        with_stop("Government", caps, t, end)
    });
    let text = py_sub(&text, &ETC_RE, not_after_ci, |t, caps, end| {
        with_stop("et cetera", caps, t, end)
    });
    let text = py_sub(&text, &VS_RE, not_after_cs, |_, _, _| "versus".to_string());
    let text = py_sub(&text, &NO_RE, not_after_ci, |t, caps, _| {
        cap("number", t, start_of(caps)) + " "
    });
    py_sub(&text, &ST_RE, not_after_ci, saint_street)
}

// ------------------------------------------------------------------ 3. currency, units, grouping

fn scale_word(word: &str) -> String {
    match fold(word).as_str() {
        "lakh" | "lakhs" | "lac" | "lacs" => "lakh".to_string(),
        "crore" | "crores" | "cr" | "crs" => "crore".to_string(),
        "million" | "millions" => "million".to_string(),
        "billion" | "billions" => "billion".to_string(),
        other => other.to_string(),
    }
}

fn is_crore_abbreviation(word: &str) -> bool {
    matches!(fold(word).as_str(), "cr" | "crs")
}

/// A scale word after an amount: `\s*scale\b`, an optional compound `\s+crore\b`, then an optional dot.
struct Scale<'t> {
    word: &'t str,
    second: Option<&'t str>,
    dot: bool,
    end: usize,
}

fn scale_at(text: &str, at: usize, compound: bool) -> Option<Scale<'_>> {
    let caps = anchored(&SCALE_RE, text, at)?;
    let word = caps
        .name("scale")
        .expect("the group always takes part")
        .as_str();
    let mut pos = at + la_end(&caps);
    let mut second = None;
    if let Some(more) = anchored(&SCALE2_RE, text, pos).filter(|_| compound) {
        second = Some(
            more.name("scale")
                .expect("the group always takes part")
                .as_str(),
        );
        pos += la_end(&more);
    }
    let dot = text[pos..].starts_with('.');
    Some(Scale {
        word,
        second,
        dot,
        end: pos + usize::from(dot),
    })
}

/// End after an optional `\s*/-` at `at`.
fn dash_end(text: &str, at: usize) -> usize {
    anchored(&DASH_RE, text, at).map_or(at, |caps| {
        at + caps.get(0).expect("group 0 is the whole match").end()
    })
}

/// `(?<![A-Za-z])` before the code-letter alternatives of the currency patterns (`$` and the rupee sign have none).
fn currency_start(text: &str, start: usize) -> bool {
    matches!(char_at(text, start), Some('$') | Some(RUPEE))
        || !prev_char(text, start).is_some_and(|c| is_ascii_letter(c, true))
}

fn range_accept(text: &str, caps: &Captures) -> Option<usize> {
    if !currency_start(text, start_of(caps)) {
        return None;
    }
    let b_end = group_end(caps, "b");
    let mut rest = text[b_end..].chars();
    let next = rest.next();
    let digit_after_mark = matches!(next, Some('.' | ',')) && rest.next().is_some_and(is_decimal);
    if next.is_some_and(is_decimal) || digit_after_mark {
        return None;
    }
    let after = scale_at(text, b_end, false).map_or(b_end, |scale| scale.end);
    Some(dash_end(text, after))
}

fn range_words(text: &str, caps: &Captures, end: usize) -> String {
    let scale = scale_at(text, group_end(caps, "b"), false);
    let mut words = format!("{} to {} ", &caps["a"], &caps["b"]);
    if let Some(scale) = &scale {
        words.push_str(&scale_word(scale.word));
        words.push(' ');
    }
    words.push_str(if caps.name("usd").is_some() {
        "dollars"
    } else {
        "rupees"
    });
    if scale.is_some_and(|s| s.dot && (!is_crore_abbreviation(s.word) || keep_stop(text, end))) {
        words.push('.');
    }
    words
}

fn currency_accept(text: &str, caps: &Captures) -> Option<usize> {
    if !currency_start(text, start_of(caps)) {
        return None;
    }
    let amt_end = group_end(caps, "amt");
    let after = scale_at(text, amt_end, true).map_or(amt_end, |scale| scale.end);
    Some(dash_end(text, after))
}

fn currency_words(text: &str, caps: &Captures, end: usize) -> String {
    let amt = &caps["amt"];
    let (one, many, sub) = if caps.name("usd").is_some() {
        ("dollar", "dollars", "cents")
    } else {
        ("rupee", "rupees", "paise")
    };
    if let Some(scale) = scale_at(text, group_end(caps, "amt"), true) {
        let compound = if scale.second.is_some() { " crore" } else { "" };
        let mut words = format!("{amt} {}{compound} {many}", scale_word(scale.word));
        let last = scale.second.unwrap_or(scale.word);
        if scale.dot && (!is_crore_abbreviation(last) || keep_stop(text, end)) {
            words.push('.');
        }
        return words;
    }
    if let Some((whole, frac)) = amt
        .split_once('.')
        .filter(|(_, frac)| frac.chars().count() == 2)
    {
        let paise = int_value(frac);
        let rupees = if whole.trim_matches(['0', ',']).is_empty() {
            String::new()
        } else {
            format!("{whole} {}", if whole == "1" { one } else { many })
        };
        if paise == 0 {
            return if rupees.is_empty() {
                format!("0 {many}")
            } else {
                rupees
            };
        }
        let small = if sub == "cents" && paise == 1 {
            "cent"
        } else {
            sub
        };
        return if rupees.is_empty() {
            format!("{paise} {small}")
        } else {
            format!("{rupees} {paise} {small}")
        };
    }
    format!("{amt} {}", if amt == "1" { one } else { many })
}

fn currency(text: &str) -> String {
    let text = py_sub(
        text,
        &CUR_AFTER_RE,
        not_after_char(|c| is_ascii_letter(c, true) || is_decimal(c) || c == '.' || c == ','),
        |_, caps, _| format!("{} {}", caps["code"].to_uppercase(), &caps["amt"]),
    );
    let text = py_sub(&text, &CUR_RANGE_RE, range_accept, range_words);
    py_sub(&text, &CURRENCY_RE, currency_accept, currency_words)
}

fn unit_words(unit: &str) -> (&'static str, &'static str) {
    match unit.to_lowercase().as_str() {
        "km/h" | "kmph" => ("kilometre per hour", "kilometres per hour"),
        "km" | "kms" => ("kilometre", "kilometres"),
        "kg" | "kgs" => ("kilogram", "kilograms"),
        "cm" => ("centimetre", "centimetres"),
        "mm" => ("millimetre", "millimetres"),
        "ft" => ("foot", "feet"),
        "ml" => ("millilitre", "millilitres"),
        "mg" => ("milligram", "milligrams"),
        _ => ("gram", "grams"),
    }
}

fn units(text: &str) -> String {
    py_sub(
        text,
        &UNIT_RE,
        not_after_char(|c| c.is_ascii_alphabetic() || is_decimal(c) || c == '.' || c == ','),
        |_, caps, _| {
            let unit = caps
                .name("u")
                .or_else(|| caps.name("g"))
                .expect("one unit alternative matched");
            let (one, many) = unit_words(unit.as_str());
            let n = &caps["n"];
            format!("{n} {}", if n == "1" { one } else { many })
        },
    )
}

/// Digits and Indian scale words (`_indian_words`); `n` is ASCII without leading zeros, or `"0"`.
fn indian_words(n: &str) -> String {
    let (crore, rest) = n.split_at(n.len().saturating_sub(7));
    let rest: u32 = rest.parse().expect("at most seven ASCII digits");
    let mut parts = Vec::new();
    if !crore.is_empty() {
        let crore = if crore.len() >= 6 {
            indian_words(crore)
        } else {
            crore.to_string()
        };
        parts.push(format!("{crore} crore"));
    }
    let (lakh, rest) = (rest / 100_000, rest % 100_000);
    if lakh > 0 {
        parts.push(format!("{lakh} lakh"));
    }
    let (thousand, rest) = (rest / 1000, rest % 1000);
    if thousand > 0 {
        parts.push(format!("{thousand} thousand"));
    }
    if rest > 0 || parts.is_empty() {
        parts.push(rest.to_string());
    }
    parts.join(" ")
}

fn indian_grouping(text: &str) -> String {
    py_sub(
        text,
        &INDIAN_RE,
        not_after_char(|c| is_decimal(c) || c == ',' || c == '.'),
        |_, caps, _| {
            let digits: String = caps["n"]
                .chars()
                .filter(|c| *c != ',')
                .map(|c| {
                    char::from_digit(decimal_value(c), 10).expect("a digit value is below ten")
                })
                .collect();
            let trimmed = digits.trim_start_matches('0');
            let mut words = indian_words(if trimmed.is_empty() { "0" } else { trimmed });
            if let Some(frac) = caps.name("frac") {
                words.push_str(" point ");
                words.push_str(
                    &frac
                        .as_str()
                        .chars()
                        .map(String::from)
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            words
        },
    )
}

// ------------------------------------------------------------------ 4. dates and times

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn ordinal(day: u32) -> String {
    let suffix = if (11..=13).contains(&(day % 100)) {
        "th"
    } else {
        match day % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        }
    };
    format!("{day}{suffix}")
}

fn say_date(original: &str, day: u32, month: u32, year: u32) -> String {
    let valid = (1..=12).contains(&month)
        && (1000..=2999).contains(&year)
        && (1..=days_in_month(year, month)).contains(&day);
    if valid {
        format!("{} {} {year}", ordinal(day), MONTHS[month as usize - 1])
    } else {
        original.to_string()
    }
}

fn decade_word(digit: &str) -> Option<&'static str> {
    Some(match digit {
        "1" => "tens",
        "2" => "twenties",
        "3" => "thirties",
        "4" => "forties",
        "5" => "fifties",
        "6" => "sixties",
        "7" => "seventies",
        "8" => "eighties",
        "9" => "nineties",
        _ => return None,
    })
}

fn date_lookbehind(c: char) -> bool {
    is_decimal(c) || matches!(c, '/' | '.' | ':' | '-')
}

fn dates(text: &str) -> String {
    let text = py_sub(
        text,
        &DATE_RE,
        not_after_char(date_lookbehind),
        |t, caps, end| {
            let month = ["m1", "m2", "m3"]
                .iter()
                .find_map(|name| caps.name(name))
                .expect("one separator alternative matched");
            say_date(
                &t[start_of(caps)..end],
                int_value(&caps["d"]),
                int_value(month.as_str()),
                int_value(&caps["y"]),
            )
        },
    );
    let text = py_sub(
        &text,
        &ISO_DATE_RE,
        not_after_char(date_lookbehind),
        |t, caps, end| {
            say_date(
                &t[start_of(caps)..end],
                int_value(&caps["d"]),
                int_value(&caps["m"]),
                int_value(&caps["y"]),
            )
        },
    );
    let text = py_sub(
        &text,
        &DECADE_RE,
        not_after_char(|c| {
            c.is_ascii_alphabetic() || is_decimal(c) || c == '.' || c == ',' || QUOTES.contains(c)
        }),
        |t, caps, end| {
            let (century, digit) = (&caps["c"], &caps["d"]);
            if digit == "0" {
                return match century {
                    "20" => "2 thousands".to_string(),
                    "10" => "thousands".to_string(),
                    _ => format!("{century} hundreds"),
                };
            }
            decade_word(digit).map_or_else(
                || t[start_of(caps)..end].to_string(),
                |word| format!("{century} {word}"),
            )
        },
    );
    py_sub(
        &text,
        &SHORT_DECADE_RE,
        not_after_char(|c| c.is_ascii_alphabetic() || is_decimal(c) || c == '.' || c == ','),
        |_, caps, _| {
            decade_word(&caps["d"])
                .expect("the digit is 2 to 9")
                .to_string()
        },
    )
}

fn clock(hour: u32, minute: u32, ampm: bool) -> String {
    if minute == 0 {
        return if ampm {
            hour.to_string()
        } else {
            format!("{hour} o'clock")
        };
    }
    format!("{hour} {}{minute}", if minute < 10 { "oh " } else { "" })
}

/// A matched time: hour, minute, the a/p letter and whether `m` had a dot.
#[derive(Clone, Copy)]
struct Clock {
    hour: u32,
    minute: u32,
    ap: Option<char>,
    dot2: bool,
}

fn ampm_letter(ap: char) -> &'static str {
    if ap.eq_ignore_ascii_case(&'a') {
        "ay em"
    } else {
        "pee em"
    }
}

fn time_words(text: &str, start: usize, end: usize, time: &Clock) -> String {
    let Clock {
        hour,
        minute,
        ap,
        dot2,
    } = *time;
    let valid = (hour <= 23 && minute <= 59) || (hour == 24 && minute == 0);
    if !valid || (ap.is_some() && !(1..=12).contains(&hour)) {
        return text[start..end].to_string();
    }
    if (hour == 0 || hour == 24) && ap.is_none() {
        return if minute == 0 {
            "midnight".to_string()
        } else {
            format!("{} {}", clock(12, minute, true), ampm_letter('a'))
        };
    }
    let mut words = clock(hour, minute, ap.is_some());
    if let Some(ap) = ap {
        words.push(' ');
        words.push_str(ampm_letter(ap));
        if dot2 && keep_stop(text, end) {
            words.push('.');
        }
    }
    words
}

fn time_lookbehind(c: char) -> bool {
    is_decimal(c) || matches!(c, ':' | '.' | ',' | '/')
}

fn clock_of(caps: &Captures, tail: Option<&Captures>) -> Clock {
    let ampm = tail.unwrap_or(caps);
    Clock {
        hour: int_value(&caps["h"]),
        minute: caps.name("m").map_or(0, |m| int_value(m.as_str())),
        ap: ampm.name("ap").and_then(|ap| ap.as_str().chars().next()),
        dot2: ampm.name("dot2").is_some(),
    }
}

fn time_accept(text: &str, caps: &Captures) -> Option<usize> {
    let start = start_of(caps);
    if prev_char(text, start).is_some_and(time_lookbehind) {
        return None;
    }
    let head_end = group_end(caps, "m");
    let mut rest = text[head_end..].chars();
    let next = rest.next();
    if next.is_some_and(is_decimal) || (next == Some(':') && rest.next().is_some_and(is_decimal)) {
        return None;
    }
    Some(anchored(&AMPM_TAIL_RE, text, head_end).map_or(head_end, |tail| head_end + la_end(&tail)))
}

fn times(text: &str) -> String {
    let text = py_sub(text, &TIME_RE, time_accept, |t, caps, end| {
        let head_end = group_end(caps, "m");
        let tail = (end > head_end)
            .then(|| anchored(&AMPM_TAIL_RE, t, head_end))
            .flatten();
        time_words(t, start_of(caps), end, &clock_of(caps, tail.as_ref()))
    });
    let text = py_sub(
        &text,
        &DOT_TIME_RE,
        not_after_char(time_lookbehind),
        |t, caps, end| time_words(t, start_of(caps), end, &clock_of(caps, None)),
    );
    py_sub(
        &text,
        &HOUR_AMPM_RE,
        not_after_char(time_lookbehind),
        |t, caps, end| time_words(t, start_of(caps), end, &clock_of(caps, None)),
    )
}

// ------------------------------------------------------------------ 5. degrees and acronyms

fn degree_parts(key: &str) -> Option<(&'static str, &'static str)> {
    Some(match key {
        "PhD" => ("PHD", ""),
        "MSc" => ("MSC", ""),
        "BSc" => ("BSC", ""),
        "BTech" => ("B", "Tech"),
        "MTech" => ("M", "Tech"),
        "BCom" => ("B", "Com"),
        "MCom" => ("M", "Com"),
        "MPhil" => ("M", "Phil"),
        _ => return None,
    })
}

fn degrees(text: &str) -> String {
    py_sub(
        text,
        &DEGREE_RE,
        not_after_char(|c| c.is_ascii_alphabetic() || c == '.'),
        |t, caps, end| {
            let key = format!("{}{}", &caps["p"], &caps["s"]);
            let Some((letters, word)) = degree_parts(&key) else {
                return t[start_of(caps)..end].to_string();
            };
            let spoken = [spell(letters), word.to_string()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            with_stop(&spoken, caps, t, end)
        },
    )
}

fn caps_word(text: &str, caps: &Captures, end: usize) -> String {
    let start = start_of(caps);
    let word = &caps["w"];
    let suffix = caps.name("s").map_or("", |s| s.as_str());
    if ACRONYM_WORDS.contains(&word) || ROMAN_NUMERALS.contains(&word) {
        return text[start..end].to_string();
    }
    if CAPS_COMMON_WORDS.contains(&word) {
        return word.to_lowercase() + suffix;
    }
    if CAPS_PLACE_NAMES.contains(&word) {
        return ascii_title(word) + suffix;
    }
    let mut out = spell(word) + suffix;
    if prev_char(text, start).is_some_and(is_py_digit) {
        out.insert(0, ' ');
    }
    if char_at(text, end).is_some_and(is_py_digit) {
        out.push(' ');
    }
    out
}

fn long_caps_word(text: &str, caps: &Captures, end: usize) -> String {
    let word = &caps["w"];
    let suffix = caps.name("s").map_or("", |s| s.as_str());
    if ACRONYM_WORDS.contains(&word) {
        return text[start_of(caps)..end].to_string();
    }
    if LONG_ACRONYMS.contains(&word) || !word.contains(['A', 'E', 'I', 'O', 'U', 'Y']) {
        return spell(word) + suffix;
    }
    let read = if CAPS_PLACE_NAMES.contains(&word) {
        ascii_title(word)
    } else {
        word.to_lowercase()
    };
    read + suffix
}

fn acronyms(text: &str) -> String {
    let after_word = |c: char| c.is_ascii_alphabetic() || is_apostrophe(c);
    let text = py_sub(
        text,
        &DOTTED_RE,
        not_after_char(|c| c.is_ascii_alphabetic() || c == '.'),
        |t, caps, end| {
            let letters: String = caps["l"].chars().filter(char::is_ascii_uppercase).collect();
            let stop = caps.name("dot").is_some() && py_strip(&t[end..]).is_empty();
            spell(&letters) + if stop { "." } else { "" }
        },
    );
    let text = py_sub(&text, &CAPS_RE, not_after_char(after_word), caps_word);
    let text = py_sub(
        &text,
        &LONG_CAPS_RE,
        not_after_char(after_word),
        long_caps_word,
    );
    py_sub(
        &text,
        &LETTER_RUN_RE,
        not_after_char(after_word),
        |t, caps, end| {
            t[start_of(caps)..end]
                .split(' ')
                .map(|letter| {
                    if letter == "W" {
                        letter_name('W')
                    } else {
                        letter.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        },
    )
}

// ------------------------------------------------------------------ driver

fn one_pass(text: &str) -> String {
    let text = lower_shouting(text);
    let text = urls(&text);
    let text = abbreviations(&text);
    let text = currency(&text);
    let text = units(&text);
    let text = indian_grouping(&text);
    let text = dates(&text);
    let text = times(&text);
    let text = degrees(&text);
    let text = acronyms(&text);
    py_strip(&SPACES_RE.replace_all(&text, " ")).to_string()
}

fn fixpoint(text: &str, pass: impl Fn(&str) -> String) -> String {
    let mut text = text.to_string();
    for _ in 0..MAX_PASSES {
        let next = pass(&text);
        if next == text {
            break;
        }
        text = next;
    }
    text
}

/// English pre-pass applied before `text_for_chars` for an English model (`normalize_en`).
pub(crate) fn normalize_en(text: &str) -> String {
    fixpoint(text, one_pass)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indic::frontend::Frontend;
    use serde_json::{Value, json};
    use std::cell::Cell;
    use std::collections::BTreeSet;

    const EN_FRONTEND: &str = include_str!("../../tests/fixtures/indic-tiny/en-frontend.json");
    const EN_PREPASS: &str = include_str!("../../tests/fixtures/indic-tiny/en-prepass.json");

    fn english_frontend() -> Frontend {
        let doc: Value = serde_json::from_str(EN_FRONTEND).unwrap();
        Frontend::from_config(&json!({
            "language": "en",
            "vocab": {
                "mode": "chr",
                "add_blank": true,
                "symbols": doc["symbols"],
                "normalizer": "textnorm",
                "normalization_version": "4",
            },
        }))
        .unwrap()
    }

    fn rows(fixture: &str) -> Vec<Value> {
        let doc: Value = serde_json::from_str(fixture).unwrap();
        doc["rows"].as_array().unwrap().clone()
    }

    fn assert_no_difference(differ: &[String], total: usize) {
        assert!(
            differ.is_empty(),
            "golden rows differ: {} of {total}\n{}",
            differ.len(),
            differ
                .iter()
                .take(15)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn golden_english_frontend_matches_reference() {
        let front = english_frontend();
        let rows = rows(EN_FRONTEND);
        assert!(rows.len() >= 250, "{} rows", rows.len());
        let mut differ = Vec::new();
        for row in &rows {
            let input = row["input"].as_str().unwrap();
            let normalized = front.normalize(input);
            let dropped: BTreeSet<char> = row["dropped"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_str().unwrap().chars().next().unwrap())
                .collect();
            let chunks = front.chunks(&normalized.text);
            let ids: Vec<Vec<i64>> = chunks.iter().map(|c| front.ids(c)).collect();
            let expected_chunks: Vec<String> =
                serde_json::from_value(row["chunks"].clone()).unwrap();
            let expected_ids: Vec<Vec<i64>> = serde_json::from_value(row["ids"].clone()).unwrap();
            if normalized.text != row["normalized"].as_str().unwrap()
                || normalized.dropped != dropped
                || chunks != expected_chunks
                || ids != expected_ids
            {
                differ.push(format!(
                    "{input:?}: got {:?} {:?} {chunks:?}, want {:?} {dropped:?} {expected_chunks:?}",
                    normalized.text, normalized.dropped, row["normalized"]
                ));
            }
        }
        assert_no_difference(&differ, rows.len());
    }

    #[test]
    fn prepass_and_single_pass_match_reference() {
        let rows = rows(EN_PREPASS);
        assert!(rows.len() >= 250, "{} rows", rows.len());
        let mut differ = Vec::new();
        let mut multi_pass = Vec::new();
        for row in &rows {
            let input = row["input"].as_str().unwrap();
            let (pre_pass, single_pass) = (normalize_en(input), one_pass(input));
            if pre_pass != row["pre_pass"].as_str().unwrap()
                || single_pass != row["single_pass"].as_str().unwrap()
            {
                differ.push(format!(
                    "{input:?}: got {pre_pass:?} / {single_pass:?}, want {:?} / {:?}",
                    row["pre_pass"], row["single_pass"]
                ));
            }
            if row["needs_more_than_one_pass"].as_bool().unwrap() {
                multi_pass.push(input);
            }
        }
        assert_no_difference(&differ, rows.len());
        assert_eq!(
            multi_pass,
            ["Tata Pvt.Ltd.", "LT. RAO", "ARs 500", "ABC. DEF. GHI."]
        );
    }

    #[test]
    fn normalize_en_is_idempotent_on_reference_outputs() {
        let rows = rows(EN_FRONTEND);
        let differ: Vec<String> = rows
            .iter()
            .filter_map(|row| {
                let once = normalize_en(row["input"].as_str().unwrap());
                let twice = normalize_en(&once);
                (once != twice).then(|| format!("{once:?} -> {twice:?}"))
            })
            .collect();
        assert_no_difference(&differ, rows.len());
    }

    #[test]
    fn spike_tokens_read_as_the_reference_does() {
        let front = english_frontend();
        for (input, text) in [
            ("GPU", "G P you"),
            ("fixture_base", "fixture base"),
            ("https://github.com/x/y", "github dot com slash x slash y"),
        ] {
            assert_eq!(front.normalize(input).text, text, "{input:?}");
        }
    }

    #[test]
    fn fixpoint_stops_after_four_passes() {
        let calls = Cell::new(0);
        let growing = fixpoint("a", |text| {
            calls.set(calls.get() + 1);
            format!("{text}b")
        });
        assert_eq!((growing.as_str(), calls.get()), ("abbbb", 4));
        calls.set(0);
        let stable = fixpoint("a", |text| {
            calls.set(calls.get() + 1);
            text.to_string()
        });
        assert_eq!((stable.as_str(), calls.get()), ("a", 1));
    }
}
