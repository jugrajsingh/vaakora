use serde::Deserialize;
use std::path::{Component, Path};
use std::sync::OnceLock;
use thiserror::Error;

#[derive(Debug, Clone, Deserialize)]
/// Describes one immutable model artifact and its integrity requirements.
pub struct ModelFile {
    pub model_id: String,
    pub repo: String,
    pub revision: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub gated: bool,
}
#[derive(Debug, Clone)]
/// Combines model metadata, voice names and pinned download files.
pub struct ModelEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub license: &'static str,
    pub attribution: &'static str,
    pub card: &'static str,
    pub default_voice: &'static str,
    pub threads: usize,
    pub native_speed: crate::speed::NativeWindow,
    pub files: Vec<ModelFile>,
    pub voices: Vec<String>,
    pub bytes: u64,
    pub recommended: bool,
    /// BCP-47 primary language tags the model reads.
    pub languages: &'static [&'static str],
}
impl ModelEntry {
    /// True when any file needs a Hugging Face token to download.
    pub fn needs_token(&self) -> bool {
        self.files.iter().any(|file| file.gated)
    }
}
#[derive(Debug, Error, Clone, PartialEq)]
pub enum CatalogError {
    #[error("tts.errors.registry")]
    Invalid,
    #[error("tts.errors.unknownModel")]
    Unknown,
}
static CATALOG: OnceLock<Result<Vec<ModelEntry>, CatalogError>> = OnceLock::new();
/// Accepts relative paths consisting only of normal filesystem components.
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
/// Accepts non-empty voice names of at most 64 characters without separators or control characters.
fn valid_voice(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
}
/// Validates a pinned file manifest and assembles the supported model entries.
pub fn parse_catalog(json: &str) -> Result<Vec<ModelEntry>, CatalogError> {
    #[derive(Deserialize)]
    struct Manifest {
        native_speed: std::collections::BTreeMap<String, crate::speed::NativeWindow>,
        #[serde(default)]
        voices: std::collections::BTreeMap<String, Vec<String>>,
        files: Vec<ModelFile>,
    }
    let manifest: Manifest = serde_json::from_str(json).map_err(|_| CatalogError::Invalid)?;
    let models = [
        (
            "pocket-en",
            "Pocket TTS (English)",
            "CC-BY-4.0",
            "tts.pocketAttribution",
            "https://huggingface.co/KevinAHM/pocket-tts-onnx",
            "alba",
            4,
            true,
            &["en"],
        ),
        (
            "supertonic-3",
            "Supertonic 3",
            "OpenRAIL-M",
            "tts.supertonicRestrictions",
            "https://huggingface.co/Supertone/supertonic-3",
            "F1",
            2,
            false,
            &["en"],
        ),
        (
            "kokoro-82m-int8",
            "Kokoro-82M (INT8)",
            "Apache-2.0",
            "tts.kokoroAttribution",
            "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
            "af_heart",
            4,
            false,
            &["en"],
        ),
        (
            "paradee-8m-int8",
            "Paradee-8M (INT8)",
            "Apache-2.0",
            "tts.paradeeAttribution",
            "https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.2",
            "af_heart",
            4,
            false,
            &["en"],
        ),
        (
            "phonon-31m-en",
            "Phonon 31M (English)",
            "Apache-2.0",
            "tts.phononAttribution",
            "https://huggingface.co/onnx-community/phonon-31m-en-ONNX",
            "default",
            4,
            false,
            &["en"],
        ),
        (
            "indic-tiny-en",
            "Indic Tiny TTS (Indian English)",
            "CC-BY-4.0 + MIT",
            "tts.indicTinyEnglishAttribution",
            "https://huggingface.co/sulabhkatiyar/indic-tiny-tts-english",
            "female",
            4,
            false,
            &["en"],
        ),
        (
            "indic-tiny-hi",
            "Indic Tiny TTS (Hindi)",
            "CC-BY-4.0 + MIT",
            "tts.indicTinyHindiAttribution",
            "https://huggingface.co/sulabhkatiyar/indic-tiny-tts-hindi",
            "female",
            4,
            false,
            &["hi"],
        ),
        (
            "indic-tiny-pa",
            "Indic Tiny TTS (Punjabi)",
            "CC-BY-4.0 + MIT",
            "tts.indicTinyPunjabiAttribution",
            "https://huggingface.co/sulabhkatiyar/indic-tiny-tts-punjabi",
            "female",
            4,
            false,
            &["pa"],
        ),
    ];
    if manifest.native_speed.len() != models.len()
        || manifest
            .native_speed
            .keys()
            .chain(manifest.voices.keys())
            .any(|id| !models.iter().any(|model| model.0 == id))
    {
        return Err(CatalogError::Invalid);
    }
    let files = manifest.files;
    let mut entries = Vec::new();
    for (id, name, license, attribution, card, default_voice, threads, recommended, languages) in
        models
    {
        let native_speed = *manifest.native_speed.get(id).ok_or(CatalogError::Invalid)?;
        if !native_speed.valid()
            || (id == "pocket-en"
                && native_speed != (crate::speed::NativeWindow { min: 1.0, max: 1.0 }))
        {
            return Err(CatalogError::Invalid);
        }
        let model_files: Vec<_> = files
            .iter()
            .filter(|file| file.model_id == id)
            .cloned()
            .collect();
        if model_files.is_empty() {
            return Err(CatalogError::Invalid);
        }
        let listed = manifest.voices.get(id);
        let mut voices = Vec::new();
        let mut paths = std::collections::HashSet::new();
        let mut bytes = 0u64;
        for file in &model_files {
            if !valid_path(&file.path)
                || !valid_path(&file.repo)
                || !paths.insert(&file.path)
                || file.revision.len() != 40
                || !file.revision.bytes().all(|c| c.is_ascii_hexdigit())
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || file.bytes == 0
            {
                return Err(CatalogError::Invalid);
            }
            bytes = bytes.checked_add(file.bytes).ok_or(CatalogError::Invalid)?;
            let path = Path::new(&file.path);
            if listed.is_none()
                && (file.path.contains("embeddings/")
                    || file.path.contains("voice_styles/")
                    || (file.path.starts_with("voices/") && file.path.ends_with(".bin")))
            {
                voices.push(
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .ok_or(CatalogError::Invalid)?
                        .to_string(),
                );
            }
        }
        if let Some(listed) = listed {
            voices = listed.clone();
        }
        voices.sort();
        if !voices.iter().any(|v| v == default_voice)
            || !voices.iter().all(|v| valid_voice(v))
            || voices.windows(2).any(|pair| pair[0] == pair[1])
        {
            return Err(CatalogError::Invalid);
        }
        entries.push(ModelEntry {
            id,
            name,
            license,
            attribution,
            card,
            default_voice,
            native_speed,
            threads,
            files: model_files,
            voices,
            bytes,
            recommended,
            languages,
        });
    }
    if files
        .iter()
        .any(|file| !entries.iter().any(|entry| entry.id == file.model_id))
    {
        return Err(CatalogError::Invalid);
    }
    Ok(entries)
}
/// Returns the validated embedded catalog, initialized once per process.
pub fn entries() -> Result<&'static [ModelEntry], CatalogError> {
    CATALOG
        .get_or_init(|| parse_catalog(include_str!("models.json")))
        .as_ref()
        .map(|entries| entries.as_slice())
        .map_err(Clone::clone)
}
/// Lists every supported model identifier in catalog order.
pub fn ids() -> Result<Vec<&'static str>, CatalogError> {
    Ok(entries()?.iter().map(|entry| entry.id).collect())
}
/// Looks up a supported model by its stable identifier.
pub fn entry(id: &str) -> Result<&'static ModelEntry, CatalogError> {
    entries()?
        .iter()
        .find(|entry| entry.id == id)
        .ok_or(CatalogError::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pocket_window_other_than_unity_is_rejected() {
        let mut json: serde_json::Value =
            serde_json::from_str(include_str!("models.json")).unwrap();
        json["native_speed"]["pocket-en"] = serde_json::json!({"min": 1.0, "max": 1.1});
        assert_eq!(
            parse_catalog(&json.to_string()).unwrap_err(),
            CatalogError::Invalid
        );
    }
    #[test]
    fn explicit_voice_lists_replace_file_discovery() {
        let mut json: serde_json::Value =
            serde_json::from_str(include_str!("models.json")).unwrap();
        let listed = json["voices"].clone();
        let with = |key: &str, value: serde_json::Value| {
            let mut voices = listed.clone();
            voices[key] = value;
            voices
        };
        json["voices"] = with(
            "kokoro-82m-int8",
            serde_json::json!(["bf_emma", "af_heart"]),
        );
        let entries = parse_catalog(&json.to_string()).unwrap();
        let kokoro = entries.iter().find(|e| e.id == "kokoro-82m-int8").unwrap();
        assert_eq!(kokoro.voices, ["af_heart", "bf_emma"]);
        for bad in [
            with("kokoro-82m-int8", serde_json::json!([])),
            with("kokoro-82m-int8", serde_json::json!(["bf_emma"])),
            with(
                "kokoro-82m-int8",
                serde_json::json!(["af_heart", "af_heart"]),
            ),
            with("kokoro-82m-int8", serde_json::json!(["af_heart", "a/b"])),
            with("ghost", serde_json::json!(["af_heart"])),
        ] {
            json["voices"] = bad;
            assert_eq!(
                parse_catalog(&json.to_string()).unwrap_err(),
                CatalogError::Invalid
            );
        }
    }
    #[test]
    fn native_speed_must_cover_exactly_the_catalog() {
        let base: serde_json::Value = serde_json::from_str(include_str!("models.json")).unwrap();
        let mut missing = base.clone();
        missing["native_speed"]
            .as_object_mut()
            .unwrap()
            .remove("kokoro-82m-int8");
        let mut extra = base;
        extra["native_speed"]["ghost"] = serde_json::json!({"min": 1.0, "max": 1.0});
        for json in [missing, extra] {
            assert_eq!(
                parse_catalog(&json.to_string()).unwrap_err(),
                CatalogError::Invalid
            );
        }
        assert_eq!(
            ids().unwrap(),
            entries().unwrap().iter().map(|e| e.id).collect::<Vec<_>>()
        );
    }
    #[test]
    fn pinned_catalog_has_exact_totals_voices_and_safe_paths() {
        for (id, count, size, voices) in [
            ("pocket-en", 36, 295738958, 27),
            ("supertonic-3", 19, 401301114, 10),
            ("kokoro-82m-int8", 33, 106998117, 28),
            ("paradee-8m-int8", 5, 8487513, 4),
            ("phonon-31m-en", 35, 79323582, 26),
            ("indic-tiny-en", 9, 91040253, 2),
            ("indic-tiny-hi", 9, 91044961, 2),
            ("indic-tiny-pa", 9, 91041406, 2),
        ] {
            let entry = entry(id).unwrap();
            assert_eq!(
                (entry.files.len(), entry.bytes, entry.voices.len()),
                (count, size, voices)
            );
        }
        for path in ["../escape", "/absolute", "a/../b", "a\\b", ""] {
            assert!(!valid_path(path));
        }
        let bad = include_str!("models.json").replacen("README.md", "../README.md", 1);
        assert!(parse_catalog(&bad).is_err());
        assert!(entry("missing").is_err());
    }
    #[test]
    fn every_model_lists_its_languages() {
        let languages: Vec<_> = entries()
            .unwrap()
            .iter()
            .map(|entry| (entry.id, entry.languages))
            .collect();
        assert_eq!(
            languages,
            [
                ("pocket-en", &["en"][..]),
                ("supertonic-3", &["en"]),
                ("kokoro-82m-int8", &["en"]),
                ("paradee-8m-int8", &["en"]),
                ("phonon-31m-en", &["en"]),
                ("indic-tiny-en", &["en"]),
                ("indic-tiny-hi", &["hi"]),
                ("indic-tiny-pa", &["pa"]),
            ]
        );
    }
    #[test]
    fn only_gated_models_need_a_token() {
        assert!(entry("pocket-en").unwrap().needs_token());
        assert!(!entry("supertonic-3").unwrap().needs_token());
    }
    #[test]
    fn recommended_comes_from_the_catalogue() {
        let recommended: Vec<_> = entries()
            .unwrap()
            .iter()
            .filter(|entry| entry.recommended)
            .map(|entry| entry.id)
            .collect();
        assert_eq!(recommended, ["pocket-en"]);
    }
    #[test]
    fn phonon_voices_are_listed_by_name() {
        let entry = entry("phonon-31m-en").unwrap();
        for name in ["default", "Zoey", "Alfie", "Elodie-Rose"] {
            assert!(entry.voices.iter().any(|v| v == name), "{name}");
        }
        assert!(!entry.voices.iter().any(|v| v == "NbpkqMVS3CJeq2j8"));
        assert_eq!(entry.default_voice, "default");
        let voice_files = entry
            .files
            .iter()
            .filter(|file| file.path.starts_with("voices/") && file.path.ends_with(".bin"))
            .count();
        assert_eq!(voice_files, entry.voices.len());
    }
}
