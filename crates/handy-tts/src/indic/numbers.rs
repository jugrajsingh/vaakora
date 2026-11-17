//! Port of `indic_tiny_tts/textnorm/numbers.py` and `_number_tables.py` at sulabhkatiyar/indic-tiny-tts-hindi@e15ac436560eb24d115d47c0783f62f10a02d30a, MIT, see INDIC-TINY-TTS-CODE-LICENSE.
//! The en, hi and pa rules only; the Hindi and Punjabi words 0-99 derive from AI4Bharat indic_numtowords (MIT).
use super::{Lang, is_alpha, is_latin_letter, is_py_space, py_strip};
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// Hindi words for 0-99 (`_HI_UNITS` of `_number_tables.py`).
const HI_UNITS_TABLE: &str = "
    शून्य एक दो तीन चार पाँच छह सात आठ नौ
    दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस
    बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस
    तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस
    चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास
    पचास इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ
    साठ इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सरसठ अड़सठ उनहत्तर
    सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी
    अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अठासी नवासी
    नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे
";

/// Punjabi words for 0-99 (`_PA_UNITS` of `_number_tables.py`).
const PA_UNITS_TABLE: &str = "
    ਸਿਫ਼ਰ ਇੱਕ ਦੋ ਤਿੰਨ ਚਾਰ ਪੰਜ ਛੇ ਸੱਤ ਅੱਠ ਨੌਂ
    ਦਸ ਗਿਆਰਾਂ ਬਾਰਾਂ ਤੇਰਾਂ ਚੌਦਾਂ ਪੰਦਰਾਂ ਸੋਲਾਂ ਸਤਾਰਾਂ ਅਠਾਰਾਂ ਉੱਨੀ
    ਵੀਹ ਇੱਕੀ ਬਾਈ ਤੇਈ ਚੌਵੀ ਪੱਚੀ ਛੱਬੀ ਸਤਾਈ ਅਠਾਈ ਉੱਨਤੀ
    ਤੀਹ ਇੱਕਤੀ ਬੱਤੀ ਤੇਤੀ ਚੌਂਤੀ ਪੈਂਤੀ ਛੱਤੀ ਸੈਂਤੀ ਅਠੱਤੀ ਉਨਤਾਲੀ
    ਚਾਲੀ ਇਕਤਾਲੀ ਬਿਆਲੀ ਤਰਤਾਲੀ ਚੁਤਾਲੀ ਪਨਤਾਲੀ ਛਿਆਲੀ ਸਨਤਾਲੀ ਅਠਤਾਲੀ ਉਨੰਜਾ
    ਪੰਜਾਹ ਇਕਵੰਜਾ ਬਵੰਜਾ ਤਰਵੰਜਾ ਚਰਵੰਜਾ ਪਚਵੰਜਾ ਛਪੰਜਾ ਸਤਵੰਜਾ ਅਠਵੰਜਾ ਉਨਾਹਟ
    ਸੱਠ ਇਕਾਹਠ ਬਾਹਠ ਤਰੇਂਹਠ ਚੌਂਹਠ ਪੈਂਹਠ ਛਿਆਹਠ ਸਤਾਹਠ ਅਠਾਹਠ ਉੱਨਤਰ
    ਸੱਤਰ ਇਕਹੱਤਰ ਬਹੱਤਰ ਤਹੱਤਰ ਚੁਹੱਤਰ ਪਚੱਤਰ ਛਿਅੱਤਰ ਸਤੱਤਰ ਅਠੱਤਰ ਉਨਾਸੀ
    ਅੱਸੀ ਇਕਆਸੀ ਬਿਆਸੀ ਤਿਰਾਸੀ ਚੌਰਾਸੀ ਪਚਾਸੀ ਛਿਆਸੀ ਸਤਾਸੀ ਅਠਾਸੀ ਉਨੱਨਵੇਂ
    ਨੱਬੇ ਇੱਕਨਵੇ ਬੱਨਵੇ ਤਰੱਨਵੇ ਚਰੱਨਵੇ ਪਚੱਨਵੇ ਛਿਅੱਨਵੇ ਸਤੱਨਵੇ ਅਠੱਨਵੇ ਨੜਿੱਨਵੇ
