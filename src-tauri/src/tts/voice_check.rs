//! The check across voices: each voice model says the words in turn, speech-to-text hears them
//! back, and the match tells the owner which voices read the correction right. Advisory only.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

/// What one voice's round trip found.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckOutcome {
    HeardRight { heard: String },
    Missed { heard: String },
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct VoiceCheck {
    pub model_id: String,
    pub outcome: CheckOutcome,
}

/// The words one voice model is asked to say.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct VoiceText {
    pub model_id: String,
    pub spoken: String,
}

/// Says the words (second argument) with one model (first argument): 16 kHz mono, or an error key.
pub type Synthesize<'a> = dyn Fn(&str, &str) -> Result<Vec<f32>, String> + 'a;

/// Synthesizes each voice's words in order, one voice at a time, transcribes them and compares
/// them with those words. A voice that fails reports only its own row; a cancelled check stops
/// before its next step and returns the rows it has.
pub fn check_voices(
    voices: &[VoiceText],
    synthesize: &Synthesize<'_>,
    transcribe: &dyn Fn(Vec<f32>) -> Result<String, String>,
    cancelled: &AtomicBool,
) -> Vec<VoiceCheck> {
    let mut results = Vec::new();
    for VoiceText { model_id, spoken } in voices {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let audio = match synthesize(model_id, spoken) {
            Ok(audio) => audio,
            Err(error) => {
                results.push(VoiceCheck {
                    model_id: model_id.clone(),
                    outcome: CheckOutcome::Failed { error },
                });
                continue;
            }
        };
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        let outcome = match transcribe(audio) {
            Ok(heard) if handy_tts_core::roundtrip::heard_matches(&heard, spoken) => {
                CheckOutcome::HeardRight { heard }
            }
            Ok(heard) => CheckOutcome::Missed { heard },
            Err(error) => CheckOutcome::Failed { error },
        };
        results.push(VoiceCheck {
            model_id: model_id.clone(),
            outcome,
        });
    }
    results
}

/// The running check's cancel flag. A new check or a dictation cancels the one before.
#[derive(Default)]
pub struct RunningCheck(Mutex<Arc<AtomicBool>>);

impl RunningCheck {
    /// Cancels the check before and returns the flag of the new one.
    pub fn begin(&self) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let previous = std::mem::replace(
            &mut *self.0.lock().unwrap_or_else(|p| p.into_inner()),
            flag.clone(),
        );
        previous.store(true, Ordering::Release);
        flag
    }
    /// Registers a new check when `eligible` allows it and returns its flag; the check before is
    /// cancelled. Refused with `eligible`'s error. `eligible` runs under the lock `cancel` takes,
    /// and a dictation is marked before it cancels, so a check either registers first and is
    /// cancelled by the dictation or sees the dictation and is refused.
    pub fn admit(
        &self,
        eligible: impl FnOnce() -> Result<(), String>,
    ) -> Result<Arc<AtomicBool>, String> {
        let mut current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        eligible()?;
        let flag = Arc::new(AtomicBool::new(false));
        std::mem::replace(&mut *current, flag.clone()).store(true, Ordering::Release);
        Ok(flag)
    }
    pub fn cancel(&self) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .store(true, Ordering::Release);
    }
    /// Ends the check whose flag is `cancelled`: `release` frees the speech-to-text model when
    /// nothing cancelled the check (a dictation, or a newer check that releases it in turn). It
    /// runs under the lock `cancel` takes, so a dictation that starts now waits until the release
    /// has been issued and then loads the model again, and a release never follows a dictation's
    /// start.
    pub fn finish(&self, cancelled: &AtomicBool, release: impl FnOnce()) {
        let _current = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if !cancelled.load(Ordering::Acquire) {
            release();
        }
    }
}

