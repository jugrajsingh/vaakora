//! Commands for the Vocabulary tab: the table, saves and Listen.

use super::{
    capture::start_capture_with,
    commands::blocking,
    service::{selection, TtsService},
    vocabulary_store::{self, SaveError, VocabularyTable},
    voice_check::{check_refusal, check_voices, VoiceCheck, VoiceText},
};
use crate::{
    audio_toolkit::audio::resample_to_16k,
    managers::{audio::AudioRecordingManager, transcription::TranscriptionManager},
};
use handy_tts_core::{
    catalog, download,
    selection::Selection,
    text::TextCursor,
    vocabulary::{
        derive, spoken_with, CorrectionRequest, Derivation, DeriveError, DerivedRule, Edit,
        Vocabulary,
    },
};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

/// What Listen reads: written text, prepared the way a read prepares it, or spoken text sent to
/// the voice as it is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ListenText {
    Written(String),
    Spoken(String),
}

fn vocabulary_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app).map_err(|e| e.to_string())
}

fn model_ids() -> Result<Vec<&'static str>, String> {
    Ok(catalog::entries()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|entry| entry.id)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn get_tts_vocabulary(app: AppHandle) -> Result<VocabularyTable, String> {
    blocking(move || {
        let ids = model_ids()?;
        Ok(vocabulary_store::table(&vocabulary_dir(&app)?, &ids))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_tts_vocabulary(
    revision: String,
    edits: Vec<Edit>,
    app: AppHandle,
) -> Result<VocabularyTable, SaveError> {
    blocking(move || {
        let dir = vocabulary_dir(&app)?;
        let ids = model_ids()?;
        Ok(vocabulary_store::save(&dir, &revision, &edits)
            .map(|_| vocabulary_store::table(&dir, &ids)))
    })
    .await
    .map_err(|message| SaveError::Io { message })?
}

#[tauri::command]
#[specta::specta]
pub async fn listen_tts_vocabulary(
    text: ListenText,
    model_id: Option<String>,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let settings = crate::settings::get_settings(&app);
        let (entry, chosen) = chosen_for(&settings, model_id.as_deref())?;
        if !entry.voices.contains(&chosen.voice) {
            return Err("tts.errors.invalidVoice".into());
        }
        let ready = service.ready()?;
        if !download::availability(&ready.root, entry).map_err(|e| e.to_string())? {
            return Err("tts.errors.notDownloaded".into());
        }
        let spoken = spoken_text(text, &service.vocabulary(), &chosen)?;
        service.preview(chosen, spoken)
    })
    .await
}

/// The catalog entry for `model_id` (the selected model when `None`) and the selection that reads
/// with it: the owner's settings, that model's voice.
fn chosen_for(
    settings: &crate::settings::AppSettings,
    model_id: Option<&str>,
) -> Result<(&'static catalog::ModelEntry, Selection), String> {
    let entry =
        catalog::entry(model_id.unwrap_or(&settings.tts_model_id)).map_err(|e| e.to_string())?;
    let mut chosen = selection(settings);
    chosen.model_id = entry.id.into();
    chosen.voice = settings
        .tts_voice
        .get(entry.id)
        .cloned()
        .unwrap_or_else(|| entry.default_voice.into());
    Ok((entry, chosen))
}

/// The words a read says for `written` on `model_id` (the selected model when `None`), prepared
/// the way a correction is derived: technical reading on, code blocks skipped.
#[tauri::command]
#[specta::specta]
pub async fn speak_tts_text(
    written: String,
    model_id: Option<String>,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<String, String> {
    let service = service.inner().clone();
    blocking(move || {
        let settings = crate::settings::get_settings(&app);
        let (_, mut chosen) = chosen_for(&settings, model_id.as_deref())?;
        chosen.read_code = false;
        spoken_text(ListenText::Written(written), &service.vocabulary(), &chosen)
    })
    .await
}

/// The rule that explains an edit of the spoken words, and the exact-text alternative.
#[tauri::command]
#[specta::specta]
pub async fn derive_tts_rule(
    request: CorrectionRequest,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<Derivation, String> {
    let service = service.inner().clone();
    blocking(move || {
        let settings = crate::settings::get_settings(&app);
        let options = selection(&settings).technical_options();
        derive(&service.vocabulary(), &request, &options).map_err(derive_error)
    })
    .await
}

/// What each voice model says for `written` once `rule` is saved: the words Play all plays and
/// the round trip checks for a correction.
#[tauri::command]
#[specta::specta]
pub async fn spoken_tts_rule(
    written: String,
    rule: DerivedRule,
    model_ids: Vec<String>,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<Vec<VoiceText>, String> {
    let service = service.inner().clone();
    blocking(move || {
        let settings = crate::settings::get_settings(&app);
        let options = selection(&settings).technical_options();
        let vocabulary = service.vocabulary();
        model_ids
            .into_iter()
            .map(|model_id| {
                spoken_with(&vocabulary, &written, &rule, &model_id, &options)
                    .map(|spoken| VoiceText { model_id, spoken })
                    .ok_or_else(|| "tts.errors.text".to_string())
            })
            .collect()
    })
    .await
}

/// The error text the correction box maps to a message; `invalid` carries the reason.
fn derive_error(error: DeriveError) -> String {
    match error {
        DeriveError::Unchanged => "tts.vocabulary.derive.unchanged".into(),
        DeriveError::SeveralWordsChanged => "tts.vocabulary.derive.severalWords".into(),
        DeriveError::NotExplained => "tts.vocabulary.derive.notExplained".into(),
        DeriveError::Invalid(reason) => format!("tts.vocabulary.derive.invalid:{reason}"),
    }
}

/// The owner-file edits that save exactly the rules shown.
fn rule_edits(rules: &[DerivedRule]) -> Vec<Edit> {
    rules.iter().map(DerivedRule::edit).collect()
}

#[tauri::command]
#[specta::specta]
pub async fn save_tts_rules(
    revision: String,
    rules: Vec<DerivedRule>,
    app: AppHandle,
) -> Result<VocabularyTable, SaveError> {
    blocking(move || {
        let dir = vocabulary_dir(&app)?;
        let ids = model_ids()?;
        Ok(vocabulary_store::save(&dir, &revision, &rule_edits(&rules))
            .map(|_| vocabulary_store::table(&dir, &ids)))
    })
    .await
    .map_err(|message| SaveError::Io { message })?
}

/// The voice model Play all is playing now; `None` once it has finished or stopped.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TtsVoicePlaying {
    pub model_id: Option<String>,
}

/// Plays each voice's words on its model in turn with the owner's speed and that model's voice,
/// naming the model as it plays. Dictation stops it like any preview.
#[tauri::command]
#[specta::specta]
pub async fn play_tts_voices(
    voices: Vec<VoiceText>,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let settings = crate::settings::get_settings(&app);
        let items = voices
            .into_iter()
            .filter_map(|voice| {
                chosen_for(&settings, Some(&voice.model_id))
                    .ok()
                    .map(|(_, chosen)| (chosen, voice.spoken))
            })
            .collect();
        service.preview_sequence(
            items,
            Arc::new(move |model_id| {
                let _ = TtsVoicePlaying { model_id }.emit(&app);
            }),
        )
    })
    .await
}

/// The round trip on each voice: synthesize its words, transcribe them raw with the current
/// speech-to-text model, compare. The model is released afterwards under the owner's unload
/// setting unless a dictation or a newer check took it over. Refused while a dictation records or a file transcribes; a
/// dictation that starts during the check stops it.
#[tauri::command]
#[specta::specta]
pub async fn check_tts_voices(
    voices: Vec<VoiceText>,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<Vec<VoiceCheck>, String> {
    let service = service.inner().clone();
    blocking(move || {
        let transcription = app
            .try_state::<Arc<TranscriptionManager>>()
            .ok_or_else(|| "tts.errors.notReady".to_string())?
            .inner()
            .clone();
        let ready = service.ready()?;
        let settings = crate::settings::get_settings(&app);
        let worker = ready.manager.fork().map_err(|e| e.to_string())?;
        let cancelled = service.voice_checks.admit(|| {
            let recording = app
                .try_state::<Arc<AudioRecordingManager>>()
                .is_some_and(|recorder| recorder.is_recording());
            check_refusal(service.dictating(), recording, transcription.job_active())
        })?;
        let synthesize = |model_id: &str, text: &str| -> Result<Vec<f32>, String> {
            let (entry, chosen) = chosen_for(&settings, Some(model_id))?;
            if !download::availability(&ready.root, entry).map_err(|e| e.to_string())? {
                return Err("tts.errors.notDownloaded".into());
            }
            let pcm = service
                .synthesize_alone(&worker, &chosen, text, &cancelled)?
                .ok_or_else(|| "tts.errors.cancelled".to_string())?;
            resample_to_16k(&pcm.samples, pcm.sample_rate).map_err(|error| {
                log::warn!("Voice check resampling failed: {error:#}");
                "tts.errors.generic".to_string()
            })
        };
        let transcribe = |audio: Vec<f32>| {
            transcription.transcribe_raw(audio).map_err(|error| {
                log::warn!("Voice check transcription failed: {error:#}");
                "tts.vocabulary.check.transcribeFailed".to_string()
            })
        };
        let results = check_voices(&voices, &synthesize, &transcribe, &cancelled);
        worker.unload();
        service.voice_checks.finish(&cancelled, || {
            transcription.maybe_unload_immediately("voice check")
        });
        Ok(results)
    })
    .await
}

/// Starts the correction microphone. Refused while read aloud is open and during a dictation, a
/// recording or a file transcription; a playing preview stops first.
#[tauri::command]
#[specta::specta]
pub async fn start_tts_capture(service: State<'_, Arc<TtsService>>) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        start_capture_with(
            service.is_reading(),
            || service.cancel_preview(),
            || service.capture.start(),
        )
    })
    .await
}

