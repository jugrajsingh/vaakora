pub mod backend_config;
pub mod cancellation;
pub mod graph;
use graph::session_for_lane;
pub mod devices;
mod indic;
mod kokoro;
pub mod misaki;
pub mod ov_graph;
pub mod padding;
mod paradee;
mod phonon;
mod pocket;
pub mod runtime;
mod supertonic;
mod unigram;
use anyhow::{Context, Result, bail};
use ort::{
    ep::CPU,
    session::{Session, builder::GraphOptimizationLevel},
};
use std::path::Path;

/// The final path component used in worker and measurement diagnostics.
pub(crate) fn diagnostic_file_name(path: &Path) -> std::borrow::Cow<'_, str> {
    path.file_name().unwrap_or_default().to_string_lossy()
}

/// Builds a CPU ONNX Runtime session. Sessions need an environment, and ort refuses a second
/// `ort::init().build()` in one process even after the first is dropped, so the first call builds
/// the process's environment and later calls reuse it. It is kept until exit because the worker
/// loads models again after every session of the previous one is gone.
fn ort_session(path: &Path, threads: usize) -> Result<Session> {
    static ENVIRONMENT: std::sync::Mutex<Option<ort::environment::Environment>> =
        std::sync::Mutex::new(None);
    let environment = {
        let mut slot = ENVIRONMENT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match slot.as_ref() {
            Some(environment) => environment.clone(),
            None => slot
                .insert(ort::init().build().context("create ORT environment")?)
                .clone(),
        }
    };
    Session::builder(&environment)
        .context("create ORT session builder")?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .with_intra_threads(threads)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .with_inter_threads(1)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .with_execution_providers([CPU::default().build()])
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .commit_from_file(path)
        .with_context(|| format!("load ONNX graph {}", diagnostic_file_name(path)))
}

/// Dispatches a validated native speed before any model inference.
pub(crate) fn synth_native(
    model: &str,
    speed: Option<f32>,
    synthesize: impl FnOnce(f32) -> Result<Vec<f32>>,
) -> Result<Vec<f32>> {
    let native = speed.unwrap_or(1.0);
    anyhow::ensure!((0.5..=2.0).contains(&native), "invalid speed");
    anyhow::ensure!(
        model != "pocket-en" || native == 1.0,
        "Pocket requires native speed 1.0"
    );
    synthesize(native)
}

