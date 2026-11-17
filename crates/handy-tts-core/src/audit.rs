//! The built-in vocabulary audit: for one voice, a carrier sentence per entry spoken with the
//! entry's rule and with the raw text, a mechanical pass rule over what speech-to-text heard,
//! a majority decision per entry and a placement of every entry across the audited voices.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::roundtrip::normalise;
use crate::text::{TextError, prepare_reading};
use crate::vocabulary::{
    BUILTIN_JSON, Edit, EntryId, EntryKey, EntryRow, ExampleResult, Matching, Origin,
    OwnerDocument, Problem, Rule, Section, TechnicalOptions, Vocabulary, VocabularyFile,
    check_examples,
};

/// Whether a line speaks the carrier through the entry's rule or leaves the raw text to the voice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
    Rule,
    Raw,
}

/// One sentence to synthesize and transcribe. `id` names its audio file; `forms` are the
/// accepted forms the transcript is matched against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditLine {
    pub id: String,
    pub entry: EntryKey,
    pub origin: Origin,
    pub variant: Variant,
    pub run: u8,
    pub text: String,
    pub forms: Vec<String>,
}

/// The lines of one voice. `partial` is set when only some entries were selected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Corpus {
    pub model_id: String,
    pub partial: bool,
    pub runs: u8,
    pub lines: Vec<AuditLine>,
}

/// What one entry decides on one voice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// The raw text already survives the round trip: the rule is not needed.
    Redundant,
    /// The rule survives and the raw text does not.
    Needed,
    /// The rule itself does not survive the round trip.
    Defect,
    /// The recogniser cannot write the entry's forms, or the voice spelled both lines letter by
    /// letter, so nothing was decided; the entry keeps reaching this voice.
    NotAudited,
}

/// One transcribed line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heard {
    pub run: u8,
    pub heard: String,
    pub pass: bool,
}

/// Every run of one entry on one voice and the decision they give.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryResult {
    pub entry: EntryKey,
    pub origin: Origin,
    pub forms: Vec<String>,
    pub rule_text: String,
    pub raw_text: String,
    pub rule: Vec<Heard>,
    pub raw: Vec<Heard>,
    pub decision: Decision,
}

/// The audit of one voice, as stored between runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelResults {
    pub model_id: String,
    pub partial: bool,
    pub entries: Vec<EntryResult>,
}

/// Where an entry goes in the proposed built-in file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    /// Redundant on every voice it reaches.
    Removed,
    /// Needed on every voice it reaches.
    TopLevel,
    /// Needed on these voices only: one `models.<id>` entry each.
    Models(Vec<String>),
    /// A defect on some voice: left where it is.
    Kept,
}

/// The place of every audited entry.
pub type Placement = BTreeMap<EntryId, Place>;

/// The proposed built-in file and the examples it fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub json: String,
    pub failures: Vec<ExampleResult>,
}

/// The fixed sentence an entry is heard in. Each is a token technical reading reads through its
/// rules: a symbol inside a flag (`~` reads as home only as a whole segment, here a flag value),
/// and an acronym both in capitals and as the lowercase piece of a hyphenated word.
pub fn carrier(section: Section, key: &str) -> String {
    match section {
        Section::Extension => format!("Open the file notes.{key} now."),
        Section::Term => format!("Then run {key} again."),
        Section::Acronym => format!(
            "The {key} is ready, and the {}-tool too.",
            key.to_lowercase()
        ),
        Section::Symbol if key == "~" => format!("Run --alpha={key} now."),
        Section::Symbol => format!("Run --alpha{key}beta now."),
    }
}

/// How many times the carrier holds the entry, each of which must be heard.
fn mentions(section: Section) -> usize {
    match section {
        Section::Acronym => 2,
        Section::Extension | Section::Term | Section::Symbol => 1,
    }
}

/// The forms a transcript may hold for the entry to count as heard: the written key without a
/// leading dot, its letters and digits spelled one by one, and the rule's spoken form. Forms
/// that normalise to no words, or to the words of an earlier form, are left out.
pub fn accepted_forms(section: Section, key: &str, spoken: &str) -> Vec<String> {
    let written = match section {
        Section::Extension => key.strip_prefix('.').unwrap_or(key),
        Section::Symbol | Section::Term | Section::Acronym => key,
    };
    let spelled = written
        .chars()
        .filter(|c| c.is_alphanumeric())
        .map(String::from)
        .collect::<Vec<_>>()
        .join(" ");
    let mut seen: Vec<Vec<String>> = Vec::new();
    let mut forms = Vec::new();
    for form in [written.to_string(), spelled, spoken.to_string()] {
        let words = normalise(&form);
        if words.is_empty() || seen.contains(&words) {
            continue;
        }
        seen.push(words);
        forms.push(form);
    }
    forms
}

/// True when the row's entry applies to a read on `model_id`: switched on, not shadowed by a
/// higher layer, and at the top level or in `models.<model_id>`.
fn reaches(row: &EntryRow, model_id: &str) -> bool {
    row.enabled
        && !row
            .problems
            .iter()
            .any(|problem| matches!(problem, Problem::Shadowed { .. }))
        && row
            .id
            .entry
            .model
            .as_deref()
            .is_none_or(|model| model == model_id)
}

/// `text` prepared with technical reading on against `vocabulary`, chunks joined with a space.
fn prepared(text: &str, vocabulary: &Arc<Vocabulary>) -> Result<String, TextError> {
    let chunks = prepare_reading(
        text,
        false,
        Some(Arc::clone(vocabulary)),
        TechnicalOptions::default(),
    )?;
    Ok(chunks
        .into_iter()
        .map(|aligned| aligned.chunk.text)
        .collect::<Vec<_>>()
        .join(" "))
}

