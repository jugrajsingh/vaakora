//! Port of `indic_tiny_tts/frontend/textproc.py` and `frontend/tokenizer.py` (mode chr) at sulabhkatiyar/indic-tiny-tts-hindi@e15ac436560eb24d115d47c0783f62f10a02d30a, MIT, see INDIC-TINY-TTS-CODE-LICENSE.
//! The Punjabi package's older textproc.py and tokenizer.py read characters the same way.
use super::{
    Lang, english::normalize_en, guarded::guarded_matches, is_alpha, latin::spell_latin, py_split,
    py_strip, textnorm::text_for_chars,
};
use anyhow::{Context, Result, ensure};
use regex::Regex;
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

/// Characters a vocabulary may lack, mapped to the nearest pause (`_PAUSE_LIKE`).
const PAUSE_LIKE: [(char, char); 5] = [
    (':', ','),
    (';', ','),
    ('\u{2026}', '.'),
    ('\u{2013}', ','),
    ('\u{2014}', ','),
];
/// Characters after which whitespace ends a sentence (`_SENTENCE_END`).
const SENTENCE_ENDS: [char; 4] = ['\u{0964}', '?', '!', '.'];
/// Longest chunk in characters (`_MAX_CHUNK`).
const MAX_CHUNK: usize = 250;
/// Pad and interspersed blank, and `<unk>`.
const BLANK: i64 = 0;
const UNK: i64 = 1;

static WHITESPACE_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\s\x1C-\x1F]+").expect("valid pattern"));

/// The text a model reads and the characters its vocabulary lacks.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Normalized {
    pub(crate) text: String,
    pub(crate) dropped: BTreeSet<char>,
    /// Latin letters spelled in the model's script.
    pub(crate) spelled: usize,
}

/// Text normalisation, chunking and token ids of one Indic Tiny model.
pub(crate) struct Frontend {
    lang: Lang,
    ids: HashMap<char, i64>,
    add_blank: bool,
}

impl Frontend {
    /// Reads `language` and `vocab` of a model's `config.json`; refuses a vocabulary another normaliser built.
    pub(crate) fn from_config(config: &serde_json::Value) -> Result<Self> {
        let lang = Lang::from_code(
            config["language"]
                .as_str()
                .context("config has no language")?,
        )?;
        let vocab = &config["vocab"];
        ensure!(
            vocab["mode"] == "chr",
            "Indic Tiny vocabulary mode must be chr"
        );
        ensure!(
            vocab["normalizer"] == "textnorm",
            "Indic Tiny vocabulary was built with another normaliser"
        );
        ensure!(
            vocab["normalization_version"] == "4",
            "Indic Tiny vocabulary was built with another normalisation version"
        );
        let symbols = vocab["symbols"]
            .as_array()
            .context("Indic Tiny vocabulary has no symbols")?;
        ensure!(
            symbols.len() >= 2 && symbols[0] == "<blank>" && symbols[1] == "<unk>",
            "Indic Tiny vocabulary must start with <blank> and <unk>"
        );
        let mut ids = HashMap::new();
        for (id, symbol) in symbols.iter().enumerate() {
            let symbol = symbol
                .as_str()
                .context("Indic Tiny symbol is not a string")?;
            let mut payload = symbol.strip_prefix("c:").unwrap_or_default().chars();
            if let (Some(ch), None) = (payload.next(), payload.next()) {
                ids.insert(ch, i64::try_from(id)?);
            }
        }
        Ok(Self {
            lang,
            ids,
            add_blank: vocab["add_blank"].as_bool().unwrap_or(true),
        })
    }

    /// Raw text to the exact characters the model reads (`TextFrontendMixin.normalize`). Latin letters left after
    /// textnorm (which removes tags and Hindi glosses and turns a Latin `I` after a native letter into a danda) are
    /// spelled in the model's script instead of dropped. English text goes through the pre-pass `normalize_en` first.
    pub(crate) fn normalize(&self, text: &str) -> Normalized {
        let english;
        let text = if self.lang == Lang::En {
            english = normalize_en(text);
            english.as_str()
        } else {
            text
        };
        let (spelled, letters) = spell_latin(&text_for_chars(text, self.lang), self.lang);
        Normalized {
            spelled: letters,
            ..self.filter_vocabulary(&spelled)
        }
    }

    /// Characters outside the vocabulary become the nearest pause or a space, then whitespace collapses.
    fn filter_vocabulary(&self, norm: &str) -> Normalized {
        let mut out = String::with_capacity(norm.len());
        let mut dropped = BTreeSet::new();
        for ch in norm.chars() {
            let pause = PAUSE_LIKE
                .iter()
                .find(|(from, _)| *from == ch)
                .map(|(_, to)| *to);
            if ch == ' ' || self.ids.contains_key(&ch) {
                out.push(ch);
            } else if let Some(to) = pause.filter(|to| self.ids.contains_key(to)) {
                out.push(to);
            } else {
                dropped.insert(ch);
                out.push(' ');
            }
        }
        Normalized {
            text: py_split(&out).collect::<Vec<_>>().join(" "),
            dropped,
            spelled: 0,
        }
    }

