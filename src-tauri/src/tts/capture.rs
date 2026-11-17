//! The correction box microphone: the owner says the reading and the current speech-to-text model
//! transcribes it raw into "Should say". Only the words leave this module; the audio is never
//! stored or sent anywhere.

use crate::{
    audio_toolkit::VadPolicy,
    managers::{
        audio::AudioRecordingManager, model::ModelManager, transcription::TranscriptionManager,
    },
};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// The recorder binding the correction microphone records under, apart from every dictation one.
pub const CAPTURE_BINDING: &str = "tts_correction";

/// The microphone the capture records with.
pub trait Recorder {
    /// Starts recording and returns the generation `stop` hands back.
    fn start(&self) -> Result<u64, String>;
    /// The recording started at `generation`, or `None` when it was cancelled since.
    fn stop(&self, generation: u64) -> Option<Vec<f32>>;
    fn cancel(&self);
    /// A dictation, a recording or a file transcription is active.
    fn busy(&self) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    #[error("tts.correction.microphone.busy")]
    Busy,
    #[error("tts.correction.microphone.stopped")]
    NotCapturing,
    #[error("tts.correction.microphone.reading")]
    Reading,
    #[error("{0}")]
    Failed(String),
}

enum Phase {
    Idle,
    Recording(u64),
    Transcribing { cancelled: bool },
}

/// One correction capture at a time: start, then stop for the words, or cancel.
pub struct CorrectionCapture<R: Recorder> {
    recorder: R,
    phase: Mutex<Phase>,
}

impl<R: Recorder> CorrectionCapture<R> {
    pub fn new(recorder: R) -> Self {
        Self {
            recorder,
            phase: Mutex::new(Phase::Idle),
        }
    }

    fn phase(&self) -> std::sync::MutexGuard<'_, Phase> {
        self.phase.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Starts recording unless a capture runs or the recorder is busy. The check and the start
    /// hold the lock `cancel` takes, so a dictation marked before its cancel always wins.
    pub fn start(&self) -> Result<(), CaptureError> {
        let mut phase = self.phase();
        if !matches!(*phase, Phase::Idle) || self.recorder.busy() {
            return Err(CaptureError::Busy);
        }
        let generation = self.recorder.start().map_err(CaptureError::Failed)?;
        *phase = Phase::Recording(generation);
        Ok(())
    }

    /// Stops the recording and returns what `transcribe` heard in it. `release` frees the
    /// speech-to-text model after a capture nothing cancelled; a cancelled one returns
    /// `NotCapturing` and never releases, since a dictation may be using the model. The release
    /// runs under the lock `cancel` takes, so it is issued before a dictation's cancel returns.
    pub fn stop(
        &self,
        transcribe: impl FnOnce(Vec<f32>) -> Result<String, String>,
        release: impl FnOnce(),
    ) -> Result<String, CaptureError> {
        let audio = {
            let mut phase = self.phase();
            let Phase::Recording(generation) = *phase else {
                return Err(CaptureError::NotCapturing);
            };
            let Some(audio) = self.recorder.stop(generation) else {
                *phase = Phase::Idle;
                return Err(CaptureError::NotCapturing);
            };
            *phase = Phase::Transcribing { cancelled: false };
            audio
        };
        let heard = transcribe(audio);
        let mut phase = self.phase();
        let cancelled = matches!(*phase, Phase::Transcribing { cancelled: true });
        *phase = Phase::Idle;
        if cancelled {
            return Err(CaptureError::NotCapturing);
        }
        release();
        heard.map_err(CaptureError::Failed)
    }

