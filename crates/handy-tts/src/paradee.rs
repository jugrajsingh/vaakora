use crate::graph::Session;
use crate::misaki::{normalize_phonemes, phoneme_ids, synth_spans, vocab_from_tokenizer};
use anyhow::{Context, Result, bail, ensure};
use misaki_rs::{G2P, Language};
use ndarray::Array;
use ort::value::Value;
use std::{collections::HashMap, fs, path::Path};

/// Id of the space symbol in Paradee's vocabulary, checked against tokenizer.json at load.
const SPACE_ID: i64 = 16;

pub struct Paradee {
    pub(crate) cancellation: crate::cancellation::Cancellation,
    session: Session,
    g2p: G2P,
    vocab: HashMap<char, i64>,
    voices: Vec<String>,
    voice: i64,
}

/// Position of a voice in config.json `voices`, which is the graph's integer voice input.
fn voice_index(voices: &[String], name: &str) -> Result<i64> {
    match voices.iter().position(|voice| voice == name) {
        Some(index) => Ok(index as i64),
        None => bail!("Paradee has no voice named {name:?}"),
    }
}

/// Runs the graph over the bounded spans of one chunk; no phonemes is 0.1 s of silence.
fn synth_ids(ids: &[i64], run: impl FnMut(&[i64]) -> Result<Vec<f32>>) -> Result<Vec<f32>> {
    synth_spans(ids, SPACE_ID, run)
}

/// Phoneme ids for one chunk of text and the count of phoneme characters the vocabulary lacks.
fn paradee_ids(g2p: &G2P, vocab: &HashMap<char, i64>, text: &str) -> Result<(Vec<i64>, usize)> {
    let (phones, _) = g2p
        .g2p(text)
        .context("permissive Misaki English phonemization")?;
    Ok(phoneme_ids(&normalize_phonemes(&phones), vocab))
}

fn language(name: &str) -> Language {
    if name.starts_with('b') {
        Language::EnglishGB
    } else {
        Language::EnglishUS
    }
}

impl Paradee {
    pub fn load(
        root: &Path,
        threads: usize,
        voice: &str,
        cancellation: crate::cancellation::Cancellation,
    ) -> Result<Self> {
        let vocab = vocab_from_tokenizer(
            &fs::read(root.join("tokenizer.json")).context("read Paradee tokenizer")?,
        )
        .context("parse Paradee tokenizer")?;
        ensure!(
            vocab.get(&' ') == Some(&SPACE_ID),
            "Paradee tokenizer space id differs from the expected {SPACE_ID}"
        );
        let config: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("config.json")).context("read Paradee config")?,
        )
        .context("parse Paradee config")?;
        let voices = config["voices"]
            .as_array()
            .context("Paradee config voices must be an array")?
            .iter()
            .map(|name| {
                name.as_str()
                    .map(str::to_string)
                    .context("Paradee voice name must be a string")
            })
            .collect::<Result<Vec<_>>>()?;
        let mut engine = Self {
            session: crate::session_for_lane(
                &root.join("onnx/paradee_int8.onnx"),
                threads,
                &cancellation,
            )?,
            g2p: G2P::new(Language::EnglishUS),
            vocab,
            voices,
            voice: 0,
            cancellation,
        };
        engine.voice(root, voice)?;
        Ok(engine)
    }
    pub fn voice(&mut self, _root: &Path, name: &str) -> Result<()> {
        self.voice = voice_index(&self.voices, name)?;
        self.g2p = G2P::new(language(name));
        Ok(())
    }
    pub fn synth(&mut self, text: &str, speed: f32) -> Result<Vec<f32>> {
        let (ids, dropped) = paradee_ids(&self.g2p, &self.vocab, text)?;
        if dropped > 0 {
            eprintln!("Paradee skipped {dropped} unsupported phonemes");
        }
        synth_ids(&ids, |span| self.synth_tokens(span, speed))
    }
    fn synth_tokens(&mut self, phones: &[i64], speed: f32) -> Result<Vec<f32>> {
        let count = phones.len();
        ensure!(
            count > 0 && count <= crate::misaki::MAX_PHONEMES,
            "phoneme count {count} outside Paradee limit"
        );
        let mut ids = Vec::with_capacity(count + 2);
        ids.push(0);
        ids.extend_from_slice(phones);
        ids.push(0);
        let n = ids.len();
        let ids = Value::from_array(Array::from_shape_vec((1, n), ids)?)?;
        let speed = Value::from_array(Array::from_vec(vec![speed]))?;
        let voice = Value::from_array(Array::from_vec(vec![self.voice]))?;
        let output = self
            .session
            .run_with_options(
                ort::inputs! {"input_ids"=>&ids,"speed"=>&speed,"voice"=>&voice},
                &self.cancellation.options,
            )
            .context("Paradee inference")?;
        Ok(output
            .get("waveform")?
            .try_extract_tensor::<f32>()?
            .1
            .to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_index_follows_config_order() {
        let voices: Vec<String> = ["af_heart", "bf_isabella", "am_puck", "bm_fable"]
            .map(String::from)
            .into();
        assert_eq!(voice_index(&voices, "am_puck").unwrap(), 2);
        assert!(voice_index(&voices, "af_bella").is_err());
    }

    fn day_vocabulary() -> HashMap<char, i64> {
        let (phones, _) = G2P::new(Language::EnglishUS).g2p("day").unwrap();
        let mut vocab = HashMap::from([(' ', SPACE_ID), ('d', 46), ('ˈ', 156), ('A', 24)]);
        for (index, ch) in normalize_phonemes(&phones).chars().enumerate() {
            vocab.entry(ch).or_insert(1000 + index as i64);
        }
        vocab
    }

    #[test]
    fn paradee_text_of_only_unknown_symbols_is_short_silence() {
        let g2p = G2P::new(Language::EnglishUS);
        let vocab = day_vocabulary();
        for text in [
            "\u{2211}",
            "\u{2211} \u{2211}",
            "\u{2211} \u{2211} \u{2211}",
        ] {
            let (ids, _) = paradee_ids(&g2p, &vocab, text).unwrap();
            assert!(
                ids.iter().all(|&id| id == SPACE_ID),
                "{text:?} leaves only spaces: {ids:?}"
            );
            let pcm = synth_ids(&ids, |_| unreachable!("no graph call for no speech")).unwrap();
            assert_eq!(pcm, vec![0.0; 2400], "{text:?}");
        }
    }

    #[test]
    fn paradee_spaces_between_phonemes_are_still_synthesized() {
        let g2p = G2P::new(Language::EnglishUS);
        let (ids, _) = paradee_ids(&g2p, &day_vocabulary(), "day \u{2211} day").unwrap();
        let mut calls = 0;
        let pcm = synth_ids(&ids, |span| {
            calls += 1;
            assert_eq!(span, ids);
            Ok(vec![0.5])
        })
        .unwrap();
        assert_eq!((calls, pcm), (1, vec![0.5]));
    }

    #[test]
    fn paradee_unspeakable_text_is_short_silence() {
        let pcm = synth_ids(&[], |_| unreachable!("no graph call for no phonemes")).unwrap();
        assert_eq!(pcm, vec![0.0; 2400]);
    }
}
