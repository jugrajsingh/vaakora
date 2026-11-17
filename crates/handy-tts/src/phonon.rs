//! Phonon 31m English: 8-frame flow graph calls with KV state, then one stateless Mimi decode per chunk.
use crate::graph::Session;
use crate::misaki::SILENCE_SAMPLES;
use crate::unigram::{Unigram, from_tokenizer_json};
use anyhow::{Context, Result, bail, ensure};
use ort::session::RunOptions;
use ort::value::{DynValue, Tensor};
use rand::{SeedableRng, rngs::StdRng};
use rand_distr::{Distribution, StandardNormal};
use std::{fs, path::Path};

const VOICE_FRAMES: usize = 125;
const VOICE_CHANNELS: usize = 512;
const LATENT: usize = 32;
const FRAMES_PER_CALL: usize = 8;
const LAYERS: usize = 6;
const HEADS: usize = 8;
const HEAD_DIM: usize = 64;
const SAMPLES_PER_FRAME: usize = 1920;
/// Most token ids one chunk may hold (the Pocket chunking rule).
const MAX_TOKENS: usize = 50;
/// A frame whose EOS logit is above this ends the utterance (`generation_config.json`).
const EOS_THRESHOLD: f32 = 4.0;
/// Sampling temperature: noise is N(0, 1) scaled by its square root.
const TEMPERATURE: f32 = 0.3;

/// Hard frame limit for a chunk of `tokens` ids: `ceil((tokens / 3 + 2) * 12.5)`.
fn frame_limit(tokens: usize) -> usize {
    ((tokens as f64 / 3.0 + 2.0) * 12.5).ceil() as usize
}

/// Frames kept after the EOS frame: 3 for at most 4 words, else 1 (`processor_config.json`).
fn frames_after_eos(text: &str) -> usize {
    if text.split_whitespace().count() <= 4 {
        3
    } else {
        1
    }
}

/// Index of the first frame of a call whose EOS logit is above the threshold; `base` is the call's first frame.
fn eos_frame(logits: &[f32], base: usize) -> Option<usize> {
    logits
        .iter()
        .position(|&logit| logit > EOS_THRESHOLD)
        .map(|offset| base + offset)
}

/// Voice file `[512, 125]` float32 channel-major, returned frame-major `[125, 512]` as the graph expects.
fn voice_latents(bytes: &[u8]) -> Result<Vec<f32>> {
    ensure!(
        bytes.len() == VOICE_FRAMES * VOICE_CHANNELS * 4,
        "Phonon voice file must hold 512 x 125 float32 values"
    );
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect();
    let mut latents = vec![0.0; values.len()];
    for channel in 0..VOICE_CHANNELS {
        for frame in 0..VOICE_FRAMES {
            latents[frame * VOICE_CHANNELS + channel] = values[channel * VOICE_FRAMES + frame];
        }
    }
    Ok(latents)
}

/// Relative path of a voice: `default`, or an en-us/en-gb row of `voices/voices.jsonl` found by name.
fn voice_file(jsonl: &str, name: &str) -> Result<String> {
    if name == "default" {
        return Ok("voices/default.bin".into());
    }
    for line in jsonl.lines().filter(|line| !line.trim().is_empty()) {
        let row: serde_json::Value =
            serde_json::from_str(line).context("parse Phonon voices.jsonl row")?;
        if row["name"] == name && matches!(row["locale"].as_str(), Some("en-us" | "en-gb")) {
            let file = row["filename"]
                .as_str()
                .context("Phonon voice row needs a filename")?;
            ensure!(
                file.starts_with("voices/")
                    && file.ends_with(".bin")
                    && handy_tts_core::catalog::valid_path(file),
                "Phonon voice file path is not a voices/*.bin path"
            );
            return Ok(file.into());
        }
    }
    bail!("Phonon has no English voice named {name:?}")
}

