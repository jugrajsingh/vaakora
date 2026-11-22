//! The built-in vocabulary audit for one voice at a time: `corpus` writes the lines to
//! synthesize, `score` transcribes the worker's WAVs with a local recogniser and decides each
//! entry, `combine` places every entry across the stored results of several voices and writes
//! the proposed built-in file and a decision table. It never edits the built-in file.

use anyhow::{bail, ensure, Context, Result};
use clap::{Parser, Subcommand};
use handy_tts_core::audit::{self, Corpus, ModelResults};
use handy_tts_core::catalog;
use handy_tts_core::vocabulary::{Vocabulary, VocabularyFile};
use std::path::{Path, PathBuf};
use transcribe_cpp::{Model, RunOptions};
use vaakora_app_lib::audio_toolkit::audio::decode_audio_file;

#[derive(Parser)]
#[command(about = "Audit the built-in read-aloud vocabulary one voice at a time")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Write the carrier lines for one voice.
    Corpus {
        #[arg(long)]
        model_id: String,
        /// A vocabulary file whose entries are audited beside the built-in ones.
        #[arg(long)]
        candidates: Option<PathBuf>,
        /// Only these entry keys, comma separated; the results are then partial.
        #[arg(long)]
        only: Option<String>,
        #[arg(long, default_value_t = 3)]
        runs: u8,
        #[arg(long)]
        out: PathBuf,
    },
    /// Transcribe the WAVs of a corpus and decide each entry.
    Score {
        #[arg(long)]
        model_id: String,
        #[arg(long)]
        asr_model: PathBuf,
        #[arg(long)]
        lines: PathBuf,
        #[arg(long)]
        wavs: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// Place every entry across the stored results of several voices.
    Combine {
        /// The directory holding `<model id>.json` results.
        #[arg(long)]
        results: PathBuf,
        /// Catalog model ids, comma separated.
        #[arg(long)]
        models: String,
        /// The candidates file the corpus runs used, if any.
        #[arg(long)]
        candidates: Option<PathBuf>,
        #[arg(long)]
        vocabulary_out: PathBuf,
        #[arg(long)]
        table_out: PathBuf,
    },
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
}

fn write(path: &Path, text: &str) -> Result<()> {
    std::fs::write(path, text).with_context(|| format!("write {}", path.display()))
}

fn candidates(path: Option<&Path>) -> Result<Option<VocabularyFile>> {
    path.map(|path| {
        let json =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        Vocabulary::parse(&json).with_context(|| format!("parse {}", path.display()))
    })
    .transpose()
}

/// The lines for `model_id` (a catalog id), only the entries keyed in `only` when given.
fn corpus(
    model_id: &str,
    candidates: Option<&VocabularyFile>,
    only: Option<&str>,
    runs: u8,
) -> Result<Corpus> {
    catalog::entry(model_id)?;
    ensure!(runs > 0, "--runs must be at least 1");
    let mut lines = audit::audit_lines(&Vocabulary::builtin(), candidates, model_id, runs)?;
    if let Some(only) = only {
        let keys: Vec<&str> = only.split(',').map(str::trim).collect();
        lines.retain(|line| keys.contains(&line.entry.key.as_str()));
        for key in keys {
            ensure!(
                lines.iter().any(|line| line.entry.key == key),
                "--only names {key:?}, which no entry reaching {model_id} has"
            );
        }
    }
    Ok(Corpus {
        model_id: model_id.to_string(),
        partial: only.is_some(),
        runs,
        lines,
    })
}

/// The models of a `combine` run: catalog ids, each with complete stored results.
fn complete_results(directory: &Path, models: &[&str]) -> Result<Vec<ModelResults>> {
    let mut results = Vec::new();
    for model in models {
        catalog::entry(model)?;
        let path = directory.join(format!("{model}.json"));
        if !path.exists() {
            continue;
        }
        let stored: ModelResults = read_json(&path)?;
        ensure!(
            stored.model_id == *model,
            "{} holds results for {}",
            path.display(),
            stored.model_id
        );
        ensure!(
            !stored.partial,
            "results for {model} are partial (--only); audit it again without --only"
        );
        results.push(stored);
    }
    Ok(results)
}

fn score(model_id: &str, asr_model: &Path, lines: &Path, wavs: &Path, out: &Path) -> Result<()> {
    catalog::entry(model_id)?;
    let corpus: Corpus = read_json(lines)?;
    ensure!(
        corpus.model_id == model_id,
        "{} holds lines for {}",
        lines.display(),
        corpus.model_id
    );
    transcribe_cpp::init_logging();
    transcribe_cpp::init_backends_default().context("initialize ASR backends")?;
    let model = Model::load(asr_model)
        .with_context(|| format!("load ASR model {}", asr_model.display()))?;
    let mut session = model.session().context("create ASR session")?;
    let results = audit::score(&corpus, |line| -> Result<String> {
        let path = wavs.join(format!("{}.wav", line.id));
        let pcm = decode_audio_file(&path)?;
        let heard = session
            .run(&pcm, &RunOptions::default())
            .with_context(|| format!("transcribe {}", path.display()))?
            .text;
        println!("HEARD {} {heard:?}", line.id);
        Ok(heard)
    })?;
    for entry in &results.entries {
        println!(
            "DECIDED {:?} {} rule={}/{} raw={}/{} {:?}",
            entry.entry.section,
            entry.entry.key,
            entry.rule.iter().filter(|heard| heard.pass).count(),
            entry.rule.len(),
            entry.raw.iter().filter(|heard| heard.pass).count(),
            entry.raw.len(),
            entry.decision
        );
    }
    write(out, &serde_json::to_string_pretty(&results)?)?;
    println!(
        "SCORED model={model_id} entries={} partial={}",
        results.entries.len(),
        results.partial
    );
    Ok(())
}

