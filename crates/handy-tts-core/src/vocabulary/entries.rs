//! The rows of the vocabulary table: every entry of the built-in and owner files in every scope,
//! with its switch state and the reasons it never applies (shadowed, unreachable, switched off).

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{
    AcronymStyle, SENTENCE_PUNCTUATION, Sections, TechnicalOptions, Term, TermMatch, Vocabulary,
    VocabularyFile, is_spoken_letter, resolve, scoped_layers,
};
use crate::text::TextCursor;

/// What a probe entry says, so its effect is visible in the prepared text.
pub(super) const SENTINEL: &str = "zqxv";

/// The section of a vocabulary file an entry belongs to.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum Section {
    Symbol,
    Extension,
    Term,
    Acronym,
}

/// Which file an entry comes from.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Builtin,
    Owner,
}

/// An entry within one file: its section, its scope (`models.<id>`, or `None` for all voices) and
/// its key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
pub struct EntryKey {
    pub section: Section,
    pub model: Option<String>,
    pub key: String,
}

/// An entry and the file it comes from.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
pub struct EntryId {
    pub origin: Origin,
    pub entry: EntryKey,
}

/// How an entry matches text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Matching {
    /// A term: whole word, prefix, suffix, anywhere or regex, case-sensitive or not.
    Term { matching: TermMatch, case: bool },
    /// The end of a file name, any case.
    Extension,
    /// Anywhere in a technical word.
    Symbol,
    /// A whole word or hyphenated piece in any case, or an identifier part in exact case.
    Acronym,
}

/// Why an entry can never match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Unreachable {
    /// A term key with a space: text is matched one word at a time.
    ContainsSpace,
    /// A term key ending in sentence punctuation, which is split off before terms match.
    EndsWithPunctuation,
    /// A symbol key that is not exactly one character.
    NotOneCharacter,
    /// An extension key that is not only letters and digits.
    ExtensionNotAlphanumeric,
    /// The entry alone does not change how its sample is read, or a symbol is a letter or digit,
    /// which is always read as text.
    NeverMatches,
}

/// A reason an entry never applies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Problem {
    /// A higher enabled layer sets the same key for every voice this entry reaches.
    Shadowed {
        by: EntryId,
    },
    Unreachable {
        reason: Unreachable,
    },
    /// The entry's own switch is off.
    Disabled,
}

/// How acronyms are given to one voice (`model`, or every voice when `None`): the owner's own
/// choice in that scope and the style a read there uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AcronymStyleRow {
    pub model: Option<String>,
    pub owner: Option<AcronymStyle>,
    pub effective: AcronymStyle,
}

/// One row of the vocabulary table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct EntryRow {
    pub id: EntryId,
    /// What the entry says; empty for acronyms and skips.
    pub spoken: String,
    pub skip: bool,
    pub matching: Matching,
    pub enabled: bool,
    /// An owner entry with a built-in entry of the same section and key in the same scope.
    pub replaces_builtin: bool,
    /// The text Listen reads to demonstrate the entry.
    pub sample: String,
    pub problems: Vec<Problem>,
}

/// One entry of a scope, borrowed from its sections.
struct Entry<'a> {
    section: Section,
    key: &'a str,
    spoken: &'a str,
    skip: bool,
    matching: Matching,
    /// The parsed term, for term entries.
    term: Option<&'a Term>,
}

fn entries(sections: &Sections) -> Vec<Entry<'_>> {
    let symbols = sections.symbols.iter().map(|(key, spoken)| Entry {
        section: Section::Symbol,
        key,
        spoken,
        skip: false,
        matching: Matching::Symbol,
        term: None,
    });
    let extensions = sections.extensions.iter().map(|(key, spoken)| Entry {
        section: Section::Extension,
        key,
        spoken,
        skip: false,
        matching: Matching::Extension,
        term: None,
    });
    let terms = sections.terms.iter().map(|(key, term)| Entry {
        section: Section::Term,
        key,
        spoken: &term.say,
        skip: term.is_skip(),
        matching: Matching::Term {
            matching: term.matching,
            case: term.case,
        },
        term: Some(term),
    });
    let acronyms = sections.acronyms.iter().map(|key| Entry {
        section: Section::Acronym,
        key,
        spoken: "",
        skip: false,
        matching: Matching::Acronym,
        term: None,
    });
    symbols
        .chain(extensions)
        .chain(terms)
        .chain(acronyms)
        .collect()
}