/// Splits word runs after words ending in one of `ends`.
fn groups<'w>(words: &[&'w str], ends: &[char]) -> Vec<Vec<&'w str>> {
    let mut groups = vec![];
    let mut current = vec![];
    for &word in words {
        current.push(word);
        if word.ends_with(ends) {
            groups.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

/// Greedily joins word groups while the joined text stays within `MAX_TOKENS`; a group over the limit stands alone.
fn pack<'w>(
    parts: impl IntoIterator<Item = Vec<&'w str>>,
    count: &impl Fn(&str) -> usize,
) -> Vec<Vec<&'w str>> {
    let mut packed = vec![];
    let mut current: Vec<&str> = vec![];
    for part in parts {
        let candidate = [current.as_slice(), part.as_slice()].concat();
        if !current.is_empty() && count(&candidate.join(" ")) > MAX_TOKENS {
            packed.push(std::mem::replace(&mut current, part));
        } else {
            current = candidate;
        }
    }
    if !current.is_empty() {
        packed.push(current);
    }
    packed
}

/// Chunks of at most `MAX_TOKENS` ids: sentences at `.!?`, long sentences at `,;:`, long clauses at words.
fn chunk_text(text: &str, count: impl Fn(&str) -> usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let fits = |part: &[&str]| count(&part.join(" ")) <= MAX_TOKENS;
    let mut parts = vec![];
    for sentence in groups(&words, &['.', '!', '?']) {
        if fits(&sentence) {
            parts.push(sentence);
            continue;
        }
        for clause in groups(&sentence, &[',', ';', ':']) {
            if fits(&clause) {
                parts.push(clause);
            } else {
                parts.extend(pack(clause.into_iter().map(|word| vec![word]), &count));
            }
        }
    }
    pack(parts, &count)
        .into_iter()
        .map(|part| part.join(" "))
        .collect()
}

/// Audio for one chunk; a chunk with no ids or no letter or digit after normalisation is 0.1 s of silence.
/// Ids go to the graph in consecutive slices of at most `MAX_TOKENS`, so one unbroken word over the limit is still bounded.
fn chunk_pcm(
    tokenizer: &Unigram,
    chunk: &str,
    mut generate: impl FnMut(&[i64]) -> Result<Vec<f32>>,
) -> Result<Vec<f32>> {
    let ids = tokenizer.encode(chunk);
    if ids.is_empty()
        || !tokenizer
            .normalize(chunk)
            .chars()
            .any(char::is_alphanumeric)
    {
        return Ok(vec![0.0; SILENCE_SAMPLES]);
    }
    let mut pcm = vec![];
    for span in ids.chunks(MAX_TOKENS) {
        pcm.extend(generate(span)?);
    }
    Ok(pcm)
}

/// Audio for the chunks of one text in order; a text with no chunk at all is 0.1 s of silence.
fn chunks_pcm(
    tokenizer: &Unigram,
    chunks: &[String],
    mut generate: impl FnMut(&[i64], usize) -> Result<Vec<f32>>,
) -> Result<Vec<f32>> {
    if chunks.is_empty() {
        return Ok(vec![0.0; SILENCE_SAMPLES]);
    }
    let mut pcm = vec![];
    for chunk in chunks {
        let after = frames_after_eos(chunk);
        pcm.extend(chunk_pcm(tokenizer, chunk, |ids| generate(ids, after))?);
    }
    Ok(pcm)
}

fn floats(shape: Vec<usize>, data: Vec<f32>) -> Result<DynValue> {
    let array = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&shape), data)
        .context("shape Phonon float tensor")?;
    Ok(Tensor::from_array(array)
        .context("create Phonon float tensor")?
        .into_dyn())
}

fn ints(shape: Vec<usize>, data: Vec<i64>) -> Result<DynValue> {
    let array = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&shape), data)
        .context("shape Phonon integer tensor")?;
    Ok(Tensor::from_array(array)
        .context("create Phonon integer tensor")?
        .into_dyn())
}

fn owned(value: &DynValue) -> Result<DynValue> {
    value
        .view()
        .try_upgrade()
        .map_err(|_| anyhow::anyhow!("Phonon state must own its backing tensor"))
}

fn kv_name(prefix: &str, index: usize) -> String {
    let part = if index.is_multiple_of(2) {
        "key"
    } else {
        "value"
    };
    format!("{prefix}.{}.{part}", index / 2)
}