fn combine(
    directory: &Path,
    models: &str,
    candidates: Option<&VocabularyFile>,
    vocabulary_out: &Path,
    table_out: &Path,
) -> Result<()> {
    let models: Vec<&str> = models.split(',').map(str::trim).collect();
    let results = complete_results(directory, &models)?;
    let placement =
        audit::place(&audit::decisions(&results), &models).map_err(anyhow::Error::msg)?;
    let proposal = audit::proposal(&placement, candidates).map_err(anyhow::Error::msg)?;
    let changes =
        audit::reading_changes(&results, &placement, &proposal.json).map_err(anyhow::Error::msg)?;
    write(vocabulary_out, &proposal.json)?;
    write(table_out, &audit::table(&results, &placement))?;
    for failure in &proposal.failures {
        let model = failure
            .model
            .as_ref()
            .map_or_else(String::new, |model| format!(" [{model}]"));
        println!(
            "EXAMPLE FAIL {}{model}: expected {:?} got {:?}",
            failure.text, failure.expected, failure.actual
        );
    }
    for change in &changes {
        println!(
            "READING CHANGED {} {:?} {}: audited {:?} proposed {:?}",
            change.model_id,
            change.entry.entry.section,
            change.entry.entry.key,
            change.audited,
            change.proposed
        );
    }
    let count = |place: fn(&audit::Place) -> bool| placement.values().filter(|p| place(p)).count();
    println!(
        "COMBINED models={} entries={} removed={} top_level={} per_model={} kept={} example_failures={} reading_changes={}",
        models.join(","),
        placement.len(),
        count(|place| *place == audit::Place::Removed),
        count(|place| *place == audit::Place::TopLevel),
        count(|place| matches!(place, audit::Place::Models(_))),
        count(|place| *place == audit::Place::Kept),
        proposal.failures.len(),
        changes.len()
    );
    Ok(())
}

fn main() -> Result<()> {
    match Args::parse().command {
        Command::Corpus {
            model_id,
            candidates: path,
            only,
            runs,
            out,
        } => {
            let candidates = candidates(path.as_deref())?;
            let corpus = corpus(&model_id, candidates.as_ref(), only.as_deref(), runs)?;
            if corpus.lines.is_empty() {
                bail!("no entry reaches {model_id}");
            }
            write(&out, &serde_json::to_string_pretty(&corpus)?)?;
            println!(
                "CORPUS model={model_id} lines={} partial={}",
                corpus.lines.len(),
                corpus.partial
            );
            Ok(())
        }
        Command::Score {
            model_id,
            asr_model,
            lines,
            wavs,
            out,
        } => score(&model_id, &asr_model, &lines, &wavs, &out),
        Command::Combine {
            results,
            models,
            candidates: path,
            vocabulary_out,
            table_out,
        } => {
            let candidates = candidates(path.as_deref())?;
            combine(
                &results,
                &models,
                candidates.as_ref(),
                &vocabulary_out,
                &table_out,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> tempfile::TempDir {
        let root = std::env::var_os("HANDY_TTS_TEST_SCRATCH").expect("HANDY_TTS_TEST_SCRATCH");
        tempfile::Builder::new()
            .prefix(name)
            .tempdir_in(root)
            .unwrap()
    }

    fn stored(directory: &Path, model: &str, partial: bool) {
        let results = ModelResults {
            model_id: model.into(),
            partial,
            entries: Vec::new(),
        };
        std::fs::write(
            directory.join(format!("{model}.json")),
            serde_json::to_vec(&results).unwrap(),
        )
        .unwrap();
    }

    mod corpus {
        use super::*;

        #[test]
        fn refuses_a_model_outside_the_catalog() {
            let error = corpus("phonon-test", None, None, 3).unwrap_err();
            assert!(
                error.downcast_ref::<catalog::CatalogError>().is_some(),
                "{error:#}"
            );
        }

        #[test]
        fn only_keeps_the_named_keys_and_marks_the_corpus_partial() {
            let only = corpus("supertonic-3", None, Some("md,kubectl,CLI"), 1).unwrap();
            let mut keys: Vec<&str> = only
                .lines
                .iter()
                .map(|line| line.entry.key.as_str())
                .collect();
            keys.dedup();
            assert_eq!(keys.len(), 3, "{keys:?}");
            assert_eq!(only.lines.len(), 6);
            assert!(only.partial);
            assert!(corpus("supertonic-3", None, Some("nosuchkey"), 1).is_err());
        }
    }

    mod combine {
        use super::*;

        #[test]
        fn refuses_partial_results() {
            let directory = scratch("ve11-partial");
            stored(directory.path(), "pocket-en", true);
            let error = complete_results(directory.path(), &["pocket-en"]).unwrap_err();
            assert!(error.to_string().contains("partial"), "{error:#}");
        }

        #[test]
        fn a_model_without_results_fails_the_placement() {
            let directory = scratch("ve11-missing");
            stored(directory.path(), "pocket-en", false);
            let results =
                complete_results(directory.path(), &["pocket-en", "supertonic-3"]).unwrap();
            let error = audit::place(&audit::decisions(&results), &["pocket-en", "supertonic-3"])
                .unwrap_err();
            assert!(error.contains("supertonic-3"), "{error}");
        }
    }
}
