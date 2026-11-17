//! Turns an owner's edit of the spoken words into the smallest vocabulary rule that explains it.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    Edit, EntryKey, Rule, SENTENCE_PUNCTUATION, SENTINEL, Section, TechnicalOptions, Term,
    TermMatch, Vocabulary, VocabularyError, WRAPPERS, file_extension, is_spoken_letter,
    speak_technical, split_camel, split_line, split_token, validate_spoken,
};
use crate::text::prepare_written;

/// An owner's correction: the written text, the words it should say, the voice it was read with,
/// the scope to save at (`None` for all voices) and the match options for a term rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct CorrectionRequest {
    pub written: String,
    pub should_say: String,
    pub reading_model: String,
    pub scope: Option<String>,
    pub matching: Option<(TermMatch, bool)>,
}

/// Which written text a derived rule changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reach {
    /// Every file name with this extension.
    Extension { extension: String },
    /// This acronym wherever it is a word or identifier part.
    Acronym { acronym: String },
    /// This word or path segment wherever the term matches it.
    Term { term: String },
    /// This symbol inside every technical word.
    Symbol { symbol: String },
    /// Only this exact written text.
    ExactText { text: String },
}

/// A rule ready to save at the owner layer, with its reach and how its key now reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DerivedRule {
    pub entry: EntryKey,
    pub rule: Rule,
    pub reach: Reach,
    /// The entry's key spoken with the rule (`.md` reads "dot M D").
    pub preview: String,
}

impl DerivedRule {
    /// The owner-file edit that saves this rule.
    pub fn edit(&self) -> Edit {
        Edit::Put {
            entry: self.entry.clone(),
            rule: self.rule.clone(),
            previous: None,
        }
    }
}

/// The derived rule for an edit, the exact-text alternative when the rule reaches further, and
/// the spoken text before and after.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Derivation {
    pub spoken_before: String,
    pub rule: DerivedRule,
    pub exact: Option<DerivedRule>,
    pub spoken_after: String,
}

/// Why no rule was derived.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DeriveError {
    #[error("the spoken words are unchanged")]
    Unchanged,
    #[error("the change touches more than one written word; correct one word at a time")]
    SeveralWordsChanged,
    #[error("{0}")]
    Invalid(VocabularyError),
    #[error("no single vocabulary rule makes the text read this way")]
    NotExplained,
}

/// One written word of the text: where it starts in the source (UTF-16), the word as written
/// and the words it is spoken as.
struct Token {
    source_start: u32,
    written: String,
    words: Vec<String>,
}

/// Text prepared with technical reading on: the spoken text and its written words.
struct Reading {
    text: String,
    tokens: Vec<Token>,
}

impl Reading {
    fn words(&self) -> Vec<String> {
        self.tokens
            .iter()
            .flat_map(|token| token.words.iter().cloned())
            .collect()
    }
}

/// The words of spoken text, without the punctuation and brackets around each word.
fn spoken_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.trim_matches(|c| SENTENCE_PUNCTUATION.contains(&c) || WRAPPERS.contains(&c))
        })
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// The part of `text` between two UTF-16 offsets.
fn utf16_slice(text: &str, start: u32, end: u32) -> &str {
    let mut units = 0_u32;
    let mut from = text.len();
    let mut to = text.len();
    for (byte, c) in text.char_indices() {
        if units == start {
            from = byte;
        }
        if units == end {
            to = byte;
            break;
        }
        units += u32::try_from(c.len_utf16()).unwrap_or(2);
    }
    text.get(from..to).unwrap_or("")
}

