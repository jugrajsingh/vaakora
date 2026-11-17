//! Indic Tiny TTS synthesis: text frontend, text encoder, durations, the Euler loop on the flow decoder, the Vocos
//! vocoder and the inverse STFT, after `TinyTTSOnnx.synthesize` in `indic_tiny_tts/export/onnx_infer.py` at
//! sulabhkatiyar/indic-tiny-tts-english@eea5d4a578c0f18173825a037487cf9c47ed4247, MIT, see INDIC-TINY-TTS-CODE-LICENSE.
use super::{
    Lang,
    acoustic::{durations, euler, length_regulate},
    frontend::Frontend,
    istft::istft,
};
use crate::graph::Session;
use anyhow::{Context, Result, ensure};
use ndarray::{Array1, Array2, Array3};
use ort::value::Value;
use rand::{SeedableRng, rngs::StdRng};
use rand_distr::{Distribution, StandardNormal};
use serde_json::Value as Json;
use std::{collections::BTreeMap, fs, io::Write, path::Path};

/// Seed of the decoder noise; every call starts from it so the same text gives the same audio.
const NOISE_SEED: u64 = 20261108;
/// A chunk with fewer mel frames is skipped (`MIN_FRAMES` in `frontend/textproc.py`).
const MIN_FRAMES: usize = 2;
/// Samples of silence (0.1 s at 24 kHz) for text with nothing speakable.
const SILENCE_SAMPLES: usize = 2400;
/// Upper bound on one chunk's mel frames (about 11 minutes of audio).
const MAX_FRAMES: usize = 1 << 16;

/// Text encoder outputs of one chunk: `mu_x` `[channels][tokens]`, `logw` `[tokens]`, `cond` `[cond]`.
pub struct Encoded {
    pub mu_x: Vec<f32>,
    pub logw: Vec<f32>,
    pub cond: Vec<f32>,
}

/// The three Indic Tiny graphs.
pub trait Graphs {
    /// Runs the text encoder on one chunk's token ids.
    fn encode(&mut self, tokens: &[i64], ids: [i64; 3]) -> Result<Encoded>;
    /// One flow decoder velocity `[channels][frames]` at time `t`.
    fn decode(
        &mut self,
        x: &[f32],
        mask: &[f32],
        mu: &[f32],
        t: f32,
        cond: &[f32],
        frames: usize,
    ) -> Result<Vec<f32>>;
    /// The vocoder's `(real, imag)` spectrum, each `[bins][frames]`.
    fn vocode(&mut self, mel: &[f32], frames: usize) -> Result<(Vec<f32>, Vec<f32>)>;
}

/// The graphs through the worker's ONNX Runtime (CPU) or OpenVINO (GPU) sessions.
pub struct OnnxGraphs {
    encoder: Session,
    decoder: Session,
    vocoder: Session,
    channels: usize,
    bins: usize,
    cancellation: crate::cancellation::Cancellation,
}

fn tensor(output: &crate::graph::Outputs, name: &str, dims: &[usize]) -> Result<Vec<f32>> {
    let (shape, data) = output
        .get(name)?
        .try_extract_tensor::<f32>()
        .with_context(|| format!("read Indic Tiny output {name}"))?;
    let shape: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    ensure!(
        shape == dims,
        "Indic Tiny output {name} has shape {shape:?}, expected {dims:?}"
    );
    Ok(data.to_vec())
}

impl Graphs for OnnxGraphs {
    fn encode(&mut self, tokens: &[i64], ids: [i64; 3]) -> Result<Encoded> {
        let n = tokens.len();
        let [language, speaker, style] = ids;
        let scalar = |value: i64| Value::from_array(Array1::from_vec(vec![value]));
        let output = self.encoder.run_with_options(
            ort::inputs! {
                "tokens" => Value::from_array(Array2::from_shape_vec((1, n), tokens.to_vec())?)?,
                "token_lengths" => scalar(i64::try_from(n)?)?,
                "language" => scalar(language)?,
                "speaker" => scalar(speaker)?,
                "style" => scalar(style)?,
            },
            &self.cancellation.options,
        )?;
        let (shape, cond) = output.get("cond")?.try_extract_tensor::<f32>()?;
        ensure!(
            shape.len() == 2 && shape[0] == 1,
            "Indic Tiny cond has shape {shape:?}"
        );
        let cond = cond.to_vec();
        Ok(Encoded {
            mu_x: tensor(&output, "mu_x", &[1, self.channels, n])?,
            logw: tensor(&output, "logw", &[1, 1, n])?,
            cond,
        })
    }

    fn decode(
        &mut self,
        x: &[f32],
        mask: &[f32],
        mu: &[f32],
        t: f32,
        cond: &[f32],
        frames: usize,
    ) -> Result<Vec<f32>> {
        let channels = self.channels;
        let output = self.decoder.run_with_options(
            ort::inputs! {
                "x" => Value::from_array(Array3::from_shape_vec((1, channels, frames), x.to_vec())?)?,
                "mask" => Value::from_array(Array3::from_shape_vec((1, 1, frames), mask.to_vec())?)?,
                "mu" => Value::from_array(Array3::from_shape_vec((1, channels, frames), mu.to_vec())?)?,
                "t" => Value::from_array(Array1::from_vec(vec![t]))?,
                "cond" => Value::from_array(Array2::from_shape_vec((1, cond.len()), cond.to_vec())?)?,
            },
            &self.cancellation.options,
        )?;
        tensor(&output, "v", &[1, channels, frames])
    }

