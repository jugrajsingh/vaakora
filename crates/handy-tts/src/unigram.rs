//! Phonon's Hugging Face `tokenizer.json`: normaliser sequence, Metaspace split and Unigram model with byte fallback.
use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde_json::Value as Json;
use std::collections::HashMap;

/// Word boundary marker of the Metaspace pre-tokenizer and the normaliser's final `Prepend`.
const METASPACE: char = '\u{2581}';
/// Hand-coded normaliser steps, identified by their exact `tokenizer.json` patterns.
const COLON: &str = r"(?<!\S):|:(?!\S)|[;()]";
const PUNCTUATION_RUN: &str = r"(?:\s|[!()*,\-./:;<=>?\[\\\]^_`{|}~]|(?<![0-9])\$)+(?=[.,])";
const WHITESPACE: &str = r"\s+";
const TRAILING_QUOTES: &str = "\"+$";
const QUOTE_AFTER_STOP: &str = r"(?<=[.!?,;])'$";
const FINAL_PERIOD: &str = r"(?<=[\p{Alphabetic}\p{N}])$";
/// Punctuation of the `PUNCTUATION_RUN` character class.
const RUN_PUNCTUATION: &str = "!()*,-./:;<=>?[\\]^_`{|}~";
/// The only normaliser shape the hand-coded steps support, one letter per step (`Step::letter`).
const SHAPE: &str = "^D+cpwsqasC+fP$";
/// Score penalty of an unknown character below the lowest piece score (Hugging Face `K_UNK_PENALTY`).
const UNK_PENALTY: f64 = 10.0;

enum Step {
    Literal { pattern: String, content: String },
    Class { pattern: Regex, content: String },
    Colon,
    PunctuationRun,
    Whitespace,
    Strip,
    TrailingQuotes,
    QuoteAfterStop,
    Capitalize { from: char, to: String },
    FinalPeriod,
    Prepend(String),
}

impl Step {
    fn letter(&self) -> char {
        match self {
            Self::Literal { .. } | Self::Class { .. } => 'D',
            Self::Colon => 'c',
            Self::PunctuationRun => 'p',
            Self::Whitespace => 'w',
            Self::Strip => 's',
            Self::TrailingQuotes => 'q',
            Self::QuoteAfterStop => 'a',
            Self::Capitalize { .. } => 'C',
            Self::FinalPeriod => 'f',
            Self::Prepend(_) => 'P',
        }
    }

    fn apply(&self, text: &str) -> String {
        match self {
            Self::Literal { pattern, content } => text.replace(pattern.as_str(), content),
            Self::Class { pattern, content } => pattern
                .replace_all(text, regex::NoExpand(content))
                .into_owned(),
            Self::Colon => colon_commas(text),
            Self::PunctuationRun => drop_runs_before_stops(text),
            Self::Whitespace => collapse_whitespace(text),
            Self::Strip => text.trim().to_string(),
            Self::TrailingQuotes => text.trim_end_matches('"').to_string(),
            Self::QuoteAfterStop => drop_quote_after_stop(text),
            Self::Capitalize { from, to } => match text.strip_prefix(*from) {
                Some(rest) => format!("{to}{rest}"),
                None => text.to_string(),
            },
            Self::FinalPeriod => {
                if text
                    .chars()
                    .last()
                    .is_some_and(|c| c.is_alphabetic() || c.is_numeric())
                {
                    format!("{text}.")
                } else {
                    text.to_string()
                }
            }
            Self::Prepend(prefix) if !text.is_empty() => format!("{prefix}{text}"),
            Self::Prepend(_) => String::new(),
        }
    }
}

/// `(?<!\S):|:(?!\S)|[;()]` -> `", "`: a colon at the start, after or before whitespace, or at the end, and every `;` `(` `)`.
fn colon_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        let spaced_colon = c == ':'
            && (i == 0
                || chars[i - 1].is_whitespace()
                || i + 1 == chars.len()
                || chars[i + 1].is_whitespace());
        if spaced_colon || matches!(c, ';' | '(' | ')') {
            out.push_str(", ");
        } else {
            out.push(c);
        }
    }
    out
}