/// The lines that audit `model_id`: `runs` rule lines and `runs` raw lines for every enabled,
/// unshadowed built-in entry that reaches the model (top level and `models.<model_id>`) and
/// every candidate entry. A rule line is the carrier prepared with technical reading on against
/// the built-in vocabulary, with the candidates as the layer above it, resolved for the model;
/// a raw line is the same carrier prepared with that entry switched off at its own scope, which
/// is what the voice gets when the entry is gone.
pub fn audit_lines(
    builtin: &Vocabulary,
    candidates: Option<&VocabularyFile>,
    model_id: &str,
    runs: u8,
) -> Result<Vec<AuditLine>, TextError> {
    let vocabulary = match candidates {
        Some(file) => Vocabulary::merge_onto(builtin.clone(), file),
        None => builtin.clone(),
    };
    let resolved = Arc::new(vocabulary.for_model(model_id));
    let mut lines = Vec::new();
    let rows = vocabulary.rows(&[model_id]);
    for (index, row) in rows.iter().filter(|row| reaches(row, model_id)).enumerate() {
        let EntryKey { section, key, .. } = &row.id.entry;
        let sentence = carrier(*section, key);
        let rule = prepared(&sentence, &resolved)?;
        let without = Arc::new(vocabulary.switched_off(&row.id).for_model(model_id));
        let raw = prepared(&sentence, &without)?;
        let forms = accepted_forms(*section, key, &row.spoken);
        for (variant, name, text) in [(Variant::Rule, "rule", &rule), (Variant::Raw, "raw", &raw)] {
            for run in 1..=runs {
                lines.push(AuditLine {
                    id: format!("{index:03}-{name}-{run}"),
                    entry: row.id.entry.clone(),
                    origin: row.id.origin,
                    variant,
                    run,
                    text: text.clone(),
                    forms: forms.clone(),
                });
            }
        }
    }
    Ok(lines)
}

/// The majority of each variant decides: a failing rule is a defect, a passing raw reading makes
/// the rule redundant, otherwise the rule is needed.
pub fn decide(rule: &[bool], raw: &[bool]) -> Decision {
    let majority = |runs: &[bool]| runs.iter().filter(|pass| **pass).count() * 2 > runs.len();
    if !majority(rule) {
        Decision::Defect
    } else if majority(raw) {
        Decision::Redundant
    } else {
        Decision::Needed
    }
}

/// True when every form is written in ASCII letters, the only ones the recogniser writes.
fn recognisable(forms: &[String]) -> bool {
    forms
        .iter()
        .all(|form| form.chars().all(|c| c.is_ascii() || !c.is_alphabetic()))
}

/// True when most words of a transcript are single letters: the voice spelled the line out.
fn spelled(heard: &str) -> bool {
    let words: Vec<&str> = heard
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let letters = words
        .iter()
        .filter(|word| word.chars().count() == 1)
        .count();
    words.len() >= 4 && letters * 4 >= words.len() * 3
}

/// The transcript in lowercase words with a `.` between letters or digits written as "dot" and
/// `tail` split off the word after it: Parakeet writes "notes dot C now" as "notes.cnow".
fn unglued(heard: &str, tail: &str) -> String {
    let chars: Vec<char> = heard.to_lowercase().chars().collect();
    let mut spaced = String::new();
    for (index, &c) in chars.iter().enumerate() {
        let joins = c == '.'
            && index > 0
            && chars[index - 1].is_alphanumeric()
            && chars
                .get(index + 1)
                .is_some_and(|next| next.is_alphanumeric());
        if joins {
            spaced.push_str(" dot ");
        } else {
            spaced.push(c);
        }
    }
    let mut words: Vec<&str> = Vec::new();
    for word in spaced
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        let glued = words.last() == Some(&"dot") && word.len() > tail.len() && word.ends_with(tail);
        if glued {
            words.push(&word[..word.len() - tail.len()]);
            words.push(tail);
        } else {
            words.push(word);
        }
    }
    words.join(" ")
}

/// How many times `form` appears, as whole consecutive normalised words, in `heard`.
fn occurrences(heard: &str, form: &str) -> usize {
    let heard = normalise(heard);
    let form = normalise(form);
    if form.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut index = 0;
    while index + form.len() <= heard.len() {
        if heard[index..index + form.len()] == form[..] {
            count += 1;
            index += form.len();
        } else {
            index += 1;
        }
    }
    count
}

/// True when the transcript holds an accepted form once for every time the carrier holds the
/// entry, as heard or with Parakeet's glued "dot" undone.
fn heard_entry(line: &AuditLine, heard: &str) -> bool {
    let sentence = carrier(line.entry.section, &line.entry.key).to_lowercase();
    let tail = sentence
        .split(|c: char| !c.is_alphanumeric())
        .rfind(|word| !word.is_empty())
        .unwrap_or_default();
    let adjusted = unglued(heard, tail);
    let needed = mentions(line.entry.section);
    line.forms
        .iter()
        .any(|form| occurrences(heard, form) >= needed || occurrences(&adjusted, form) >= needed)
}