/// `written` read with technical reading on against `vocabulary` resolved for `model`; the
/// parts of a word split across chunks join into one token.
fn read(
    written: &str,
    vocabulary: &Vocabulary,
    model: &str,
    options: &TechnicalOptions,
) -> Option<Reading> {
    let resolved = Arc::new(vocabulary.for_model(model));
    let chunks = prepare_written(written, false, Some(resolved), *options).ok()?;
    let mut tokens: Vec<Token> = Vec::new();
    let mut previous_end = None;
    for (aligned, words) in &chunks {
        for (span, word) in aligned.words.iter().zip(words) {
            let spoken = spoken_words(utf16_slice(
                &aligned.chunk.text,
                span.spoken_start,
                span.spoken_end,
            ));
            match tokens.last_mut() {
                Some(last) if previous_end == Some(span.source_start) && last.written == *word => {
                    last.words.extend(spoken);
                }
                _ => tokens.push(Token {
                    source_start: span.source_start,
                    written: word.clone(),
                    words: spoken,
                }),
            }
            previous_end = Some(span.source_end);
        }
    }
    let text = chunks
        .iter()
        .map(|(aligned, _)| aligned.chunk.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    Some(Reading { text, tokens })
}

/// `vocabulary` with one more owner entry at `scope`, set as `OwnerDocument` would set it.
fn with_entry(
    vocabulary: &Vocabulary,
    scope: Option<&str>,
    section: Section,
    key: &str,
    rule: &Rule,
) -> Result<Vocabulary, VocabularyError> {
    let mut owner = vocabulary.owner.clone().unwrap_or_default();
    let sections = match scope {
        None => &mut owner.top,
        Some(id) => &mut owner.models.entry(id.to_string()).or_default().sections,
    };
    let say = rule.say.clone().unwrap_or_default();
    match section {
        Section::Symbol => {
            validate_spoken(key, "symbol", &say, false)?;
            sections.symbols.insert(key.to_string(), say);
        }
        Section::Extension => {
            validate_spoken(key, "extension", &say, false)?;
            sections.extensions.insert(key.to_lowercase(), say);
        }
        Section::Term => {
            let term = Term::new(
                key,
                say,
                rule.matching.unwrap_or_default(),
                rule.case.unwrap_or(true),
            )?;
            match sections
                .terms
                .iter_mut()
                .find(|(existing, _)| existing == key)
            {
                Some(existing) => existing.1 = term,
                None => sections.terms.push((key.to_string(), term)),
            }
        }
        Section::Acronym => {
            sections.acronyms.insert(key.to_string());
        }
    }
    Ok(Vocabulary::from_layers(
        vocabulary.builtin.clone(),
        Some(owner),
    ))
}

/// A rule to try: its section and key, and what it reaches.
struct Candidate {
    section: Section,
    key: String,
    reach: Reach,
}

/// The rules that could explain a change to the word `core`, smallest first: its extension, each
/// identifier run as an acronym, each path segment and identifier run as a term, each symbol.
fn candidates(core: &str, vocabulary: &Vocabulary) -> Vec<Candidate> {
    let mut list: Vec<Candidate> = Vec::new();
    let mut add = |section: Section, key: &str, reach: Reach| {
        if !list.iter().any(|c| c.section == section && c.key == key) {
            list.push(Candidate {
                section,
                key: key.to_string(),
                reach,
            });
        }
    };
    if let Some((_, extension)) = file_extension(split_line(core, vocabulary).0, vocabulary) {
        let extension = extension.to_lowercase();
        add(
            Section::Extension,
            &extension,
            Reach::Extension {
                extension: extension.clone(),
            },
        );
    }
    let runs = |text: &'_ str| -> Vec<String> {
        text.split(|c: char| !is_spoken_letter(c))
            .filter(|run| !run.is_empty())
            .flat_map(split_camel)
            .map(str::to_string)
            .collect()
    };
    for run in runs(core) {
        add(
            Section::Acronym,
            &run,
            Reach::Acronym {
                acronym: run.clone(),
            },
        );
    }
    for segment in core.split('/').filter(|segment| !segment.is_empty()) {
        if core.contains('/') {
            add(
                Section::Term,
                segment,
                Reach::Term {
                    term: segment.to_string(),
                },
            );
        }
        for run in runs(segment) {
            add(Section::Term, &run, Reach::Term { term: run.clone() });
        }
    }
    for symbol in core.chars().filter(|c| !is_spoken_letter(*c)) {
        let symbol = symbol.to_string();
        add(
            Section::Symbol,
            &symbol,
            Reach::Symbol {
                symbol: symbol.clone(),
            },
        );
    }
    list
}