/// `PUNCTUATION_RUN` -> `""`: the leftmost run of whitespace, run punctuation or a `$` not after an ASCII digit,
/// cut back to the last position followed by `.` or `,`, is removed; the search resumes at that `.` or `,`.
fn drop_runs_before_stops(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let in_run = |i: usize| {
        let c = chars[i];
        c.is_whitespace()
            || RUN_PUNCTUATION.contains(c)
            || (c == '$' && (i == 0 || !chars[i - 1].is_ascii_digit()))
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let end = (i..chars.len())
            .find(|&j| !in_run(j))
            .unwrap_or(chars.len());
        match (i + 1..end).rev().find(|&k| matches!(chars[k], '.' | ',')) {
            Some(stop) => i = stop,
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `\s+` -> `" "`.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `(?<=[.!?,;])'$` -> `""`.
fn drop_quote_after_stop(text: &str) -> String {
    match text.strip_suffix('\'') {
        Some(rest) if rest.ends_with(['.', '!', '?', ',', ';']) => rest.to_string(),
        _ => text.to_string(),
    }
}

fn parse_step(step: &Json) -> Option<Step> {
    match step["type"].as_str()? {
        "Strip" => {
            (step["strip_left"] == true && step["strip_right"] == true).then_some(Step::Strip)
        }
        "Prepend" => Some(Step::Prepend(step["prepend"].as_str()?.to_string())),
        "Replace" => parse_replace(&step["pattern"], step["content"].as_str()?),
        _ => None,
    }
}

fn parse_replace(pattern: &Json, content: &str) -> Option<Step> {
    let content = content.to_string();
    if let Some(literal) = pattern["String"].as_str() {
        return (!literal.is_empty()).then(|| Step::Literal {
            pattern: literal.to_string(),
            content,
        });
    }
    let regex = pattern["Regex"].as_str()?;
    let fixed = match (regex, content.as_str()) {
        (COLON, ", ") => Some(Step::Colon),
        (PUNCTUATION_RUN, "") => Some(Step::PunctuationRun),
        (WHITESPACE, " ") => Some(Step::Whitespace),
        (TRAILING_QUOTES, "") => Some(Step::TrailingQuotes),
        (QUOTE_AFTER_STOP, "") => Some(Step::QuoteAfterStop),
        (FINAL_PERIOD, ".") => Some(Step::FinalPeriod),
        _ => None,
    };
    if fixed.is_some() {
        return fixed;
    }
    if let Some(rest) = regex.strip_prefix('^') {
        let mut chars = rest.chars();
        return match (chars.next(), chars.next()) {
            (Some(from), None) if from.is_alphabetic() => {
                Some(Step::Capitalize { from, to: content })
            }
            _ => None,
        };
    }
    let class = regex.strip_suffix('+').unwrap_or(regex);
    let pure_class = class.len() > 2
        && class.starts_with('[')
        && class.ends_with(']')
        && !["&&", "--", "~~", "[:"]
            .iter()
            .any(|op| class[1..].contains(op));
    if !pure_class {
        return None;
    }
    Regex::new(regex)
        .ok()
        .map(|pattern| Step::Class { pattern, content })
}

enum Piece<'t> {
    Text(&'t str),
    Added(i64),
}

pub(crate) struct Unigram {
    steps: Vec<Step>,
    added: Vec<(String, i64)>,
    pieces: HashMap<String, (i64, f64)>,
    bytes: Vec<Option<i64>>,
    longest: usize,
    min_score: f64,
    unk: i64,
}

/// Loads the normaliser, pre-tokenizer, added tokens and Unigram model, refusing any shape this port does not reproduce.
pub(crate) fn from_tokenizer_json(json: &[u8]) -> Result<Unigram> {
    let file: Json = serde_json::from_slice(json).context("parse Phonon tokenizer")?;
    let steps = file["normalizer"]["normalizers"]
        .as_array()
        .filter(|_| file["normalizer"]["type"] == "Sequence")
        .and_then(|steps| steps.iter().map(parse_step).collect::<Option<Vec<_>>>())
        .context("unsupported Phonon normalizer")?;
    let shape: String = steps.iter().map(Step::letter).collect();
    ensure!(
        Regex::new(SHAPE)?.is_match(&shape)
            && matches!(steps.last(), Some(Step::Prepend(prefix)) if prefix == "\u{2581}"),
        "unsupported Phonon normalizer"
    );
    let pre = &file["pre_tokenizer"];
    ensure!(
        pre["type"] == "Metaspace"
            && pre["replacement"] == "\u{2581}"
            && pre["prepend_scheme"] == "always"
            && pre["split"] == true,
        "unsupported Phonon pre-tokenizer"
    );
    let model = &file["model"];
    ensure!(
        model["type"] == "Unigram" && model["byte_fallback"] == true,
        "unsupported Phonon tokenizer model"
    );
    let vocab = model["vocab"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .map(|row| Some((row[0].as_str()?.to_string(), row[1].as_f64()?)))
                .collect::<Option<Vec<_>>>()
        })
        .context("Phonon vocabulary rows must be [piece, score]")?;
    let unk = model["unk_id"]
        .as_u64()
        .filter(|&id| (id as usize) < vocab.len())
        .context("Phonon tokenizer needs an unk id inside the vocabulary")? as i64;
    let mut pieces = HashMap::new();
    let mut longest = 0;
    let mut min_score = f64::INFINITY;
    for (id, (piece, score)) in vocab.into_iter().enumerate() {
        longest = longest.max(piece.len());
        min_score = min_score.min(score);
        pieces.insert(piece, (id as i64, score));
    }
    let bytes = (0..=255u8)
        .map(|byte| pieces.get(&format!("<0x{byte:02X}>")).map(|&(id, _)| id))
        .collect();
    Ok(Unigram {
        steps,
        added: added_tokens(&file["added_tokens"])?,
        pieces,
        bytes,
        longest,
        min_score,
        unk,
    })
}

/// Added tokens are matched in the raw text before normalisation; only the plain non-normalised form is supported.
fn added_tokens(tokens: &Json) -> Result<Vec<(String, i64)>> {
    tokens
        .as_array()
        .context("Phonon added_tokens must be a list")?
        .iter()
        .map(|token| {
            let plain = ["single_word", "lstrip", "rstrip", "normalized"]
                .iter()
                .all(|flag| token[flag] == false);
            match (token["content"].as_str(), token["id"].as_i64()) {
                (Some(content), Some(id)) if plain && !content.is_empty() => {
                    Ok((content.to_string(), id))
                }
                _ => anyhow::bail!("unsupported Phonon added token"),
            }
        })
        .collect()
}

impl Unigram {
    /// Applies the normaliser sequence to the whole text.
    pub(crate) fn normalize(&self, text: &str) -> String {
        let mut text = text.to_string();
        for step in &self.steps {
            text = step.apply(&text);
        }
        text
    }

    /// Token ids without special tokens, as `Tokenizer.encode(text, add_special_tokens=False)` returns them.
    pub(crate) fn encode(&self, text: &str) -> Vec<i64> {
        let mut ids = Vec::new();
        for piece in self.split_added(text) {
            match piece {
                Piece::Added(id) => ids.push(id),
                Piece::Text(text) => {
                    for word in metaspace_words(&self.normalize(text)) {
                        self.encode_word(&word, &mut ids);
                    }
                }
            }
        }
        ids
    }

    /// Splits the raw text at added tokens, leftmost first and longest at a position.
    fn split_added<'t>(&self, text: &'t str) -> Vec<Piece<'t>> {
        let mut pieces = Vec::new();
        let (mut start, mut at) = (0, 0);
        while at < text.len() {
            let hit = self
                .added
                .iter()
                .filter(|(content, _)| text[at..].starts_with(content.as_str()))
                .max_by_key(|(content, _)| content.len());
            match hit {
                Some((content, id)) => {
                    if start < at {
                        pieces.push(Piece::Text(&text[start..at]));
                    }
                    pieces.push(Piece::Added(*id));
                    at += content.len();
                    start = at;
                }
                None => at += text[at..].chars().next().map_or(1, char::len_utf8),
            }
        }
        if start < text.len() {
            pieces.push(Piece::Text(&text[start..]));
        }
        pieces
    }

    /// Viterbi best path over the pieces of one word; unknown characters are fused and spelled as byte pieces.
    fn encode_word(&self, word: &str, ids: &mut Vec<i64>) {
        struct Node {
            id: i64,
            score: f64,
            start: Option<usize>,
        }
        let unk_score = self.min_score - UNK_PENALTY;
        let mut best: Vec<Node> = (0..=word.len())
            .map(|_| Node {
                id: self.unk,
                score: 0.0,
                start: None,
            })
            .collect();
        for (start, ch) in word.char_indices() {
            let here = best[start].score;
            let mut single = false;
            let ends = word[start..]
                .char_indices()
                .skip(1)
                .map(|(offset, _)| start + offset)
                .chain([word.len()])
                .take_while(|end| end - start <= self.longest);
            for end in ends {
                if let Some(&(id, score)) = self.pieces.get(&word[start..end]) {
                    let candidate = here + score;
                    if best[end].start.is_none() || candidate > best[end].score {
                        best[end] = Node {
                            id,
                            score: candidate,
                            start: Some(start),
                        };
                    }
                    single |= end - start == ch.len_utf8();
                }
            }
            let end = start + ch.len_utf8();
            if !single && (best[end].start.is_none() || here + unk_score > best[end].score) {
                best[end] = Node {
                    id: self.unk,
                    score: here + unk_score,
                    start: Some(start),
                };
            }
        }
        let mut path = Vec::new();
        let mut end = word.len();
        while end > 0 {
            let node = &best[end];
            let start = node
                .start
                .expect("every character boundary is reached: each character has a piece or an unknown edge");
            match path.last_mut() {
                Some((id, first, _)) if *id == self.unk && node.id == self.unk => *first = start,
                _ => path.push((node.id, start, end)),
            }
            end = start;
        }
        for (id, start, end) in path.into_iter().rev() {
            if id != self.unk {
                ids.push(id);
                continue;
            }
            let text = &word[start..end];
            match self.pieces.get(text) {
                Some(&(id, _)) => ids.push(id),
                None => match text
                    .bytes()
                    .map(|byte| self.bytes[usize::from(byte)])
                    .collect::<Option<Vec<_>>>()
                {
                    Some(bytes) => ids.extend(bytes),
                    None => ids.push(self.unk),
                },
            }
        }
    }
}

