//! The owner's vocabulary file as the editor changes it. Every section is kept in a typed form
//! that holds terms and acronyms in file order, so a save never loses or reorders an entry.
//! Formatting and the order of symbol, extension and switch keys are normalised on save.

use std::collections::{BTreeMap, BTreeSet};

use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    AcronymStyle, Disabled, EntryId, EntryKey, Example, Origin, RawFile, RawTerm, SCHEMA_VERSION,
    Section, Switches, TermMatch, Vocabulary, VocabularyError, VocabularyFile, contains,
    full_term_say, is_spoken_letter, json_error,
};

/// What an entry says and how a term matches. `say: None` is a skip (terms only); `matching`
/// defaults to whole and `case` to true. Acronyms ignore all three.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Rule {
    pub say: Option<String>,
    pub matching: Option<TermMatch>,
    pub case: Option<bool>,
}

/// One change to the owner's file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Edit {
    /// Sets an owner entry: an existing one is replaced in place, a new term is appended.
    /// `previous`, when it names another key, is removed (an edit that changed the key).
    Put {
        entry: EntryKey,
        rule: Rule,
        previous: Option<EntryKey>,
    },
    /// Removes an owner entry and its own switch.
    Delete { entry: EntryKey },
    /// Removes an owner entry, its own switch and the built-in switch for the same key and
    /// scope, so the built-in entry applies again.
    Reset { entry: EntryKey },
    /// Switches an entry on or off at its scope.
    SetEnabled { id: EntryId, enabled: bool },
    /// Sets how acronyms are given to a voice (`model`, or every voice when `None`); a `None`
    /// style removes the owner's choice there.
    SetAcronymStyle {
        model: Option<String>,
        style: Option<AcronymStyle>,
    },
}

/// Why a batch of edits was refused; the document is then unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EditError {
    #[error("there is no such vocabulary entry: {0:?}")]
    NoSuchEntry(EntryId),
    #[error("the key {key:?} is invalid: {reason}")]
    InvalidKey { key: String, reason: String },
    #[error("{0}")]
    Invalid(VocabularyError),
}

/// A term as the file stores it; `say: None` is a skip.
#[derive(Debug, Clone, PartialEq)]
struct StoredTerm {
    say: Option<String>,
    matching: TermMatch,
    case: bool,
}

impl Serialize for StoredTerm {
    /// A bare string for a whole, case-sensitive term; otherwise an object without defaults.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(say) = &self.say
            && self.matching == TermMatch::Whole
            && self.case
        {
            return serializer.serialize_str(say);
        }
        let mut map = serializer.serialize_map(None)?;
        match &self.say {
            Some(say) => map.serialize_entry("say", say)?,
            None => map.serialize_entry("skip", &true)?,
        }
        if self.matching != TermMatch::Whole {
            map.serialize_entry("match", &self.matching)?;
        }
        if !self.case {
            map.serialize_entry("case", &false)?;
        }
        map.end()
    }
}

fn terms_in_order<S: Serializer>(
    terms: &[(String, StoredTerm)],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(terms.iter().map(|(key, term)| (key, term)))
}

/// The top level or one `models.<id>` section.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
struct Scope {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    symbols: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    extensions: BTreeMap<String, String>,
    #[serde(
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "terms_in_order"
    )]
    terms: Vec<(String, StoredTerm)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    acronyms: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    acronym_style: Option<AcronymStyle>,
    #[serde(skip_serializing_if = "Disabled::is_empty")]
    disabled: Disabled,
}

impl Scope {
    fn from_raw(
        symbols: BTreeMap<String, String>,
        extensions: BTreeMap<String, String>,
        terms: Vec<(String, RawTerm)>,
        acronyms: Vec<String>,
        acronym_style: Option<AcronymStyle>,
        disabled: Disabled,
    ) -> Result<Scope, VocabularyError> {
        let mut stored = Vec::with_capacity(terms.len());
        for (key, term) in terms {
            let (say, matching, case) = match term {
                RawTerm::Plain(say) => (say, TermMatch::Whole, true),
                RawTerm::Full(full) => (
                    full_term_say(&key, full.say, full.skip)?,
                    full.matching,
                    full.case,
                ),
            };
            let say = Some(say).filter(|say| !say.is_empty());
            stored.push((
                key,
                StoredTerm {
                    say,
                    matching,
                    case,
                },
            ));
        }
        Ok(Scope {
            symbols,
            extensions: extensions
                .into_iter()
                .map(|(key, spoken)| (key.to_lowercase(), spoken))
                .collect(),
            terms: stored,
            acronyms,
            acronym_style,
            disabled: disabled.normalised(),
        })
    }