struct Graphs {
    flow: Session,
    mimi: Session,
    voice: Vec<f32>,
    rng: StdRng,
}

impl Graphs {
    /// Runs 8-frame flow calls until the EOS tail or the frame limit, then decodes the kept latents.
    fn generate(&mut self, ids: &[i64], after: usize, options: &RunOptions) -> Result<Vec<f32>> {
        let limit = frame_limit(ids.len());
        let mut past = (0..2 * LAYERS)
            .map(|_| floats(vec![1, HEADS, 0, HEAD_DIM], vec![]))
            .collect::<Result<Vec<_>>>()?;
        let mut past_latents = floats(vec![1, 0, LATENT], vec![])?;
        let (mut past_len, mut calls, mut eos) = (0, 0, None);
        let latents = loop {
            let first = calls == 0;
            let text = if first { ids.to_vec() } else { vec![] };
            let voice_frames = if first { VOICE_FRAMES } else { 0 };
            let fresh = voice_frames + text.len() + 1 + FRAMES_PER_CALL - 1;
            let total = past_len + fresh;
            let noise = (0..FRAMES_PER_CALL * LATENT)
                .map(|_| {
                    let z: f32 = StandardNormal.sample(&mut self.rng);
                    z * TEMPERATURE.sqrt()
                })
                .collect();
            let mut inputs: Vec<(String, DynValue)> = vec![
                ("input_ids".into(), ints(vec![1, text.len()], text)?),
                (
                    "audio_prompt_latents".into(),
                    floats(
                        vec![1, voice_frames, VOICE_CHANNELS],
                        if first { self.voice.clone() } else { vec![] },
                    )?,
                ),
                (
                    "attention_mask".into(),
                    ints(vec![1, total], vec![1; total])?,
                ),
                (
                    "position_ids".into(),
                    ints(vec![1, fresh], (past_len as i64..total as i64).collect())?,
                ),
                ("past_key_values.audio_latents".into(), past_latents),
                (
                    "noise".into(),
                    floats(vec![1, FRAMES_PER_CALL, LATENT], noise)?,
                ),
            ];
            inputs.extend(
                past.into_iter()
                    .enumerate()
                    .map(|(index, value)| (kv_name("past_key_values", index), value)),
            );
            let outputs = self
                .flow
                .run_with_options(inputs, options)
                .context("run Phonon flow graph")?;
            calls += 1;
            let (shape, history) = outputs
                .get("audio_latents")?
                .try_extract_tensor::<f32>()
                .context("read Phonon latents")?;
            let frames = shape.get(1).map_or(0, |&frames| frames as usize);
            ensure!(
                frames == calls * FRAMES_PER_CALL && history.len() == frames * LATENT,
                "Phonon flow graph returned {frames} frames after {calls} calls"
            );
            let (_, logits) = outputs
                .get("eos_logits")?
                .try_extract_tensor::<f32>()
                .context("read Phonon EOS logits")?;
            ensure!(
                logits.len() == FRAMES_PER_CALL,
                "Phonon EOS logits must cover 8 frames"
            );
            if eos.is_none() {
                eos = eos_frame(logits, frames - FRAMES_PER_CALL);
            }
            let keep = eos.map_or(limit, |frame| limit.min(frame + after + 1));
            if frames >= keep {
                break history[..keep * LATENT].to_vec();
            }
            past_latents = owned(outputs.get("present.audio_latents")?)?;
            past = (0..2 * LAYERS)
                .map(|index| owned(outputs.get(&kv_name("present", index))?))
                .collect::<Result<Vec<_>>>()?;
            let (present, _) = past[0]
                .try_extract_tensor::<f32>()
                .context("read Phonon KV shape")?;
            ensure!(
                present.get(2) == Some(&(total as i64)),
                "Phonon KV length differs from the attention mask"
            );
            past_len = total;
        };
        if eos.is_none() {
            eprintln!("Phonon reached the frame limit without EOS");
        }
        self.decode(latents, options)
    }