/// Metaspace pre-tokenizer: spaces become `\u{2581}`, a leading one is ensured, and every `\u{2581}` starts a word.
fn metaspace_words(normalized: &str) -> Vec<String> {
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut text = normalized.replace(' ', "\u{2581}");
    if !text.starts_with(METASPACE) {
        text.insert(0, METASPACE);
    }
    let mut words = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if c == METASPACE && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        current.push(c);
    }
    words.push(current);
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Unigram {
        from_tokenizer_json(include_bytes!("../tests/fixtures/phonon/tokenizer.json")).unwrap()
    }

    #[test]
    fn normalizer_matches_reference_examples() {
        let t = fixture();
        for (input, expected) in [
            ("hello world", "\u{2581}Hello world."),
            ("a : b; (c)", "\u{2581}A, b, c,"),
            ("Wait ... what?", "\u{2581}Wait. what?"),
            ("price $5 , ok", "\u{2581}Price $5, ok."),
            ("x\u{2019}s \u{201c}quote\u{201d}", "\u{2581}X's \"quote."),
            ("\u{e9}t\u{e9}", "\u{2581}\u{c9}t\u{e9}."),
            ("H\u{2082}O", "\u{2581}H2O."),
            ("", ""),
            ("   ", ""),
            ("3:45 PM", "\u{2581}3:45 PM."),
            ("end.'", "\u{2581}End."),
            ("say \"hi\"", "\u{2581}Say \"hi."),
        ] {
            assert_eq!(t.normalize(input), expected, "{input:?}");
        }
    }

    #[test]
    fn ids_match_reference_examples() {
        let t = fixture();
        assert_eq!(t.encode("hello world"), [3248, 956, 663]);
        assert_eq!(t.encode("a : b; (c)"), [803, 661, 959, 661, 723, 661]);
        assert_eq!(
            t.encode("\u{4f60}\u{597d}"),
            [660, 632, 593, 564, 633, 569, 593, 663]
        );
        assert_eq!(
            t.encode("3:45 PM"),
            [660, 873, 462, 924, 856, 949, 1283, 663]
        );
        assert!(t.encode("").is_empty());
    }

    #[test]
    fn golden_corpus_matches_hf_tokenizers() {
        let t = fixture();
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/fixtures/phonon/golden.json")).unwrap();
        assert!(rows.len() >= 150, "{} golden rows", rows.len());
        let mut mismatches = Vec::new();
        for row in &rows {
            let input = row["input"].as_str().unwrap();
            let normalized = row["normalized"].as_str().unwrap();
            let ids: Vec<i64> = serde_json::from_value(row["ids"].clone()).unwrap();
            let (got_normalized, got_ids) = (t.normalize(input), t.encode(input));
            if got_normalized != normalized || got_ids != ids {
                mismatches.push(format!(
                    "{input:?}: normalized {got_normalized:?} want {normalized:?}; ids {got_ids:?} want {ids:?}"
                ));
            }
        }
        assert!(
            mismatches.is_empty(),
            "golden rows differ: {} of {}\n{}",
            mismatches.len(),
            rows.len(),
            mismatches.join("\n")
        );
    }

    #[test]
    fn unexpected_normalizer_is_refused() {
        let mut json: serde_json::Value =
            serde_json::from_slice(include_bytes!("../tests/fixtures/phonon/tokenizer.json"))
                .unwrap();
        let steps = json["normalizer"]["normalizers"].as_array_mut().unwrap();
        assert_eq!(steps.pop().unwrap()["type"], "Prepend");
        let error = from_tokenizer_json(json.to_string().as_bytes())
            .err()
            .expect("a normalizer without the final Prepend is refused")
            .to_string();
        assert!(error.contains("unsupported Phonon normalizer"), "{error}");
    }
}