/// Stops the correction microphone and returns the words the current speech-to-text model heard,
/// raw: no custom-word correction, filler removal, post-processing, paste or history. The audio
/// goes to speech-to-text only. The model is released afterwards under the owner's unload setting
/// unless a dictation cancelled the capture.
#[tauri::command]
#[specta::specta]
pub async fn stop_tts_capture(
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<String, String> {
    let service = service.inner().clone();
    blocking(move || {
        let transcription = app
            .try_state::<Arc<TranscriptionManager>>()
            .map(|state| state.inner().clone());
        service
            .capture
            .stop(
                |audio| {
                    if audio.is_empty() {
                        return Ok(String::new());
                    }
                    let transcription = transcription
                        .as_ref()
                        .ok_or_else(|| "tts.errors.notReady".to_string())?;
                    transcription.transcribe_raw(audio).map_err(|error| {
                        log::warn!("Correction microphone transcription failed: {error:#}");
                        "tts.correction.microphone.transcribeFailed".to_string()
                    })
                },
                || {
                    if let Some(transcription) = &transcription {
                        transcription.maybe_unload_immediately("correction microphone");
                    }
                },
            )
            .map_err(|error| error.to_string())
    })
    .await
}

/// Stops the correction microphone without transcribing; nothing is kept.
#[tauri::command]
#[specta::specta]
pub async fn cancel_tts_capture(service: State<'_, Arc<TtsService>>) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        service.capture.cancel();
        Ok(())
    })
    .await
}