    /// Cancels a recording or discards the words of a running transcription. `false` when idle.
    pub fn cancel(&self) -> bool {
        let mut phase = self.phase();
        match *phase {
            Phase::Idle => false,
            Phase::Recording(_) => {
                self.recorder.cancel();
                *phase = Phase::Idle;
                true
            }
            Phase::Transcribing { .. } => {
                *phase = Phase::Transcribing { cancelled: true };
                true
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn recorder(&self) -> &R {
        &self.recorder
    }
}

/// Starts a correction capture: refused while read aloud is open (`reading`); a playing preview
/// stops first, and a failed stop leaves the microphone closed.
pub fn start_capture_with(
    reading: bool,
    stop_preview: impl FnOnce() -> Result<(), String>,
    start: impl FnOnce() -> Result<(), CaptureError>,
) -> Result<(), String> {
    if reading {
        return Err(CaptureError::Reading.to_string());
    }
    stop_preview()?;
    start().map_err(|error| error.to_string())
}

/// The app's microphone, recording under [`CAPTURE_BINDING`] with no overlay, sound, paste,
/// post-processing or history.
pub struct AppRecorder(pub AppHandle);

impl AppRecorder {
    fn audio(&self) -> Option<Arc<AudioRecordingManager>> {
        self.0
            .try_state::<Arc<AudioRecordingManager>>()
            .map(|state| state.inner().clone())
    }
}

impl Recorder for AppRecorder {
    fn start(&self) -> Result<u64, String> {
        let audio = self.audio().ok_or("tts.errors.notReady")?;
        let settings = crate::settings::get_settings(&self.0);
        let streaming = self
            .0
            .try_state::<Arc<ModelManager>>()
            .and_then(|models| models.get_model_info(&settings.selected_model))
            .is_some_and(|model| model.supports_streaming);
        // The VAD policy a dictation records with (actions.rs).
        let policy = if !settings.vad_enabled {
            VadPolicy::Disabled
        } else if streaming {
            VadPolicy::Streaming
        } else {
            VadPolicy::Offline
        };
        let generation = audio.cancel_generation();
        audio
            .try_start_recording(CAPTURE_BINDING, policy)
            .map(|_| generation)
            .map_err(|error| {
                log::warn!("Correction microphone could not start: {error:#}");
                "tts.correction.microphone.failed".to_string()
            })
    }

    fn stop(&self, generation: u64) -> Option<Vec<f32>> {
        self.audio()?.stop_recording(CAPTURE_BINDING, generation)
    }

    fn cancel(&self) {
        if let Some(audio) = self.audio() {
            audio.cancel_recording();
        }
    }

    fn busy(&self) -> bool {
        self.audio().is_some_and(|audio| audio.is_recording())
            || self
                .0
                .try_state::<Arc<TranscriptionManager>>()
                .is_some_and(|transcription| transcription.job_active())
            || self
                .0
                .try_state::<Arc<super::service::TtsService>>()
                .is_some_and(|service| service.dictating())
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::Recorder;
    use std::cell::{Cell, RefCell};

    /// A recorder that hands back `samples` and counts what it was asked to do.
    #[derive(Default)]
    pub struct FakeRecorder {
        pub busy: Cell<bool>,
        pub started: Cell<u32>,
        pub cancelled: Cell<u32>,
        pub samples: RefCell<Option<Vec<f32>>>,
    }

    impl Recorder for FakeRecorder {
        fn start(&self) -> Result<u64, String> {
            self.started.set(self.started.get() + 1);
            *self.samples.borrow_mut() = Some(vec![0.25; 4]);
            Ok(7)
        }
        fn stop(&self, generation: u64) -> Option<Vec<f32>> {
            assert_eq!(generation, 7, "stop hands back the start's generation");
            self.samples.borrow_mut().take()
        }
        fn cancel(&self) {
            self.cancelled.set(self.cancelled.get() + 1);
            self.samples.borrow_mut().take();
        }
        fn busy(&self) -> bool {
            self.busy.get()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::FakeRecorder, *};
    use std::cell::Cell;

    fn unreached(_: Vec<f32>) -> Result<String, String> {
        panic!("speech-to-text must not run");
    }

    #[test]
    fn stop_returns_the_transcript_verbatim() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        capture.start().unwrap();
        let heard = capture.stop(
            |audio| {
                assert_eq!(audio, vec![0.25; 4], "the recorded samples are transcribed");
                Ok("README dot M D".into())
            },
            || {},
        );
        assert_eq!(heard, Ok("README dot M D".into()));
    }

    #[test]
    fn start_while_busy_is_refused() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        capture.recorder.busy.set(true);
        assert_eq!(capture.start(), Err(CaptureError::Busy));
        assert_eq!(
            capture.recorder.started.get(),
            0,
            "the microphone stays closed"
        );
        capture.recorder.busy.set(false);
        capture.start().unwrap();
        assert_eq!(
            capture.start(),
            Err(CaptureError::Busy),
            "one capture at a time"
        );
        assert_eq!(capture.recorder.started.get(), 1);
    }

    #[test]
    fn stop_without_start_is_an_error() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        assert_eq!(
            capture.stop(unreached, || panic!("nothing to release")),
            Err(CaptureError::NotCapturing)
        );
    }

    #[test]
    fn an_uncancelled_capture_releases_the_model_even_when_transcription_fails() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        let released = Cell::new(0);
        capture.start().unwrap();
        assert_eq!(
            capture.stop(
                |_| Err("tts.correction.microphone.transcribeFailed".into()),
                || { released.set(released.get() + 1) }
            ),
            Err(CaptureError::Failed(
                "tts.correction.microphone.transcribeFailed".into()
            ))
        );
        assert_eq!(released.get(), 1);
        capture.start().unwrap();
        assert_eq!(
            capture.stop(|_| Ok("G P U".into()), || released.set(released.get() + 1)),
            Ok("G P U".into())
        );
        assert_eq!(released.get(), 2);
    }

    #[test]
    fn a_cancel_during_transcription_discards_the_words_and_keeps_the_model() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        capture.start().unwrap();
        let heard = capture.stop(
            |_| {
                assert!(capture.cancel(), "a running transcription is cancellable");
                Ok("README dot M D".into())
            },
            || panic!("a cancelled capture never unloads the model"),
        );
        assert_eq!(heard, Err(CaptureError::NotCapturing));
        assert_eq!(
            capture.recorder.cancelled.get(),
            0,
            "the recording had already stopped"
        );
        capture
            .start()
            .expect("the capture is idle again once the transcription returns");
    }