    fn has(&self, section: Section, key: &str) -> bool {
        match section {
            Section::Symbol => self.symbols.contains_key(key),
            Section::Extension => self.extensions.contains_key(key),
            Section::Term => self.terms.iter().any(|(term, _)| term == key),
            Section::Acronym => self.acronyms.iter().any(|acronym| acronym == key),
        }
    }

    /// Removes the entry and its own switch; true when the entry was there.
    fn remove(&mut self, section: Section, key: &str) -> bool {
        let found = self.has(section, key);
        match section {
            Section::Symbol => {
                self.symbols.remove(key);
            }
            Section::Extension => {
                self.extensions.remove(key);
            }
            Section::Term => self.terms.retain(|(term, _)| term != key),
            Section::Acronym => self.acronyms.retain(|acronym| acronym != key),
        }
        switch_keys(&mut self.disabled.mine, section).remove(key);
        found
    }
}

fn switch_keys(switches: &mut Switches, section: Section) -> &mut BTreeSet<String> {
    match section {
        Section::Symbol => &mut switches.symbols,
        Section::Extension => &mut switches.extensions,
        Section::Term => &mut switches.terms,
        Section::Acronym => &mut switches.acronyms,
    }
}

/// The key as the file stores it, or why it cannot be one.
fn normalised_key(section: Section, key: &str) -> Result<String, EditError> {
    let refuse = |reason: &str| EditError::InvalidKey {
        key: key.to_string(),
        reason: reason.to_string(),
    };
    match section {
        Section::Extension => {
            let bare = key.strip_prefix('.').unwrap_or(key).to_lowercase();
            if bare.is_empty() {
                return Err(refuse("an extension needs at least one character"));
            }
            Ok(bare)
        }
        Section::Symbol if key.chars().count() != 1 => {
            Err(refuse("a symbol is exactly one character"))
        }
        Section::Term if key.is_empty() || key.contains(char::is_whitespace) => {
            Err(refuse("a term is one word without spaces"))
        }
        Section::Acronym if key.is_empty() || !key.chars().all(is_spoken_letter) => {
            Err(refuse("an acronym holds only letters and digits"))
        }
        _ => Ok(key.to_string()),
    }
}

/// The owner's file, ready to edit and write back.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OwnerDocument {
    version: u32,
    #[serde(flatten)]
    top: Scope,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    examples: Vec<Example>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    models: BTreeMap<String, Scope>,
}

impl OwnerDocument {
    /// Reads a file the loader accepts; any file the loader refuses is refused with its error.
    pub fn parse(json: &str) -> Result<OwnerDocument, VocabularyError> {
        Vocabulary::parse(json)?;
        let raw: RawFile = serde_json::from_str(json).map_err(|error| json_error(&error))?;
        let mut models = BTreeMap::new();
        for (id, model) in raw.models {
            let scope = Scope::from_raw(
                model.symbols,
                model.extensions,
                model.terms,
                model.acronyms,
                model.acronym_style,
                model.disabled,
            )?;
            models.insert(id, scope);
        }
        Ok(OwnerDocument {
            version: SCHEMA_VERSION,
            top: Scope::from_raw(
                raw.symbols,
                raw.extensions,
                raw.terms,
                raw.acronyms,
                raw.acronym_style,
                raw.disabled,
            )?,
            examples: raw.examples,
            models,
        })
    }

    /// A file with no entries, for an owner who has none yet.
    pub fn empty() -> OwnerDocument {
        OwnerDocument {
            version: SCHEMA_VERSION,
            top: Scope::default(),
            examples: Vec::new(),
            models: BTreeMap::new(),
        }
    }

    /// Applies every edit or none: on an error the document is unchanged. `builtin` is the
    /// built-in layer, which built-in switches must name an entry of.
    pub fn apply(&mut self, edits: &[Edit], builtin: &VocabularyFile) -> Result<(), EditError> {
        let mut next = self.clone();
        for edit in edits {
            next.apply_one(edit, builtin)?;
        }
        next.to_json().map_err(EditError::Invalid)?;
        *self = next;
        Ok(())
    }

