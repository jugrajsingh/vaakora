//! Edits to the owner's vocabulary file from the app: the table the Vocabulary tab shows and
//! atomic saves that refuse a file changed on disk since it was loaded.

use super::vocabulary::{read_user_bytes, user_text, FILE_NAME, MAX_BYTES};
use handy_tts_core::vocabulary::{AcronymStyleRow, Edit, EntryRow, OwnerDocument, Vocabulary};
use std::{
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::Path,
    sync::Mutex,
};

/// The revision of a missing file.
const ABSENT: &str = "absent";
/// The revision of a file that cannot be read; no save ever matches it with a usable file.
const UNREADABLE: &str = "unreadable";

/// Held for the whole of a save, so two saves never interleave.
static SAVING: Mutex<()> = Mutex::new(());

/// What the Vocabulary tab shows: every row, the file's revision for the next save, and the
/// file's error when it cannot be used (the rows are then the built-in ones).
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
pub struct VocabularyTable {
    pub revision: String,
    pub path: String,
    pub file_error: Option<String>,
    pub rows: Vec<EntryRow>,
    pub acronym_styles: Vec<AcronymStyleRow>,
}

/// Why a save wrote nothing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveError {
    /// The file changed on disk since it was loaded.
    Changed,
    FileInvalid {
        message: String,
    },
    InvalidEdit {
        message: String,
    },
    /// The saved file would be larger than 1 MiB.
    TooLarge,
    Io {
        message: String,
    },
}

/// The file as it is on disk now.
struct OnDisk {
    revision: String,
    /// The text, `None` when there is no file, or why it cannot be read.
    text: Result<Option<String>, String>,
}

/// A hash of the bytes and their length.
fn revision_of(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn on_disk(path: &Path) -> OnDisk {
    match read_user_bytes(path) {
        Ok(None) => OnDisk {
            revision: ABSENT.into(),
            text: Ok(None),
        },
        Ok(Some(bytes)) => OnDisk {
            revision: revision_of(&bytes),
            text: user_text(bytes)
                .map(Some)
                .map_err(|error| error.to_string()),
        },
        Err(error) => OnDisk {
            revision: UNREADABLE.into(),
            text: Err(error.to_string()),
        },
    }
}

/// The rows of the built-in vocabulary and the owner's file in `dir`, for `model_ids`.
pub fn table(dir: &Path, model_ids: &[&str]) -> VocabularyTable {
    let path = dir.join(FILE_NAME);
    let disk = on_disk(&path);
    let owner = disk.text.and_then(|text| {
        text.map(|text| Vocabulary::parse(&text).map_err(|error| error.to_string()))
            .transpose()
    });
    let (vocabulary, file_error) = match owner {
        Ok(Some(file)) => (Vocabulary::merged(&file), None),
        Ok(None) => (Vocabulary::builtin(), None),
        Err(message) => (Vocabulary::builtin(), Some(message)),
    };
    VocabularyTable {
        revision: disk.revision,
        path: path.display().to_string(),
        file_error,
        rows: vocabulary.rows(model_ids),
        acronym_styles: vocabulary.acronym_styles(model_ids),
    }
}

/// Applies `edits` to the owner's file in `dir` and writes it atomically, unless the file is no
/// longer at `revision`, cannot be used, or the result is invalid or over 1 MiB. Returns the new
/// revision.
pub fn save(dir: &Path, revision: &str, edits: &[Edit]) -> Result<String, SaveError> {
    let _saving = SAVING.lock().unwrap_or_else(|p| p.into_inner());
    let path = dir.join(FILE_NAME);
    let disk = on_disk(&path);
    if disk.revision != revision {
        return Err(SaveError::Changed);
    }
    let file_invalid = |message: String| SaveError::FileInvalid { message };
    let mut document = match disk.text.map_err(file_invalid)? {
        None => OwnerDocument::empty(),
        Some(text) => {
            OwnerDocument::parse(&text).map_err(|error| file_invalid(error.to_string()))?
        }
    };
    let invalid_edit = |message: String| SaveError::InvalidEdit { message };
    document
        .apply(edits, Vocabulary::builtin().builtin_file())
        .map_err(|error| invalid_edit(error.to_string()))?;
    let json = document
        .to_json()
        .map_err(|error| invalid_edit(error.to_string()))?;
    if json.len() as u64 > MAX_BYTES {
        return Err(SaveError::TooLarge);
    }
    write_atomically(&path, json.as_bytes()).map_err(|error| SaveError::Io {
        message: error.to_string(),
    })?;
    Ok(revision_of(json.as_bytes()))
}

/// Writes a temp file beside the real file (the link's target when `path` is a symlink), syncs
/// it with the target's permissions, and renames it over the target.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let target = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => std::fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(std::io::Error::other(
            "the vocabulary path has no file name",
        ));
    };
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    let written = write_temp(&temp, &target, bytes).and_then(|()| std::fs::rename(&temp, &target));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