    /// Sentence chunks of normalised text, each at most 250 characters, without chunks that hold no letter
    /// (`TextFrontendMixin._chunks`).
    pub(crate) fn chunks(&self, norm: &str) -> Vec<String> {
        let ends = guarded_matches(norm, &WHITESPACE_RUN, |text, start, _| {
            text[..start]
                .chars()
                .next_back()
                .is_some_and(|c| SENTENCE_ENDS.contains(&c))
        });
        let mut sentences = Vec::with_capacity(ends.len() + 1);
        let mut from = 0;
        for end in &ends {
            let run = end.get(0).expect("group 0 is the whole match");
            sentences.push(&norm[from..run.start()]);
            from = run.end();
        }
        sentences.push(&norm[from..]);
        let mut chunks = Vec::new();
        for sentence in sentences {
            let mut sent: Vec<char> = sentence.chars().collect();
            while sent.len() > MAX_CHUNK {
                let window = &sent[..MAX_CHUNK];
                let cut = match window.iter().rposition(|&c| c == ',') {
                    Some(comma) if comma > 0 => comma + 1,
                    _ => window.iter().rposition(|&c| c == ' ').unwrap_or(0),
                };
                let cut = if cut == 0 { MAX_CHUNK } else { cut };
                chunks.push(py_strip(&sent[..cut].iter().collect::<String>()).to_string());
                sent = py_strip(&sent[cut..].iter().collect::<String>())
                    .chars()
                    .collect();
            }
            chunks.push(py_strip(&sent.iter().collect::<String>()).to_string());
        }
        chunks.retain(|chunk| chunk.chars().any(is_alpha));
        chunks
    }

