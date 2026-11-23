//! The text `status` and `voices` print.

use serde_json::Value;

fn text<'a>(result: &'a Value, pointer: &str) -> &'a str {
    result
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or("unknown")
}

fn flag(result: &Value, pointer: &str) -> bool {
    result
        .pointer(pointer)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn installed(yes: bool) -> &'static str {
    if yes {
        "installed"
    } else {
        "not downloaded"
    }
}

/// The lines of the `status` result, without a trailing newline.
pub(crate) fn status_text(result: &Value) -> String {
    let reading = if !flag(result, "/tts/available") {
        "not available".to_string()
    } else if flag(result, "/reading/visible") {
        format!("{}, reader open", text(result, "/reading/state"))
    } else {
        text(result, "/reading/state").to_string()
    };
    let speech_model = match text(result, "/stt/selected_model") {
        "" => "none",
        model => model,
    };
    [
        format!(
            "Vaakora {} (protocol {})",
            text(result, "/app_version"),
            result
                .pointer("/protocol_version")
                .and_then(Value::as_u64)
                .map_or_else(|| "unknown".to_string(), |n| n.to_string())
        ),
        format!("Dictation: {}", text(result, "/dictation")),
        format!("Read aloud: {reading}"),
        format!(
            "Voice: {}, {} ({})",
            text(result, "/tts/model_id"),
            text(result, "/tts/voice"),
            installed(flag(result, "/tts/installed"))
        ),
        format!(
            "Speech to text: {speech_model} ({})",
            installed(flag(result, "/stt/installed"))
        ),
    ]
    .join("\n")
}

/// One line per downloaded voice model, `<id>: <voice>, <voice>`. The selected model's line starts
/// with `* ` and its selected voice ends with ` (selected)`.
pub(crate) fn voices_text(result: &Value) -> String {
    let selected_model = text(result, "/model_id");
    let selected_voice = text(result, "/voice");
    let models = result
        .pointer("/models")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    models
        .iter()
        .map(|model| {
            let id = text(model, "/id");
            let is_selected = id == selected_model;
            let voices = model
                .pointer("/voices")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .filter_map(Value::as_str)
                .map(|voice| {
                    if is_selected && voice == selected_voice {
                        format!("{voice} (selected)")
                    } else {
                        voice.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let marker = if is_selected { "* " } else { "" };
            format!("{marker}{id}: {voices}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(dictation: &str, reading: Value, tts: Value, stt: Value) -> Value {
        json!({
            "server": "vaakora",
            "protocol_version": 1,
            "app_version": "0.2.0",
            "dictation": dictation,
            "reading": reading,
            "tts": tts,
            "stt": stt,
        })
    }

    fn voice(installed: bool) -> Value {
        json!({ "available": true, "model_id": "pocket-en", "voice": "alba", "installed": installed })
    }

    #[test]
    fn status_text_names_every_fact() {
        let result = status(
            "recording",
            json!({ "state": "playing", "visible": true }),
            voice(true),
            json!({ "selected_model": "parakeet", "installed": true }),
        );
        assert_eq!(
            status_text(&result),
            "Vaakora 0.2.0 (protocol 1)\n\
             Dictation: recording\n\
             Read aloud: playing, reader open\n\
             Voice: pocket-en, alba (installed)\n\
             Speech to text: parakeet (installed)"
        );
    }

    #[test]
    fn status_text_hides_a_closed_reader_and_marks_missing_models() {
        let result = status(
            "idle",
            json!({ "state": "idle", "visible": false }),
            voice(false),
            json!({ "selected_model": "", "installed": false }),
        );
        assert_eq!(
            status_text(&result),
            "Vaakora 0.2.0 (protocol 1)\n\
             Dictation: idle\n\
             Read aloud: idle\n\
             Voice: pocket-en, alba (not downloaded)\n\
             Speech to text: none (not downloaded)"
        );
        let named = status(
            "idle",
            json!({ "state": "idle", "visible": false }),
            voice(true),
            json!({ "selected_model": "parakeet", "installed": false }),
        );
        assert!(status_text(&named).ends_with("Speech to text: parakeet (not downloaded)"));
    }

    #[test]
    fn status_text_says_when_read_aloud_is_not_available() {
        let result = status(
            "idle",
            json!({ "state": "idle", "visible": false }),
            json!({ "available": false, "model_id": "pocket-en", "voice": "alba", "installed": false }),
            json!({ "selected_model": "parakeet", "installed": true }),
        );
        let text = status_text(&result);
        assert!(text.contains("\nRead aloud: not available\n"), "{text}");
    }

    #[test]
    fn voices_text_marks_the_selection() {
        let result = json!({
            "model_id": "kokoro",
            "voice": "af_bella",
            "models": [
                { "id": "pocket-en", "name": "Pocket TTS", "voices": ["alba", "marius"], "default_voice": "alba" },
                { "id": "kokoro", "name": "Kokoro", "voices": ["af_heart", "af_bella"], "default_voice": "af_heart" },
            ],
        });
        assert_eq!(
            voices_text(&result),
            "pocket-en: alba, marius\n* kokoro: af_heart, af_bella (selected)"
        );
    }

    #[test]
    fn voices_text_marks_the_voice_only_in_the_selected_model() {
        // The same voice name in another model is not the selection.
        let result = json!({
            "model_id": "b",
            "voice": "alba",
            "models": [
                { "id": "a", "name": "A", "voices": ["alba"], "default_voice": "alba" },
                { "id": "b", "name": "B", "voices": ["alba", "x"], "default_voice": "alba" },
            ],
        });
        assert_eq!(voices_text(&result), "a: alba\n* b: alba (selected), x");
        let none = json!({ "model_id": "pocket-en", "voice": "alba", "models": [] });
        assert_eq!(voices_text(&none), "");
    }
}