/// Everything a candidate is tried against.
struct Attempt<'a> {
    vocabulary: &'a Vocabulary,
    request: &'a CorrectionRequest,
    options: &'a TechnicalOptions,
    /// Where the changed written word starts in the source (UTF-16).
    token_start: u32,
    /// The words the whole text should say.
    wanted: Vec<String>,
    /// The words the changed written word should say.
    token_wanted: Vec<String>,
}

impl Attempt<'_> {
    /// The rule a candidate saves: a term takes the requested match options, the exact text is
    /// always a whole, case-sensitive term.
    fn rule(&self, candidate: &Candidate, say: Option<String>) -> Rule {
        let matching = match candidate.reach {
            Reach::Term { .. } => self.request.matching,
            _ => None,
        };
        Rule {
            say,
            matching: matching.map(|(matching, _)| matching),
            case: matching.map(|(_, case)| case),
        }
    }

    /// The value a candidate needs: the candidate says the sentinel at the highest layer, and the
    /// wanted words where the sentinel lands are the value. None when the sentinel never lands in
    /// the changed word or the wanted words cannot fill its places.
    fn value(&self, candidate: &Candidate) -> Result<Option<String>, VocabularyError> {
        let model = self.request.reading_model.as_str();
        let probe = self.rule(candidate, Some(SENTINEL.to_string()));
        let vocabulary = with_entry(
            self.vocabulary,
            Some(model),
            candidate.section,
            &candidate.key,
            &probe,
        )?;
        let Some(reading) = read(&self.request.written, &vocabulary, model, self.options) else {
            return Ok(None);
        };
        let Some(token) = reading
            .tokens
            .iter()
            .find(|t| t.source_start == self.token_start)
        else {
            return Ok(None);
        };
        let places = token.words.iter().filter(|word| *word == SENTINEL).count();
        let Some(first) = token.words.iter().position(|word| word == SENTINEL) else {
            return Ok(None);
        };
        let Some(spare) = self
            .token_wanted
            .len()
            .checked_sub(token.words.len() - places)
        else {
            return Ok(None);
        };
        if spare % places != 0 {
            return Ok(None);
        }
        Ok(self
            .token_wanted
            .get(first..first + spare / places)
            .map(|words| words.join(" ")))
    }

    /// The candidate as a rule when, saved at the request's scope, it makes the text say the
    /// wanted words; with the spoken text it then gives.
    fn verified(
        &self,
        candidate: &Candidate,
    ) -> Result<Option<(DerivedRule, String)>, VocabularyError> {
        let say = match candidate.section {
            Section::Acronym => None,
            _ => match self.value(candidate)? {
                None => return Ok(None),
                Some(value) if value.is_empty() => match candidate.reach {
                    Reach::ExactText { .. } => None,
                    _ => return Ok(None),
                },
                Some(value) => Some(value),
            },
        };
        let rule = self.rule(candidate, say);
        let model = self.request.reading_model.as_str();
        let scope = self.request.scope.as_deref();
        let vocabulary = with_entry(
            self.vocabulary,
            scope,
            candidate.section,
            &candidate.key,
            &rule,
        )?;
        let Some(after) = read(&self.request.written, &vocabulary, model, self.options) else {
            return Ok(None);
        };
        if after.words() != self.wanted {
            return Ok(None);
        }
        let preview = match candidate.section {
            Section::Extension => speak_technical(
                &format!(".{}", candidate.key),
                &vocabulary.for_model(model),
                self.options,
            ),
            Section::Acronym => {
                speak_technical(&candidate.key, &vocabulary.for_model(model), self.options)
            }
            Section::Symbol | Section::Term => rule.say.clone().unwrap_or_default(),
        };
        let derived = DerivedRule {
            entry: EntryKey {
                section: candidate.section,
                model: self.request.scope.clone(),
                key: candidate.key.clone(),
            },
            rule,
            reach: candidate.reach.clone(),
            preview,
        };
        Ok(Some((derived, after.text)))
    }
}