/// Refuses a check during a dictation (from the moment it starts, before its recorder runs), a
/// recording or a file transcription: each holds the speech-to-text model the check would use.
pub fn check_refusal(dictating: bool, recording: bool, file_job: bool) -> Result<(), String> {
    if dictating || recording || file_job {
        return Err("tts.vocabulary.check.dictating".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn same(spoken: &str, ids: &[&str]) -> Vec<VoiceText> {
        ids.iter()
            .map(|id| VoiceText {
                model_id: id.to_string(),
                spoken: spoken.into(),
            })
            .collect()
    }

    #[test]
    fn every_model_is_checked_in_order() {
        let synthesized = RefCell::new(Vec::new());
        let heard = RefCell::new(vec!["readme dot markdown", "Open README dot MD."]);
        let results = check_voices(
            &same("README dot M D", &["pocket-en", "supertonic-3"]),
            &|model, text| {
                assert_eq!(text, "README dot M D");
                synthesized.borrow_mut().push(model.to_string());
                Ok(vec![0.0; 16])
            },
            &|_| Ok(heard.borrow_mut().pop().unwrap().to_string()),
            &AtomicBool::new(false),
        );
        assert_eq!(*synthesized.borrow(), ["pocket-en", "supertonic-3"]);
        assert_eq!(
            results,
            [
                VoiceCheck {
                    model_id: "pocket-en".into(),
                    outcome: CheckOutcome::HeardRight {
                        heard: "Open README dot MD.".into()
                    },
                },
                VoiceCheck {
                    model_id: "supertonic-3".into(),
                    outcome: CheckOutcome::Missed {
                        heard: "readme dot markdown".into()
                    },
                },
            ]
        );
    }

    #[test]
    fn missing_model_fails_only_that_model() {
        let results = check_voices(
            &same("G P U", &["pocket-en", "supertonic-3"]),
            &|model, _| {
                if model == "pocket-en" {
                    Err("tts.errors.notDownloaded".into())
                } else {
                    Ok(vec![0.0; 16])
                }
            },
            &|_| Ok("GPU".into()),
            &AtomicBool::new(false),
        );
        assert_eq!(
            results,
            [
                VoiceCheck {
                    model_id: "pocket-en".into(),
                    outcome: CheckOutcome::Failed {
                        error: "tts.errors.notDownloaded".into()
                    },
                },
                VoiceCheck {
                    model_id: "supertonic-3".into(),
                    outcome: CheckOutcome::HeardRight {
                        heard: "GPU".into()
                    },
                },
            ]
        );
    }

    #[test]
    fn dictation_start_cancels_a_running_check() {
        let running = RunningCheck::default();
        let cancelled = running.begin();
        let synthesized = RefCell::new(0);
        let results = check_voices(
            &same("G P U", &["pocket-en", "supertonic-3"]),
            &|_, _| {
                *synthesized.borrow_mut() += 1;
                Ok(vec![0.0; 16])
            },
            &|_| {
                running.cancel();
                Ok("GPU".into())
            },
            &cancelled,
        );
        assert_eq!(results.len(), 1, "the check stops after the step it was in");
        assert_eq!(*synthesized.borrow(), 1, "no second voice is synthesized");
    }

    #[test]
    fn a_new_check_cancels_the_one_before() {
        let running = RunningCheck::default();
        let first = running.begin();
        let second = running.begin();
        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
    }

    #[test]
    fn each_voice_says_and_is_matched_against_its_own_words() {
        let synthesized = RefCell::new(Vec::new());
        let voices = [
            VoiceText {
                model_id: "pocket-en".into(),
                spoken: "CLI".into(),
            },
            VoiceText {
                model_id: "supertonic-3".into(),
                spoken: "C L I".into(),
            },
        ];
        let results = check_voices(
            &voices,
            &|model, text| {
                synthesized
                    .borrow_mut()
                    .push((model.to_string(), text.to_string()));
                Ok(vec![0.0; 16])
            },
            &|_| Ok("cli".into()),
            &AtomicBool::new(false),
        );
        assert_eq!(
            *synthesized.borrow(),
            [
                ("pocket-en".to_string(), "CLI".to_string()),
                ("supertonic-3".to_string(), "C L I".to_string())
            ]
        );
        assert!(results
            .iter()
            .all(|result| matches!(result.outcome, CheckOutcome::HeardRight { .. })));
    }

    mod finish {
        use super::*;
        use std::sync::mpsc;
        use std::time::Duration;

        #[test]
        fn an_uncancelled_check_releases_the_model() {
            let running = RunningCheck::default();
            let cancelled = running.begin();
            let mut released = false;
            running.finish(&cancelled, || released = true);
            assert!(released);
        }

        #[test]
        fn a_check_replaced_by_a_successor_leaves_the_release_to_it() {
            let running = RunningCheck::default();
            let first = running.begin();
            let second = running.begin();
            let mut released = 0;
            running.finish(&first, || released += 1);
            assert_eq!(released, 0, "the newer check still uses the model");
            running.finish(&second, || released += 1);
            assert_eq!(released, 1);
        }

        #[test]
        fn a_check_cancelled_by_dictation_releases_nothing() {
            let running = RunningCheck::default();
            let cancelled = running.begin();
            running.cancel();
            let mut released = false;
            running.finish(&cancelled, || released = true);
            assert!(!released, "the dictation now uses the model");
        }

        #[test]
        fn a_dictation_cancel_waits_until_the_release_is_issued() {
            let running = RunningCheck::default();
            let cancelled = running.begin();
            let (entered, entered_wait) = mpsc::channel();
            let (release, release_wait) = mpsc::channel::<()>();
            let (cancelled_done, cancelled_wait) = mpsc::channel();
            let (running, cancelled) = (&running, &cancelled);
            std::thread::scope(|scope| {
                scope.spawn(move || {
                    running.finish(cancelled, || {
                        entered.send(()).unwrap();
                        release_wait.recv().unwrap();
                    })
                });
                entered_wait.recv_timeout(Duration::from_secs(2)).unwrap();
                scope.spawn(move || {
                    running.cancel();
                    cancelled_done.send(()).unwrap();
                });
                let early = cancelled_wait.recv_timeout(Duration::from_millis(200));
                release.send(()).unwrap();
                assert!(
                    early.is_err(),
                    "the dictation's cancel waits for the release"
                );
                cancelled_wait.recv_timeout(Duration::from_secs(2)).unwrap();
            });
        }
    }

    #[test]
    fn refuses_a_check_during_a_dictation_a_recording_or_a_file_job() {
        assert_eq!(check_refusal(false, false, false), Ok(()));
        for (dictating, recording, file_job) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (true, true, true),
        ] {
            assert_eq!(
                check_refusal(dictating, recording, file_job),
                Err("tts.vocabulary.check.dictating".to_string())
            );
        }
    }
}