/// True when `sections` holds an entry for `key` in `section`.
pub(super) fn contains(sections: &Sections, section: Section, key: &str) -> bool {
    match section {
        Section::Symbol => sections.symbols.contains_key(key),
        Section::Extension => sections.extensions.contains_key(key),
        Section::Term => sections.terms.iter().any(|(term, _)| term == key),
        Section::Acronym => sections.acronyms.contains(key),
    }
}

/// The text Listen reads for an entry: a file name for an extension, a word holding a symbol,
/// the key itself for terms and acronyms.
fn sample(section: Section, key: &str) -> String {
    match section {
        Section::Extension => format!("notes.{key}"),
        Section::Symbol => format!("alpha{key}beta"),
        Section::Term | Section::Acronym => key.to_string(),
    }
}

/// `text` prepared with technical reading on against `vocabulary`, chunks joined with a space.
fn prepared(text: &str, vocabulary: Vocabulary) -> Option<String> {
    let mut cursor = TextCursor::streaming_with(
        text,
        false,
        Some(Arc::new(vocabulary)),
        TechnicalOptions::default(),
    )
    .ok()?;
    let texts: Vec<String> = std::iter::from_fn(|| cursor.next_chunk().ok().flatten())
        .map(|chunk| chunk.text)
        .collect();
    Some(texts.join(" "))
}

/// True when the entry alone, saying the sentinel, reads its sample exactly as no entry does.
fn never_matches(entry: &Entry, sample: &str) -> bool {
    let key = entry.key.to_string();
    let mut sections = Sections::default();
    match (entry.section, entry.term) {
        (_, Some(term)) => {
            let probe = Term {
                say: SENTINEL.to_string(),
                ..term.clone()
            };
            sections.terms.push((key, probe));
        }
        (Section::Extension, None) => {
            sections.extensions.insert(key, SENTINEL.to_string());
        }
        (Section::Acronym, None) => {
            sections.acronyms.insert(key);
        }
        _ => return false,
    }
    let alone = VocabularyFile {
        top: sections,
        ..VocabularyFile::default()
    };
    let with_entry = prepared(sample, Vocabulary::from_file(&alone));
    with_entry.is_some() && with_entry == prepared(sample, Vocabulary::default())
}

/// The structural reason an entry cannot match, else whether the probe finds it never applies.
/// Regex terms and one-letter acronyms are not checked. Symbols are checked without a probe: a
/// spoken letter (`is_spoken_letter`, as `speakable` reads it) is always read as text.
fn unreachable(entry: &Entry, sample: &str) -> Option<Unreachable> {
    let key = entry.key;
    let structural = match &entry.matching {
        Matching::Term {
            matching: TermMatch::Regex,
            ..
        } => return None,
        Matching::Acronym if key.chars().count() == 1 => return None,
        Matching::Term { .. } if key.contains(char::is_whitespace) => {
            Some(Unreachable::ContainsSpace)
        }
        Matching::Term { .. } if key.ends_with(SENTENCE_PUNCTUATION) => {
            Some(Unreachable::EndsWithPunctuation)
        }
        Matching::Symbol if key.chars().count() != 1 => {
            return Some(Unreachable::NotOneCharacter);
        }
        Matching::Symbol => {
            return key
                .chars()
                .all(is_spoken_letter)
                .then_some(Unreachable::NeverMatches);
        }
        Matching::Extension if !key.chars().all(char::is_alphanumeric) => {
            Some(Unreachable::ExtensionNotAlphanumeric)
        }
        _ => None,
    };
    structural.or_else(|| never_matches(entry, sample).then_some(Unreachable::NeverMatches))
}

impl Vocabulary {
    /// The acronym style of every voice in `model_ids`, after the one for all voices.
    pub fn acronym_styles(&self, model_ids: &[&str]) -> Vec<AcronymStyleRow> {
        std::iter::once(None)
            .chain(model_ids.iter().copied().map(Some))
            .map(|model| {
                let owner = self.owner.as_ref().and_then(|file| match model {
                    None => file.top.acronym_style,
                    Some(id) => file.models.get(id).and_then(|m| m.sections.acronym_style),
                });
                AcronymStyleRow {
                    model: model.map(str::to_string),
                    owner,
                    effective: resolve(&self.builtin, self.owner.as_ref(), model).acronym_style,
                }
            })
            .collect()
    }