    fn decode(&mut self, latents: Vec<f32>, options: &RunOptions) -> Result<Vec<f32>> {
        let frames = latents.len() / LATENT;
        let inputs: Vec<(String, DynValue)> = vec![
            (
                "audio_latents".into(),
                floats(vec![1, frames, LATENT], latents)?,
            ),
            ("num_frames".into(), ints(vec![1], vec![frames as i64])?),
        ];
        let outputs = self
            .mimi
            .run_with_options(inputs, options)
            .context("run Phonon Mimi decoder")?;
        let (_, pcm) = outputs
            .get("audio_values")?
            .try_extract_tensor::<f32>()
            .context("read Phonon decoded PCM")?;
        let samples = frames * SAMPLES_PER_FRAME;
        ensure!(
            pcm.len() >= samples,
            "Phonon decoder returned too few samples"
        );
        Ok(pcm[..samples].to_vec())
    }
}

pub struct Phonon {
    pub(crate) cancellation: crate::cancellation::Cancellation,
    tokenizer: Unigram,
    voices: String,
    graphs: Graphs,
}

impl Phonon {
    pub fn load(
        root: &Path,
        threads: usize,
        voice: &str,
        cancellation: crate::cancellation::Cancellation,
    ) -> Result<Self> {
        let tokenizer = from_tokenizer_json(
            &fs::read(root.join("tokenizer.json")).context("read Phonon tokenizer")?,
        )
        .context("parse Phonon tokenizer")?;
        let voices = fs::read_to_string(root.join("voices/voices.jsonl"))
            .context("read Phonon voices.jsonl")?;
        let graphs = Graphs {
            flow: crate::session_for_lane(
                &root.join("onnx/model_q4.onnx"),
                threads,
                &cancellation,
            )?,
            mimi: crate::session_for_lane(
                &root.join("onnx/mimi_decoder.onnx"),
                threads,
                &cancellation,
            )?,
            voice: vec![],
            rng: StdRng::seed_from_u64(20261108),
        };
        let mut engine = Self {
            cancellation,
            tokenizer,
            voices,
            graphs,
        };
        engine.voice(root, voice)?;
        Ok(engine)
    }

    pub fn voice(&mut self, root: &Path, name: &str) -> Result<()> {
        let file = voice_file(&self.voices, name)?;
        let bytes = crate::runtime::read_voice_file(&root.join(file))
            .context("read Phonon voice latents")?;
        self.graphs.voice = voice_latents(&bytes)?;
        Ok(())
    }

    fn chunks(&self, text: &str) -> Vec<String> {
        chunk_text(text, |chunk| self.tokenizer.encode(chunk).len())
    }