    fn vocode(&mut self, mel: &[f32], frames: usize) -> Result<(Vec<f32>, Vec<f32>)> {
        let output = self.vocoder.run_with_options(
            ort::inputs! {
                "mel" => Value::from_array(Array3::from_shape_vec((1, self.channels, frames), mel.to_vec())?)?,
            },
            &self.cancellation.options,
        )?;
        Ok((
            tensor(&output, "real", &[1, self.bins, frames])?,
            tensor(&output, "imag", &[1, self.bins, frames])?,
        ))
    }
}

/// Synthesis constants from `config.json` and `onnx/onnx_manifest.json`.
struct Model {
    lang: Lang,
    channels: usize,
    steps: usize,
    temperature: f32,
    pause: usize,
    mel_mean: f32,
    mel_std: f32,
    n_fft: usize,
    hop: usize,
    frame_multiple: usize,
    max_tokens: usize,
    language: i64,
    style: i64,
    /// Voice name -> (speaker id, length scale).
    voices: BTreeMap<String, (i64, f64)>,
}

fn count(value: &Json, what: &str) -> Result<usize> {
    let n = value
        .as_u64()
        .with_context(|| format!("Indic Tiny {what} is not a count"))?;
    Ok(usize::try_from(n)?)
}

impl Model {
    fn from_json(config: &Json, manifest: &Json) -> Result<Self> {
        let number = |value: &Json, what: &str| {
            value
                .as_f64()
                .with_context(|| format!("Indic Tiny {what} is not a number"))
        };
        let id = |value: &Json, what: &str| {
            value
                .as_i64()
                .with_context(|| format!("Indic Tiny {what} id is missing"))
        };
        let lang = Lang::from_code(
            config["language"]
                .as_str()
                .context("Indic Tiny config has no language")?,
        )?;
        let sample_rate = count(&config["sample_rate"], "sample rate")?;
        ensure!(sample_rate == 24000, "Indic Tiny sample rate must be 24000");
        let synthesis = &config["synthesis"];
        let head = &config["vocoder"]["head"];
        ensure!(
            head["padding"] == "center",
            "Indic Tiny vocoder padding must be center"
        );
        let n_fft = count(&head["n_fft"], "n_fft")?;
        let hop = count(&head["hop_length"], "hop length")?;
        ensure!(
            n_fft.is_power_of_two() && hop > 0 && n_fft % hop == 0,
            "unsupported Indic Tiny STFT {n_fft}/{hop}"
        );
        let stats = config["mel_stats"]
            .as_array()
            .context("Indic Tiny config has no mel_stats")?;
        ensure!(
            stats.len() == 2,
            "Indic Tiny mel_stats must hold two values"
        );
        let speakers = &config["ids"]["speakers"];
        let scales = &synthesis["length_scale"];
        let mut voices = BTreeMap::new();
        for (name, speaker) in config["voices"]
            .as_object()
            .context("Indic Tiny config has no voices")?
        {
            let speaker = speaker
                .as_str()
                .context("Indic Tiny voice speaker is not a name")?;
            let scale = match scales.get(speaker) {
                Some(value) => number(value, "length scale")?,
                None => 1.0,
            };
            voices.insert(name.clone(), (id(&speakers[speaker], "speaker")?, scale));
        }
        let style = synthesis["style"].as_str().unwrap_or("read");
        let pause_s = match synthesis.get("sentence_pause_s") {
            Some(value) => number(value, "sentence pause")?,
            None => 0.15,
        };
        let frame_multiple = count(&manifest["frame_multiple"], "frame multiple")?;
        ensure!(
            frame_multiple > 0,
            "Indic Tiny frame multiple must be positive"
        );
        Ok(Self {
            lang,
            channels: count(&config["model_cfg"]["n_feats"], "mel channels")?,
            steps: match synthesis.get("n_timesteps") {
                Some(value) => count(value, "step count")?,
                None => 4,
            },
            temperature: match synthesis.get("temperature") {
                Some(value) => number(value, "temperature")? as f32,
                None => 0.667,
            },
            pause: (pause_s * sample_rate as f64) as usize,
            mel_mean: number(&stats[0], "mel mean")? as f32,
            mel_std: number(&stats[1], "mel std")? as f32,
            n_fft,
            hop,
            frame_multiple,
            max_tokens: count(&manifest["max_tokens"], "max tokens")?,
            language: id(&config["ids"]["language"], "language")?,
            style: id(&config["ids"]["styles"][style], "style")?,
            voices,
        })
    }

    fn voice(&self, name: &str) -> Result<(i64, f64)> {
        self.voices
            .get(name)
            .copied()
            .with_context(|| format!("unknown Indic Tiny voice {name:?}"))
    }
}

/// One chunk's mel spectrogram `[channels][frames]`.
pub(crate) struct Acoustic {
    pub(crate) frames: usize,
    pub(crate) mel: Vec<f32>,
}

/// An Indic Tiny model of one language with one selected voice.
pub struct IndicTiny<G: Graphs = OnnxGraphs> {
    pub(crate) cancellation: crate::cancellation::Cancellation,
    graphs: G,
    frontend: Frontend,
    model: Model,
    speaker: i64,
    length_scale: f64,
    /// Where the counts-only frontend diagnostics go (stderr in the worker).
    diagnostics: Box<dyn std::io::Write + Send>,
}

fn read_json(path: &Path, what: &str) -> Result<Json> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("read Indic Tiny {what}"))?)
        .with_context(|| format!("parse Indic Tiny {what}"))
}