    /// Every entry of both files in every scope, as table rows sorted by key (any case), then
    /// owner before built-in, then all voices before one model. `model_ids` are the catalog
    /// models a top-level entry reaches; an entry in `models.<id>` reaches that model only.
    pub fn rows(&self, model_ids: &[&str]) -> Vec<EntryRow> {
        let owner = self.owner.as_ref();
        let files = [
            (Origin::Builtin, Some(&self.builtin)),
            (Origin::Owner, owner),
        ];
        let mut rows = Vec::new();
        for (origin, file) in files {
            let Some(file) = file else { continue };
            let scopes = std::iter::once((None, &file.top)).chain(
                file.models
                    .iter()
                    .map(|(id, layer)| (Some(id.as_str()), &layer.sections)),
            );
            for (scope, sections) in scopes {
                let reached: Vec<Option<&str>> = match scope {
                    Some(id) => vec![Some(id)],
                    None => model_ids.iter().copied().map(Some).collect(),
                };
                let reached_layers: Vec<_> = reached
                    .into_iter()
                    .map(|model| scoped_layers(&self.builtin, owner, model))
                    .collect();
                let own_layers = scoped_layers(&self.builtin, owner, scope);
                let own = own_layers
                    .iter()
                    .find(|layer| layer.origin == origin && layer.model == scope);
                let builtin_scope = match scope {
                    Some(id) => self.builtin.models.get(id).map(|layer| &layer.sections),
                    None => Some(&self.builtin.top),
                };
                for entry in entries(sections) {
                    let enabled = own
                        .is_some_and(|layer| contains(&layer.sections, entry.section, entry.key));
                    let sample = sample(entry.section, entry.key);
                    let mut problems = Vec::new();
                    if let Some(reason) = unreachable(&entry, &sample) {
                        problems.push(Problem::Unreachable { reason });
                    }
                    if !enabled {
                        problems.push(Problem::Disabled);
                    } else if let Some(by) = shadowed(&entry, origin, scope, &reached_layers) {
                        problems.push(Problem::Shadowed { by });
                    }
                    rows.push(EntryRow {
                        id: EntryId {
                            origin,
                            entry: EntryKey {
                                section: entry.section,
                                model: scope.map(str::to_string),
                                key: entry.key.to_string(),
                            },
                        },
                        spoken: entry.spoken.to_string(),
                        skip: entry.skip,
                        matching: entry.matching,
                        enabled,
                        replaces_builtin: origin == Origin::Owner
                            && entry.section != Section::Acronym
                            && builtin_scope
                                .is_some_and(|builtin| contains(builtin, entry.section, entry.key)),
                        sample,
                        problems,
                    });
                }
            }
        }
        rows.sort_by_cached_key(|row| {
            (
                row.id.entry.key.to_lowercase(),
                row.id.origin == Origin::Builtin,
                row.id.entry.model.clone(),
            )
        });
        rows
    }
}