pub enum Engine {
    Pocket(Box<pocket::Pocket>),
    Supertonic(Box<supertonic::Supertonic>),
    Kokoro(Box<kokoro::Kokoro>),
    Paradee(Box<paradee::Paradee>),
    Phonon(Box<phonon::Phonon>),
    IndicTiny(Box<indic::engine::IndicTiny>),
}
impl Engine {
    pub fn load(id: &str, root: &Path, threads: usize, voice: &str) -> Result<Self> {
        Self::load_lane(id, root, threads, voice, cancellation::Cancellation::new()?)
    }
    fn load_lane(
        id: &str,
        root: &Path,
        threads: usize,
        voice: &str,
        cancellation: cancellation::Cancellation,
    ) -> Result<Self> {
        match id {
            "pocket-en" => Ok(Self::Pocket(Box::new(pocket::Pocket::load(
                root,
                threads,
                voice,
                cancellation,
            )?))),
            "supertonic-3" => Ok(Self::Supertonic(Box::new(supertonic::Supertonic::load(
                root,
                threads,
                voice,
                cancellation,
            )?))),
            "kokoro-82m-int8" => Ok(Self::Kokoro(Box::new(kokoro::Kokoro::load(
                root,
                threads,
                voice,
                cancellation,
            )?))),
            "paradee-8m-int8" => Ok(Self::Paradee(Box::new(paradee::Paradee::load(
                root,
                threads,
                voice,
                cancellation,
            )?))),
            "phonon-31m-en" => Ok(Self::Phonon(Box::new(phonon::Phonon::load(
                root,
                threads,
                voice,
                cancellation,
            )?))),
            "indic-tiny-en" | "indic-tiny-hi" | "indic-tiny-pa" => {
                let engine = indic::engine::IndicTiny::load(root, threads, voice, cancellation)?;
                anyhow::ensure!(
                    id.strip_prefix("indic-tiny-") == Some(engine.lang().code()),
                    "{id} files are for another language"
                );
                Ok(Self::IndicTiny(Box::new(engine)))
            }
            _ => bail!("unknown model id"),
        }
    }
    /// Loads lane-local engine state while sharing accelerated compiled weights.
    pub fn load_lanes(
        id: &str,
        root: &Path,
        threads_per_lane: usize,
        voice: &str,
        lanes: usize,
    ) -> Result<Vec<Self>> {
        anyhow::ensure!((1..=3).contains(&lanes), "invalid lanes");
        anyhow::ensure!(
            (1..=8).contains(&threads_per_lane) && threads_per_lane * lanes <= 8,
            "invalid lane thread budget"
        );
        graph::with_compiled_graphs(|| {
            (0..lanes)
                .map(|_| Self::load(id, root, threads_per_lane, voice))
                .collect()
        })
    }
    /// Returns the cancellation handle for this engine's lane.
    pub fn cancellation(&self) -> &cancellation::Cancellation {
        match self {
            Self::Pocket(engine) => &engine.cancellation,
            Self::Supertonic(engine) => &engine.cancellation,
            Self::Kokoro(engine) => &engine.cancellation,
            Self::Paradee(engine) => &engine.cancellation,
            Self::Phonon(engine) => &engine.cancellation,
            Self::IndicTiny(engine) => &engine.cancellation,
        }
    }
    pub fn synth(&mut self, text: &str, speed: Option<f32>) -> Result<Vec<f32>> {
        match self {
            Self::Pocket(e) => synth_native("pocket-en", speed, |native| e.synth(text, native)),
            Self::Supertonic(e) => {
                synth_native("supertonic-3", speed, |native| e.synth(text, native))
            }
            Self::Kokoro(e) => {
                synth_native("kokoro-82m-int8", speed, |native| e.synth(text, native))
            }
            Self::Paradee(e) => {
                synth_native("paradee-8m-int8", speed, |native| e.synth(text, native))
            }
            Self::Phonon(e) => synth_native("phonon-31m-en", speed, |native| e.synth(text, native)),
            Self::IndicTiny(e) => synth_native("indic-tiny", speed, |native| e.synth(text, native)),
        }
    }
    pub fn voice(&mut self, root: &Path, voice: &str) -> Result<()> {
        match self {
            Self::Pocket(e) => e.voice(root, voice),
            Self::Supertonic(e) => e.voice(root, voice),
            Self::Kokoro(e) => e.voice(root, voice),
            Self::Paradee(e) => e.voice(root, voice),
            Self::Phonon(e) => e.voice(root, voice),
            Self::IndicTiny(e) => e.voice(root, voice),
        }
    }
    pub fn sample_rate(&self) -> u32 {
        match self {
            Self::Supertonic(e) => e.rate(),
            _ => 24000,
        }
    }
}

pub mod measure;

#[cfg(test)]
mod ort_environment_tests {
    #[test]
    fn every_ort_session_in_the_process_shares_one_environment() {
        let fixture = crate::cancellation::tests::CpuFixture::new();
        let first = super::ort_session(&fixture.0, 1).expect("first session");
        drop(first);
        for n in 2..=3 {
            super::ort_session(&fixture.0, 1)
                .unwrap_or_else(|error| panic!("session {n} after the first: {error:#}"));
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    #[test]
    fn followup_diagnostics_use_only_the_file_name() {
        for path in ["/private/fixture/model.onnx", "/another/root/model.onnx"] {
            assert_eq!(
                super::diagnostic_file_name(std::path::Path::new(path)),
                "model.onnx",
                "diagnostics must not expose parent directories"
            );
        }
    }
}