impl IndicTiny {
    pub fn load(
        root: &Path,
        threads: usize,
        voice: &str,
        cancellation: crate::cancellation::Cancellation,
    ) -> Result<Self> {
        let config = read_json(&root.join("config.json"), "config")?;
        let manifest = read_json(&root.join("onnx/onnx_manifest.json"), "ONNX manifest")?;
        let model = Model::from_json(&config, &manifest)?;
        let dir = root.join("onnx");
        let graphs = OnnxGraphs {
            encoder: crate::session_for_lane(
                &dir.join("text_encoder.onnx"),
                threads,
                &cancellation,
            )?,
            decoder: crate::session_for_lane(
                &dir.join("flow_decoder.onnx"),
                threads,
                &cancellation,
            )?,
            vocoder: crate::session_for_lane(&dir.join("vocoder.onnx"), threads, &cancellation)?,
            channels: model.channels,
            bins: model.n_fft / 2 + 1,
            cancellation: cancellation.clone(),
        };
        Self::from_parts(&config, model, graphs, voice, cancellation)
    }
}

impl<G: Graphs> IndicTiny<G> {
    fn from_parts(
        config: &Json,
        model: Model,
        graphs: G,
        voice: &str,
        cancellation: crate::cancellation::Cancellation,
    ) -> Result<Self> {
        let (speaker, length_scale) = model.voice(voice)?;
        Ok(Self {
            cancellation,
            graphs,
            frontend: Frontend::from_config(config)?,
            model,
            speaker,
            length_scale,
            diagnostics: Box::new(std::io::stderr()),
        })
    }

    /// The language the loaded config reads.
    pub(crate) fn lang(&self) -> Lang {
        self.model.lang
    }

    /// Selects `female` or `male` from the loaded config.
    pub fn voice(&mut self, _root: &Path, name: &str) -> Result<()> {
        (self.speaker, self.length_scale) = self.model.voice(name)?;
        Ok(())
    }

    pub fn synth(&mut self, text: &str, speed: f32) -> Result<Vec<f32>> {
        let mut rng = StdRng::seed_from_u64(NOISE_SEED);
        self.synth_with(text, speed, &mut |len| {
            Ok((0..len).map(|_| StandardNormal.sample(&mut rng)).collect())
        })
    }

    /// Synthesises `text` with `noise(len)` giving each chunk's N(0, 1) draw, in chunk order.
    pub(crate) fn synth_with(
        &mut self,
        text: &str,
        speed: f32,
        noise: &mut dyn FnMut(usize) -> Result<Vec<f32>>,
    ) -> Result<Vec<f32>> {
        let normalized = self.frontend.normalize(text);
        if !normalized.dropped.is_empty() {
            self.diagnose(format_args!(
                "Indic Tiny skipped {} unsupported characters",
                normalized.dropped.len()
            ));
        }
        if normalized.spelled > 0 {
            self.diagnose(format_args!(
                "Indic Tiny spelled {} Latin letters",
                normalized.spelled
            ));
        }
        let length_scale = (self.length_scale / f64::from(speed)) as f32;
        let mut pcm = Vec::new();
        let mut pieces = 0;
        for chunk in self.frontend.chunks(&normalized.text) {
            let ids = self.frontend.ids(&chunk);
            let acoustic = self.acoustic(&ids, length_scale, noise)?;
            if acoustic.frames < MIN_FRAMES {
                continue;
            }
            let wav = self.vocode(&acoustic)?;
            if pieces > 0 {
                pcm.resize(pcm.len() + self.model.pause, 0.0);
            }
            pcm.extend(wav);
            pieces += 1;
        }
        if pieces == 0 {
            return Ok(vec![0.0; SILENCE_SAMPLES]);
        }
        Ok(pcm)
    }

    /// Writes one diagnostic line; a diagnostics stream that cannot be written does not stop synthesis.
    fn diagnose(&mut self, line: std::fmt::Arguments<'_>) {
        writeln!(self.diagnostics, "{line}").ok();
    }

    /// One chunk's mel spectrogram: text encoder, durations, length regulation and the Euler loop on the decoder.
    pub(crate) fn acoustic(
        &mut self,
        ids: &[i64],
        length_scale: f32,
        noise: &mut dyn FnMut(usize) -> Result<Vec<f32>>,
    ) -> Result<Acoustic> {
        let model = &self.model;
        let channels = model.channels;
        ensure!(
            !ids.is_empty() && ids.len() <= model.max_tokens,
            "Indic Tiny chunk has {} tokens, at most {} fit",
            ids.len(),
            model.max_tokens
        );
        let encoded = self
            .graphs
            .encode(ids, [model.language, self.speaker, model.style])
            .context("run the Indic Tiny text encoder")?;
        ensure!(
            encoded.mu_x.len() == channels * ids.len() && encoded.logw.len() == ids.len(),
            "Indic Tiny text encoder output does not match its tokens"
        );
        let (w_ceil, y_len, y_pad) = durations(&encoded.logw, length_scale, model.frame_multiple);
        ensure!(
            w_ceil.iter().all(|w| w.is_finite()) && y_pad <= MAX_FRAMES,
            "invalid Indic Tiny durations ({y_len} frames)"
        );
        let (mu_y, mask) = length_regulate(&encoded.mu_x, channels, &w_ceil, y_len, y_pad);
        let z = noise(channels * y_pad)?;
        ensure!(
            z.len() == channels * y_pad,
            "Indic Tiny noise has the wrong size"
        );
        let temperature = model.temperature;
        let x0 = z.into_iter().map(|value| value * temperature).collect();
        let graphs = &mut self.graphs;
        let x = euler(model.steps, x0, |x, t| {
            graphs
                .decode(x, &mask, &mu_y, t, &encoded.cond, y_pad)
                .context("run the Indic Tiny decoder")
        })?;
        let mut mel = Vec::with_capacity(channels * y_len);
        for row in x.chunks(y_pad) {
            mel.extend(
                row[..y_len]
                    .iter()
                    .map(|value| value * model.mel_std + model.mel_mean),
            );
        }
        Ok(Acoustic { frames: y_len, mel })
    }