/// What a read says for `written` on `model` once `rule` is saved, prepared the way a correction
/// is derived; `None` when the rule cannot be added or the text cannot be prepared.
pub fn spoken_with(
    vocabulary: &Vocabulary,
    written: &str,
    rule: &DerivedRule,
    model: &str,
    options: &TechnicalOptions,
) -> Option<String> {
    let vocabulary = with_entry(
        vocabulary,
        rule.entry.model.as_deref(),
        rule.entry.section,
        &rule.entry.key,
        &rule.rule,
    )
    .ok()?;
    read(written, &vocabulary, model, options).map(|reading| reading.text)
}

/// Derives the smallest rule that makes `request.written` read as `request.should_say` on
/// `request.reading_model`. The changed words must all belong to one written word; for it the
/// rules are tried smallest first (see `candidates`) and the first that, saved at the owner
/// layer of `request.scope`, makes the whole text say the wanted words is the rule. The
/// exact-text term is the fallback and, when the rule reaches further, the alternative.
pub fn derive(
    vocabulary: &Vocabulary,
    request: &CorrectionRequest,
    options: &TechnicalOptions,
) -> Result<Derivation, DeriveError> {
    let model = request.reading_model.as_str();
    let before =
        read(&request.written, vocabulary, model, options).ok_or(DeriveError::NotExplained)?;
    let spoken = before.words();
    let wanted = spoken_words(&request.should_say);
    if spoken == wanted {
        return Err(DeriveError::Unchanged);
    }
    let prefix = spoken
        .iter()
        .zip(&wanted)
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = spoken
        .iter()
        .rev()
        .zip(wanted.iter().rev())
        .take(spoken.len().min(wanted.len()) - prefix)
        .take_while(|(a, b)| a == b)
        .count();
    let changed_end = spoken.len() - suffix;
    let mut start = 0;
    let mut changed: Option<(&Token, std::ops::Range<usize>)> = None;
    for token in &before.tokens {
        let range = start..start + token.words.len();
        start = range.end;
        let holds = range.start <= prefix && changed_end <= range.end;
        if holds
            && changed
                .as_ref()
                .is_none_or(|(_, best)| range.len() < best.len())
        {
            changed = Some((token, range));
        }
    }
    let (token, range) = changed.ok_or(DeriveError::SeveralWordsChanged)?;
    let core = split_token(&token.written).core;
    let attempt = Attempt {
        vocabulary,
        request,
        options,
        token_start: token.source_start,
        token_wanted: wanted[range.start..wanted.len() - (spoken.len() - range.end)].to_vec(),
        wanted,
    };
    let exact = Candidate {
        section: Section::Term,
        key: core.to_string(),
        reach: Reach::ExactText {
            text: core.to_string(),
        },
    };
    let mut invalid = None;
    let mut found = None;
    if !core.is_empty() {
        for candidate in candidates(core, &vocabulary.for_model(model))
            .iter()
            .chain([&exact])
        {
            match attempt.verified(candidate) {
                Ok(Some(result)) => {
                    found = Some(result);
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    invalid.get_or_insert(error);
                }
            }
        }
    }
    let Some((rule, spoken_after)) = found else {
        return Err(invalid.map_or(DeriveError::NotExplained, DeriveError::Invalid));
    };
    let exact = match rule.reach {
        Reach::ExactText { .. } => None,
        _ => attempt
            .verified(&exact)
            .ok()
            .flatten()
            .map(|(exact, _)| exact)
            .filter(|exact| (&exact.entry, &exact.rule) != (&rule.entry, &rule.rule)),
    };
    Ok(Derivation {
        spoken_before: before.text,
        rule,
        exact,
        spoken_after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vocabulary::{OwnerDocument, Section};

    fn request(written: &str, should_say: &str) -> CorrectionRequest {
        CorrectionRequest {
            written: written.to_string(),
            should_say: should_say.to_string(),
            reading_model: "pocket-en".to_string(),
            scope: None,
            matching: None,
        }
    }
    fn derived(written: &str, should_say: &str) -> Result<Derivation, DeriveError> {
        derive(
            &Vocabulary::builtin(),
            &request(written, should_say),
            &TechnicalOptions::default(),
        )
    }
    fn key(section: Section, model: Option<&str>, key: &str) -> EntryKey {
        EntryKey {
            section,
            model: model.map(str::to_string),
            key: key.to_string(),
        }
    }

    mod spoken_with {
        use super::*;

        fn zfs_acronym() -> DerivedRule {
            DerivedRule {
                entry: key(Section::Acronym, None, "ZFS"),
                rule: Rule {
                    say: None,
                    matching: None,
                    case: None,
                },
                reach: Reach::Acronym {
                    acronym: "ZFS".to_string(),
                },
                preview: "Z F S".to_string(),
            }
        }

        fn styled() -> Vocabulary {
            let owner = Vocabulary::parse(
                r#"{"version":1,"models":{"pocket-en":{"acronym_style":"capitals"},
                    "supertonic-3":{"acronym_style":"spaced"}}}"#,
            )
            .unwrap();
            Vocabulary::merged(&owner)
        }

        #[test]
        fn says_an_unsaved_acronym_in_each_voices_style() {
            let vocabulary = styled();
            let options = TechnicalOptions::default();
            let say = |written: &str, model: &str| {
                spoken_with(&vocabulary, written, &zfs_acronym(), model, &options)
            };
            assert_eq!(
                say("use ZFS now", "pocket-en").as_deref(),
                Some("use ZFS now.")
            );
            assert_eq!(
                say("use ZFS now", "supertonic-3").as_deref(),
                Some("use Z F S now.")
            );
            assert_eq!(say("ZFS", "pocket-en").as_deref(), Some("ZFS."));
            assert_eq!(say("ZFS", "supertonic-3").as_deref(), Some("Z F S."));
        }

        /// The rule a passed-only save writes for one voice: the checked rule with that scope.
        fn rescoped(rule: &DerivedRule, model: &str) -> DerivedRule {
            let mut scoped = rule.clone();
            scoped.entry.model = Some(model.to_string());
            scoped
        }

        #[test]
        fn a_rule_rescoped_to_a_passing_voice_reads_there_as_it_was_checked() {
            let vocabulary = styled();
            let options = TechnicalOptions::default();
            let all_voices = zfs_acronym();
            let pocket_only = rescoped(&all_voices, "pocket-en");
            let say = |rule: &DerivedRule, model: &str| {
                spoken_with(&vocabulary, "use ZFS now", rule, model, &options)
            };
            assert_eq!(
                say(&pocket_only, "pocket-en"),
                say(&all_voices, "pocket-en"),
                "the capitals voice reads what its check heard"
            );
            assert_eq!(
                say(&pocket_only, "pocket-en").as_deref(),
                Some("use ZFS now.")
            );
            assert_eq!(pocket_only.entry.section, Section::Acronym);
            assert_eq!(
                say(&pocket_only, "supertonic-3").as_deref(),
                Some("use ZFS now."),
                "a voice that did not pass gets no rule"
            );
        }
    }

    #[test]
    fn extension_edit_reaches_every_file_with_that_extension() {
        let derivation = derived("README.md", "README dot M D").unwrap();
        assert_eq!(derivation.spoken_before, "README dot markdown.");
        assert_eq!(derivation.spoken_after, "README dot M D.");
        let rule = derivation.rule;
        assert_eq!(rule.entry, key(Section::Extension, None, "md"));
        assert_eq!(rule.rule.say.as_deref(), Some("M D"));
        assert_eq!(
            rule.reach,
            Reach::Extension {
                extension: "md".to_string()
            }
        );
        assert_eq!(rule.preview, "dot M D");
        let exact = derivation.exact.expect("an exact-text alternative");
        assert_eq!(exact.entry, key(Section::Term, None, "README.md"));
        assert_eq!(exact.rule.say.as_deref(), Some("README dot M D"));
        assert_eq!(
            exact.reach,
            Reach::ExactText {
                text: "README.md".to_string()
            }
        );
    }

    #[test]
    fn extension_edit_with_a_line_suffix_keeps_extension_reach() {
        for (written, should_say) in [
            ("README.md:12", "README dot M D at line 12"),
            (
                "docs/README.md:12:3",
                "docs slash README dot M D at line 12 column 3",
            ),
        ] {
            let derivation = derived(written, should_say).unwrap();
            assert_eq!(
                derivation.rule.reach,
                Reach::Extension {
                    extension: "md".to_string()
                },
                "{written}"
            );
            assert_eq!(derivation.rule.rule.say.as_deref(), Some("M D"));
            assert_eq!(derivation.spoken_after, format!("{should_say}."));
            let exact = derivation.exact.expect("an exact-text alternative");
            assert_eq!(exact.entry, key(Section::Term, None, written));
        }
    }

    /// The owner file after saving `rule`, read for pocket-en.
    fn saved(rule: &DerivedRule) -> Vocabulary {
        let mut document = OwnerDocument::empty();
        document
            .apply(&[rule.edit()], Vocabulary::builtin().builtin_file())
            .unwrap();
        let file = Vocabulary::parse(&document.to_json().unwrap()).unwrap();
        Vocabulary::merged(&file).for_model("pocket-en")
    }

    #[test]
    fn exact_alternative_is_whole_even_when_matching_is_anywhere() {
        let anywhere = |written: &str, should_say: &str| CorrectionRequest {
            matching: Some((TermMatch::Anywhere, true)),
            ..request(written, should_say)
        };
        let options = TechnicalOptions::default();
        let builtin = Vocabulary::builtin().for_model("pocket-en");

        let derivation = derive(
            &Vocabulary::builtin(),
            &anywhere("README.md", "README dot M D"),
            &options,
        )
        .unwrap();
        let exact = derivation.exact.expect("an exact-text alternative");
        let vocabulary = saved(&exact);
        assert_eq!(
            speak_technical("README.md", &vocabulary, &options),
            "README dot M D"
        );
        assert_eq!(
            speak_technical("xREADME.md", &vocabulary, &options),
            speak_technical("xREADME.md", &builtin, &options)
        );

        let skip = derive(&Vocabulary::builtin(), &anywhere("ABC-123", ""), &options)
            .unwrap()
            .rule;
        assert_eq!(
            skip.reach,
            Reach::ExactText {
                text: "ABC-123".to_string()
            }
        );
        let vocabulary = saved(&skip);
        assert_eq!(speak_technical("ABC-123", &vocabulary, &options), "");
        assert_eq!(
            speak_technical("xABC-123", &vocabulary, &options),
            speak_technical("xABC-123", &builtin, &options)
        );
    }

    #[test]
    fn devanagari_marks_stay_inside_the_word() {
        for (written, should_say) in [
            ("\u{915}\u{94d}\u{937}\u{92e}\u{93e}", "kshama"),
            ("\u{91c}\u{93c}\u{930}\u{93e}", "zara"),
        ] {
            let derivation = derived(written, should_say).unwrap();
            assert_eq!(
                derivation.rule.reach,
                Reach::Term {
                    term: written.to_string()
                },
                "{written}"
            );
            assert_eq!(derivation.exact, None);
        }
    }

    #[test]
    fn spelled_out_word_is_an_acronym() {
        let rule = derived("ZFS", "Z F S").unwrap().rule;
        assert_eq!(rule.entry, key(Section::Acronym, None, "ZFS"));
        assert_eq!(
            rule.reach,
            Reach::Acronym {
                acronym: "ZFS".to_string()
            }
        );
    }

    #[test]
    fn changed_symbol_word_is_a_symbol() {
        let rule = derived("a/b", "a stroke b").unwrap().rule;
        assert_eq!(rule.entry, key(Section::Symbol, None, "/"));
        assert_eq!(rule.rule.say.as_deref(), Some("stroke"));
        assert_eq!(
            rule.reach,
            Reach::Symbol {
                symbol: "/".to_string()
            }
        );
    }

    #[test]
    fn whole_word_is_a_term_without_a_separate_exact_rule() {
        let derivation = derived("kubectl", "kube control").unwrap();
        assert_eq!(derivation.rule.entry, key(Section::Term, None, "kubectl"));
        assert_eq!(derivation.rule.rule.say.as_deref(), Some("kube control"));
        assert_eq!(
            derivation.rule.reach,
            Reach::Term {
                term: "kubectl".to_string()
            }
        );
        assert_eq!(derivation.exact, None);
    }

    #[test]
    fn emptied_word_is_an_exact_skip() {
        let rule = derived("ABC-123", "").unwrap().rule;
        assert_eq!(rule.entry, key(Section::Term, None, "ABC-123"));
        assert_eq!(rule.rule.say, None);
        assert_eq!(
            rule.reach,
            Reach::ExactText {
                text: "ABC-123".to_string()
            }
        );
    }

    #[test]
    fn emptied_whole_word_is_an_exact_skip_not_a_term() {
        let rule = derived("kubectl", "").unwrap().rule;
        assert_eq!(rule.entry, key(Section::Term, None, "kubectl"));
        assert_eq!(rule.rule.say, None);
        assert_eq!(
            rule.reach,
            Reach::ExactText {
                text: "kubectl".to_string()
            }
        );
    }

    #[test]
    fn skipped_word_can_be_spoken_again() {
        let file = Vocabulary::parse(r#"{"version":1,"terms":{"ABC-123":{"skip":true}}}"#)
            .expect("test vocabulary parses");
        let derivation = derive(
            &Vocabulary::merged(&file),
            &request("see ABC-123 now", "see A B C now"),
            &TechnicalOptions::default(),
        )
        .unwrap();
        assert_eq!(derivation.spoken_before, "see now.");
        assert_eq!(derivation.rule.entry, key(Section::Term, None, "ABC-123"));
        assert_eq!(derivation.rule.rule.say.as_deref(), Some("A B C"));
        assert_eq!(derivation.spoken_after, "see A B C now.");
    }

    #[test]
    fn change_across_two_words_is_refused() {
        assert_eq!(
            derived("see README.md now", "sea README dot M D now"),
            Err(DeriveError::SeveralWordsChanged)
        );
    }

    #[test]
    fn spoken_text_outside_the_output_contract_is_refused() {
        match derived("README.md", "README dot M/D") {
            Err(DeriveError::Invalid(VocabularyError::Pattern { message, .. })) => {
                assert!(message.contains("'/'"), "{message}");
            }
            other => panic!("expected an invalid edit, got {other:?}"),
        }
    }

    #[test]
    fn unchanged_words_are_refused() {
        assert_eq!(
            derived("README.md", "README dot markdown"),
            Err(DeriveError::Unchanged)
        );
    }

    #[test]
    fn scoped_rule_saves_for_that_voice() {
        let request = CorrectionRequest {
            scope: Some("pocket-en".to_string()),
            ..request("README.md", "README dot M D")
        };
        let rule = derive(
            &Vocabulary::builtin(),
            &request,
            &TechnicalOptions::default(),
        )
        .unwrap()
        .rule;
        let entry = key(Section::Extension, Some("pocket-en"), "md");
        assert_eq!(rule.entry, entry);
        assert_eq!(
            rule.edit(),
            Edit::Put {
                entry,
                rule: rule.rule.clone(),
                previous: None,
            }
        );
    }

    #[test]
    fn rule_masked_at_the_voice_falls_back_to_exact_text() {
        let file = Vocabulary::parse(
            r#"{"version":1,"models":{"pocket-en":{"extensions":{"md":"em dee"}}}}"#,
        )
        .expect("test vocabulary parses");
        let vocabulary = Vocabulary::merged(&file);
        let derivation = derive(
            &vocabulary,
            &request("README.md", "README dot M D"),
            &TechnicalOptions::default(),
        )
        .unwrap();
        assert_eq!(derivation.spoken_before, "README dot em dee.");
        assert_eq!(
            derivation.rule.reach,
            Reach::ExactText {
                text: "README.md".to_string()
            }
        );
        assert_eq!(derivation.exact, None);
    }
}
