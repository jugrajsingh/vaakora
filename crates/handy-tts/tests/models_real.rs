//! Opt-in tests against real downloaded models: `HANDY_TTS_IT=1`, `HANDY_TTS_MODEL_ROOT=<model dir>`.
use handy_tts::{
    Engine,
    misaki::{normalize_phonemes, phoneme_ids, vocab_from_tokenizer},
};
use misaki_rs::{G2P, Language};
use std::{path::PathBuf, time::Instant};

fn model_root() -> PathBuf {
    assert_eq!(
        std::env::var("HANDY_TTS_IT").as_deref(),
        Ok("1"),
        "HANDY_TTS_IT=1 opts in to real-model tests"
    );
    PathBuf::from(
        std::env::var("HANDY_TTS_MODEL_ROOT")
            .expect("HANDY_TTS_MODEL_ROOT names the model directory"),
    )
}

#[test]
#[ignore = "needs the real Paradee files; opt in with HANDY_TTS_IT=1"]
fn paradee_real_cpu_synthesizes_every_voice() {
    let root = model_root();
    for voice in ["af_heart", "am_puck", "bf_isabella", "bm_fable"] {
        let mut engine = Engine::load("paradee-8m-int8", &root, 4, voice).unwrap();
        let started = Instant::now();
        let pcm = engine.synth("Fixture base is ready.", None).unwrap();
        let synth_s = started.elapsed().as_secs_f64();
        let seconds = pcm.len() as f64 / f64::from(engine.sample_rate());
        let peak = pcm.iter().fold(0.0f32, |peak, v| peak.max(v.abs()));
        println!("REAL_PARADEE voice={voice} seconds={seconds:.2} synth_s={synth_s:.3}");
        assert!((0.5..=5.0).contains(&seconds), "{voice}: {seconds} s");
        assert!(pcm.iter().all(|v| v.is_finite()), "{voice}: finite samples");
        assert!(peak > 0.01, "{voice}: peak {peak}");
    }
}

#[test]
#[ignore = "needs a Kokoro-family tokenizer.json; opt in with HANDY_TTS_IT=1"]
fn kokoro_tokenizer_drops_no_phonemes_after_normalization() {
    let root = model_root();
    let vocab = vocab_from_tokenizer(&std::fs::read(root.join("tokenizer.json")).unwrap()).unwrap();
    let seed = std::fs::read_to_string(
        std::env::var("HANDY_TTS_SEED").expect("HANDY_TTS_SEED names the seed sentences file"),
    )
    .unwrap();
    let lines: Vec<&str> = seed
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(10)
        .collect();
    assert_eq!(lines.len(), 10, "ten seed sentences");
    let g2p = G2P::new(Language::EnglishUS);
    let (mut raw, mut normalized) = (0, 0);
    for line in lines {
        let (phones, _) = g2p.g2p(line).unwrap();
        raw += phoneme_ids(phones.trim(), &vocab).1;
        normalized += phoneme_ids(&normalize_phonemes(&phones), &vocab).1;
    }
    println!("REAL_KOKORO_TOKENIZER raw_dropped={raw} normalized_dropped={normalized}");
    assert!(raw > 0, "the raw path drops the joiner");
    assert_eq!(normalized, 0);
}

#[test]
#[ignore = "needs the real Phonon files; opt in with HANDY_TTS_IT=1"]
fn phonon_real_cpu_synthesizes_default_and_named_voices() {
    let root = model_root();
    for voice in ["default", "Zoey"] {
        let started = Instant::now();
        let mut engine = Engine::load("phonon-31m-en", &root, 4, voice).unwrap();
        let load_s = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let pcm = engine.synth("The quick review is done.", None).unwrap();
        let first_call_s = started.elapsed().as_secs_f64();
        let started = Instant::now();
        let warm = engine.synth("The quick review is done.", None).unwrap();
        let warm_s = started.elapsed().as_secs_f64();
        let rate = f64::from(engine.sample_rate());
        let seconds = pcm.len() as f64 / rate;
        let rtf = warm_s / (warm.len() as f64 / rate);
        let peak = pcm.iter().fold(0.0f32, |peak, v| peak.max(v.abs()));
        println!(
            "REAL_PHONON voice={voice} seconds={seconds:.2} load_s={load_s:.2} first_call_s={first_call_s:.3} warm_s={warm_s:.3} rtf={rtf:.3} peak={peak:.3}"
        );
        assert!((1.0..=6.0).contains(&seconds), "{voice}: {seconds} s");
        assert!(pcm.iter().all(|v| v.is_finite()), "{voice}: finite samples");
        assert!(peak > 0.01, "{voice}: peak {peak}");
    }
}

#[test]
#[ignore = "needs the real Phonon files; opt in with HANDY_TTS_IT=1"]
fn phonon_real_every_catalog_voice_resolves() {
    let root = model_root();
    let entry = handy_tts_core::catalog::entry("phonon-31m-en").unwrap();
    let mut engine = Engine::load("phonon-31m-en", &root, 1, entry.default_voice).unwrap();
    for voice in &entry.voices {
        engine
            .voice(&root, voice)
            .unwrap_or_else(|error| panic!("{voice}: {error:#}"));
    }
    println!("REAL_PHONON_VOICES resolved={}", entry.voices.len());
    assert_eq!(entry.voices.len(), 26);
}

#[test]
#[ignore = "needs a real CPU model; opt in with HANDY_TTS_IT=1 and HANDY_TTS_MODEL_ID=<catalog id>"]
fn audit_lines_synthesize_with_a_real_model() {
    use handy_tts_core::audit::{Corpus, audit_lines};
    use handy_tts_core::vocabulary::Vocabulary;
    let root = model_root();
    let id = std::env::var("HANDY_TTS_MODEL_ID").expect("HANDY_TTS_MODEL_ID names the model");
    let scratch = PathBuf::from(
        std::env::var_os("HANDY_TTS_TEST_SCRATCH").expect("HANDY_TTS_TEST_SCRATCH is set"),
    )
    .join(format!("ve11-real-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).unwrap();
    let lines: Vec<_> = audit_lines(&Vocabulary::builtin(), None, &id, 1)
        .unwrap()
        .into_iter()
        .filter(|line| line.entry.key == "md")
        .collect();
    assert_eq!(lines.len(), 2, "one rule line and one raw line");
    let corpus = Corpus {
        model_id: id.clone(),
        partial: true,
        runs: 1,
        lines,
    };
    let path = scratch.join("lines.json");
    std::fs::write(&path, serde_json::to_vec(&corpus).unwrap()).unwrap();
    let wavs = scratch.join("wavs");
    handy_tts::measure::synthesize_lines(
        &id,
        &root,
        handy_tts_core::device::Device::Cpu,
        &scratch.join("cache"),
        &path,
        &wavs,
        1.0,
        None,
    )
    .unwrap();
    for line in &corpus.lines {
        let bytes = std::fs::read(wavs.join(format!("{}.wav", line.id))).unwrap();
        let rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let seconds = (bytes.len() - 44) as f64 / 4.0 / f64::from(rate);
        println!(
            "REAL_AUDIT_LINE model={id} id={} seconds={seconds:.2}",
            line.id
        );
        assert!((0.5..=8.0).contains(&seconds), "{}: {seconds} s", line.id);
    }
    std::fs::remove_dir_all(scratch).unwrap();
}