    /// Token ids of one chunk, with a blank around and between every symbol when the vocabulary adds blanks
    /// (`TextFrontendMixin._ids`). A character outside the vocabulary maps to `<unk>`; `normalize` emits none.
    pub(crate) fn ids(&self, chunk: &str) -> Vec<i64> {
        let symbols: Vec<i64> = chunk
            .chars()
            .map(|c| self.ids.get(&c).copied().unwrap_or(UNK))
            .collect();
        if !self.add_blank {
            return symbols;
        }
        let mut out = vec![BLANK; 2 * symbols.len() + 1];
        for (i, id) in symbols.into_iter().enumerate() {
            out[2 * i + 1] = id;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indic::latin::spell_latin;
    use crate::indic::textnorm::text_for_chars;
    use serde_json::{Value, json};

    const HI: &str = include_str!("../../tests/fixtures/indic-tiny/hi-frontend.json");
    const PA: &str = include_str!("../../tests/fixtures/indic-tiny/pa-frontend.json");
    const EN_TEXTNORM: &str = include_str!("../../tests/fixtures/indic-tiny/en-textnorm.json");

    fn fixture_config(fixture: &str) -> Value {
        let doc: Value = serde_json::from_str(fixture).unwrap();
        json!({
            "language": doc["language"],
            "vocab": {
                "mode": "chr",
                "add_blank": true,
                "symbols": doc["symbols"],
                "normalizer": "textnorm",
                "normalization_version": "4",
            },
        })
    }

    fn hindi_fixture_config() -> Value {
        fixture_config(HI)
    }

    fn assert_golden(fixture: &str) {
        let doc: Value = serde_json::from_str(fixture).unwrap();
        let front = Frontend::from_config(&fixture_config(fixture)).unwrap();
        let rows = doc["rows"].as_array().unwrap();
        assert!(rows.len() >= 120, "{} rows", rows.len());
        let mut differ = Vec::new();
        let mut without_latin = 0;
        for row in rows {
            let input = row["input"].as_str().unwrap();
            let textnorm = text_for_chars(input, front.lang);
            let normalized = front.filter_vocabulary(&textnorm);
            if !textnorm.chars().any(|c| c.is_ascii_alphabetic()) {
                without_latin += 1;
                if front.normalize(input) != normalized {
                    differ.push(format!(
                        "{input:?}: normalize() differs from the reference path"
                    ));
                }
            }
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
        assert!(
            differ.is_empty(),
            "golden rows differ: {} of {}\n{}",
            differ.len(),
            rows.len(),
            differ
                .iter()
                .take(15)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(
            without_latin >= 120,
            "{without_latin} rows without Latin letters"
        );
    }

    #[test]
    fn golden_hindi_matches_reference() {
        assert_golden(HI);
    }

    #[test]
    fn golden_punjabi_matches_reference() {
        assert_golden(PA);
    }

    #[test]
    fn golden_english_textnorm_matches_reference() {
        let doc: Value = serde_json::from_str(EN_TEXTNORM).unwrap();
        let rows = doc["rows"].as_array().unwrap();
        assert!(rows.len() >= 100, "{} rows", rows.len());
        let differ: Vec<String> = rows
            .iter()
            .filter_map(|row| {
                let input = row["input"].as_str().unwrap();
                let got = text_for_chars(input, Lang::En);
                let want = row["text_for_chars"].as_str().unwrap();
                (got != want).then(|| format!("{input:?}: got {got:?}, want {want:?}"))
            })
            .collect();
        assert!(
            differ.is_empty(),
            "golden rows differ: {} of {}\n{}",
            differ.len(),
            rows.len(),
            differ
                .iter()
                .take(15)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn frontend_refuses_another_normalizer_version() {
        for (key, value) in [
            ("normalization_version", "3"),
            ("normalizer", "other"),
            ("mode", "ipa"),
        ] {
            let mut config = hindi_fixture_config();
            config["vocab"][key] = json!(value);
            assert!(Frontend::from_config(&config).is_err(), "{key} {value}");
        }
        assert!(Frontend::from_config(&hindi_fixture_config()).is_ok());
    }

    #[test]
    fn spelled_latin_survives_the_hindi_frontend() {
        let front = Frontend::from_config(&hindi_fixture_config()).unwrap();
        let (spelled, _) = spell_latin("इस GPU पर मॉडल README.md में है।", Lang::Hi);
        let normalized = front.normalize(&spelled);
        assert!(normalized.dropped.is_empty(), "{:?}", normalized.dropped);
        assert!(normalized.text.contains("जी पी यू"));
    }

    fn read(fixture: &str, text: &str) -> Normalized {
        Frontend::from_config(&fixture_config(fixture))
            .unwrap()
            .normalize(text)
    }

    #[test]
    fn normalize_spells_latin_letters_in_the_model_script() {
        let hindi = read(HI, "इस GPU पर");
        assert_eq!(hindi.text, "इस जी पी यू पर");
        assert!(hindi.dropped.is_empty(), "{:?}", hindi.dropped);
        assert_eq!(hindi.spelled, 3, "the engine logs the spelled letter count");
        assert_eq!(read(PA, "ਇਸ README ਉੱਤੇ").spelled, 6);
        assert_eq!(read(HI, "इस पर").spelled, 0);
        let punjabi = read(PA, "ਇਸ gpu ਉੱਤੇ");
        assert_eq!(punjabi.text, "ਇਸ ਜੀ ਪੀ ਯੂ ਉੱਤੇ");
        assert!(punjabi.dropped.is_empty(), "{:?}", punjabi.dropped);
    }

    #[test]
    fn nonspeech_tags_are_removed_before_latin_is_spelled() {
        assert_eq!(
            read(HI, "भारत GPU [noise] दिल्ली").text,
            "भारत जी पी यू दिल्ली"
        );
        assert_eq!(
            read(PA, "ਪੰਜਾਬ GPU [noise] ਚੰਡੀਗੜ੍ਹ").text,
            "ਪੰਜਾਬ ਜੀ ਪੀ ਯੂ ਚੰਡੀਗੜ੍ਹ"
        );
    }

    #[test]
    fn hindi_latin_gloss_is_dropped_before_latin_is_spelled() {
        assert_eq!(
            read(HI, "भारत (smart phone) दिल्ली GPU").text,
            "भारत दिल्ली जी पी यू"
        );
    }

    #[test]
    fn latin_i_after_a_native_letter_is_still_a_danda() {
        assert_eq!(read(HI, "भारत GPU दिल्लीI").text, "भारत जी पी यू दिल्ली।");
        assert_eq!(read(PA, "ਇਹ GPU ਵਾਕ ਹੈI").text, "ਇਹ ਜੀ ਪੀ ਯੂ ਵਾਕ ਹੈ।");
    }

    #[test]
    fn long_text_chunks_stay_within_the_token_bucket() {
        let front = Frontend::from_config(&hindi_fixture_config()).unwrap();
        let spaced = "कमल ".repeat(150);
        let unbroken = "क".repeat(600);
        for text in [spaced.trim_end(), unbroken.as_str()] {
            assert_eq!(
                text.chars().count() + usize::from(text == spaced.trim_end()),
                600
            );
            let normalized = front.normalize(text);
            let chunks = front.chunks(&normalized.text);
            assert!(chunks.len() >= 3, "{} chunks", chunks.len());
            for chunk in &chunks {
                let chars = chunk.chars().count();
                assert!(chars <= 250, "{chars} characters");
                let ids = front.ids(chunk);
                assert_eq!(
                    ids.len(),
                    2 * chars + 1,
                    "blank around and between every symbol"
                );
                assert!(ids.len() <= 501);
            }
            let rejoined: String = chunks.concat().chars().filter(|c| *c != ' ').collect();
            let original: String = text.chars().filter(|c| *c != ' ').collect();
            assert_eq!(rejoined, original, "chunks keep every character");
        }
    }
}