fn write_temp(temp: &Path, target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(temp)?;
    file.write_all(bytes)?;
    if let Ok(metadata) = std::fs::metadata(target) {
        file.set_permissions(metadata.permissions())?;
    }
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::vocabulary::{load_vocabulary, testing::scratch, Reported};
    use handy_tts_core::vocabulary::{speak_technical, EntryKey, Rule, Section, TechnicalOptions};
    use std::path::PathBuf;

    const MODELS: [&str; 2] = ["pocket-en", "supertonic-3"];
    /// The owner's file as it is today.
    const TODAY: &str = r#"{"version":1,"extensions":{"md":"M D"},"acronyms":["Cli","cli"]}"#;

    fn put(section: Section, key: &str, say: &str) -> Edit {
        Edit::Put {
            entry: EntryKey {
                section,
                model: None,
                key: key.to_string(),
            },
            rule: Rule {
                say: Some(say.to_string()),
                matching: None,
                case: None,
            },
            previous: None,
        }
    }

    fn file(dir: &Path) -> PathBuf {
        dir.join(FILE_NAME)
    }

    fn loaded(dir: &Path) -> String {
        table(dir, &MODELS).revision
    }

    fn json(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).expect("the saved file is JSON")
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// A term value too long for a 1 MiB file.
    fn oversized() -> String {
        "a".repeat(MAX_BYTES as usize)
    }

    #[test]
    fn save_writes_atomically_and_keeps_other_entries() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = scratch("store-atomic");
        let owner = r#"{"version":1,"extensions":{"md":"M D"},"acronyms":["Cli","cli"],
            "terms":{"zeta":"zay ta","alpha":"al fa"}}"#;
        std::fs::write(file(&dir), owner).unwrap();
        std::fs::set_permissions(file(&dir), std::fs::Permissions::from_mode(0o640)).unwrap();
        let inode = std::fs::metadata(file(&dir)).unwrap().ino();
        let saved = save(&dir, &loaded(&dir), &[put(Section::Term, "mid", "mid")]).unwrap();
        assert_eq!(saved, loaded(&dir), "the returned revision is the file's");
        let metadata = std::fs::metadata(file(&dir)).unwrap();
        assert_ne!(metadata.ino(), inode, "the file was replaced by a rename");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
        let text = std::fs::read_to_string(file(&dir)).unwrap();
        let position = |key: &str| text.find(&format!("\"{key}\"")).unwrap();
        assert!(position("zeta") < position("alpha") && position("alpha") < position("mid"));
        let value = json(&file(&dir));
        assert_eq!(value["extensions"], serde_json::json!({"md": "M D"}));
        assert_eq!(value["acronyms"], serde_json::json!(["Cli", "cli"]));
        assert_eq!(value["terms"]["mid"], serde_json::json!("mid"));
    }

    #[test]
    fn an_acronym_style_is_saved_and_listed_per_voice() {
        use handy_tts_core::vocabulary::AcronymStyle;
        let dir = scratch("store-acronym-style");
        std::fs::write(file(&dir), TODAY).unwrap();
        let edit = Edit::SetAcronymStyle {
            model: Some("pocket-en".into()),
            style: Some(AcronymStyle::Capitals),
        };
        save(&dir, &loaded(&dir), &[edit]).unwrap();
        let styles = table(&dir, &MODELS).acronym_styles;
        let of = |model: Option<&str>| {
            styles
                .iter()
                .find(|row| row.model.as_deref() == model)
                .map(|row| (row.owner, row.effective))
                .unwrap()
        };
        assert_eq!(
            of(Some("pocket-en")),
            (Some(AcronymStyle::Capitals), AcronymStyle::Capitals)
        );
        assert_eq!(of(Some("supertonic-3")), (None, AcronymStyle::Spaced));
        assert_eq!(of(None), (None, AcronymStyle::Spaced));
        let value = json(&file(&dir));
        assert_eq!(value["extensions"], serde_json::json!({"md": "M D"}));
        assert_eq!(
            value["models"]["pocket-en"]["acronym_style"],
            serde_json::json!("capitals")
        );
    }

    #[test]
    fn save_refuses_a_file_changed_since_load() {
        let dir = scratch("store-changed");
        std::fs::write(file(&dir), TODAY).unwrap();
        let revision = loaded(&dir);
        let hand_edit = r#"{"version":1,"extensions":{"md":"mark down"}}"#;
        std::fs::write(file(&dir), hand_edit).unwrap();
        assert_eq!(
            save(&dir, &revision, &[put(Section::Term, "x", "ex")]),
            Err(SaveError::Changed)
        );
        assert_eq!(std::fs::read_to_string(file(&dir)).unwrap(), hand_edit);
        let created = scratch("store-changed-created");
        let absent = loaded(&created);
        std::fs::write(file(&created), hand_edit).unwrap();
        assert_eq!(
            save(&created, &absent, &[put(Section::Term, "x", "ex")]),
            Err(SaveError::Changed)
        );
        assert_eq!(std::fs::read_to_string(file(&created)).unwrap(), hand_edit);
    }

    #[test]
    fn save_through_a_symlink_keeps_the_link() {
        let dir = scratch("store-symlink");
        let dotfiles = dir.join("dotfiles");
        std::fs::create_dir(&dotfiles).unwrap();
        std::fs::write(dotfiles.join("vocabulary.json"), TODAY).unwrap();
        let app = dir.join("app");
        std::fs::create_dir(&app).unwrap();
        let link = Path::new("../dotfiles/vocabulary.json");
        std::os::unix::fs::symlink(link, file(&app)).unwrap();
        save(
            &app,
            &loaded(&app),
            &[put(Section::Term, "kubectl", "kube control")],
        )
        .unwrap();
        let metadata = std::fs::symlink_metadata(file(&app)).unwrap();
        assert!(
            metadata.file_type().is_symlink(),
            "the link is still a link"
        );
        assert_eq!(std::fs::read_link(file(&app)).unwrap(), link);
        let target = json(&dotfiles.join("vocabulary.json"));
        assert_eq!(
            target["terms"]["kubectl"],
            serde_json::json!("kube control")
        );
        assert_eq!(target["extensions"], serde_json::json!({"md": "M D"}));
        assert_eq!(listing(&app), [FILE_NAME]);
        assert_eq!(listing(&dotfiles), ["vocabulary.json"]);
    }

    #[test]
    fn save_refuses_while_the_file_has_an_error() {
        let dir = scratch("store-invalid");
        std::fs::write(file(&dir), "{ not json").unwrap();
        let table = table(&dir, &MODELS);
        assert!(table.file_error.is_some());
        assert!(!table.rows.is_empty(), "the built-in rows are still listed");
        let result = save(&dir, &table.revision, &[put(Section::Term, "x", "ex")]);
        assert!(
            matches!(result, Err(SaveError::FileInvalid { .. })),
            "got {result:?}"
        );
        assert_eq!(std::fs::read_to_string(file(&dir)).unwrap(), "{ not json");
    }

    #[test]
    fn save_over_one_mebibyte_is_refused() {
        let dir = scratch("store-too-large");
        std::fs::write(file(&dir), TODAY).unwrap();
        assert_eq!(
            save(
                &dir,
                &loaded(&dir),
                &[put(Section::Term, "big", &oversized())]
            ),
            Err(SaveError::TooLarge)
        );
        assert_eq!(std::fs::read_to_string(file(&dir)).unwrap(), TODAY);
    }

    #[test]
    fn no_temp_file_is_left() {
        let dir = scratch("store-temp");
        std::fs::write(dir.join("owner-vocabulary.json"), TODAY).unwrap();
        std::os::unix::fs::symlink("owner-vocabulary.json", file(&dir)).unwrap();
        let expected = ["owner-vocabulary.json", FILE_NAME];
        save(&dir, &loaded(&dir), &[put(Section::Term, "x", "ex")]).unwrap();
        assert_eq!(listing(&dir), expected);
        assert_eq!(
            save(
                &dir,
                &loaded(&dir),
                &[put(Section::Term, "big", &oversized())]
            ),
            Err(SaveError::TooLarge)
        );
        assert_eq!(listing(&dir), expected);
    }

    #[test]
    fn saved_file_is_read_by_the_loader() {
        let dir = scratch("store-loader");
        std::fs::write(file(&dir), r#"{"version":1}"#).unwrap();
        save(&dir, &loaded(&dir), &[put(Section::Extension, "md", "M D")]).unwrap();
        let vocabulary = load_vocabulary(&dir, &Reported::default(), &mut |_| {});
        assert_eq!(
            speak_technical("notes.md", &vocabulary, &TechnicalOptions::default()),
            "notes dot M D"
        );
    }

    #[test]
    fn unknown_model_section_survives_save() {
        let dir = scratch("store-unknown-model");
        let owner = r#"{"version":1,"models":{"phonon-x":{"terms":{"Handy":"handee"}}}}"#;
        std::fs::write(file(&dir), owner).unwrap();
        save(&dir, &loaded(&dir), &[put(Section::Extension, "md", "M D")]).unwrap();
        let value = json(&file(&dir));
        assert_eq!(
            value["models"]["phonon-x"],
            serde_json::json!({"terms": {"Handy": "handee"}})
        );
        let rows = table(&dir, &MODELS).rows;
        assert!(rows
            .iter()
            .any(|row| row.id.entry.model.as_deref() == Some("phonon-x")));
    }

    #[test]
    fn missing_file_saves_a_new_one() {
        let dir = scratch("store-missing");
        let revision = loaded(&dir);
        assert_eq!(revision, "absent");
        save(&dir, &revision, &[put(Section::Extension, "md", "M D")]).unwrap();
        assert_eq!(
            json(&file(&dir)),
            serde_json::json!({"version": 1, "extensions": {"md": "M D"}})
        );
        assert_ne!(loaded(&dir), "absent");
    }

    /// What `text` is read as on `model` after the owner's file in `dir` is applied to the
    /// built-in vocabulary.
    fn read_on(dir: &Path, model: &str, text: &str) -> String {
        let vocabulary = load_vocabulary(dir, &Reported::default(), &mut |_| {});
        speak_technical(
            text,
            &vocabulary.for_model(model),
            &TechnicalOptions::default(),
        )
    }

    fn slash_entry(model: &str) -> EntryKey {
        EntryKey {
            section: Section::Symbol,
            model: Some(model.to_string()),
            key: "/".to_string(),
        }
    }

    fn slash_switch(enabled: bool) -> Edit {
        Edit::SetEnabled {
            id: handy_tts_core::vocabulary::EntryId {
                origin: handy_tts_core::vocabulary::Origin::Builtin,
                entry: EntryKey {
                    section: Section::Symbol,
                    model: None,
                    key: "/".to_string(),
                },
            },
            enabled,
        }
    }

    fn slash_copy(model: &str, say: &str) -> Edit {
        Edit::Put {
            entry: slash_entry(model),
            rule: Rule {
                say: Some(say.to_string()),
                matching: None,
                case: None,
            },
            previous: None,
        }
    }

    /// The edits the Vocabulary tab saves to switch the shared "/ = slash" row off and back on
    /// (`switchPlan` in groups.test.ts pins the same edits against the shipped rows).
    #[test]
    fn switching_the_shared_slash_row_off_and_on_keeps_the_hindi_and_punjabi_readings() {
        let models = ["pocket-en", "indic-tiny-hi", "indic-tiny-pa"];
        let dir = scratch("store-shared-slash");
        let before: Vec<String> = models.iter().map(|m| read_on(&dir, m, "a/b")).collect();
        assert!(before[0].contains("slash"), "{before:?}");
        assert!(
            before[1].contains("स्लैश") && before[2].contains("ਸਲੈਸ਼"),
            "{before:?}"
        );

        let naive = scratch("store-shared-slash-naive");
        save(&naive, &loaded(&naive), &[slash_switch(false)]).unwrap();
        assert_ne!(
            read_on(&naive, "indic-tiny-hi", "a/b"),
            before[1],
            "a bare top-level switch also turns off the Hindi reading"
        );

        save(
            &dir,
            &loaded(&dir),
            &[
                slash_copy("indic-tiny-hi", "स्लैश"),
                slash_copy("indic-tiny-pa", "ਸਲੈਸ਼"),
                slash_switch(false),
            ],
        )
        .unwrap();
        assert!(!read_on(&dir, "pocket-en", "a/b").contains("slash"));
        assert_eq!(read_on(&dir, "indic-tiny-hi", "a/b"), before[1]);
        assert_eq!(read_on(&dir, "indic-tiny-pa", "a/b"), before[2]);

        save(&dir, &loaded(&dir), &[slash_switch(true)]).unwrap();
        for (model, expected) in models.iter().zip(&before) {
            assert_eq!(&read_on(&dir, model, "a/b"), expected, "{model}");
        }
    }
}