/// The text Listen sends to the voice. Written text is prepared with technical reading on, the
/// vocabulary resolved for the selection's model and the selection's path and link options.
fn spoken_text(
    text: ListenText,
    vocabulary: &Vocabulary,
    chosen: &Selection,
) -> Result<String, String> {
    let written = match text {
        ListenText::Spoken(spoken) => return Ok(spoken),
        ListenText::Written(written) => written,
    };
    let unprepared = |_| "tts.errors.text".to_string();
    let mut cursor = TextCursor::streaming_with(
        &written,
        chosen.read_code,
        Some(Arc::new(vocabulary.for_model(&chosen.model_id))),
        chosen.technical_options(),
    )
    .map_err(unprepared)?;
    let mut chunks = Vec::new();
    while let Some(chunk) = cursor.next_chunk().map_err(unprepared)? {
        chunks.push(chunk.text);
    }
    if chunks.is_empty() {
        return Err("tts.errors.text".into());
    }
    Ok(chunks.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::vocabulary::{testing::scratch, FILE_NAME};
    use handy_tts_core::vocabulary::TechnicalOptions;

    fn chosen(model_id: &str) -> Selection {
        Selection {
            model_id: model_id.to_string(),
            voice: "alba".into(),
            speed: 1.0,
            pitch: 0.0,
            output_device: None,
            read_code: false,
            technical: false,
            full_paths: true,
            full_links: false,
            tables: handy_tts_core::formatted::tables::TableStyle::NameEach,
        }
    }

    #[test]
    fn written_text_is_prepared_for_the_model_and_spoken_text_is_sent_as_is() {
        let owner = Vocabulary::parse(
            r#"{"version":1,"extensions":{"md":"M D"},
                "models":{"pocket-en":{"extensions":{"md":"mark down"}}}}"#,
        )
        .unwrap();
        let vocabulary = Vocabulary::merged(&owner);
        let written = || ListenText::Written("notes.md".into());
        assert_eq!(
            spoken_text(written(), &vocabulary, &chosen("supertonic-3")),
            Ok("notes dot M D.".to_string())
        );
        assert_eq!(
            spoken_text(written(), &vocabulary, &chosen("pocket-en")),
            Ok("notes dot mark down.".to_string())
        );
        assert_eq!(
            spoken_text(
                ListenText::Spoken("notes.md".into()),
                &vocabulary,
                &chosen("pocket-en")
            ),
            Ok("notes.md".to_string())
        );
    }

    fn correction(scope: Option<&str>) -> CorrectionRequest {
        CorrectionRequest {
            written: "README.md".into(),
            should_say: "README dot M D".into(),
            reading_model: "pocket-en".into(),
            scope: scope.map(str::to_string),
            matching: None,
        }
    }

    #[test]
    fn save_tts_rules_saves_exactly_the_rule_shown() {
        let owner = r#"{"version":1,"acronyms":["Cli"],"terms":{"zeta":"zay ta"}}"#;
        let options = TechnicalOptions::default();
        for (name, scope) in [("rules-all", None), ("rules-one", Some("pocket-en"))] {
            let dir = scratch(name);
            let path = dir.join(FILE_NAME);
            std::fs::write(&path, owner).unwrap();
            let derivation = derive(&Vocabulary::builtin(), &correction(scope), &options).unwrap();
            assert_eq!(derivation.rule.preview, "dot M D");
            let revision = vocabulary_store::table(&dir, &["pocket-en"]).revision;
            vocabulary_store::save(&dir, &revision, &rule_edits(&[derivation.rule])).unwrap();
            let mut expected: serde_json::Value = serde_json::from_str(owner).unwrap();
            match scope {
                None => expected["extensions"] = serde_json::json!({"md": "M D"}),
                Some(id) => {
                    expected["models"] = serde_json::json!({id: {"extensions": {"md": "M D"}}})
                }
            }
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(saved, expected, "{name}");
        }
    }

    #[test]
    fn derive_errors_are_keys_the_box_translates() {
        let options = TechnicalOptions::default();
        let mut request = correction(None);
        request.should_say = "README dot markdown".into();
        let unchanged = derive(&Vocabulary::builtin(), &request, &options).unwrap_err();
        assert_eq!(derive_error(unchanged), "tts.vocabulary.derive.unchanged");
        request.written = "see README.md now".into();
        request.should_say = "saw README dot markdown know".into();
        let several = derive(&Vocabulary::builtin(), &request, &options).unwrap_err();
        assert_eq!(derive_error(several), "tts.vocabulary.derive.severalWords");
        request.written = "README.md".into();
        request.should_say = "README dot M/D".into();
        let invalid = derive(&Vocabulary::builtin(), &request, &options).unwrap_err();
        assert!(derive_error(invalid).starts_with("tts.vocabulary.derive.invalid:"));
    }

    fn saved_vocabulary(dir: &std::path::Path) -> Vocabulary {
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        Vocabulary::merged(&Vocabulary::parse(&text).unwrap())
    }

    #[test]
    fn a_correction_for_another_voice_is_derived_and_saved_for_that_voice() {
        let options = TechnicalOptions::default();
        let dir = scratch("rules-other-voice");
        let mut stale = correction(Some("supertonic-3"));
        stale.reading_model = "pocket-en".into();
        assert!(
            derive(&Vocabulary::builtin(), &stale, &options).is_err(),
            "a rule for supertonic-3 does not change what pocket-en reads"
        );
        let mut request = correction(Some("supertonic-3"));
        request.reading_model = "supertonic-3".into();
        let derivation = derive(&Vocabulary::builtin(), &request, &options).unwrap();
        let revision = vocabulary_store::table(&dir, &["pocket-en"]).revision;
        vocabulary_store::save(&dir, &revision, &rule_edits(&[derivation.rule])).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(
            saved["models"],
            serde_json::json!({"supertonic-3": {"extensions": {"md": "M D"}}})
        );
        assert!(saved.get("extensions").is_none());
        let vocabulary = saved_vocabulary(&dir);
        let read = |model: &str| {
            spoken_text(
                ListenText::Written("README.md".into()),
                &vocabulary,
                &chosen(model),
            )
            .unwrap()
        };
        assert_eq!(read("supertonic-3"), "README dot M D.");
        assert_eq!(read("pocket-en"), "README dot markdown.");
    }

    #[test]
    fn a_skip_and_an_acronym_are_derived_in_the_shape_the_box_shows() {
        let options = TechnicalOptions::default();
        let mut request = correction(None);
        request.written = "ABC-123".into();
        request.should_say = String::new();
        let skip = derive(&Vocabulary::builtin(), &request, &options).unwrap();
        assert_eq!(
            skip.rule.entry.section,
            handy_tts_core::vocabulary::Section::Term
        );
        assert_eq!(skip.rule.rule.say, None);
        request.written = "ZFS".into();
        request.should_say = "Z F S".into();
        let acronym = derive(&Vocabulary::builtin(), &request, &options).unwrap();
        assert_eq!(
            acronym.rule.entry.section,
            handy_tts_core::vocabulary::Section::Acronym
        );
        assert_eq!(acronym.rule.rule.say, None);
        assert_eq!(acronym.rule.preview, "Z F S");
    }
}