/// The entry that wins over `entry` for every model it reaches: the highest enabled layer above
/// the entry's own that sets the same key, taken from the first model. Acronyms are unioned, so
/// they are never shadowed.
fn shadowed(
    entry: &Entry,
    origin: Origin,
    scope: Option<&str>,
    reached_layers: &[Vec<super::Layer>],
) -> Option<EntryId> {
    if entry.section == Section::Acronym {
        return None;
    }
    let mut winner = None;
    for layers in reached_layers {
        let own = layers
            .iter()
            .position(|layer| layer.origin == origin && layer.model == scope)?;
        let higher = layers[..own]
            .iter()
            .find(|layer| contains(&layer.sections, entry.section, entry.key))?;
        winner.get_or_insert_with(|| EntryId {
            origin: higher.origin,
            entry: EntryKey {
                section: entry.section,
                model: higher.model.map(str::to_string),
                key: entry.key.to_string(),
            },
        });
    }
    winner
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vocabulary::{BUILTIN_JSON, TermMatch, Vocabulary, rules_fixture, speak_technical};

    const MODELS: [&str; 2] = ["pocket-en", "supertonic-3"];

    fn with_user(json: &str) -> Vocabulary {
        Vocabulary::merge_onto(
            rules_fixture(),
            &Vocabulary::parse(json).expect("test vocabulary parses"),
        )
    }

    fn id(origin: Origin, section: Section, model: Option<&str>, key: &str) -> EntryId {
        EntryId {
            origin,
            entry: EntryKey {
                section,
                model: model.map(str::to_string),
                key: key.to_string(),
            },
        }
    }

    fn row<'a>(rows: &'a [EntryRow], wanted: &EntryId) -> &'a EntryRow {
        rows.iter()
            .find(|row| &row.id == wanted)
            .unwrap_or_else(|| panic!("no row {wanted:?}"))
    }

    #[test]
    fn builtin_rows_cover_every_builtin_entry() {
        let rows = Vocabulary::builtin().rows(&MODELS);
        let json: serde_json::Value = serde_json::from_str(BUILTIN_JSON).unwrap();
        for (section, name) in [
            (Section::Symbol, "symbols"),
            (Section::Extension, "extensions"),
            (Section::Term, "terms"),
            (Section::Acronym, "acronyms"),
        ] {
            let count_of = |scope: &serde_json::Value| match &scope[name] {
                serde_json::Value::Object(map) => map.len(),
                serde_json::Value::Array(list) => list.len(),
                serde_json::Value::Null => 0,
                other => panic!("{name} is {other:?}"),
            };
            let models = json["models"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values());
            let expected = count_of(&json) + models.map(count_of).sum::<usize>();
            let count = rows
                .iter()
                .filter(|row| row.id.entry.section == section)
                .count();
            assert_eq!(count, expected, "{name}");
        }
        for row in &rows {
            assert_eq!(row.id.origin, Origin::Builtin, "{row:?}");
            assert!(row.enabled, "{row:?}");
            assert_eq!(row.problems, Vec::new(), "{row:?}");
        }
    }

    #[test]
    fn owner_edit_of_a_builtin_shadows_it() {
        let rows = with_user(r#"{"version":1,"extensions":{"md":"M D"}}"#).rows(&MODELS);
        let owner_md = id(Origin::Owner, Section::Extension, None, "md");
        let owner = row(&rows, &owner_md);
        assert_eq!(owner.spoken, "M D");
        assert!(owner.replaces_builtin);
        assert_eq!(owner.problems, Vec::new());
        let builtin = row(&rows, &id(Origin::Builtin, Section::Extension, None, "md"));
        assert_eq!(builtin.problems, vec![Problem::Shadowed { by: owner_md }]);
        assert!(!builtin.replaces_builtin);
    }

    #[test]
    fn an_all_voices_entry_is_shadowed_only_when_every_model_overrides_it() {
        let v = with_user(
            r#"{"version":1,"extensions":{"sh":"ess"},
                "models":{"pocket-en":{"extensions":{"sh":"esh"}}}}"#,
        );
        let top = id(Origin::Owner, Section::Extension, None, "sh");
        let pocket = id(Origin::Owner, Section::Extension, Some("pocket-en"), "sh");
        assert_eq!(row(&v.rows(&MODELS), &top).problems, Vec::new());
        assert_eq!(
            row(&v.rows(&["pocket-en"]), &top).problems,
            vec![Problem::Shadowed { by: pocket.clone() }]
        );
        assert_eq!(row(&v.rows(&MODELS), &pocket).problems, Vec::new());
    }

    #[test]
    fn unreachable_entries_name_the_reason() {
        let rows = with_user(
            r#"{"version":1,
                "terms":{"two words":"x","done.":"x",
                         "foo":{"say":"bar","match":"prefix"},
                         "^x$":{"say":"y","match":"regex"}},
                "symbols":{"->":"arrow"},
                "extensions":{"t-s":"x"}}"#,
        )
        .rows(&MODELS);
        let problems = |section, key| {
            row(&rows, &id(Origin::Owner, section, None, key))
                .problems
                .clone()
        };
        let unreachable = |reason| vec![Problem::Unreachable { reason }];
        assert_eq!(
            problems(Section::Term, "two words"),
            unreachable(Unreachable::ContainsSpace)
        );
        assert_eq!(
            problems(Section::Term, "done."),
            unreachable(Unreachable::EndsWithPunctuation)
        );
        assert_eq!(
            problems(Section::Symbol, "->"),
            unreachable(Unreachable::NotOneCharacter)
        );
        assert_eq!(
            problems(Section::Extension, "t-s"),
            unreachable(Unreachable::ExtensionNotAlphanumeric)
        );
        assert_eq!(problems(Section::Term, "foo"), Vec::new());
        assert_eq!(problems(Section::Term, "^x$"), Vec::new());
    }

    #[test]
    fn one_character_symbol_that_cannot_apply_is_unreachable() {
        let rows =
            with_user(r#"{"version":1,"symbols":{"a":"letter","7":"seven","@":"at"," ":"space"}}"#)
                .rows(&MODELS);
        let problems = |key| {
            row(&rows, &id(Origin::Owner, Section::Symbol, None, key))
                .problems
                .clone()
        };
        let never = vec![Problem::Unreachable {
            reason: Unreachable::NeverMatches,
        }];
        assert_eq!(problems("a"), never);
        assert_eq!(problems("7"), never);
        assert_eq!(problems("@"), Vec::new());
        assert_eq!(problems(" "), Vec::new());
    }

    #[test]
    fn indic_mark_symbol_never_applies_like_a_letter() {
        let user = with_user(r#"{"version":1,"symbols":{"्":"virama","़":"nukta","੍":"halant"}}"#);
        let rows = user.rows(&MODELS);
        let never = vec![Problem::Unreachable {
            reason: Unreachable::NeverMatches,
        }];
        for key in ["\u{094d}", "\u{093c}", "\u{0a4d}"] {
            assert!(!key.chars().all(char::is_alphanumeric), "{key:?}");
            let problems = &row(&rows, &id(Origin::Owner, Section::Symbol, None, key)).problems;
            assert_eq!(problems, &never, "{key:?}");
        }
        assert_eq!(
            speak_technical("क्ष/ਕ੍ਰ", &user, &TechnicalOptions::default()),
            speak_technical(
                "क्ष/ਕ੍ਰ",
                &Vocabulary::builtin(),
                &TechnicalOptions::default()
            )
        );
    }

    #[test]
    fn a_term_the_rules_never_see_is_unreachable() {
        let rows = with_user(r#"{"version":1,"terms":{"(zz":"found it"}}"#).rows(&MODELS);
        assert_eq!(
            row(&rows, &id(Origin::Owner, Section::Term, None, "(zz")).problems,
            vec![Problem::Unreachable {
                reason: Unreachable::NeverMatches
            }]
        );
    }

    #[test]
    fn switched_off_rows_are_disabled() {
        let rows = with_user(r#"{"version":1,"disabled":{"builtin":{"extensions":["json"]}}}"#)
            .rows(&MODELS);
        let json = row(
            &rows,
            &id(Origin::Builtin, Section::Extension, None, "json"),
        );
        assert!(!json.enabled);
        assert_eq!(json.problems, vec![Problem::Disabled]);
        let md = row(&rows, &id(Origin::Builtin, Section::Extension, None, "md"));
        assert!(md.enabled);
    }

    #[test]
    fn a_top_level_switch_shows_the_entry_off_in_every_model_section() {
        let rows = Vocabulary::merged(
            &Vocabulary::parse(r#"{"version":1,"disabled":{"builtin":{"acronyms":["GPU"]}}}"#)
                .expect("test owner file parses"),
        )
        .rows(&MODELS);
        let gpu = row(
            &rows,
            &id(Origin::Builtin, Section::Acronym, Some("pocket-en"), "GPU"),
        );
        assert!(!gpu.enabled);
        assert_eq!(gpu.problems, vec![Problem::Disabled]);
        let cpu = row(
            &rows,
            &id(Origin::Builtin, Section::Acronym, Some("pocket-en"), "CPU"),
        );
        assert!(cpu.enabled);
    }

    #[test]
    fn an_orphan_switch_can_be_undone_from_a_section_row() {
        use crate::vocabulary::{Edit, OwnerDocument};
        let saved = r#"{"version":1,"disabled":{"builtin":{"acronyms":["GPU"]}}}"#;
        let models = ["pocket-en", "indic-tiny-hi"];
        let gpu = |model: &str| id(Origin::Builtin, Section::Acronym, Some(model), "GPU");
        let before =
            Vocabulary::merged(&Vocabulary::parse(saved).expect("owner file parses")).rows(&models);
        assert!(!row(&before, &gpu("pocket-en")).enabled);
        let mut doc = OwnerDocument::parse(saved).expect("owner file parses");
        doc.apply(
            &[Edit::SetEnabled {
                id: gpu("pocket-en"),
                enabled: true,
            }],
            Vocabulary::builtin().builtin_file(),
        )
        .expect("the Pocket GPU row exists");
        let json = doc.to_json().expect("the document serializes");
        let after = Vocabulary::merged(&Vocabulary::parse(&json).expect("the saved file parses"))
            .rows(&models);
        let pocket = row(&after, &gpu("pocket-en"));
        assert!(pocket.enabled);
        assert_eq!(pocket.problems, Vec::new());
        let hindi = row(&after, &gpu("indic-tiny-hi"));
        assert!(!hindi.enabled);
        assert_eq!(hindi.problems, vec![Problem::Disabled]);
    }

    #[test]
    fn skip_and_matching_are_reported() {
        let rows = with_user(r#"{"version":1,"terms":{"ABC-123":{"skip":true,"case":false}}}"#)
            .rows(&MODELS);
        let skip = row(&rows, &id(Origin::Owner, Section::Term, None, "ABC-123"));
        assert!(skip.skip);
        assert_eq!(skip.spoken, "");
        assert_eq!(
            skip.matching,
            Matching::Term {
                matching: TermMatch::Whole,
                case: false
            }
        );
        let md = row(&rows, &id(Origin::Builtin, Section::Extension, None, "md"));
        assert_eq!(md.matching, Matching::Extension);
        assert!(!md.skip);
        assert_eq!(md.spoken, "markdown");
        assert_eq!(md.sample, "notes.md");
        let slash = row(&rows, &id(Origin::Builtin, Section::Symbol, None, "/"));
        assert_eq!(slash.matching, Matching::Symbol);
        assert_eq!(slash.sample, "alpha/beta");
        let gpu = row(&rows, &id(Origin::Builtin, Section::Acronym, None, "GPU"));
        assert_eq!(gpu.matching, Matching::Acronym);
        assert_eq!(gpu.spoken, "");
        assert_eq!(gpu.sample, "GPU");
    }

    #[test]
    fn acronym_styles_list_the_owner_choice_and_the_style_a_read_uses() {
        let styles = with_user(
            r#"{"version":1,"acronym_style":"capitals",
                "models":{"pocket-en":{"acronym_style":"spaced"}}}"#,
        )
        .acronym_styles(&MODELS);
        let style = |model: Option<&str>, owner, effective| AcronymStyleRow {
            model: model.map(str::to_string),
            owner,
            effective,
        };
        assert_eq!(
            styles,
            vec![
                style(None, Some(AcronymStyle::Capitals), AcronymStyle::Capitals),
                style(
                    Some("pocket-en"),
                    Some(AcronymStyle::Spaced),
                    AcronymStyle::Spaced
                ),
                style(Some("supertonic-3"), None, AcronymStyle::Capitals),
            ]
        );
        let none = Vocabulary::builtin().acronym_styles(&["pocket-en"]);
        assert!(none.iter().all(|row| row.owner.is_none()));
    }

    #[test]
    fn unknown_model_rows_are_listed() {
        let rows =
            with_user(r#"{"version":1,"models":{"phonon-x":{"extensions":{"sh":"shell"}}}}"#)
                .rows(&MODELS);
        let phonon = row(
            &rows,
            &id(Origin::Owner, Section::Extension, Some("phonon-x"), "sh"),
        );
        assert_eq!(phonon.id.entry.model.as_deref(), Some("phonon-x"));
        assert_eq!(phonon.spoken, "shell");
        assert_eq!(phonon.problems, Vec::new());
    }

    #[test]
    fn acronyms_are_never_shadowed_and_one_letter_ones_never_probed() {
        let rows = with_user(
            r#"{"version":1,"acronyms":["GPU","X"],
                "models":{"pocket-en":{"acronyms":["GPU"]}}}"#,
        )
        .rows(&["pocket-en"]);
        for wanted in [
            id(Origin::Builtin, Section::Acronym, None, "GPU"),
            id(Origin::Owner, Section::Acronym, None, "GPU"),
            id(Origin::Owner, Section::Acronym, None, "X"),
        ] {
            assert_eq!(row(&rows, &wanted).problems, Vec::new(), "{wanted:?}");
        }
        assert!(!row(&rows, &id(Origin::Owner, Section::Acronym, None, "GPU")).replaces_builtin);
    }

    #[test]
    fn rows_sort_by_key_then_owner_then_all_voices() {
        let rows = with_user(
            r#"{"version":1,"extensions":{"md":"M D"},
                "models":{"pocket-en":{"extensions":{"md":"emdee"}}}}"#,
        )
        .rows(&MODELS);
        let md: Vec<(Origin, Option<&str>)> = rows
            .iter()
            .filter(|row| row.id.entry.key == "md")
            .map(|row| (row.id.origin, row.id.entry.model.as_deref()))
            .collect();
        assert_eq!(
            md,
            [
                (Origin::Owner, None),
                (Origin::Owner, Some("pocket-en")),
                (Origin::Builtin, None)
            ]
        );
        let keys: Vec<String> = rows
            .iter()
            .map(|row| row.id.entry.key.to_lowercase())
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }
}