    /// The file text: pretty JSON with two-space indents, checked by the loader's parser.
    pub fn to_json(&self) -> Result<String, VocabularyError> {
        let mut json = serde_json::to_string_pretty(self).map_err(|error| json_error(&error))?;
        json.push('\n');
        Vocabulary::parse(&json)?;
        Ok(json)
    }

    fn scope(&mut self, model: Option<&str>) -> &mut Scope {
        match model {
            None => &mut self.top,
            Some(id) => self.models.entry(id.to_string()).or_default(),
        }
    }

    fn apply_one(&mut self, edit: &Edit, builtin: &VocabularyFile) -> Result<(), EditError> {
        let no_such = |origin: Origin, entry: &EntryKey| {
            EditError::NoSuchEntry(EntryId {
                origin,
                entry: entry.clone(),
            })
        };
        match edit {
            Edit::Put {
                entry,
                rule,
                previous,
            } => {
                let key = normalised_key(entry.section, &entry.key)?;
                let scope = self.scope(entry.model.as_deref());
                put(scope, entry.section, &key, rule)?;
                if let Some(previous) = previous
                    && (previous.section, &previous.model, previous.key.as_str())
                        != (entry.section, &entry.model, key.as_str())
                {
                    self.scope(previous.model.as_deref())
                        .remove(previous.section, &previous.key);
                }
            }
            Edit::Delete { entry } => {
                if !self
                    .scope(entry.model.as_deref())
                    .remove(entry.section, &entry.key)
                {
                    return Err(no_such(Origin::Owner, entry));
                }
            }
            Edit::Reset { entry } => {
                let scope = self.scope(entry.model.as_deref());
                let removed = scope.remove(entry.section, &entry.key);
                let switched =
                    switch_keys(&mut scope.disabled.builtin, entry.section).remove(&entry.key);
                if !removed && !switched {
                    return Err(no_such(Origin::Owner, entry));
                }
            }
            Edit::SetEnabled { id, enabled } => {
                let entry = &id.entry;
                let exists = match id.origin {
                    Origin::Owner => self
                        .scope(entry.model.as_deref())
                        .has(entry.section, &entry.key),
                    Origin::Builtin => match &entry.model {
                        None => Some(&builtin.top),
                        Some(model) => builtin.models.get(model).map(|layer| &layer.sections),
                    }
                    .is_some_and(|sections| contains(sections, entry.section, &entry.key)),
                };
                if !exists {
                    return Err(no_such(id.origin, entry));
                }
                if id.origin == Origin::Builtin
                    && *enabled
                    && let Some(model) = &entry.model
                    && switch_keys(&mut self.top.disabled.builtin, entry.section)
                        .contains(&entry.key)
                    && !contains(&builtin.top, entry.section, &entry.key)
                {
                    // An all-voices switch with no all-voices row: keep it for the other voices.
                    switch_keys(&mut self.top.disabled.builtin, entry.section).remove(&entry.key);
                    for (other, layer) in &builtin.models {
                        if other != model && contains(&layer.sections, entry.section, &entry.key) {
                            switch_keys(
                                &mut self.scope(Some(other)).disabled.builtin,
                                entry.section,
                            )
                            .insert(entry.key.clone());
                        }
                    }
                }
                let disabled = &mut self.scope(entry.model.as_deref()).disabled;
                let switches = match id.origin {
                    Origin::Owner => &mut disabled.mine,
                    Origin::Builtin => &mut disabled.builtin,
                };
                let keys = switch_keys(switches, entry.section);
                if *enabled {
                    keys.remove(&entry.key);
                } else {
                    keys.insert(entry.key.clone());
                }
            }
            Edit::SetAcronymStyle { model, style } => {
                let missing = model
                    .as_ref()
                    .is_some_and(|id| !self.models.contains_key(id));
                if !(style.is_none() && missing) {
                    self.scope(model.as_deref()).acronym_style = *style;
                }
            }
        }
        Ok(())
    }
}