/// Transcribes every line of `corpus` with `transcribe` and decides each entry. An entry with a
/// form outside ASCII letters is not audited and not transcribed: the recogniser (Parakeet)
/// writes Latin script only. An entry whose rule and raw lines are both mostly spelled out
/// letter by letter is not audited either: the voice reads that script as letters whatever the
/// rule says.
pub fn score<E>(
    corpus: &Corpus,
    mut transcribe: impl FnMut(&AuditLine) -> Result<String, E>,
) -> Result<ModelResults, E> {
    let mut entries: Vec<EntryResult> = Vec::new();
    for line in &corpus.lines {
        let index = match entries
            .iter()
            .position(|entry| entry.entry == line.entry && entry.origin == line.origin)
        {
            Some(index) => index,
            None => {
                entries.push(EntryResult {
                    entry: line.entry.clone(),
                    origin: line.origin,
                    forms: line.forms.clone(),
                    rule_text: String::new(),
                    raw_text: String::new(),
                    rule: Vec::new(),
                    raw: Vec::new(),
                    decision: Decision::NotAudited,
                });
                entries.len() - 1
            }
        };
        let entry = &mut entries[index];
        match line.variant {
            Variant::Rule => entry.rule_text.clone_from(&line.text),
            Variant::Raw => entry.raw_text.clone_from(&line.text),
        }
        if !recognisable(&line.forms) {
            continue;
        }
        let heard = transcribe(line)?;
        let pass = heard_entry(line, &heard);
        let heard = Heard {
            run: line.run,
            heard,
            pass,
        };
        match line.variant {
            Variant::Rule => entry.rule.push(heard),
            Variant::Raw => entry.raw.push(heard),
        }
    }
    for entry in &mut entries {
        if recognisable(&entry.forms) {
            let passes = |runs: &[Heard]| runs.iter().map(|heard| heard.pass).collect::<Vec<_>>();
            let spelled_out = |runs: &[Heard]| {
                runs.iter().filter(|heard| spelled(&heard.heard)).count() * 2 > runs.len()
            };
            entry.decision = if spelled_out(&entry.rule) && spelled_out(&entry.raw) {
                Decision::NotAudited
            } else {
                decide(&passes(&entry.rule), &passes(&entry.raw))
            };
        }
    }
    Ok(ModelResults {
        model_id: corpus.model_id.clone(),
        partial: corpus.partial,
        entries,
    })
}

/// The decisions of each voice, by model id.
pub fn decisions(results: &[ModelResults]) -> BTreeMap<String, BTreeMap<EntryId, Decision>> {
    results
        .iter()
        .map(|model| {
            let entries = model
                .entries
                .iter()
                .map(|entry| {
                    let id = EntryId {
                        origin: entry.origin,
                        entry: entry.entry.clone(),
                    };
                    (id, entry.decision)
                })
                .collect();
            (model.model_id.clone(), entries)
        })
        .collect()
}

/// Places every entry decided on any of `models`. An entry reaches the voices that decided it;
/// a defect on any of them keeps it where it is; otherwise, counting a voice it was not audited
/// on as one that needs it, it is removed when no voice needs it, stays at (or goes to) the top
/// level when a top-level entry is needed on every voice it reaches, and goes to `models.<id>` of
/// each voice that needs it otherwise.
/// Fails naming every model in `models` that has no results.
pub fn place(
    decisions: &BTreeMap<String, BTreeMap<EntryId, Decision>>,
    models: &[&str],
) -> Result<Placement, String> {
    let missing: Vec<&str> = models
        .iter()
        .copied()
        .filter(|model| !decisions.contains_key(*model))
        .collect();
    if !missing.is_empty() {
        return Err(format!("no audit results for {}", missing.join(", ")));
    }
    let mut by_entry: BTreeMap<&EntryId, Vec<(&str, Decision)>> = BTreeMap::new();
    for model in models {
        for (id, decision) in &decisions[*model] {
            by_entry.entry(id).or_default().push((model, *decision));
        }
    }
    let mut placement = Placement::new();
    for (id, reached) in by_entry {
        let undecided = reached
            .iter()
            .any(|(_, decision)| *decision == Decision::Defect);
        let needed: Vec<String> = reached
            .iter()
            .filter(|(_, decision)| matches!(decision, Decision::Needed | Decision::NotAudited))
            .map(|(model, _)| model.to_string())
            .collect();
        let place = if undecided {
            Place::Kept
        } else if needed.is_empty() {
            Place::Removed
        } else if id.entry.model.is_none() && needed.len() == reached.len() {
            Place::TopLevel
        } else {
            Place::Models(needed)
        };
        placement.insert(id.clone(), place);
    }
    Ok(placement)
}

/// The rule an editor save would write for the row's entry.
fn rule(row: &EntryRow) -> Rule {
    let (matching, case) = match row.matching {
        Matching::Term { matching, case } => (Some(matching), Some(case)),
        Matching::Extension | Matching::Symbol | Matching::Acronym => (None, None),
    };
    let say = (!row.skip && row.id.entry.section != Section::Acronym).then(|| row.spoken.clone());
    Rule {
        say,
        matching,
        case,
    }
}