";

/// Longer digit strings are read digit by digit (`MAX_CARDINAL_DIGITS`).
const MAX_CARDINAL_DIGITS: usize = 9;
/// Zero of every native decimal digit block (`_DIGIT_BLOCK_ZEROS`).
const DIGIT_BLOCK_ZEROS: [u32; 9] = [
    0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66,
];
const EN_ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const EN_TENS: [&str; 10] = [
    "_", "_", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const EN_ORDINAL_IRREGULAR: [(&str, &str); 7] = [
    ("one", "first"),
    ("two", "second"),
    ("three", "third"),
    ("five", "fifth"),
    ("eight", "eighth"),
    ("nine", "ninth"),
    ("twelve", "twelfth"),
];
/// सौ, ਸੌ.
const HI_HUNDRED: &str = "\u{0938}\u{094c}";
const PA_HUNDRED: &str = "\u{0a38}\u{0a4c}";
/// हज़ार लाख करोड़ and ਹਜ਼ਾਰ ਲੱਖ ਕਰੋੜ (thousand, lakh, crore), NFC.
const HI_SCALES: [&str; 3] = [
    "\u{0939}\u{091c}\u{093c}\u{093e}\u{0930}",
    "\u{0932}\u{093e}\u{0916}",
    "\u{0915}\u{0930}\u{094b}\u{0921}\u{093c}",
];
const PA_SCALES: [&str; 3] = [
    "\u{0a39}\u{0a1c}\u{0a3c}\u{0a3e}\u{0a30}",
    "\u{0a32}\u{0a71}\u{0a16}",
    "\u{0a15}\u{0a30}\u{0a4b}\u{0a5c}",
];
/// दशमलव, प्रतिशत, रुपये.
const HI_POINT: &str = "\u{0926}\u{0936}\u{092e}\u{0932}\u{0935}";
const HI_PERCENT: &str = "\u{092a}\u{094d}\u{0930}\u{0924}\u{093f}\u{0936}\u{0924}";
const HI_RUPEES: &str = "\u{0930}\u{0941}\u{092a}\u{092f}\u{0947}";
/// ਡਾਲਰ, ਮਿਲੀਅਨ, ਬਿਲੀਅਨ (v4 `$` convention).
const PA_DOLLAR: &str = "\u{0a21}\u{0a3e}\u{0a32}\u{0a30}";
const PA_SCALE_WORDS: [&str; 2] = [
    "\u{0a2e}\u{0a3f}\u{0a32}\u{0a40}\u{0a05}\u{0a28}",
    "\u{0a2c}\u{0a3f}\u{0a32}\u{0a40}\u{0a05}\u{0a28}",
];
/// ਵਜੇ, ਸਾਢੇ, and half past one and two: ਡੇਢ, ਢਾਈ (v4 clock convention).
const PA_VAJE: &str = "\u{0a35}\u{0a1c}\u{0a47}";
const PA_HALF_PAST: &str = "\u{0a38}\u{0a3e}\u{0a22}\u{0a47}";
const PA_HALF_PAST_1_2: [&str; 2] = ["\u{0a21}\u{0a47}\u{0a22}", "\u{0a22}\u{0a3e}\u{0a08}"];

static WESTERN_GROUPS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,3}(?:,[0-9]{3})+$").expect("valid pattern"));
static INDIAN_GROUPS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,2}(?:,[0-9]{2})+,[0-9]{3}$").expect("valid pattern"));

/// NFC without ZWJ/ZWNJ (`_clean` for en, hi and pa).
fn clean(word: &str) -> String {
    word.replace(['\u{200c}', '\u{200d}'], "").nfc().collect()
}

