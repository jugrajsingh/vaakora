use crate::graph::Session;
use crate::misaki::{normalize_phonemes, phoneme_ids, synth_spans, vocab_from_tokenizer};
use anyhow::{Context, Result, ensure};
use misaki_rs::{G2P, Language};
use ndarray::Array;
use ort::value::Value;
use std::{collections::HashMap, fs, path::Path};

/// Phoneme ids for one chunk of text and the count of phoneme characters the vocabulary lacks.
fn kokoro_ids(g2p: &G2P, vocab: &HashMap<char, i64>, text: &str) -> Result<(Vec<i64>, usize)> {
    let (phones, _) = g2p
        .g2p(text)
        .context("permissive Misaki English phonemization")?;
    Ok(phoneme_ids(&normalize_phonemes(&phones), vocab))
}

pub struct Kokoro {
    pub(crate) cancellation: crate::cancellation::Cancellation,
    session: Session,
    g2p: G2P,
    vocab: HashMap<char, i64>,
    voice: Vec<f32>,
}
impl Kokoro {
    pub fn load(
        root: &Path,
        threads: usize,
        voice: &str,
        cancellation: crate::cancellation::Cancellation,
    ) -> Result<Self> {
        let vocab = vocab_from_tokenizer(
            &fs::read(root.join("tokenizer.json")).context("read Kokoro tokenizer")?,
        )
        .context("parse Kokoro tokenizer")?;
        let mut engine = Self {
            session: crate::session_for_lane(
                &root.join("onnx/model_quantized.onnx"),
                threads,
                &cancellation,
            )?,
            g2p: G2P::new(Language::EnglishUS),
            vocab,
            voice: vec![],
            cancellation,
        };
        engine.voice(root, voice)?;
        Ok(engine)
    }
    pub fn voice(&mut self, root: &Path, name: &str) -> Result<()> {
        let bytes = crate::runtime::read_voice_file(&root.join(format!("voices/{name}.bin")))
            .context("read Kokoro voice")?;
        ensure!(
            bytes.len() % 1024 == 0,
            "voice pack must contain rows of 256 float32 values"
        );
        self.voice = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|x| f32::from_le_bytes([x[0], x[1], x[2], x[3]]))
            .collect();
        self.g2p = G2P::new(if name.starts_with('b') {
            Language::EnglishGB
        } else {
            Language::EnglishUS
        });
        Ok(())
    }
    pub fn synth(&mut self, text: &str, speed: f32) -> Result<Vec<f32>> {
        let (ids, dropped) = kokoro_ids(&self.g2p, &self.vocab, text)?;
        if dropped > 0 {
            eprintln!("Kokoro skipped {dropped} unsupported phonemes");
        }
        let space = self
            .vocab
            .get(&' ')
            .copied()
            .context("missing phoneme space ID")?;
        if ids.len() > crate::misaki::MAX_PHONEMES {
            eprintln!(
                "Kokoro synthesized {} phonemes using bounded native calls",
                ids.len()
            );
        }
        synth_spans(&ids, space, |span| self.synth_tokens(span, speed))
    }
    fn synth_tokens(&mut self, phones: &[i64], speed: f32) -> Result<Vec<f32>> {
        let count = phones.len();
        ensure!(
            count > 0 && count <= 510,
            "phoneme count {count} outside Kokoro limit"
        );
        let mut ids = Vec::with_capacity(count + 2);
        ids.push(0);
        ids.extend_from_slice(phones);
        ids.push(0);
        let style_index = (count - 1) * 256;
        let style = self
            .voice
            .get(style_index..style_index + 256)
            .context("missing voice style row")?
            .to_vec();
        let n = ids.len();
        let ids = Value::from_array(Array::from_shape_vec((1, n), ids)?)?;
        let style = Value::from_array(Array::from_shape_vec((1, 256), style)?)?;
        let speed = Value::from_array(Array::from_vec(vec![speed]))?;
        let output = self
            .session
            .run_with_options(
                ort::inputs! {"input_ids"=>&ids,"style"=>&style,"speed"=>&speed},
                &self.cancellation.options,
            )
            .context("Kokoro inference")?;
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

    fn day_vocabulary() -> HashMap<char, i64> {
        let (phones, _) = G2P::new(Language::EnglishUS).g2p("day").unwrap();
        let mut vocab = HashMap::from([(' ', 16), ('d', 46), ('ˈ', 156), ('A', 24)]);
        for (index, ch) in normalize_phonemes(&phones).chars().enumerate() {
            vocab.entry(ch).or_insert(1000 + index as i64);
        }
        vocab
    }

    #[test]
    fn kokoro_phonemes_are_normalized() {
        let g2p = G2P::new(Language::EnglishUS);
        let (ids, dropped) = kokoro_ids(&g2p, &day_vocabulary(), "day").unwrap();
        assert!(ids.contains(&24), "the diphthong is the single symbol A");
        assert_eq!(dropped, 0);
    }

    #[test]
    fn kokoro_text_of_only_unknown_symbols_is_short_silence() {
        let g2p = G2P::new(Language::EnglishUS);
        let vocab = day_vocabulary();
        for text in [
            "\u{2211}",
            "\u{2211} \u{2211}",
            "\u{2211} \u{2211} \u{2211}",
        ] {
            let (ids, _) = kokoro_ids(&g2p, &vocab, text).unwrap();
            assert!(
                ids.iter().all(|&id| id == 16),
                "{text:?} leaves only spaces: {ids:?}"
            );
            let pcm =
                synth_spans(&ids, 16, |_| unreachable!("no graph call for no speech")).unwrap();
            assert_eq!(pcm, vec![0.0; 2400], "{text:?}");
        }
    }

    #[test]
    fn kokoro_spaces_between_phonemes_are_still_synthesized() {
        let g2p = G2P::new(Language::EnglishUS);
        let (ids, _) = kokoro_ids(&g2p, &day_vocabulary(), "day \u{2211} day").unwrap();
        let mut calls = 0;
        let pcm = synth_spans(&ids, 16, |span| {
            calls += 1;
            assert_eq!(span, ids);
            Ok(vec![0.5])
        })
        .unwrap();
        assert_eq!((calls, pcm), (1, vec![0.5]));
    }

    #[test]
    fn kokoro_text_without_phonemes_is_short_silence() {
        let g2p = G2P::new(Language::EnglishUS);
        let (ids, _) = kokoro_ids(&g2p, &HashMap::new(), "day").unwrap();
        assert!(ids.is_empty());
        let pcm = synth_spans(&ids, 16, |_| unreachable!("no graph call for no phonemes")).unwrap();
        assert_eq!(pcm, vec![0.0; 2400]);
    }
}