/// The built-in file with `placement` applied (written through `OwnerDocument`), and the
/// examples it fails. Candidate entries come from `candidates`. The audit read candidates above
/// every built-in layer, so a candidate placed at the top level also replaces the built-in
/// `models.<id>` entries with its section and key. A candidate term joins a built-in layer,
/// where whole terms apply before partial ones; `reading_changes` reports any audited line the
/// proposal reads differently.
pub fn proposal(
    placement: &Placement,
    candidates: Option<&VocabularyFile>,
) -> Result<Proposal, String> {
    let builtin = Vocabulary::builtin();
    let mut rows = builtin.rows(&[]);
    if let Some(file) = candidates {
        rows.extend(
            Vocabulary::merge_onto(builtin.clone(), file)
                .rows(&[])
                .into_iter()
                .filter(|row| row.id.origin == Origin::Owner),
        );
    }
    let mut edits = Vec::new();
    for (id, place) in placement {
        let targets: Vec<Option<String>> = match place {
            Place::Kept => continue,
            Place::Removed => Vec::new(),
            Place::TopLevel => vec![None],
            Place::Models(models) => models.iter().cloned().map(Some).collect(),
        };
        let row = rows
            .iter()
            .find(|row| row.id == *id)
            .ok_or_else(|| format!("no vocabulary entry {id:?}"))?;
        if id.origin == Origin::Builtin {
            if targets == [id.entry.model.clone()] {
                continue;
            }
            edits.push(Edit::Delete {
                entry: id.entry.clone(),
            });
        }
        if id.origin == Origin::Owner && targets.contains(&None) {
            edits.extend(
                rows.iter()
                    .filter(|other| {
                        other.id.origin == Origin::Builtin
                            && other.id.entry.model.is_some()
                            && other.id.entry.section == id.entry.section
                            && other.id.entry.key == id.entry.key
                            && !placement.contains_key(&other.id)
                    })
                    .map(|other| Edit::Delete {
                        entry: other.id.entry.clone(),
                    }),
            );
        }
        for model in targets {
            edits.push(Edit::Put {
                entry: EntryKey {
                    model,
                    ..id.entry.clone()
                },
                rule: rule(row),
                previous: None,
            });
        }
    }
    let mut document = OwnerDocument::parse(BUILTIN_JSON).map_err(|error| error.to_string())?;
    document
        .apply(&edits, builtin.builtin_file())
        .map_err(|error| error.to_string())?;
    let json = document.to_json().map_err(|error| error.to_string())?;
    let file = Vocabulary::parse(&json).map_err(|error| error.to_string())?;
    Ok(Proposal {
        failures: check_examples(&Vocabulary::from_file(&file)),
        json,
    })
}

/// An audited carrier line the proposed file reads differently from the audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadingChange {
    pub model_id: String,
    pub entry: EntryId,
    pub audited: String,
    pub proposed: String,
}

/// True when `place` leaves the entry in effect on `model_id`: a built-in entry kept where it
/// is, or any entry at the top level or in `models.<model_id>`.
fn kept_on(origin: Origin, place: &Place, model_id: &str) -> bool {
    match place {
        Place::Kept => origin == Origin::Builtin,
        Place::TopLevel => true,
        Place::Models(models) => models.iter().any(|model| model == model_id),
        Place::Removed => false,
    }
}

/// Every audited rule line of an entry still in effect on its model that the proposed file
/// `json`, loaded as the built-in vocabulary, reads differently from the audited setup.
pub fn reading_changes(
    results: &[ModelResults],
    placement: &Placement,
    json: &str,
) -> Result<Vec<ReadingChange>, String> {
    let file = Vocabulary::parse(json).map_err(|error| error.to_string())?;
    let proposed = Vocabulary::from_file(&file);
    let mut changes = Vec::new();
    for model in results {
        let resolved = Arc::new(proposed.for_model(&model.model_id));
        for entry in &model.entries {
            let id = EntryId {
                origin: entry.origin,
                entry: entry.entry.clone(),
            };
            if !placement
                .get(&id)
                .is_some_and(|place| kept_on(entry.origin, place, &model.model_id))
            {
                continue;
            }
            let reading = prepared(&carrier(entry.entry.section, &entry.entry.key), &resolved)
                .map_err(|error| error.to_string())?;
            if reading != entry.rule_text {
                changes.push(ReadingChange {
                    model_id: model.model_id.clone(),
                    entry: id,
                    audited: entry.rule_text.clone(),
                    proposed: reading,
                });
            }
        }
    }
    Ok(changes)
}

fn section_name(section: Section) -> &'static str {
    match section {
        Section::Symbol => "symbol",
        Section::Extension => "extension",
        Section::Term => "term",
        Section::Acronym => "acronym",
    }
}

fn decision_name(decision: Decision) -> &'static str {
    match decision {
        Decision::Redundant => "redundant",
        Decision::Needed => "needed",
        Decision::Defect => "defect",
        Decision::NotAudited => "not audited",
    }
}

fn runs(heard: &[Heard]) -> String {
    heard
        .iter()
        .map(|heard| if heard.pass { 'P' } else { 'F' })
        .collect()
}