fn units_table(block: &str) -> Vec<String> {
    let words: Vec<String> = block.split_whitespace().map(clean).collect();
    assert_eq!(words.len(), 100, "a number table holds the words for 0-99");
    words
}

static HI_UNITS: LazyLock<Vec<String>> = LazyLock::new(|| units_table(HI_UNITS_TABLE));
static PA_UNITS: LazyLock<Vec<String>> = LazyLock::new(|| units_table(PA_UNITS_TABLE));

fn units(lang: Lang) -> &'static [String] {
    match lang {
        Lang::Pa => &PA_UNITS,
        Lang::Hi | Lang::En => &HI_UNITS,
    }
}

/// The value of an ASCII or native digit (`DIGIT_CHARS`).
fn digit_value(c: char) -> Option<u32> {
    if c.is_ascii_digit() {
        return c.to_digit(10);
    }
    let code = u32::from(c);
    DIGIT_BLOCK_ZEROS
        .iter()
        .find(|zero| (**zero..*zero + 10).contains(&code))
        .map(|zero| code - zero)
}

fn is_digit(c: char) -> bool {
    digit_value(c).is_some()
}

fn ascii(digits: &str) -> String {
    digits
        .chars()
        .map(|c| match digit_value(c) {
            Some(d) => char::from_digit(d, 10).expect("a digit value is below ten"),
            None => c,
        })
        .collect()
}

fn en_cardinal(n: u64) -> String {
    if n < 20 {
        return EN_ONES[n as usize].to_string();
    }
    if n < 100 {
        let (tens, ones) = (n / 10, n % 10);
        return if ones == 0 {
            EN_TENS[tens as usize].to_string()
        } else {
            format!("{} {}", EN_TENS[tens as usize], EN_ONES[ones as usize])
        };
    }
    let mut words = Vec::new();
    let mut n = n;
    for (value, name) in [
        (1_000_000_000, "billion"),
        (1_000_000, "million"),
        (1000, "thousand"),
        (100, "hundred"),
    ] {
        if n >= value {
            words.push(format!("{} {name}", en_cardinal(n / value)));
            n %= value;
        }
    }
    if n > 0 {
        words.push(en_cardinal(n));
    }
    words.join(" ")
}

fn en_year(n: u64) -> Option<String> {
    if !((1100..=1999).contains(&n) || (2010..=2099).contains(&n)) {
        return None;
    }
    let (high, low) = (n / 100, n % 100);
    Some(if low == 0 {
        format!("{} hundred", en_cardinal(high))
    } else if low < 10 {
        format!("{} oh {}", en_cardinal(high), EN_ONES[low as usize])
    } else {
        format!("{} {}", en_cardinal(high), en_cardinal(low))
    })
}

fn en_ordinal(n: u64) -> String {
    let cardinal = en_cardinal(n);
    let (head, last) = match cardinal.rsplit_once(' ') {
        Some((head, last)) => (format!("{head} "), last),
        None => (String::new(), cardinal.as_str()),
    };
    let last = match EN_ORDINAL_IRREGULAR.iter().find(|(word, _)| *word == last) {
        Some((_, ordinal)) => (*ordinal).to_string(),
        None => match last.strip_suffix('y') {
            Some(stem) => format!("{stem}ieth"),
            None => format!("{last}th"),
        },
    };
    format!("{head}{last}")
}