/// Sets one owner entry in `scope`: replaced in place when present, appended when new.
fn put(scope: &mut Scope, section: Section, key: &str, rule: &Rule) -> Result<(), EditError> {
    let say = rule.say.clone().filter(|say| !say.is_empty());
    let needs_say = || {
        say.clone().ok_or_else(|| {
            EditError::Invalid(VocabularyError::Pattern {
                key: key.to_string(),
                message: "a symbol or extension needs say; only terms can be skipped".into(),
            })
        })
    };
    match section {
        Section::Symbol => {
            scope.symbols.insert(key.to_string(), needs_say()?);
        }
        Section::Extension => {
            scope.extensions.insert(key.to_string(), needs_say()?);
        }
        Section::Term => {
            let term = StoredTerm {
                say,
                matching: rule.matching.unwrap_or_default(),
                case: rule.case.unwrap_or(true),
            };
            match scope.terms.iter_mut().find(|(existing, _)| existing == key) {
                Some(existing) => existing.1 = term,
                None => scope.terms.push((key.to_string(), term)),
            }
        }
        Section::Acronym => {
            if !scope.has(Section::Acronym, key) {
                scope.acronyms.push(key.to_string());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin() -> VocabularyFile {
        crate::vocabulary::rules_fixture().builtin_file().clone()
    }

    fn document(json: &str) -> OwnerDocument {
        OwnerDocument::parse(json).expect("test owner file parses")
    }

    fn entry(section: Section, model: Option<&str>, key: &str) -> EntryKey {
        EntryKey {
            section,
            model: model.map(str::to_string),
            key: key.to_string(),
        }
    }

    fn say(text: &str) -> Rule {
        Rule {
            say: Some(text.to_string()),
            matching: None,
            case: None,
        }
    }

    fn put(section: Section, key: &str, rule: Rule) -> Edit {
        Edit::Put {
            entry: entry(section, None, key),
            rule,
            previous: None,
        }
    }

    fn json(doc: &OwnerDocument) -> String {
        doc.to_json()
            .expect("the document serializes to a valid file")
    }

    /// The saved file as the loader reads it, so term order is the file order.
    fn reparsed(doc: &OwnerDocument) -> VocabularyFile {
        Vocabulary::parse(&json(doc)).expect("the saved file parses")
    }

    /// The saved file as plain JSON, for exact shapes (object key order is lost).
    fn value(doc: &OwnerDocument) -> serde_json::Value {
        serde_json::from_str(&json(doc)).expect("the saved file is JSON")
    }

    fn term_keys(file: &VocabularyFile) -> Vec<&str> {
        file.top.terms.iter().map(|(key, _)| key.as_str()).collect()
    }

    fn term_say<'a>(file: &'a VocabularyFile, key: &str) -> &'a str {
        file.top
            .terms
            .iter()
            .find(|(term, _)| term == key)
            .map(|(_, term)| term.say.as_str())
            .unwrap_or_else(|| panic!("no term {key}"))
    }

    #[test]
    fn put_replaces_in_place_and_appends_new_terms() {
        let mut doc = document(r#"{"version":1,"terms":{"c":"see","a":"ay","b":"bee"}}"#);
        doc.apply(
            &[
                put(Section::Term, "a", say("alpha")),
                put(Section::Term, "d", say("dee")),
            ],
            &builtin(),
        )
        .unwrap();
        let file = reparsed(&doc);
        assert_eq!(term_keys(&file), ["c", "a", "b", "d"]);
        assert_eq!(term_say(&file, "a"), "alpha");
        assert_eq!(term_say(&file, "d"), "dee");
    }

    #[test]
    fn todays_owner_file_round_trips() {
        for owner in [
            r#"{"version":1,"extensions":{"md":"M D"}}"#,
            r#"{"version":1,"extensions":{"md":"M D"},"acronyms":["Cli","cli"]}"#,
        ] {
            let mut doc = document(owner);
            let json_off = Edit::SetEnabled {
                id: EntryId {
                    origin: Origin::Builtin,
                    entry: entry(Section::Extension, None, "json"),
                },
                enabled: false,
            };
            doc.apply(&[json_off], &builtin()).unwrap();
            let file = reparsed(&doc);
            assert_eq!(
                file.top.extensions.get("md").map(String::as_str),
                Some("M D")
            );
            assert_eq!(
                file.disabled()
                    .builtin
                    .extensions
                    .iter()
                    .collect::<Vec<_>>(),
                ["json"]
            );
            let expected_acronyms = value(&document(owner))["acronyms"].clone();
            assert_eq!(value(&doc)["acronyms"], expected_acronyms, "{owner}");
        }
    }

    #[test]
    fn builtin_entries_cannot_be_deleted() {
        let mut doc = document(r#"{"version":1,"extensions":{"md":"M D"}}"#);
        let before = json(&doc);
        let json_key = entry(Section::Extension, None, "json");
        assert_eq!(
            doc.apply(
                &[Edit::Delete {
                    entry: json_key.clone()
                }],
                &builtin()
            ),
            Err(EditError::NoSuchEntry(EntryId {
                origin: Origin::Owner,
                entry: json_key,
            }))
        );
        let absent = EntryId {
            origin: Origin::Builtin,
            entry: entry(Section::Extension, None, "wxyz"),
        };
        assert_eq!(
            doc.apply(
                &[Edit::SetEnabled {
                    id: absent.clone(),
                    enabled: false
                }],
                &builtin()
            ),
            Err(EditError::NoSuchEntry(absent))
        );
        assert_eq!(json(&doc), before);
    }

    #[test]
    fn reset_removes_the_owner_entry_and_the_builtin_switch() {
        let mut doc = document(
            r#"{"version":1,"extensions":{"json":"jay son","md":"M D"},
                "disabled":{"builtin":{"extensions":["json","sh"]}},
                "models":{"pocket-en":{"terms":{"kubectl":"kube cuddle"},
                  "disabled":{"builtin":{"terms":["kubectl"]}}}}}"#,
        );
        doc.apply(
            &[
                Edit::Reset {
                    entry: entry(Section::Extension, None, "json"),
                },
                Edit::Reset {
                    entry: entry(Section::Term, Some("pocket-en"), "kubectl"),
                },
            ],
            &builtin(),
        )
        .unwrap();
        let file = reparsed(&doc);
        assert!(!file.top.extensions.contains_key("json"));
        assert_eq!(
            file.top.extensions.get("md").map(String::as_str),
            Some("M D")
        );
        assert_eq!(
            file.disabled()
                .builtin
                .extensions
                .iter()
                .collect::<Vec<_>>(),
            ["sh"]
        );
        let pocket = &file.models["pocket-en"];
        assert!(pocket.sections.terms.is_empty());
        assert!(pocket.disabled.builtin.terms.is_empty());
        let nothing = entry(Section::Extension, None, "rs");
        assert_eq!(
            doc.apply(
                &[Edit::Reset {
                    entry: nothing.clone()
                }],
                &builtin()
            ),
            Err(EditError::NoSuchEntry(EntryId {
                origin: Origin::Owner,
                entry: nothing,
            }))
        );
    }

    #[test]
    fn delete_removes_the_owner_entry_and_its_switch() {
        let mut doc = document(
            r#"{"version":1,"terms":{"c":"see","a":"ay"},"disabled":{"mine":{"terms":["c"]}}}"#,
        );
        doc.apply(
            &[Edit::Delete {
                entry: entry(Section::Term, None, "c"),
            }],
            &builtin(),
        )
        .unwrap();
        let file = reparsed(&doc);
        assert_eq!(term_keys(&file), ["a"]);
        assert!(file.disabled().mine.is_empty());
    }

    fn turn_on(model: &str, section: Section, key: &str) -> Edit {
        Edit::SetEnabled {
            id: EntryId {
                origin: Origin::Builtin,
                entry: entry(section, Some(model), key),
            },
            enabled: true,
        }
    }

    #[test]
    fn enabling_a_section_row_converts_an_orphan_top_level_switch() {
        let shipped = Vocabulary::builtin().builtin_file().clone();
        assert!(!contains(&shipped.top, Section::Acronym, "GPU"));
        let mut doc = document(r#"{"version":1,"disabled":{"builtin":{"acronyms":["GPU"]}}}"#);
        doc.apply(&[turn_on("pocket-en", Section::Acronym, "GPU")], &shipped)
            .expect("the Pocket GPU row exists");
        let file = reparsed(&doc);
        assert!(file.disabled().builtin.acronyms.is_empty());
        assert!(
            file.model_disabled("pocket-en")
                .is_none_or(|disabled| !disabled.builtin.acronyms.contains("GPU"))
        );
        for model in ["indic-tiny-hi", "indic-tiny-pa"] {
            let acronyms: Vec<&str> = file
                .model_disabled(model)
                .map(|disabled| {
                    disabled
                        .builtin
                        .acronyms
                        .iter()
                        .map(String::as_str)
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(acronyms, ["GPU"], "{model}");
        }
    }

    #[test]
    fn a_top_level_switch_with_a_top_level_row_is_left_alone() {
        let shipped = Vocabulary::builtin().builtin_file().clone();
        assert!(contains(&shipped.top, Section::Symbol, "/"));
        let mut doc = document(r#"{"version":1,"disabled":{"builtin":{"symbols":["/"]}}}"#);
        doc.apply(&[turn_on("indic-tiny-hi", Section::Symbol, "/")], &shipped)
            .expect("the Hindi slash row exists");
        let file = reparsed(&doc);
        assert_eq!(
            file.disabled()
                .builtin
                .symbols
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["/"]
        );
        assert!(
            file.model_disabled("indic-tiny-pa")
                .is_none_or(|disabled| disabled.builtin.symbols.is_empty())
        );
    }

    #[test]
    fn switches_act_at_the_entry_scope() {
        let mut doc = document(r#"{"version":1,"symbols":{"/":"stroke"}}"#);
        doc.apply(
            &[
                Edit::SetEnabled {
                    id: EntryId {
                        origin: Origin::Owner,
                        entry: entry(Section::Symbol, None, "/"),
                    },
                    enabled: false,
                },
                Edit::SetEnabled {
                    id: EntryId {
                        origin: Origin::Builtin,
                        entry: entry(Section::Acronym, Some("pocket-en"), "GPU"),
                    },
                    enabled: false,
                },
            ],
            &builtin(),
        )
        .expect_err("GPU is a top-level built-in acronym, not one in models.pocket-en");
        doc.apply(
            &[
                Edit::SetEnabled {
                    id: EntryId {
                        origin: Origin::Owner,
                        entry: entry(Section::Symbol, None, "/"),
                    },
                    enabled: false,
                },
                Edit::SetEnabled {
                    id: EntryId {
                        origin: Origin::Builtin,
                        entry: entry(Section::Acronym, None, "GPU"),
                    },
                    enabled: false,
                },
            ],
            &builtin(),
        )
        .unwrap();
        let file = reparsed(&doc);
        assert_eq!(
            file.disabled().mine.symbols.iter().collect::<Vec<_>>(),
            ["/"]
        );
        assert_eq!(
            file.disabled().builtin.acronyms.iter().collect::<Vec<_>>(),
            ["GPU"]
        );
        doc.apply(
            &[Edit::SetEnabled {
                id: EntryId {
                    origin: Origin::Owner,
                    entry: entry(Section::Symbol, None, "/"),
                },
                enabled: true,
            }],
            &builtin(),
        )
        .unwrap();
        assert!(reparsed(&doc).disabled().mine.is_empty());
    }

    #[test]
    fn put_with_a_previous_key_replaces_that_entry() {
        let mut doc = document(r#"{"version":1,"terms":{"kubctl":"kube control","x":"ex"}}"#);
        doc.apply(
            &[Edit::Put {
                entry: entry(Section::Term, None, "kubectl"),
                rule: say("kube control"),
                previous: Some(entry(Section::Term, None, "kubctl")),
            }],
            &builtin(),
        )
        .unwrap();
        assert_eq!(term_keys(&reparsed(&doc)), ["x", "kubectl"]);
    }

    #[test]
    fn invalid_edits_change_nothing() {
        let mut doc = document(r#"{"version":1,"extensions":{"md":"M D"}}"#);
        let before = json(&doc);
        let result = doc.apply(
            &[
                put(Section::Term, "d", say("dee")),
                put(Section::Extension, "md", say("M/D")),
            ],
            &builtin(),
        );
        assert!(
            matches!(result, Err(EditError::Invalid(_))),
            "got {result:?}"
        );
        assert_eq!(json(&doc), before);
    }

    #[test]
    fn keys_are_normalised_or_refused() {
        let mut doc = OwnerDocument::empty();
        doc.apply(&[put(Section::Extension, ".MD", say("M D"))], &builtin())
            .unwrap();
        assert_eq!(value(&doc)["extensions"], serde_json::json!({"md": "M D"}));
        for (section, key) in [
            (Section::Symbol, "->"),
            (Section::Term, "two words"),
            (Section::Term, ""),
            (Section::Extension, "."),
            (Section::Acronym, "C-L"),
        ] {
            let result = doc.apply(&[put(section, key, say("x"))], &builtin());
            assert!(
                matches!(&result, Err(EditError::InvalidKey { key: bad, .. }) if bad == key),
                "{section:?} {key:?} gave {result:?}"
            );
        }
    }

    #[test]
    fn acronym_keys_keep_virama_and_nukta() {
        let mut doc = OwnerDocument::empty();
        doc.apply(
            &[
                put(Section::Acronym, "\u{915}\u{94d}\u{937}", say("x")),
                put(Section::Acronym, "\u{a16}\u{a3c}", say("x")),
            ],
            &builtin(),
        )
        .unwrap();
        assert_eq!(
            value(&doc)["acronyms"],
            serde_json::json!(["\u{915}\u{94d}\u{937}", "\u{a16}\u{a3c}"])
        );
    }

    #[test]
    fn skip_and_match_options_serialize() {
        let mut doc = OwnerDocument::empty();
        doc.apply(
            &[
                put(
                    Section::Term,
                    "ABC-123",
                    Rule {
                        say: None,
                        matching: None,
                        case: Some(false),
                    },
                ),
                put(Section::Term, "kubectl", say("kube control")),
                put(
                    Section::Term,
                    "foo",
                    Rule {
                        say: Some("fu".into()),
                        matching: Some(TermMatch::Prefix),
                        case: Some(true),
                    },
                ),
            ],
            &builtin(),
        )
        .unwrap();
        let terms = &value(&doc)["terms"];
        assert_eq!(
            terms["ABC-123"],
            serde_json::json!({"skip": true, "case": false})
        );
        assert_eq!(terms["kubectl"], serde_json::json!("kube control"));
        assert_eq!(
            terms["foo"],
            serde_json::json!({"say": "fu", "match": "prefix"})
        );
    }

    #[test]
    fn acronym_style_is_set_and_cleared_per_scope() {
        let set = |model: Option<&str>, style| Edit::SetAcronymStyle {
            model: model.map(str::to_string),
            style,
        };
        let mut doc = document(r#"{"version":1,"extensions":{"md":"M D"}}"#);
        doc.apply(
            &[
                set(None, Some(AcronymStyle::Capitals)),
                set(Some("pocket-en"), Some(AcronymStyle::Spaced)),
            ],
            &builtin(),
        )
        .unwrap();
        let saved = value(&doc);
        assert_eq!(saved["acronym_style"], "capitals");
        assert_eq!(saved["models"]["pocket-en"]["acronym_style"], "spaced");
        assert_eq!(saved["extensions"]["md"], "M D");
        doc.apply(
            &[set(Some("pocket-en"), None), set(Some("phonon-x"), None)],
            &builtin(),
        )
        .unwrap();
        let cleared = value(&doc);
        assert_eq!(cleared["acronym_style"], "capitals");
        assert!(
            cleared["models"]["pocket-en"]
                .get("acronym_style")
                .is_none()
        );
        assert!(cleared["models"].get("phonon-x").is_none());
    }

    #[test]
    fn other_sections_survive_an_edit() {
        let owner = r#"{"version":1,"acronym_style":"capitals",
            "examples":[{"text":"notes.md","spoken":"notes dot M D","model":"pocket-en"}],
            "acronyms":["ZFS","Cli"],
            "models":{"phonon-x":{"symbols":{"~":"tilde"},"acronym_style":"spaced"}}}"#;
        let mut doc = document(owner);
        doc.apply(&[put(Section::Extension, "md", say("M D"))], &builtin())
            .unwrap();
        let saved = value(&doc);
        let original = value(&document(owner));
        for section in ["acronym_style", "examples", "acronyms", "models"] {
            assert_eq!(saved[section], original[section], "{section}");
        }
        assert_eq!(saved["acronyms"], serde_json::json!(["ZFS", "Cli"]));
        assert_eq!(saved["version"], serde_json::json!(1));
    }
}
