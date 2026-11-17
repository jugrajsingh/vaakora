use anyhow::{Context, Result};
use serde_json::Value as Json;
use std::{collections::HashMap, ops::Range};

/// Longest phoneme run one Kokoro-family graph call accepts (512 with the two pad ids).
pub(crate) const MAX_PHONEMES: usize = 510;
/// Samples returned for a chunk with no phonemes: 0.1 s at 24 kHz.
pub(crate) const SILENCE_SAMPLES: usize = 2400;

/// Maps misaki-rs phoneme text to the single-character symbols the Kokoro family was trained on.
pub fn normalize_phonemes(phones: &str) -> String {
    const PAIRS: [(&str, &str); 8] = [
        ("e\u{200d}ɪ", "A"),
        ("a\u{200d}ɪ", "I"),
        ("o\u{200d}ʊ", "O"),
        ("a\u{200d}ʊ", "W"),
        ("ɔ\u{200d}ɪ", "Y"),
        ("ə\u{200d}ʊ", "Q"),
        ("d\u{200d}ʒ", "ʤ"),
        ("t\u{200d}ʃ", "ʧ"),
    ];
    let mut text = phones.to_string();
    for (pair, symbol) in PAIRS {
        text = text.replace(pair, symbol);
    }
    let mut collapsed = String::with_capacity(text.len());
    for ch in text.chars().filter(|&ch| ch != '\u{200d}') {
        if ch != ' ' || !collapsed.ends_with(' ') {
            collapsed.push(ch);
        }
    }
    collapsed.trim().to_string()
}

/// Looks every phoneme up in the vocabulary and counts the characters it does not know.
pub fn phoneme_ids(phones: &str, vocab: &HashMap<char, i64>) -> (Vec<i64>, usize) {
    let mut ids = Vec::new();
    let mut dropped = 0;
    for ch in phones.chars() {
        match vocab.get(&ch) {
            Some(&id) => ids.push(id),
            None => dropped += 1,
        }
    }
    (ids, dropped)
}

/// Splits ids into runs of at most `limit`, each cut right after a space id when one fits.
pub(crate) fn bounded_spans(ids: &[i64], space: i64, limit: usize) -> Vec<Range<usize>> {
    let mut spans = Vec::new();
    let mut start = 0;
    while start < ids.len() {
        let window = (start + limit).min(ids.len());
        let end = if window < ids.len() {
            ids[start..window]
                .iter()
                .rposition(|&id| id == space)
                .filter(|&offset| offset > 0)
                .map_or(window, |offset| start + offset + 1)
        } else {
            window
        };
        spans.push(start..end);
        start = end;
    }
    spans
}

/// Runs the graph over each bounded span; a chunk with no phonemes, or only spaces, is 0.1 s of silence.
pub(crate) fn synth_spans(
    ids: &[i64],
    space: i64,
    mut run: impl FnMut(&[i64]) -> Result<Vec<f32>>,
) -> Result<Vec<f32>> {
    if ids.iter().all(|&id| id == space) {
        return Ok(vec![0.0; SILENCE_SAMPLES]);
    }
    let mut pcm = Vec::new();
    for span in bounded_spans(ids, space, MAX_PHONEMES) {
        pcm.extend(run(&ids[span])?);
    }
    Ok(pcm)
}

/// Reads `model.vocab` of a tokenizer.json as the first character of each symbol to its id.
pub fn vocab_from_tokenizer(json: &[u8]) -> Result<HashMap<char, i64>> {
    let tokenizer: Json = serde_json::from_slice(json).context("parse tokenizer")?;
    let mut vocab = HashMap::new();
    for (symbol, id) in tokenizer["model"]["vocab"]
        .as_object()
        .context("vocab must be object")?
    {
        if let Some(c) = symbol.chars().next() {
            vocab.insert(c, id.as_i64().context("vocab ID must be integer")?);
        }
    }
    Ok(vocab)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zwj_digraphs_map_to_misaki_shorthand() {
        assert_eq!(normalize_phonemes("dˈe\u{200d}ɪ"), "dˈA");
        assert_eq!(
            normalize_phonemes("fˈɪkst\u{200d}ʃɚ   bˈe\u{200d}ɪs"),
            "fˈɪksʧɚ bˈAs"
        );
        assert_eq!(
            normalize_phonemes("d\u{200d}ʒˈʌd\u{200d}ʒ t\u{200d}ʃˈɜːt\u{200d}ʃ"),
            "ʤˈʌʤ ʧˈɜːʧ"
        );
        assert_eq!(
            normalize_phonemes("hˈa\u{200d}ʊ bˈɔ\u{200d}ɪ ɡˌə\u{200d}ʊ ɡˌo\u{200d}ʊ nˈa\u{200d}ɪ"),
            "hˈW bˈY ɡˌQ ɡˌO nˈI"
        );
        assert_eq!(normalize_phonemes("ɑː\u{200d}ɹ"), "ɑːɹ");
    }

    #[test]
    fn kokoro_vocabulary_ids_use_shorthand() {
        let vocab = HashMap::from([
            (' ', 16),
            ('d', 46),
            ('ˈ', 156),
            ('A', 24),
            ('e', 47),
            ('ɪ', 102),
        ]);
        assert_eq!(
            phoneme_ids(&normalize_phonemes("dˈe\u{200d}ɪ"), &vocab),
            (vec![46, 156, 24], 0)
        );
        assert_eq!(
            phoneme_ids("dˈe\u{200d}ɪ", &vocab),
            (vec![46, 156, 47, 102], 1)
        );
    }

    #[test]
    fn misaki_rs_still_emits_zwj_digraphs() {
        let (phones, _) = misaki_rs::G2P::new(misaki_rs::Language::EnglishUS)
            .g2p("day")
            .unwrap();
        assert!(
            phones.contains('\u{200d}'),
            "upstream behaviour this fix depends on"
        );
        assert_eq!(normalize_phonemes(phones.trim()), "dˈA");
    }

    #[test]
    fn bounded_spans_split_after_a_space_within_the_limit() {
        let ids: Vec<i64> = (0..1200)
            .map(|i| if i % 100 == 99 { 16 } else { 5 })
            .collect();
        let spans = bounded_spans(&ids, 16, MAX_PHONEMES);
        assert!(spans.iter().all(|span| span.len() <= 510));
        let (last, rest) = spans.split_last().unwrap();
        assert!(rest.iter().all(|span| ids[span.end - 1] == 16));
        assert_eq!(last.end, ids.len());
        let rejoined: Vec<i64> = spans
            .iter()
            .flat_map(|span| ids[span.clone()].to_vec())
            .collect();
        assert_eq!(rejoined, ids);
    }

    #[test]
    fn empty_ids_are_short_silence() {
        let pcm = synth_spans(&[], 16, |_| unreachable!("no graph call for no phonemes")).unwrap();
        assert_eq!(pcm, vec![0.0; 2400]);
    }

    #[test]
    fn vocabulary_takes_the_first_character_of_each_symbol() {
        let vocab =
            vocab_from_tokenizer(br#"{"model":{"vocab":{"$":0," ":16,"A":24,"ab":99}}}"#).unwrap();
        assert_eq!(vocab[&' '], 16);
        assert_eq!(vocab[&'a'], 99);
        assert!(vocab_from_tokenizer(b"{}").is_err());
    }
}