fn indic_cardinal(n: u64, lang: Lang) -> String {
    let units = units(lang);
    if n < 100 {
        return units[n as usize].clone();
    }
    let (hundred_word, scales) = match lang {
        Lang::Pa => (PA_HUNDRED, PA_SCALES),
        Lang::Hi | Lang::En => (HI_HUNDRED, HI_SCALES),
    };
    let parts = [
        (n / 10_000_000, Some(scales[2])),
        (n % 10_000_000 / 100_000, Some(scales[1])),
        (n % 100_000 / 1000, Some(scales[0])),
        (n % 1000 / 100, Some(hundred_word)),
        (n % 100, None),
    ];
    parts
        .iter()
        .filter(|(value, _)| *value > 0)
        .map(|(value, scale)| match scale {
            Some(word) => format!("{} {word}", units[*value as usize]),
            None => units[*value as usize].clone(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Cardinal words for `0 <= n < 10**9`.
fn cardinal(n: u64, lang: Lang) -> String {
    match lang {
        Lang::En => en_cardinal(n),
        Lang::Hi | Lang::Pa => indic_cardinal(n, lang),
    }
}

/// One word per digit.
fn read_digits(digits: &str, lang: Lang) -> String {
    ascii(digits)
        .chars()
        .filter_map(|c| c.to_digit(10))
        .map(|d| match lang {
            Lang::En => EN_ONES[d as usize].to_string(),
            Lang::Hi | Lang::Pa => units(lang)[d as usize].clone(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Words for a digit string without separators (`_integer`).
fn integer(digits: &str, lang: Lang, year_style: bool) -> String {
    let ascii_digits = ascii(digits);
    if (ascii_digits.len() > 1 && ascii_digits.starts_with('0'))
        || ascii_digits.len() > MAX_CARDINAL_DIGITS
    {
        return read_digits(&ascii_digits, lang);
    }
    let n: u64 = ascii_digits.parse().expect("at most nine ASCII digits");
    if year_style && ascii_digits.len() == 4 {
        match lang {
            Lang::En => {
                if let Some(year) = en_year(n) {
                    return year;
                }
            }
            Lang::Hi if (1100..=1999).contains(&n) => {
                let (high, low) = (n / 100, n % 100);
                let words = format!("{} {HI_HUNDRED}", HI_UNITS[high as usize]);
                return if low > 0 {
                    format!("{words} {}", HI_UNITS[low as usize])
                } else {
                    words
                };
            }
            Lang::Hi | Lang::Pa => {}
        }
    }
    cardinal(n, lang)
}

/// Digits of a valid Western or Indian grouped number (`_grouped`).
fn grouped(body: &str) -> Option<String> {
    let ascii_body = ascii(body);
    (WESTERN_GROUPS_RE.is_match(&ascii_body) || INDIAN_GROUPS_RE.is_match(&ascii_body))
        .then(|| ascii_body.replace(',', ""))
}

fn point(lang: Lang) -> Option<&'static str> {
    match lang {
        Lang::En => Some("point"),
        Lang::Hi => Some(HI_POINT),
        Lang::Pa => None,
    }
}

fn percent(lang: Lang) -> Option<&'static str> {
    match lang {
        Lang::En => Some("percent"),
        Lang::Hi => Some(HI_PERCENT),
        Lang::Pa => None,
    }
}

fn rupees(lang: Lang) -> Option<&'static str> {
    match lang {
        Lang::En => Some("rupees"),
        Lang::Hi => Some(HI_RUPEES),
        Lang::Pa => None,
    }
}

/// Words for a numeric token body, or None to leave it unchanged (`_body_words`).
fn body_words(body: &str, lang: Lang) -> Option<String> {
    if body.contains([':', '/']) || body.matches('.').count() > 1 {
        return None;
    }
    if let Some((int_part, frac)) = body.split_once('.') {
        let point = point(lang)?;
        if frac.contains(',') {
            return None;
        }
        let int_digits = if int_part.contains(',') {
            grouped(int_part)?
        } else {
            int_part.to_string()
        };
        return Some(format!(
            "{} {point} {}",
            integer(&int_digits, lang, false),
            read_digits(frac, lang)
        ));
    }
    if body.contains(',') {
        return Some(match grouped(body) {
            Some(digits) => integer(&digits, lang, false),
            None => body
                .split(',')
                .map(|part| integer(part, lang, true))
                .collect::<Vec<_>>()
                .join(","),
        });
    }
    Some(integer(body, lang, true))
}

/// One `_NUM_TOKEN_RE` match: byte offsets of the token, its currency prefix, body and percent sign.
struct Token<'t> {
    start: usize,
    end: usize,
    cur: Option<&'t str>,
    body: &'t str,
    pct: bool,
}

/// `(?P<cur>[₹$€£]\s?)?(?P<body>D(?:D|[,.:/](?=D))*)(?P<pct>\s?%)?` scanned by hand (D: `DIGIT_CHARS`).
fn tokens(text: &str) -> Vec<Token<'_>> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let at = |i: usize| chars.get(i).map(|&(_, c)| c);
    let offset = |i: usize| chars.get(i).map_or(text.len(), |&(o, _)| o);
    let mut found = Vec::new();
    let mut i = 0;
    while let Some(c) = at(i) {
        let body_start = if matches!(c, '\u{20b9}' | '$' | '\u{20ac}' | '\u{a3}') {
            if at(i + 1).is_some_and(is_py_space) && at(i + 2).is_some_and(is_digit) {
                i + 2
            } else if at(i + 1).is_some_and(is_digit) {
                i + 1
            } else {
                i += 1;
                continue;
            }
        } else if is_digit(c) {
            i
        } else {
            i += 1;
            continue;
        };
        let mut k = body_start + 1;
        loop {
            if at(k).is_some_and(is_digit) {
                k += 1;
            } else if at(k).is_some_and(|s| matches!(s, ',' | '.' | ':' | '/'))
                && at(k + 1).is_some_and(is_digit)
            {
                k += 2;
            } else {
                break;
            }
        }
        let body_end = k;
        let end = if at(k) == Some('%') {
            k + 1
        } else if at(k).is_some_and(is_py_space) && at(k + 1) == Some('%') {
            k + 2
        } else {
            k
        };
        found.push(Token {
            start: offset(i),
            end: offset(end),
            cur: (body_start > i).then(|| &text[offset(i)..offset(body_start)]),
            body: &text[offset(body_start)..offset(body_end)],
            pct: end > body_end,
        });
        i = end;
    }
    found
}

/// `\s*(\S+)` at `end`: the start and text of the next word.
fn next_word(text: &str, end: usize) -> Option<(usize, &str)> {
    let rest = &text[end..];
    let skipped = rest.len() - rest.trim_start_matches(is_py_space).len();
    let start = end + skipped;
    let word_len = text[start..]
        .find(is_py_space)
        .unwrap_or(text.len() - start);
    (word_len > 0).then(|| (start, &text[start..start + word_len]))
}

/// Integer, grouped or decimal body for a convention (`_conv_number`; Punjabi has no decimal word).
fn conv_number(body: &str, lang: Lang) -> Option<String> {
    if body.contains([':', '/', '.']) {
        return None;
    }
    body_words(body, lang)
}

/// `H:MM` with at most two hour digits and exactly two minute digits (`_split_time`).
fn split_time(body: &str, sep: char) -> Option<(u64, u64)> {
    let (hh, mm) = body.split_once(sep)?;
    if mm.chars().count() != 2 || hh.chars().count() > 2 {
        return None;
    }
    Some((ascii(hh).parse().ok()?, ascii(mm).parse().ok()?))
}

/// Punjabi clock time before ਵਜੇ (`_conv_time`).
fn conv_time(hour: u64, minute: u64, text: &str, end: usize) -> Option<String> {
    if !(1..=23).contains(&hour) || minute > 59 {
        return None;
    }
    let next = next_word(text, end).map_or("", |(_, word)| word);
    if !next.starts_with(PA_VAJE) {
        return None;
    }
    let h = cardinal(hour, Lang::Pa);
    match minute {
        30 => Some(match hour {
            1 | 2 => PA_HALF_PAST_1_2[hour as usize - 1].to_string(),
            _ => format!("{PA_HALF_PAST} {h}"),
        }),
        0 => Some(h),
        _ => None,
    }
}

/// v4 reading conventions for a token the default rules leave unsupported (`_convention`; Punjabi only here).
fn convention(text: &str, token: &Token, lang: Lang) -> Option<(String, usize, usize)> {
    if lang != Lang::Pa {
        return None;
    }
    let (start, end, body) = (token.start, token.end, token.body);
    if let Some(cur) = token.cur {
        if token.pct || py_strip(cur) != "$" || body.contains('.') {
            return None;
        }
        let words = conv_number(body, lang)?;
        let scale = next_word(text, end).and_then(|(word_start, word)| {
            PA_SCALE_WORDS
                .iter()
                .find(|scale| {
                    word.strip_prefix(**scale)
                        .is_some_and(|rest| !rest.chars().next().is_some_and(is_alpha))
                })
                .map(|scale| (word_start, *scale))
        });
        return Some(match scale {
            Some((word_start, scale)) => (
                format!("{words} {scale} {PA_DOLLAR}"),
                start,
                word_start + scale.len(),
            ),
            None => (format!("{words} {PA_DOLLAR}"), start, end),
        });
    }
    if token.pct {
        return None;
    }
    if body.matches(':').count() == 1 && !body.contains(['.', '/', ',']) {
        let (hour, minute) = split_time(body, ':')?;
        return conv_time(hour, minute, text, end).map(|words| (words, start, end));
    }
    if body.matches('/').count() == 2 || body.matches('.').count() == 2 {
        return None;
    }
    conv_number(body, lang).map(|words| (words, start, end))
}

/// `(st|nd|rd|th)(?![A-Za-z])` at `end`: the end of an English ordinal suffix.
fn en_ordinal_end(text: &str, end: usize) -> Option<usize> {
    let rest = &text[end..];
    ["st", "nd", "rd", "th"]
        .iter()
        .find(|suffix| {
            rest.starts_with(**suffix) && !rest[2..].starts_with(|c: char| c.is_ascii_alphabetic())
        })
        .map(|_| end + 2)
}

/// Rewrites every ASCII or native digit token as words (`verbalize_digits`).
pub(super) fn verbalize_digits(text: &str, lang: Lang) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut pos = 0;
    for token in tokens(text) {
        if token.start < pos {
            continue;
        }
        let (mut start, mut end) = (token.start, token.end);
        let default = body_words(token.body, lang).filter(|_| {
            !(token.pct && percent(lang).is_none())
                && !token
                    .cur
                    .is_some_and(|cur| py_strip(cur) != "\u{20b9}" || rupees(lang).is_none())
        });
        let mut words = match default {
            Some(mut words) => {
                let plain = token.cur.is_none() && !token.pct && token.body.chars().all(is_digit);
                if lang == Lang::En
                    && plain
                    && token.body.chars().count() <= MAX_CARDINAL_DIGITS
                    && let Some(ordinal_end) = en_ordinal_end(text, end)
                {
                    let n: u64 = ascii(token.body)
                        .parse()
                        .expect("at most nine ASCII digits");
                    words = en_ordinal(n);
                    end = ordinal_end;
                }
                if let Some(word) = percent(lang).filter(|_| token.pct) {
                    words = format!("{words} {word}");
                }
                if let Some(word) = rupees(lang).filter(|_| token.cur.is_some()) {
                    let unit = if lang == Lang::En && words == "one" {
                        "rupee"
                    } else {
                        word
                    };
                    words = format!("{words} {unit}");
                }
                words
            }
            None => match convention(text, &token, lang) {
                Some((words, conv_start, conv_end)) if conv_start >= pos => {
                    start = conv_start;
                    end = conv_end;
                    words
                }
                _ => continue,
            },
        };
        words = clean(&words);
        let joins = |c: Option<char>| {
            c.is_some_and(|c| is_alpha(c) && (lang == Lang::En || is_latin_letter(c)))
        };
        if joins(text[..start].chars().next_back()) {
            words.insert(0, ' ');
        }
        if joins(text[end..].chars().next()) {
            words.push(' ');
        }
        out.push_str(&text[pos..start]);
        out.push_str(&words);
        pos = end;
    }
    out.push_str(&text[pos..]);
    out
}