    #[test]
    fn a_cancelled_recording_never_reaches_speech_to_text() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        assert!(!capture.cancel(), "nothing to cancel while idle");
        capture.start().unwrap();
        assert!(capture.cancel());
        assert_eq!(capture.recorder.cancelled.get(), 1);
        assert!(!capture.cancel(), "a second cancel finds nothing");
        assert_eq!(capture.recorder.cancelled.get(), 1);
        assert_eq!(
            capture.stop(unreached, || panic!("nothing to release")),
            Err(CaptureError::NotCapturing)
        );
    }

    mod starting {
        use super::*;
        use std::cell::RefCell;

        #[test]
        fn reading_refuses_without_opening_the_microphone() {
            let steps = RefCell::new(Vec::new());
            let result = start_capture_with(
                true,
                || {
                    steps.borrow_mut().push("stop preview");
                    Ok(())
                },
                || {
                    steps.borrow_mut().push("start");
                    Ok(())
                },
            );
            assert_eq!(result, Err("tts.correction.microphone.reading".into()));
            assert!(
                steps.borrow().is_empty(),
                "nothing runs: {:?}",
                steps.borrow()
            );
        }

        #[test]
        fn a_playing_preview_stops_before_recording_starts() {
            let steps = RefCell::new(Vec::new());
            let result = start_capture_with(
                false,
                || {
                    steps.borrow_mut().push("stop preview");
                    Ok(())
                },
                || {
                    steps.borrow_mut().push("start");
                    Ok(())
                },
            );
            assert_eq!(result, Ok(()));
            assert_eq!(*steps.borrow(), ["stop preview", "start"]);
        }

        #[test]
        fn a_failed_preview_stop_keeps_the_microphone_closed() {
            let started = Cell::new(false);
            let result = start_capture_with(
                false,
                || Err("tts.errors.busy".into()),
                || {
                    started.set(true);
                    Ok(())
                },
            );
            assert_eq!(result, Err("tts.errors.busy".into()));
            assert!(!started.get());
        }
    }

    #[test]
    fn a_recording_cancelled_elsewhere_is_not_transcribed() {
        let capture = CorrectionCapture::new(FakeRecorder::default());
        capture.start().unwrap();
        capture.recorder.samples.borrow_mut().take();
        assert_eq!(
            capture.stop(unreached, || panic!("nothing to release")),
            Err(CaptureError::NotCapturing)
        );
        capture.start().expect("the capture is idle again");
    }
}