    pub fn synth(&mut self, text: &str, speed: f32) -> Result<Vec<f32>> {
        ensure!(speed == 1.0, "Phonon requires native speed 1.0");
        let chunks = self.chunks(text);
        chunks_pcm(&self.tokenizer, &chunks, |ids, after| {
            self.graphs.generate(ids, after, &self.cancellation.options)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokenizer() -> Unigram {
        crate::unigram::from_tokenizer_json(include_bytes!(
            "../tests/fixtures/phonon/tokenizer.json"
        ))
        .unwrap()
    }

    #[test]
    fn frame_limit_and_tail_follow_the_processor_config() {
        assert_eq!(frame_limit(3), 38);
        assert_eq!(frame_limit(50), 234);
        assert_eq!(frames_after_eos("One two three four."), 3);
        assert_eq!(frames_after_eos("One two three four five."), 1);
    }

    #[test]
    fn eos_frame_is_the_first_logit_above_four() {
        assert_eq!(
            eos_frame(&[0.0, 1.0, 4.0, 4.1, 9.0, 0.0, 0.0, 0.0], 16),
            Some(19)
        );
        assert_eq!(eos_frame(&[4.0; 8], 0), None);
    }

    #[test]
    fn voice_file_is_transposed_from_channel_major() {
        let bytes: Vec<u8> = (0..512 * 125)
            .flat_map(|i| ((i / 125 * 1000 + i % 125) as f32).to_le_bytes())
            .collect();
        let latents = voice_latents(&bytes).unwrap();
        assert_eq!(latents[512 + 2], 2001.0, "frame 1, channel 2");
        assert!(voice_latents(&bytes[..1024]).is_err());
    }

    #[test]
    fn voice_names_resolve_through_voices_jsonl() {
        let jsonl = "{\"filename\":\"voices/NbpkqMVS3CJeq2j8.bin\",\"name\":\"Zoey\",\"locale\":\"en-us\"}\n{\"filename\":\"voices/x.bin\",\"name\":\"Lilou\",\"locale\":\"fr-fr\"}\n";
        assert_eq!(
            voice_file(jsonl, "Zoey").unwrap(),
            "voices/NbpkqMVS3CJeq2j8.bin"
        );
        assert_eq!(voice_file(jsonl, "default").unwrap(), "voices/default.bin");
        assert!(voice_file(jsonl, "Lilou").is_err());
        assert!(voice_file(jsonl, "Nobody").is_err());
    }

    #[test]
    fn chunks_hold_at_most_fifty_tokens() {
        let t = tokenizer();
        let sentence = |topic: &str| {
            let mut words: Vec<String> = (0..39)
                .map(|i| format!("{topic}{}", ["alpha", "bravo", "charlie", "delta"][i % 4]))
                .collect();
            words.push("done.".into());
            words.join(" ")
        };
        let paragraph = [sentence("red"), sentence("blue"), sentence("green")].join(" ");
        assert_eq!(paragraph.split_whitespace().count(), 120);
        assert!(t.encode(&paragraph).len() > 3 * MAX_TOKENS);
        let chunks = chunk_text(&paragraph, |text| t.encode(text).len());
        assert!(chunks.len() > 3, "{} chunks", chunks.len());
        for chunk in &chunks {
            let count = t.encode(chunk).len();
            assert!(count <= MAX_TOKENS, "{count} ids in {chunk:?}");
        }
        let words: Vec<&str> = chunks.iter().flat_map(|c| c.split_whitespace()).collect();
        assert_eq!(words, paragraph.split_whitespace().collect::<Vec<_>>());
    }

    #[test]
    fn phonon_empty_ids_are_short_silence() {
        let t = tokenizer();
        for text in [
            "",
            "   ",
            "\u{2014}",
            "\u{1f600}",
            "\u{1f600} \u{1f44d}",
            "...",
        ] {
            let pcm = chunk_pcm(&t, text, |_| unreachable!("no graph call for no speech")).unwrap();
            assert_eq!(pcm, vec![0.0; 2400], "{text:?}");
        }
        assert!(t.encode("\u{2014}").is_empty(), "a dash alone has no ids");
        let mut calls = 0;
        let pcm = chunk_pcm(&t, "Hi.", |ids| {
            calls += 1;
            assert_eq!(ids, t.encode("Hi."));
            Ok(vec![0.5])
        })
        .unwrap();
        assert_eq!((calls, pcm), (1, vec![0.5]));
    }

    #[test]
    fn an_unbroken_word_over_the_limit_reaches_the_graph_in_bounded_slices() {
        let t = tokenizer();
        for text in [
            "q".repeat(300),
            "\u{4f60}".repeat(40),
            format!("Read {} now.", "q".repeat(300)),
        ] {
            let ids = t.encode(&text);
            assert!(ids.len() > 2 * MAX_TOKENS, "{} ids for {text:?}", ids.len());
            let chunks = chunk_text(&text, |chunk| t.encode(chunk).len());
            assert_eq!(
                chunks.join(" "),
                text,
                "chunking keeps every character in order"
            );
            let expected: Vec<i64> = chunks.iter().flat_map(|chunk| t.encode(chunk)).collect();
            let mut seen = vec![];
            let mut calls = 0;
            let pcm = chunks_pcm(&t, &chunks, |span, _| {
                assert!(
                    span.len() <= MAX_TOKENS,
                    "{} ids reached the graph",
                    span.len()
                );
                calls += 1;
                seen.extend_from_slice(span);
                Ok(vec![0.25])
            })
            .unwrap();
            assert!(calls > 2, "{calls} graph calls for {text:?}");
            assert_eq!(seen, expected, "every id reaches the graph once, in order");
            assert_eq!(pcm, vec![0.25; calls]);
        }
    }
}