/// A Markdown table: one row per placed entry, one column per voice (rule and raw result per
/// run, then the decision) and the proposed place.
pub fn table(results: &[ModelResults], placement: &Placement) -> String {
    let mut out = String::from("| Entry |");
    for model in results {
        out.push_str(&format!(" {} |", model.model_id));
    }
    out.push_str(" Proposed |\n|---|");
    out.push_str(&"---|".repeat(results.len() + 1));
    out.push('\n');
    for (id, place) in placement {
        let mut label = format!(
            "{} `{}`",
            section_name(id.entry.section),
            id.entry.key.replace('|', "\\|")
        );
        if let Some(model) = &id.entry.model {
            label.push_str(&format!(" in models.{model}"));
        }
        if id.origin == Origin::Owner {
            label.push_str(" (candidate)");
        }
        out.push_str(&format!("| {label} |"));
        for model in results {
            let cell = model
                .entries
                .iter()
                .find(|entry| entry.origin == id.origin && entry.entry == id.entry)
                .map_or_else(
                    || "does not reach".to_string(),
                    |entry| match entry.decision {
                        Decision::NotAudited => "not audited".to_string(),
                        decision => format!(
                            "rule {}, raw {}: {}",
                            runs(&entry.rule),
                            runs(&entry.raw),
                            decision_name(decision)
                        ),
                    },
                );
            out.push_str(&format!(" {cell} |"));
        }
        let place = match place {
            Place::Removed => "removed".to_string(),
            Place::TopLevel => "top level".to_string(),
            Place::Models(models) => models
                .iter()
                .map(|model| format!("models.{model}"))
                .collect::<Vec<_>>()
                .join(", "),
            Place::Kept => "kept".to_string(),
        };
        out.push_str(&format!(" {place} |\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roundtrip::heard_matches;
    use crate::vocabulary::rules_fixture;

    fn key(section: Section, model: Option<&str>, key: &str) -> EntryKey {
        EntryKey {
            section,
            model: model.map(str::to_string),
            key: key.to_string(),
        }
    }

    fn builtin(section: Section, model: Option<&str>, name: &str) -> EntryId {
        EntryId {
            origin: Origin::Builtin,
            entry: key(section, model, name),
        }
    }

    fn decided(
        rows: &[(&str, &[(EntryId, Decision)])],
    ) -> BTreeMap<String, BTreeMap<EntryId, Decision>> {
        rows.iter()
            .map(|(model, entries)| (model.to_string(), entries.iter().cloned().collect()))
            .collect()
    }

    mod carriers {
        use super::*;

        #[test]
        fn carriers_are_fixed() {
            assert_eq!(
                carrier(Section::Extension, "md"),
                "Open the file notes.md now."
            );
            assert_eq!(carrier(Section::Term, "kubectl"), "Then run kubectl again.");
            assert_eq!(
                carrier(Section::Acronym, "GPU"),
                "The GPU is ready, and the gpu-tool too."
            );
            assert_eq!(carrier(Section::Symbol, "/"), "Run --alpha/beta now.");
            assert_eq!(carrier(Section::Symbol, "~"), "Run --alpha=~ now.");
        }

        #[test]
        fn every_builtin_symbol_carrier_is_read_through_its_rule() {
            let lines = audit_lines(&rules_fixture(), None, "pocket-en", 1).unwrap();
            let symbols: Vec<&AuditLine> = lines
                .iter()
                .filter(|line| {
                    line.entry.section == Section::Symbol && line.variant == Variant::Rule
                })
                .collect();
            assert_eq!(symbols.len(), 6);
            for line in symbols {
                let spoken = line.forms.last().expect("a symbol has its spoken form");
                assert!(
                    heard_matches(&line.text, spoken),
                    "{:?} does not say {spoken:?}: {:?}",
                    line.entry.key,
                    line.text
                );
            }
        }
    }

    mod forms {
        use super::*;

        #[test]
        fn json_raw_reading_counts_as_heard() {
            let forms = accepted_forms(Section::Extension, "json", "jason");
            assert!(forms.iter().any(|form| form == "jason"), "{forms:?}");
            assert!(forms.iter().any(|form| form == "json"), "{forms:?}");
            assert!(
                forms
                    .iter()
                    .any(|form| heard_matches("open the file notes dot jason now", form))
            );
        }

        #[test]
        fn symbol_forms_leave_out_the_written_symbol() {
            assert_eq!(accepted_forms(Section::Symbol, "/", "slash"), ["slash"]);
        }

        #[test]
        fn extension_forms_drop_the_leading_dot_and_spell_digits() {
            assert_eq!(
                accepted_forms(Section::Extension, ".mp3", "M P 3"),
                ["mp3", "m p 3"]
            );
        }
    }

    mod decisions {
        use super::*;

        #[test]
        fn decide_uses_the_majority() {
            assert_eq!(
                decide(&[true, true, false], &[false, false, true]),
                Decision::Needed
            );
            assert_eq!(
                decide(&[true, false, false], &[true, true, true]),
                Decision::Defect
            );
            assert_eq!(
                decide(&[true, true, true], &[true, true, false]),
                Decision::Redundant
            );
        }
    }

    mod placement {
        use super::*;

        #[test]
        fn place_needs_every_model() {
            let md = builtin(Section::Extension, None, "md");
            let decisions = decided(&[("pocket-en", &[(md, Decision::Needed)])]);
            let error = place(&decisions, &["pocket-en", "supertonic-3"]).unwrap_err();
            assert!(error.contains("supertonic-3"), "{error}");
            assert!(!error.contains("pocket-en"), "{error}");
        }

        #[test]
        fn place_moves_one_model_needs_into_its_section() {
            let md = builtin(Section::Extension, None, "md");
            let src = builtin(Section::Term, None, "src");
            let gpu = builtin(Section::Acronym, None, "GPU");
            let decisions = decided(&[
                (
                    "pocket-en",
                    &[
                        (md.clone(), Decision::Needed),
                        (src.clone(), Decision::Redundant),
                        (gpu.clone(), Decision::Needed),
                    ],
                ),
                (
                    "supertonic-3",
                    &[
                        (md.clone(), Decision::Redundant),
                        (src.clone(), Decision::Redundant),
                        (gpu.clone(), Decision::Needed),
                    ],
                ),
            ]);
            let placement = place(&decisions, &["pocket-en", "supertonic-3"]).unwrap();
            assert_eq!(placement[&md], Place::Models(vec!["pocket-en".into()]));
            assert_eq!(placement[&src], Place::Removed);
            assert_eq!(placement[&gpu], Place::TopLevel);
        }

        #[test]
        fn a_defect_on_any_voice_keeps_the_entry() {
            let md = builtin(Section::Extension, None, "md");
            let decisions = decided(&[
                ("pocket-en", &[(md.clone(), Decision::Redundant)]),
                ("indic-tiny-hi", &[(md.clone(), Decision::Defect)]),
            ]);
            let placement = place(&decisions, &["pocket-en", "indic-tiny-hi"]).unwrap();
            assert_eq!(placement[&md], Place::Kept);
        }

        #[test]
        fn an_entry_keeps_reaching_every_voice_it_was_not_audited_on() {
            let md = builtin(Section::Extension, None, "md");
            let json = builtin(Section::Extension, None, "json");
            let slash = builtin(Section::Symbol, Some("indic-tiny-hi"), "/");
            let decisions = decided(&[
                (
                    "pocket-en",
                    &[
                        (md.clone(), Decision::Redundant),
                        (json.clone(), Decision::Needed),
                    ],
                ),
                (
                    "indic-tiny-hi",
                    &[
                        (md.clone(), Decision::NotAudited),
                        (json.clone(), Decision::NotAudited),
                        (slash.clone(), Decision::NotAudited),
                    ],
                ),
            ]);
            let placement = place(&decisions, &["pocket-en", "indic-tiny-hi"]).unwrap();
            assert_eq!(placement[&md], Place::Models(vec!["indic-tiny-hi".into()]));
            assert_eq!(placement[&json], Place::TopLevel);
            assert_eq!(
                placement[&slash],
                Place::Models(vec!["indic-tiny-hi".into()])
            );
            let proposal = proposal(&placement, None).unwrap();
            let file: serde_json::Value = serde_json::from_str(&proposal.json).unwrap();
            let builtin_file: serde_json::Value = serde_json::from_str(BUILTIN_JSON).unwrap();
            assert_eq!(
                file["models"]["indic-tiny-hi"]["symbols"],
                builtin_file["models"]["indic-tiny-hi"]["symbols"]
            );
            assert_eq!(
                file["models"]["indic-tiny-hi"]["extensions"]["md"],
                "markdown"
            );
            assert!(file["extensions"].get("md").is_none());
        }

        #[test]
        fn a_model_entry_reaches_only_its_model() {
            let slash = builtin(Section::Symbol, Some("indic-tiny-hi"), "/");
            let md = builtin(Section::Extension, None, "md");
            let decisions = decided(&[
                ("pocket-en", &[(md.clone(), Decision::Needed)]),
                (
                    "indic-tiny-hi",
                    &[
                        (md.clone(), Decision::Needed),
                        (slash.clone(), Decision::Needed),
                    ],
                ),
            ]);
            let placement = place(&decisions, &["pocket-en", "indic-tiny-hi"]).unwrap();
            assert_eq!(
                placement[&slash],
                Place::Models(vec!["indic-tiny-hi".into()])
            );
            assert_eq!(placement[&md], Place::TopLevel);
        }
    }

    mod lines {
        use super::*;

        fn top_level_entries(vocabulary: &Vocabulary) -> usize {
            vocabulary
                .rows(&[])
                .iter()
                .filter(|row| row.id.origin == Origin::Builtin && row.id.entry.model.is_none())
                .count()
        }

        #[test]
        fn audit_lines_cover_every_entry_for_any_model() {
            let vocabulary = Vocabulary::builtin();
            let lines = audit_lines(&vocabulary, None, "phonon-test", 3).unwrap();
            let entries = top_level_entries(&vocabulary);
            assert!(entries > 0);
            assert_eq!(lines.len(), entries * 2 * 3);
            for variant in [Variant::Rule, Variant::Raw] {
                for run in 1..=3 {
                    let count = lines
                        .iter()
                        .filter(|line| line.variant == variant && line.run == run)
                        .count();
                    assert_eq!(count, entries, "{variant:?} run {run}");
                }
            }
            let mut ids: Vec<&str> = lines.iter().map(|line| line.id.as_str()).collect();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), lines.len(), "line ids are unique");
        }

        fn text(lines: &[AuditLine], variant: Variant, entry: &EntryKey) -> Option<String> {
            lines
                .iter()
                .find(|line| line.variant == variant && line.entry == *entry)
                .map(|line| line.text.clone())
        }

        #[test]
        fn raw_lines_read_the_carrier_with_the_entry_switched_off() {
            let lines = audit_lines(&Vocabulary::builtin(), None, "supertonic-3", 1).unwrap();
            let md = key(Section::Extension, None, "md");
            assert_eq!(
                text(&lines, Variant::Rule, &md).as_deref(),
                Some("Open the file notes dot markdown now.")
            );
            assert_eq!(
                text(&lines, Variant::Raw, &md).as_deref(),
                Some("Open the file notes dot M D now.")
            );
            let slash = key(Section::Symbol, None, "/");
            assert_eq!(
                text(&lines, Variant::Raw, &slash).as_deref(),
                Some("Run dash dash alpha beta now.")
            );
        }

        #[test]
        fn a_switched_off_model_entry_falls_back_to_the_shared_entry() {
            let lines = audit_lines(&Vocabulary::builtin(), None, "indic-tiny-hi", 1).unwrap();
            let raw = text(
                &lines,
                Variant::Raw,
                &key(Section::Symbol, Some("indic-tiny-hi"), "/"),
            )
            .expect("the Hindi slash is audited");
            assert!(raw.contains(" slash "), "{raw}");
            assert!(!raw.contains("स्लैश"), "{raw}");
        }

        #[test]
        fn a_model_section_shadows_the_top_level_entry_for_its_model() {
            let lines = audit_lines(&Vocabulary::builtin(), None, "indic-tiny-hi", 1).unwrap();
            let slashes: Vec<&EntryKey> = lines
                .iter()
                .filter(|line| line.entry.key == "/" && line.variant == Variant::Rule)
                .map(|line| &line.entry)
                .collect();
            assert_eq!(slashes, [&key(Section::Symbol, Some("indic-tiny-hi"), "/")]);
        }

        #[test]
        fn candidates_are_heard_with_their_own_reading() {
            let candidates = Vocabulary::parse(r#"{"version":1,"extensions":{"md":"M D"}}"#)
                .expect("candidate file parses");
            let lines =
                audit_lines(&Vocabulary::builtin(), Some(&candidates), "pocket-en", 1).unwrap();
            let md: Vec<&AuditLine> = lines
                .iter()
                .filter(|line| line.entry.key == "md" && line.variant == Variant::Rule)
                .collect();
            assert_eq!(md.len(), 1, "the built-in md is shadowed by the candidate");
            assert_eq!(md[0].origin, Origin::Owner);
            assert_eq!(md[0].text, "Open the file notes dot M D now.");
        }
    }

    mod scoring {
        use super::*;

        fn corpus(lines: Vec<AuditLine>) -> Corpus {
            Corpus {
                model_id: "pocket-en".into(),
                partial: false,
                runs: 3,
                lines,
            }
        }

        #[test]
        fn score_decides_each_entry_from_what_was_heard() {
            let lines: Vec<AuditLine> = audit_lines(&Vocabulary::builtin(), None, "pocket-en", 3)
                .unwrap()
                .into_iter()
                .filter(|line| line.entry.key == "json")
                .collect();
            let results = score(&corpus(lines), |line| {
                Ok::<_, String>(match (line.variant, line.run) {
                    (Variant::Rule, _) => "Open the file notes dot jason now.".to_string(),
                    (Variant::Raw, 1) => "Open the file notes dot jason now.".to_string(),
                    (Variant::Raw, _) => "Open the file notes dot jay son now.".to_string(),
                })
            })
            .unwrap();
            assert_eq!(results.entries.len(), 1);
            let json = &results.entries[0];
            assert_eq!(json.rule.iter().filter(|heard| heard.pass).count(), 3);
            assert_eq!(json.raw.iter().filter(|heard| heard.pass).count(), 1);
            assert_eq!(json.decision, Decision::Needed);
        }

        fn only(model: &str, name: &str) -> Vec<AuditLine> {
            audit_lines(&rules_fixture(), None, model, 3)
                .unwrap()
                .into_iter()
                .filter(|line| line.entry.key == name)
                .collect()
        }

        fn decision(lines: Vec<AuditLine>, rule: &str, raw: &str) -> Decision {
            let results = score(&corpus(lines), |line| {
                Ok::<_, String>(match line.variant {
                    Variant::Rule => rule.to_string(),
                    Variant::Raw => raw.to_string(),
                })
            })
            .unwrap();
            assert_eq!(results.entries.len(), 1);
            results.entries[0].decision
        }

        #[test]
        fn a_voice_that_spells_both_lines_letter_by_letter_is_not_audited() {
            assert_eq!(
                decision(
                    only("indic-tiny-hi", "json"),
                    "O P E N T H E F I L E N O T E S dot J A S O N N O W",
                    "O-P-E-N T H E F I L E N O T E S D O T J S O N N O W"
                ),
                Decision::NotAudited
            );
            assert_eq!(
                decision(
                    only("pocket-en", "GPU"),
                    "The G P U is ready, and the G P U tool too.",
                    "The GPU is ready, and the GPU tool too."
                ),
                Decision::Redundant
            );
        }

        #[test]
        fn a_dot_glued_to_the_next_word_counts_as_heard() {
            assert_eq!(
                decision(
                    only("pocket-en", "c"),
                    "Open the file notes.cnow.",
                    "Open the file notes dot see now."
                ),
                Decision::Needed
            );
            assert_eq!(
                decision(
                    only("pocket-en", "."),
                    "Run --alpha.beta now.",
                    "Run dash dash alpha beta now."
                ),
                Decision::Needed
            );
        }

        #[test]
        fn an_acronym_must_be_heard_in_capitals_and_in_a_hyphenated_word() {
            assert_eq!(
                decision(
                    only("pocket-en", "CLI"),
                    "The C L I is ready, and the C L I tool too.",
                    "The CLI is ready, and the kali tool too."
                ),
                Decision::Needed
            );
        }

        #[test]
        fn native_script_entries_are_not_audited() {
            let lines: Vec<AuditLine> = audit_lines(&rules_fixture(), None, "indic-tiny-hi", 1)
                .unwrap()
                .into_iter()
                .filter(|line| line.entry.model.is_some())
                .collect();
            assert!(!lines.is_empty());
            let results = score(&corpus(lines), |line| -> Result<String, String> {
                Err(format!("{} was transcribed", line.id))
            })
            .unwrap();
            assert!(
                results
                    .entries
                    .iter()
                    .all(|entry| entry.decision == Decision::NotAudited && entry.rule.is_empty())
            );
        }
    }

    mod proposals {
        use super::*;

        #[test]
        fn proposal_removes_and_moves_builtin_entries() {
            let placement: Placement = [
                (builtin(Section::Extension, None, "md"), Place::Removed),
                (
                    builtin(Section::Term, None, "systemd"),
                    Place::Models(vec!["pocket-en".into()]),
                ),
                (builtin(Section::Acronym, None, "CLI"), Place::TopLevel),
            ]
            .into_iter()
            .collect();
            let proposal = proposal(&placement, None).unwrap();
            Vocabulary::parse(&proposal.json).expect("the proposal parses");
            let json: serde_json::Value = serde_json::from_str(&proposal.json).unwrap();
            assert!(json["extensions"].get("md").is_none());
            assert!(json["terms"].get("systemd").is_none());
            assert_eq!(json["models"]["pocket-en"]["terms"]["systemd"], "system D");
            assert!(
                json["acronyms"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|acronym| acronym == "CLI")
            );
            assert!(
                proposal
                    .failures
                    .iter()
                    .any(|failure| failure.text == "~/notes.md" && failure.model.is_none()),
                "{:?}",
                proposal.failures
            );
        }

        #[test]
        fn proposal_adds_needed_candidates() {
            let candidates =
                Vocabulary::parse(r#"{"version":1,"terms":{"podman":"pod man"}}"#).unwrap();
            let podman = EntryId {
                origin: Origin::Owner,
                entry: key(Section::Term, None, "podman"),
            };
            let placement: Placement = [(podman, Place::Models(vec!["supertonic-3".into()]))]
                .into_iter()
                .collect();
            let proposal = proposal(&placement, Some(&candidates)).unwrap();
            let json: serde_json::Value = serde_json::from_str(&proposal.json).unwrap();
            assert_eq!(json["models"]["supertonic-3"]["terms"]["podman"], "pod man");
            assert!(json["terms"].get("podman").is_none());
        }
    }

    mod faithful {
        use super::*;

        const MODELS: [&str; 2] = ["pocket-en", "indic-tiny-hi"];

        /// Audits `MODELS` with `candidates`, every rule line heard as written and every raw
        /// line heard as `raw(model, line)`, then places and proposes.
        fn audit(
            candidates: &VocabularyFile,
            raw: impl Fn(&str, &AuditLine) -> String,
        ) -> (Vec<ModelResults>, Placement, Proposal) {
            let results: Vec<ModelResults> = MODELS
                .iter()
                .map(|model| {
                    let corpus = Corpus {
                        model_id: model.to_string(),
                        partial: false,
                        runs: 3,
                        lines: audit_lines(&Vocabulary::builtin(), Some(candidates), model, 3)
                            .unwrap(),
                    };
                    score(&corpus, |line| {
                        Ok::<_, String>(match line.variant {
                            Variant::Rule => line.text.clone(),
                            Variant::Raw => raw(model, line),
                        })
                    })
                    .unwrap()
                })
                .collect();
            let placement = place(&decisions(&results), &MODELS).unwrap();
            let proposal = proposal(&placement, Some(candidates)).unwrap();
            (results, placement, proposal)
        }

        fn stroke() -> VocabularyFile {
            Vocabulary::parse(r#"{"version":1,"symbols":{"/":"stroke"}}"#).unwrap()
        }

        fn slash_candidate() -> EntryId {
            EntryId {
                origin: Origin::Owner,
                entry: key(Section::Symbol, None, "/"),
            }
        }

        #[test]
        fn a_top_level_candidate_reads_as_audited_on_every_model() {
            let (results, placement, proposal) = audit(&stroke(), |_, _| String::new());
            assert_eq!(placement[&slash_candidate()], Place::TopLevel);
            let changes = reading_changes(&results, &placement, &proposal.json).unwrap();
            assert_eq!(changes, [], "the proposal reads differently from the audit");
        }

        #[test]
        fn a_model_candidate_reads_as_audited_on_its_model() {
            let (results, placement, proposal) = audit(&stroke(), |model, line| {
                if model == "pocket-en" && line.entry.key == "/" {
                    "Open alpha stroke beta now.".to_string()
                } else {
                    String::new()
                }
            });
            assert_eq!(
                placement[&slash_candidate()],
                Place::Models(vec!["indic-tiny-hi".into()])
            );
            let changes = reading_changes(&results, &placement, &proposal.json).unwrap();
            assert_eq!(changes, [], "the proposal reads differently from the audit");
        }

        #[test]
        fn reading_changes_reports_a_line_the_proposal_reads_differently() {
            let md = key(Section::Extension, None, "md");
            let results = [ModelResults {
                model_id: "pocket-en".into(),
                partial: false,
                entries: vec![EntryResult {
                    entry: md.clone(),
                    origin: Origin::Builtin,
                    forms: vec!["md".into()],
                    rule_text: "Open the file notes dot M D now.".into(),
                    raw_text: String::new(),
                    rule: Vec::new(),
                    raw: Vec::new(),
                    decision: Decision::Needed,
                }],
            }];
            let placement: Placement = [(builtin(Section::Extension, None, "md"), Place::TopLevel)]
                .into_iter()
                .collect();
            let proposal = proposal(&placement, None).unwrap();
            let changes = reading_changes(&results, &placement, &proposal.json).unwrap();
            assert_eq!(changes.len(), 1, "{changes:?}");
            assert_eq!(changes[0].proposed, "Open the file notes dot markdown now.");
        }
    }

    mod tables {
        use super::*;

        #[test]
        fn table_shows_each_run_and_the_place() {
            let md = key(Section::Extension, None, "md");
            let heard = |run, pass| Heard {
                run,
                heard: String::new(),
                pass,
            };
            let results = [ModelResults {
                model_id: "pocket-en".into(),
                partial: false,
                entries: vec![EntryResult {
                    entry: md.clone(),
                    origin: Origin::Builtin,
                    forms: vec!["md".into(), "markdown".into()],
                    rule_text: String::new(),
                    raw_text: String::new(),
                    rule: vec![heard(1, true), heard(2, true), heard(3, false)],
                    raw: vec![heard(1, false), heard(2, false), heard(3, true)],
                    decision: Decision::Needed,
                }],
            }];
            let placement: Placement = [(builtin(Section::Extension, None, "md"), Place::TopLevel)]
                .into_iter()
                .collect();
            let table = table(&results, &placement);
            assert!(table.contains("| extension `md` |"), "{table}");
            assert!(table.contains("rule PPF, raw FFP: needed"), "{table}");
            assert!(table.contains("| top level |"), "{table}");
        }
    }
}