    /// The vocoder and inverse STFT of one mel spectrogram, clipped to [-1, 1].
    fn vocode(&mut self, acoustic: &Acoustic) -> Result<Vec<f32>> {
        let (real, imag) = self
            .graphs
            .vocode(&acoustic.mel, acoustic.frames)
            .context("run the Indic Tiny vocoder")?;
        let bins = self.model.n_fft / 2 + 1;
        let wav = istft(
            &real,
            &imag,
            bins,
            acoustic.frames,
            self.model.n_fft,
            self.model.hop,
        )?;
        Ok(wav
            .into_iter()
            .map(|sample| sample.clamp(-1.0, 1.0))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;
    use std::rc::Rc;

    #[derive(Default)]
    struct Calls {
        encode: Cell<usize>,
        decode: Cell<usize>,
        vocode: Cell<usize>,
    }

    /// Graphs whose encoder gives every token of call `i` the log duration `logw[i]` (default 0, one frame before the
    /// voice's length scale) and, when `full` is set, a decoder that reports a full static class.
    struct FakeGraphs {
        calls: Rc<Calls>,
        full: bool,
        logw: Vec<f32>,
    }
    impl Graphs for FakeGraphs {
        fn encode(&mut self, tokens: &[i64], _ids: [i64; 3]) -> Result<Encoded> {
            let call = self.calls.encode.get();
            self.calls.encode.set(call + 1);
            Ok(Encoded {
                mu_x: vec![0.0; 100 * tokens.len()],
                logw: vec![self.logw.get(call).copied().unwrap_or(0.0); tokens.len()],
                cond: vec![0.0; 112],
            })
        }
        fn decode(
            &mut self,
            x: &[f32],
            _mask: &[f32],
            _mu: &[f32],
            _t: f32,
            _cond: &[f32],
            _frames: usize,
        ) -> Result<Vec<f32>> {
            self.calls.decode.set(self.calls.decode.get() + 1);
            if self.full {
                return Err(crate::padding::StaticCapacity.into());
            }
            Ok(vec![0.0; x.len()])
        }
        fn vocode(&mut self, _mel: &[f32], frames: usize) -> Result<(Vec<f32>, Vec<f32>)> {
            self.calls.vocode.set(self.calls.vocode.get() + 1);
            Ok((vec![0.0; 513 * frames], vec![0.0; 513 * frames]))
        }
    }

    fn config() -> Json {
        config_for("en", "abcdefghijklmnopqrstuvwxyz.,")
    }

    fn config_for(language: &str, letters: &str) -> Json {
        let mut symbols = vec!["<blank>".to_string(), "<unk>".to_string()];
        symbols.extend(letters.chars().map(|c| format!("c:{c}")));
        json!({
            "language": language,
            "sample_rate": 24000,
            "voices": {"female": "en_lim_F", "male": "en_lim_M"},
            "model_cfg": {"n_feats": 100},
            "mel_stats": [-0.6874043567306062, 1.8015918237255453],
            "synthesis": {"n_timesteps": 4, "temperature": 0.667, "style": "read", "sentence_pause_s": 0.15,
                "length_scale": {"en_lim_F": 1.0319, "en_lim_M": 0.9777}},
            "ids": {"language": 0, "speakers": {"en_lim_F": 0, "en_lim_M": 1}, "styles": {"read": 0}},
            "vocoder": {"head": {"n_fft": 1024, "hop_length": 256, "padding": "center"}},
            "vocab": {"mode": "chr", "normalizer": "textnorm", "normalization_version": "4", "add_blank": true,
                "symbols": symbols},
        })
    }

    fn engine(full: bool) -> (IndicTiny<FakeGraphs>, Rc<Calls>) {
        engine_with(config(), full, vec![])
    }

    fn engine_with(config: Json, full: bool, logw: Vec<f32>) -> (IndicTiny<FakeGraphs>, Rc<Calls>) {
        let calls = Rc::new(Calls::default());
        let model =
            Model::from_json(&config, &json!({"frame_multiple": 2, "max_tokens": 2048})).unwrap();
        let graphs = FakeGraphs {
            calls: calls.clone(),
            full,
            logw,
        };
        let engine = IndicTiny::from_parts(
            &config,
            model,
            graphs,
            "female",
            crate::cancellation::Cancellation::new().unwrap(),
        )
        .unwrap();
        (engine, calls)
    }

    /// A shared buffer standing in for stderr.
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn frontend_diagnostics_report_counts_only() {
        let (mut engine, _) = engine_with(
            config_for("hi", "\u{091c}\u{0940}\u{092a}\u{092f}\u{0942}"),
            false,
            vec![],
        );
        let captured = Captured::default();
        engine.diagnostics = Box::new(captured.clone());
        engine.synth("GPU \u{2603} \u{2713}", 1.0).unwrap();
        let text = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            text,
            "Indic Tiny skipped 2 unsupported characters\nIndic Tiny spelled 3 Latin letters\n",
            "diagnostics carry counts and never the text"
        );
        let (mut quiet, _) = engine_with(config(), false, vec![]);
        let captured = Captured::default();
        quiet.diagnostics = Box::new(captured.clone());
        quiet.synth("open the file.", 1.0).unwrap();
        assert!(
            captured.0.lock().unwrap().is_empty(),
            "nothing skipped or spelled, nothing reported"
        );
    }

    #[test]
    fn chunks_under_two_frames_are_skipped_after_their_noise_draw() {
        // logw -1000 gives ceil(exp(-1000)) = 0 frames per token, so the middle chunk has y_len 1 (y_pad 2).
        let text = "open the file. then run it. and go.";
        let (mut engine, calls) = engine_with(config(), false, vec![0.0, -1000.0, 0.0]);
        let chunks = engine
            .frontend
            .chunks(&engine.frontend.normalize(text).text);
        assert_eq!(chunks.len(), 3, "{chunks:?}");
        let frames: Vec<usize> = chunks
            .iter()
            .map(|chunk| (engine.frontend.ids(chunk).len() as f32 * 1.0319f32) as usize)
            .collect();
        let mut draws = Vec::new();
        let pcm = engine
            .synth_with(text, 1.0, &mut |len| {
                draws.push(len);
                Ok(vec![0.0; len])
            })
            .unwrap();
        assert_eq!(
            draws,
            [
                100 * frames[0].div_ceil(2) * 2,
                200,
                100 * frames[2].div_ceil(2) * 2
            ],
            "the skipped chunk still takes its noise draw, in order"
        );
        assert_eq!(
            calls.decode.get(),
            12,
            "the skipped chunk still runs the Euler loop"
        );
        assert_eq!(
            calls.vocode.get(),
            2,
            "the skipped chunk never reaches the vocoder"
        );
        assert_eq!(
            pcm.len(),
            256 * (frames[0] - 1) + 3600 + 256 * (frames[2] - 1),
            "one pause, only between the two chunks that produced audio"
        );

        let (mut silent, calls) = engine_with(config(), false, vec![-1000.0; 3]);
        let pcm = silent.synth(text, 1.0).unwrap();
        assert_eq!((calls.encode.get(), calls.vocode.get()), (3, 0));
        assert_eq!(
            pcm.len(),
            2400,
            "every chunk skipped gives the short silence"
        );
        assert!(pcm.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn decoder_capacity_error_reaches_the_worker_splitter() {
        let (mut engine, calls) = engine(true);
        let error = engine.synth("hello there.", 1.0).unwrap_err();
        assert!(
            error
                .downcast_ref::<crate::padding::StaticCapacity>()
                .is_some(),
            "a full decoder class must reach synthesize_bounded as StaticCapacity: {error:#}"
        );
        assert_eq!(calls.decode.get(), 1);
    }

    #[test]
    fn indic_unspeakable_text_is_short_silence() {
        for text in ["...", "\u{2014}", "", "  "] {
            let (mut engine, calls) = engine(false);
            let pcm = engine.synth(text, 1.0).unwrap();
            assert_eq!(pcm.len(), 2400, "{text:?}");
            assert!(pcm.iter().all(|sample| *sample == 0.0), "{text:?}");
            assert_eq!(
                calls.encode.get() + calls.decode.get() + calls.vocode.get(),
                0,
                "{text:?} reaches no graph"
            );
        }
    }

    #[test]
    fn chunks_are_joined_by_the_sentence_pause() {
        let (mut engine, calls) = engine(false);
        let pcm = engine.synth("open the file. then run it.", 1.0).unwrap();
        assert_eq!(calls.encode.get(), 2);
        assert_eq!(calls.decode.get(), 8, "four Euler steps per chunk");
        assert_eq!(calls.vocode.get(), 2);
        // Each token lasts ceil(exp(0)) x 1.0319 frames; "open the file." is 29 tokens, "then run it." 25.
        let frames = |tokens: f32| (tokens * 1.0319f32) as usize;
        let expected = 256 * (frames(29.0) - 1) + 3600 + 256 * (frames(25.0) - 1);
        assert_eq!(pcm.len(), expected);
        assert!(pcm.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn voices_follow_the_config() {
        let (mut engine, _) = engine(false);
        assert_eq!((engine.speaker, engine.length_scale), (0, 1.0319));
        engine.voice(Path::new("."), "male").unwrap();
        assert_eq!((engine.speaker, engine.length_scale), (1, 0.9777));
        assert!(engine.voice(Path::new("."), "alba").is_err());
        assert_eq!(engine.lang(), Lang::En);
    }
}

/// Opt-in tests against the real models and the reference waveforms of the audited Python package
/// (`HANDY_TTS_IT=1`, `HANDY_TTS_MODEL_ROOT` holding `indic-tiny-{en,hi,pa}/`, `HANDY_TTS_INDIC_REFERENCE` holding
/// `{en,hi,pa}/index.json` and its tensors; GPU tests also `HANDY_TTS_DEVICE=gpu` and `HANDY_TTS_TEST_CACHE`).
#[cfg(test)]
mod real {
    use super::*;
    use handy_tts_core::device::Device;
    use std::path::PathBuf;
    use std::time::Instant;

    const LANGS: [&str; 3] = ["en", "hi", "pa"];

    fn env_path(name: &str) -> PathBuf {
        assert_eq!(
            std::env::var("HANDY_TTS_IT").as_deref(),
            Ok("1"),
            "HANDY_TTS_IT=1 opts in to real-model tests"
        );
        PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set")))
    }

    fn reference(lang: &str) -> (PathBuf, Json) {
        let dir = env_path("HANDY_TTS_INDIC_REFERENCE").join(lang);
        let index = read_json(&dir.join("index.json"), "reference index").unwrap();
        (dir, index)
    }

    fn f32_file(path: &Path) -> Vec<f32> {
        let bytes = fs::read(path).unwrap();
        assert_eq!(bytes.len() % 4, 0, "{}", path.display());
        bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect()
    }

    /// A little-endian f32 `.npy` array in C order: `(shape, data)`.
    fn npy(path: &Path) -> (Vec<usize>, Vec<f32>) {
        let bytes = fs::read(path).unwrap();
        assert_eq!(&bytes[..6], b"\x93NUMPY", "{}", path.display());
        let (header_len, start) = if bytes[6] == 1 {
            (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10)
        } else {
            (
                u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
                12,
            )
        };
        let header = std::str::from_utf8(&bytes[start..start + header_len]).unwrap();
        assert!(header.contains("'descr': '<f4'"), "{header}");
        let fortran = header.contains("'fortran_order': True");
        let shape_text = header.split("'shape': (").nth(1).unwrap();
        let shape: Vec<usize> = shape_text[..shape_text.find(')').unwrap()]
            .split(',')
            .filter(|d| !d.trim().is_empty())
            .map(|d| d.trim().parse().unwrap())
            .collect();
        let stored: Vec<f32> = bytes[start + header_len..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        if !fortran {
            return (shape, stored);
        }
        let data = (0..stored.len())
            .map(|linear| {
                let mut rest = linear;
                let mut column = 0;
                let mut column_stride = 1;
                let mut coordinates = vec![0; shape.len()];
                for (axis, &dimension) in shape.iter().enumerate().rev() {
                    coordinates[axis] = rest % dimension;
                    rest /= dimension;
                }
                for (axis, &dimension) in shape.iter().enumerate() {
                    column += coordinates[axis] * column_stride;
                    column_stride *= dimension;
                }
                stored[column]
            })
            .collect();
        (shape, data)
    }

    /// The waveform offset of chunk `j` of a reference sentence.
    fn draws_offset(sentence: &Json, j: usize) -> usize {
        sentence["chunks"][j]["wav_offset"].as_u64().unwrap() as usize
    }

    fn relative_l2(expected: &[f32], actual: &[f32]) -> f64 {
        let error: f64 = expected
            .iter()
            .zip(actual)
            .map(|(&e, &a)| (f64::from(e) - f64::from(a)).powi(2))
            .sum();
        let norm: f64 = expected.iter().map(|&e| f64::from(e).powi(2)).sum();
        (error / norm).sqrt()
    }

    fn snr_db(expected: &[f32], actual: &[f32]) -> f64 {
        let signal: f64 = expected.iter().map(|&e| f64::from(e).powi(2)).sum();
        let error: f64 = expected
            .iter()
            .zip(actual)
            .map(|(&e, &a)| (f64::from(e) - f64::from(a)).powi(2))
            .sum();
        10.0 * (signal / error).log10()
    }

    /// The DRM client memory lines (`drm-total-*`, `drm-resident-*`) of this process, one entry per client.
    fn drm_memory() -> String {
        let mut clients = BTreeMap::new();
        for entry in fs::read_dir("/proc/self/fdinfo").unwrap().flatten() {
            let Ok(info) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let Some(client) = info
                .lines()
                .find_map(|line| line.strip_prefix("drm-client-id:"))
            else {
                continue;
            };
            let lines: Vec<String> = info
                .lines()
                .filter(|line| {
                    line.starts_with("drm-driver")
                        || line.starts_with("drm-total-")
                        || line.starts_with("drm-resident-")
                })
                .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
                .collect();
            clients.insert(client.trim().to_string(), lines.join(", "));
        }
        clients
            .iter()
            .map(|(client, lines)| format!("client {client}: {lines}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn load(lang: &str, device: Device, cache: &Path) -> (PathBuf, IndicTiny) {
        let id = format!("indic-tiny-{lang}");
        let root = env_path("HANDY_TTS_MODEL_ROOT").join(&id);
        let config = crate::backend_config::config(&id, &root, device, cache).unwrap();
        let engine = crate::graph::with_config(config, || {
            crate::graph::with_compiled_graphs(|| {
                IndicTiny::load(
                    &root,
                    1,
                    "female",
                    crate::cancellation::Cancellation::new()?,
                )
            })
        })
        .unwrap();
        assert_eq!(engine.lang().code(), lang);
        (root, engine)
    }

    /// The recorded noise draws of one reference sentence, in chunk order.
    fn recorded_noise(dir: &Path, sentence: &Json) -> Vec<Vec<f32>> {
        sentence["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|chunk| f32_file(&dir.join(chunk["noise_file"].as_str().unwrap())))
            .collect()
    }

    #[test]
    #[ignore = "needs the Indic Tiny models and reference audio; opt in with HANDY_TTS_IT=1"]
    fn indic_real_cpu_matches_the_onnx_reference() {
        let cache = env_path("HANDY_TTS_TEST_SCRATCH").join("nm6-cpu-cache");
        for lang in LANGS {
            let (dir, index) = reference(lang);
            let (root, mut engine) = load(lang, Device::Cpu, &cache);
            for sentence in index["sentences"].as_array().unwrap() {
                let k = sentence["index"].as_u64().unwrap();
                engine
                    .voice(&root, sentence["voice"].as_str().unwrap())
                    .unwrap();
                let draws = recorded_noise(&dir, sentence);
                let mut next = draws.iter();
                let mut noise = |len: usize| {
                    let draw = next.next().context("more chunks than reference draws")?;
                    ensure!(
                        draw.len() == len,
                        "noise size {len}, reference {}",
                        draw.len()
                    );
                    Ok(draw.clone())
                };
                let speed = sentence["speed"].as_f64().unwrap() as f32;
                let text = sentence["text"].as_str().unwrap();
                let pcm = engine.synth_with(text, speed, &mut noise).unwrap();
                assert!(
                    next.next().is_none(),
                    "{lang} s{k}: a reference noise draw is unused"
                );
                let expected = f32_file(&dir.join(sentence["wav_file"].as_str().unwrap()));
                assert_eq!(pcm.len(), expected.len(), "{lang} s{k} length");
                let snr = snr_db(&expected, &pcm);
                println!(
                    "INDIC_REAL_CPU lang={lang} sentence={k} chunks={} samples={} snr_db={snr:.2}",
                    draws.len(),
                    pcm.len()
                );
                assert!(snr >= 60.0, "{lang} s{k}: SNR {snr:.2} dB below 60 dB");
                let length_scale = (engine.length_scale / f64::from(speed)) as f32;
                let chunks = engine
                    .frontend
                    .chunks(&engine.frontend.normalize(text).text);
                for (j, (chunk, draw)) in chunks.iter().zip(&draws).enumerate() {
                    let ids = engine.frontend.ids(chunk);
                    let acoustic = engine
                        .acoustic(&ids, length_scale, &mut |_| Ok(draw.clone()))
                        .unwrap();
                    let (shape, mel) = npy(&dir.join(format!("s{k}_c{j}.mel.npy")));
                    assert_eq!(shape, [1, 100, acoustic.frames], "{lang} s{k} c{j} frames");
                    let frames = acoustic.frames;
                    let (real, imag) = engine.graphs.vocode(&mel, frames).unwrap();
                    let (_, expected_real) = npy(&dir.join(format!("s{k}_c{j}.vocoder_real.npy")));
                    let (_, expected_imag) = npy(&dir.join(format!("s{k}_c{j}.vocoder_imag.npy")));
                    let spectrum = [expected_real.as_slice(), &expected_imag].concat();
                    let wav =
                        istft(&expected_real, &expected_imag, 513, frames, 1024, 256).unwrap();
                    let offset = draws_offset(sentence, j);
                    let clipped: Vec<f32> = wav.iter().map(|s| s.clamp(-1.0, 1.0)).collect();
                    println!(
                        "INDIC_REAL_CPU_STAGES lang={lang} sentence={k} chunk={j} frames={frames} mel_rel_l2={:.3e} vocoder_rel_l2={:.3e} istft_snr_db={:.2}",
                        relative_l2(&mel, &acoustic.mel),
                        relative_l2(&spectrum, &[real, imag].concat()),
                        snr_db(&expected[offset..offset + clipped.len()], &clipped)
                    );
                }
            }
            for edge in index["edge_cases"].as_array().unwrap() {
                let text = edge["text"].as_str().unwrap();
                let reference = edge["wav_samples"].as_u64().unwrap() as usize;
                let pcm = engine.synth(text, 1.0).unwrap();
                println!(
                    "INDIC_REAL_CPU_EDGE lang={lang} text={text:?} reference_samples={reference} samples={}",
                    pcm.len()
                );
                if reference == 0 {
                    assert_eq!(
                        pcm.len(),
                        SILENCE_SAMPLES,
                        "{lang} {text:?}: Handy reads nothing as short silence"
                    );
                    assert!(pcm.iter().all(|s| *s == 0.0));
                } else {
                    assert!(!pcm.is_empty() && pcm.iter().all(|s| s.is_finite()));
                }
            }
        }
    }

    fn gpu_cache() -> PathBuf {
        assert_eq!(
            std::env::var("HANDY_TTS_DEVICE").as_deref(),
            Ok("gpu"),
            "HANDY_TTS_DEVICE=gpu selects the GPU tests"
        );
        env_path("HANDY_TTS_TEST_CACHE")
    }

    /// Stage errors of one chunk against the reference: the encoder outputs, and the decoder loop alone fed the
    /// reference `mu_y`, mask, `cond` and noise.
    fn gpu_stages(
        engine: &mut IndicTiny,
        dir: &Path,
        k: u64,
        j: usize,
        ids: &[i64],
        draw: &[f32],
    ) -> String {
        let stem = |name: &str| dir.join(format!("s{k}_c{j}.{name}.npy"));
        let model = &engine.model;
        let encoded = engine
            .graphs
            .encode(ids, [model.language, engine.speaker, model.style])
            .unwrap();
        let (_, mu_x) = npy(&stem("mu_x"));
        let (_, logw) = npy(&stem("logw"));
        let (_, mu_y) = npy(&stem("mu_y"));
        let (_, mask) = npy(&stem("y_mask"));
        let (_, cond) = npy(&stem("cond"));
        let (_, mel) = npy(&stem("mel"));
        let frames = mask.len();
        let y_len = mel.len() / model.channels;
        let temperature = model.temperature;
        let x0 = draw.iter().map(|z| z * temperature).collect();
        let graphs = &mut engine.graphs;
        let x = euler(model.steps, x0, |x, t| {
            graphs.decode(x, &mask, &mu_y, t, &cond, frames)
        })
        .unwrap();
        let decoded: Vec<f32> = x
            .chunks(frames)
            .flat_map(|row| {
                row[..y_len]
                    .iter()
                    .map(|v| v * model.mel_std + model.mel_mean)
            })
            .collect();
        format!(
            "enc_mu_x_rel_l2={:.4} enc_logw_rel_l2={:.4} decoder_only_mel_rel_l2={:.4}",
            relative_l2(&mu_x, &encoded.mu_x),
            relative_l2(&logw, &encoded.logw),
            relative_l2(&mel, &decoded)
        )
    }

    #[test]
    #[ignore = "needs the Indic Tiny models, reference tensors and the Intel GPU; opt in with HANDY_TTS_IT=1"]
    fn indic_real_gpu_tracks_cpu() {
        let cache = gpu_cache();
        let mut failures = Vec::new();
        for lang in LANGS {
            let (dir, index) = reference(lang);
            let start = Instant::now();
            let (root, mut engine) = load(lang, Device::Gpu, &cache);
            println!(
                "INDIC_REAL_GPU_LOAD lang={lang} seconds={:.3} drm=[{}]",
                start.elapsed().as_secs_f64(),
                drm_memory()
            );
            for sentence in index["sentences"].as_array().unwrap() {
                let k = sentence["index"].as_u64().unwrap();
                engine
                    .voice(&root, sentence["voice"].as_str().unwrap())
                    .unwrap();
                let speed = sentence["speed"].as_f64().unwrap() as f32;
                let length_scale = (engine.length_scale / f64::from(speed)) as f32;
                let text = sentence["text"].as_str().unwrap();
                let chunks = engine
                    .frontend
                    .chunks(&engine.frontend.normalize(text).text);
                let reference_chunks = sentence["chunks"].as_array().unwrap();
                assert_eq!(chunks.len(), reference_chunks.len(), "{lang} s{k}");
                for (j, (chunk, expected)) in chunks.iter().zip(reference_chunks).enumerate() {
                    assert_eq!(chunk, expected["chunk"].as_str().unwrap());
                    let draw = f32_file(&dir.join(expected["noise_file"].as_str().unwrap()));
                    let ids = engine.frontend.ids(chunk);
                    let acoustic = engine
                        .acoustic(&ids, length_scale, &mut |len| {
                            let mut z = draw.clone();
                            z.resize(len, 0.0);
                            Ok(z)
                        })
                        .unwrap();
                    let reference_frames = expected["y_len"].as_u64().unwrap() as usize;
                    let stages = gpu_stages(&mut engine, &dir, k, j, &ids, &draw);
                    let (shape, mel) = npy(&dir.join(format!("s{k}_c{j}.mel.npy")));
                    assert_eq!(shape, [1, 100, reference_frames]);
                    assert!(
                        acoustic.frames.abs_diff(reference_frames) <= 2,
                        "{lang} s{k} c{j}: GPU {} frames, CPU {reference_frames}",
                        acoustic.frames
                    );
                    let relative = if acoustic.frames == reference_frames {
                        let relative = relative_l2(&mel, &acoustic.mel);
                        if relative > 0.05 {
                            failures
                                .push(format!("{lang} s{k} c{j}: mel relative L2 {relative:.4}"));
                        }
                        format!("{relative:.4}")
                    } else {
                        "n/a".into()
                    };
                    println!(
                        "INDIC_REAL_GPU lang={lang} sentence={k} chunk={j} gpu_frames={} cpu_frames={reference_frames} mel_rel_l2={relative} {stages}",
                        acoustic.frames
                    );
                }
                let pcm = engine.synth(text, speed).unwrap();
                assert!(pcm.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
                assert!(
                    pcm.iter().any(|s| s.abs() > 0.01),
                    "{lang} s{k}: GPU audio is silent"
                );
                println!(
                    "INDIC_REAL_GPU_SYNTH lang={lang} sentence={k} samples={} reference_samples={}",
                    pcm.len(),
                    sentence["wav_samples"]
                );
            }
            println!("INDIC_REAL_GPU_DONE lang={lang} drm=[{}]", drm_memory());
        }
        assert!(
            failures.is_empty(),
            "GPU mel beyond 0.05 relative L2: {failures:?}"
        );
    }

    /// Warm synthesis time per sentence (each a new frame count) and the real-time factor at 1x.
    #[test]
    #[ignore = "needs the Indic Tiny models, reference texts and the Intel GPU; opt in with HANDY_TTS_IT=1"]
    fn indic_real_gpu_meets_the_speed_bars() {
        let cache = gpu_cache();
        for lang in LANGS {
            let (_, index) = reference(lang);
            let (root, mut engine) = load(lang, Device::Gpu, &cache);
            engine
                .synth(index["edge_cases"][1]["text"].as_str().unwrap(), 1.0)
                .unwrap();
            let (mut seconds, mut audio, mut worst) = (0.0, 0.0, 0.0f64);
            let mut texts: Vec<String> = index["sentences"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["text"].as_str().unwrap().to_string())
                .collect();
            texts.push(texts.join(" "));
            for text in &texts {
                engine.voice(&root, "female").unwrap();
                let start = Instant::now();
                let pcm = engine.synth(text, 1.0).unwrap();
                let elapsed = start.elapsed().as_secs_f64();
                let duration = pcm.len() as f64 / 24000.0;
                println!(
                    "INDIC_REAL_GPU_SPEED lang={lang} seconds={elapsed:.4} audio_seconds={duration:.3} rtf={:.4}",
                    elapsed / duration
                );
                seconds += elapsed;
                audio += duration;
                worst = worst.max(elapsed);
            }
            let rtf = seconds / audio;
            println!(
                "INDIC_REAL_GPU_SPEED_SUMMARY lang={lang} rtf_1x={rtf:.4} worst_sentence_seconds={worst:.4}"
            );
            assert!(
                worst <= 3.0,
                "{lang}: a warm sentence took {worst:.3} s, over the 3.0 s first-audio limit"
            );
            assert!(
                rtf <= 0.165,
                "{lang}: RTF {rtf:.4} at 1x is over 0.165 (0.33 at 2x)"
            );
        }
    }

    #[test]
    #[ignore = "needs the Indic Tiny models and the Intel GPU; opt in with HANDY_TTS_IT=1"]
    fn indic_real_gpu_cached_load_within_five_seconds() {
        let cache = gpu_cache();
        let root = env_path("HANDY_TTS_MODEL_ROOT").join("indic-tiny-hi");
        let mut seconds = Vec::new();
        for _ in 0..2 {
            let start = Instant::now();
            let engine = crate::runtime::load_adapter(
                "indic-tiny-hi",
                &root,
                "female",
                4,
                Device::Gpu,
                &cache,
            )
            .unwrap();
            seconds.push(start.elapsed().as_secs_f64());
            println!("INDIC_REAL_GPU_ADAPTER drm=[{}]", drm_memory());
            drop(engine);
        }
        println!(
            "INDIC_REAL_GPU_CACHED cold_seconds={:.3} cached_seconds={:.3}",
            seconds[0], seconds[1]
        );
        assert!(seconds[1] < 5.0, "cached load took {:.3} s", seconds[1]);
    }
}
