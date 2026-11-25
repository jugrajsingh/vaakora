//! Read-aloud history: what each read said, in `<app data dir>/tts-history.db`. Text only, no
//! audio; separate from speech-to-text history and from the vocabulary file.

use crate::settings::{AppSettings, ReadHistoryRetention};
use anyhow::{Context, Result};
use handy_tts_core::{selection::Selection, text::AlignedChunk, vocabulary::Vocabulary};
use rusqlite::{params, Connection};
use rusqlite_migration::{Migrations, M};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, PoisonError,
    },
};

pub const FILE_NAME: &str = "tts-history.db";
/// The highest count limit the setting accepts.
pub const MAX_LIMIT: usize = 1000;

static MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE read_history (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        voice TEXT NOT NULL,
        speed REAL NOT NULL,
        technical INTEGER NOT NULL,
        source TEXT NOT NULL,
        chunks TEXT NOT NULL
    );",
    ),
    M::up("ALTER TABLE read_history ADD COLUMN origin TEXT NOT NULL DEFAULT 'app';"),
];

/// Who asked for a read: the owner in the app, or a client of the command-line socket (an
/// agent). Stored as `app` or `agent`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "lowercase")]
pub enum ReadOrigin {
    #[default]
    App,
    Agent,
}

impl ReadOrigin {
    /// The text stored in the `origin` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Agent => "agent",
        }
    }

    /// The origin a stored value names; a value this version does not know counts as the owner's.
    pub fn from_stored(value: &str) -> Self {
        match value {
            "agent" => Self::Agent,
            _ => Self::App,
        }
    }
}

/// One read as it started: the written source, every chunk sent to the voice with its word
/// spans, and the voice and speed it was read with.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadRecord {
    pub timestamp: i64,
    pub model_id: String,
    pub voice: String,
    pub speed: f32,
    pub technical: bool,
    pub source: String,
    pub origin: ReadOrigin,
    pub chunks: Vec<AlignedChunk>,
}

/// A stored read.
#[derive(Debug, Clone, PartialEq, serde::Serialize, specta::Type)]
pub struct ReadHistoryEntry {
    pub id: i64,
    pub timestamp: i64,
    pub model_id: String,
    pub voice: String,
    pub speed: f32,
    pub technical: bool,
    pub source: String,
    pub origin: ReadOrigin,
    pub chunks: Vec<AlignedChunk>,
}

/// The owner's keep rules: at most `limit` reads, and with a time choice none older than it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keep {
    pub limit: usize,
    pub retention: ReadHistoryRetention,
}

impl Keep {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            limit: settings.tts_history_limit,
            retention: settings.tts_history_retention,
        }
    }

    fn keeps_nothing(self) -> bool {
        self.limit == 0 || self.retention == ReadHistoryRetention::KeepNothing
    }

    /// Reads older than this timestamp are deleted.
    fn cutoff(self, now: i64) -> Option<i64> {
        const DAY: i64 = 24 * 60 * 60;
        match self.retention {
            ReadHistoryRetention::KeepNothing | ReadHistoryRetention::KeepLimit => None,
            ReadHistoryRetention::Days3 => Some(now - 3 * DAY),
            ReadHistoryRetention::Weeks2 => Some(now - 14 * DAY),
            ReadHistoryRetention::Months3 => Some(now - 90 * DAY),
        }
    }
}

/// Refuses a count limit over [`MAX_LIMIT`].
pub fn checked_limit(limit: usize) -> Result<usize, String> {
    if limit > MAX_LIMIT {
        return Err(format!("history limit {limit} is over {MAX_LIMIT}"));
    }
    Ok(limit)
}

/// Deletes what `keep` no longer allows: everything when it keeps nothing, else reads older
/// than its time choice and all but the newest `limit`.
fn prune_in(conn: &Connection, keep: Keep, now: i64) -> rusqlite::Result<usize> {
    if keep.keeps_nothing() {
        return conn.execute("DELETE FROM read_history", []);
    }
    let mut removed = 0;
    if let Some(cutoff) = keep.cutoff(now) {
        removed += conn.execute(
            "DELETE FROM read_history WHERE timestamp < ?1",
            params![cutoff],
        )?;
    }
    removed += conn.execute(
        "DELETE FROM read_history WHERE id NOT IN
            (SELECT id FROM read_history ORDER BY timestamp DESC, id DESC LIMIT ?1)",
        params![i64::try_from(keep.limit).unwrap_or(i64::MAX)],
    )?;
    Ok(removed)
}

/// The history store; one connection shared by the writer thread and the commands.
pub struct ReadHistory {
    conn: Mutex<Connection>,
    /// How many times Clear has run; a read queued before the latest Clear is not saved.
    cleared: AtomicU64,
}

impl ReadHistory {
    /// Opens (or creates) `dir/tts-history.db` and brings its schema up to date.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join(FILE_NAME);
        let mut conn =
            Connection::open(&path).with_context(|| format!("opening {}", path.display()))?;
        Migrations::new(MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .context("migrating tts-history.db")?;
        Ok(Self {
            conn: Mutex::new(conn),
            cleared: AtomicU64::new(0),
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The Clear count to queue a read with.
    pub fn generation(&self) -> u64 {
        self.cleared.load(Ordering::Acquire)
    }

    /// Stores `record`, queued at Clear count `generation`, unless a Clear ran since or the keep
    /// rules keep nothing, then prunes in the same transaction. `keep` is read with the store
    /// locked, so a setting change that prunes after it is never undone. Returns the new id.
    pub fn record(
        &self,
        record: &ReadRecord,
        generation: u64,
        keep: impl FnOnce() -> Keep,
        now: i64,
    ) -> Result<Option<i64>> {
        let mut conn = self.connection();
        let keep = keep();
        let transaction = conn.transaction()?;
        let id = if keep.keeps_nothing() || generation != self.generation() {
            None
        } else {
            transaction.execute(
                "INSERT INTO read_history (timestamp, model_id, voice, speed, technical, source, chunks, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    record.timestamp,
                    record.model_id,
                    record.voice,
                    f64::from(record.speed),
                    record.technical,
                    record.source,
                    serde_json::to_string(&record.chunks)?,
                    record.origin.as_str(),
                ],
            )?;
            Some(transaction.last_insert_rowid())
        };
        prune_in(&transaction, keep, now)?;
        transaction.commit()?;
        Ok(id)
    }

    /// Every stored read, newest first.
    pub fn entries(&self) -> Result<Vec<ReadHistoryEntry>> {
        let conn = self.connection();
        let mut statement = conn.prepare(
            "SELECT id, timestamp, model_id, voice, speed, technical, source, chunks, origin
             FROM read_history ORDER BY timestamp DESC, id DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                ReadHistoryEntry {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    model_id: row.get(2)?,
                    voice: row.get(3)?,
                    speed: row.get::<_, f64>(4)? as f32,
                    technical: row.get(5)?,
                    source: row.get(6)?,
                    origin: ReadOrigin::from_stored(&row.get::<_, String>(8)?),
                    chunks: Vec::new(),
                },
                row.get::<_, String>(7)?,
            ))
        })?;
        rows.map(|row| {
            let (entry, chunks) = row?;
            let chunks = serde_json::from_str(&chunks)
                .with_context(|| format!("reading the alignment of history entry {}", entry.id))?;
            Ok(ReadHistoryEntry { chunks, ..entry })
        })
        .collect()
    }

    /// Deletes the reads `keep` no longer allows; returns how many.
    pub fn prune(&self, keep: Keep, now: i64) -> Result<usize> {
        let mut conn = self.connection();
        let transaction = conn.transaction()?;
        let removed = prune_in(&transaction, keep, now)?;
        transaction.commit()?;
        Ok(removed)
    }

    /// Deletes every read, and every read queued before now; returns how many were stored.
    pub fn clear(&self) -> Result<usize> {
        let conn = self.connection();
        let removed = conn.execute("DELETE FROM read_history", [])?;
        self.cleared.fetch_add(1, Ordering::AcqRel);
        Ok(removed)
    }
}

/// The store once it is open: opening runs on its own thread so app start never waits for it.
#[derive(Default)]
pub struct HistorySlot {
    opened: Mutex<Option<Result<Arc<ReadHistory>, String>>>,
    published: Condvar,
}

impl HistorySlot {
    /// Starts opening the store with `open` and returns at once; until it finishes, `get`
    /// reports `tts.errors.starting` and `wait` blocks.
    pub fn open_in_background(
        open: impl FnOnce() -> Result<Arc<ReadHistory>, String> + Send + 'static,
    ) -> Arc<Self> {
        let slot = Arc::new(Self::default());
        let filled = slot.clone();
        std::thread::spawn(move || {
            let opened = open();
            *filled.opened.lock().unwrap_or_else(PoisonError::into_inner) = Some(opened);
            filled.published.notify_all();
        });
        slot
    }

    /// A slot holding an already open store.
    #[cfg(test)]
    pub fn ready(history: Arc<ReadHistory>) -> Arc<Self> {
        Arc::new(Self {
            opened: Mutex::new(Some(Ok(history))),
            published: Condvar::new(),
        })
    }

    /// The open store, or why there is none yet.
    pub fn get(&self) -> Result<Arc<ReadHistory>, String> {
        self.opened
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .unwrap_or_else(|| Err("tts.errors.starting".into()))
    }

    /// The store once opening has finished, or why it failed; blocks the caller until then.
    pub fn wait(&self) -> Result<Arc<ReadHistory>, String> {
        let opened = self.opened.lock().unwrap_or_else(PoisonError::into_inner);
        self.published
            .wait_while(opened, |opened| opened.is_none())
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .unwrap_or_else(|| Err("tts.errors.starting".into()))
    }
}

/// Opens the store in the app data dir and prunes it with the current settings; a failure is
/// logged and leaves read aloud without history.
pub fn open_in_app(app: &tauri::AppHandle) -> Result<Arc<ReadHistory>, String> {
    let opened = crate::portable::app_data_dir(app)
        .map_err(anyhow::Error::from)
        .and_then(|dir| ReadHistory::open(&dir))
        .map_err(|error| format!("{error:#}"));
    match opened {
        Ok(history) => {
            let keep = Keep::from_settings(&crate::settings::get_settings(app));
            if let Err(error) = history.prune(keep, chrono::Utc::now().timestamp()) {
                log::warn!("read-aloud history was not pruned: {error:#}");
            }
            Ok(Arc::new(history))
        }
        Err(error) => {
            log::warn!("read-aloud history is unavailable: {error}");
            Err(error)
        }
    }
}

/// A read whose audio has started, as the session read it: cheap to take on the session thread
/// and prepared into a [`ReadRecord`] by the history writer.
#[derive(Clone)]
pub struct ReadSnapshot {
    /// Counts documents in one session, so the writer can tell a repeat from a new document.
    pub document: u64,
    pub timestamp: i64,
    pub source: Arc<str>,
    pub origin: ReadOrigin,
    pub selection: Selection,
    pub vocabulary: Option<Arc<Vocabulary>>,
}

/// Prepares a snapshot the way its session read it.
pub fn prepare(snapshot: &ReadSnapshot) -> Result<Vec<AlignedChunk>, String> {
    handy_tts_core::session::reading(
        &snapshot.source,
        &snapshot.selection,
        snapshot.vocabulary.as_ref(),
    )
}

/// Turns snapshots into stored reads, one at a time.
pub struct Writer<K, P> {
    slot: Arc<HistorySlot>,
    keep: K,
    prepare: P,
    /// The last saved read: its document, model, voice and reading.
    last: Option<(u64, String, String, Vec<AlignedChunk>)>,
}

impl<K, P> Writer<K, P>
where
    K: Fn() -> Keep,
    P: Fn(&ReadSnapshot) -> Result<Vec<AlignedChunk>, String>,
{
    pub fn new(slot: Arc<HistorySlot>, keep: K, prepare: P) -> Self {
        Self {
            slot,
            keep,
            prepare,
            last: None,
        }
    }

    /// Saves `snapshot`, queued at Clear count `generation`, unless the keep rules keep nothing
    /// (then nothing is prepared) or it reads its document exactly as the last saved read did.
    pub fn write(&mut self, generation: u64, snapshot: &ReadSnapshot) {
        if (self.keep)().keeps_nothing() {
            return;
        }
        let history = match self.slot.wait() {
            Ok(history) => history,
            Err(error) => {
                log::warn!("read-aloud history was not saved: {error}");
                return;
            }
        };
        let chunks = match (self.prepare)(snapshot) {
            Ok(chunks) => chunks,
            Err(error) => {
                log::warn!("read-aloud history: the reading could not be prepared: {error}");
                return;
            }
        };
        let chosen = &snapshot.selection;
        if self
            .last
            .as_ref()
            .is_some_and(|(document, model, voice, spoken)| {
                *document == snapshot.document
                    && *model == chosen.model_id
                    && *voice == chosen.voice
                    && *spoken == chunks
            })
        {
            return;
        }
        let record = ReadRecord {
            timestamp: snapshot.timestamp,
            model_id: chosen.model_id.clone(),
            voice: chosen.voice.clone(),
            speed: chosen.speed,
            technical: chosen.technical,
            source: snapshot.source.to_string(),
            origin: snapshot.origin,
            chunks,
        };
        match history.record(
            &record,
            generation,
            &self.keep,
            chrono::Utc::now().timestamp(),
        ) {
            Ok(Some(_)) => {
                self.last = Some((
                    snapshot.document,
                    record.model_id,
                    record.voice,
                    record.chunks,
                ))
            }
            Ok(None) => {}
            Err(error) => log::warn!("read-aloud history was not saved: {error:#}"),
        }
    }
}

/// Hands a read whose audio has started to the history writer; called on the session thread,
/// so it only queues.
pub type HistoryRecorder = Arc<dyn Fn(ReadSnapshot) + Send + Sync>;

/// A recorder whose writer runs on its own thread; a failed write logs a warning and reading
/// goes on.
pub fn recorder<K, P>(slot: Arc<HistorySlot>, keep: K, prepare: P) -> HistoryRecorder
where
    K: Fn() -> Keep + Send + 'static,
    P: Fn(&ReadSnapshot) -> Result<Vec<AlignedChunk>, String> + Send + 'static,
{
    let (sender, snapshots) = mpsc::channel::<(u64, ReadSnapshot)>();
    let mut writer = Writer::new(slot.clone(), keep, prepare);
    std::thread::spawn(move || {
        for (generation, snapshot) in snapshots {
            writer.write(generation, &snapshot);
        }
    });
    Arc::new(move |snapshot| {
        let generation = slot.get().map_or(0, |history| history.generation());
        let _ = sender.send((generation, snapshot));
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use handy_tts_core::text::{prepare_reading, TextChunk, WordSpan};
    use handy_tts_core::vocabulary::{TechnicalOptions, Vocabulary};
    use std::{path::PathBuf, sync::mpsc, time::Duration};

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 24 * 60 * 60;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::var_os("HANDY_TTS_TEST_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = root.join("tts-history-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(source: &str, timestamp: i64) -> ReadRecord {
        ReadRecord {
            timestamp,
            model_id: "pocket-en".into(),
            voice: "alba".into(),
            speed: 1.25,
            technical: true,
            source: source.into(),
            origin: ReadOrigin::App,
            chunks: vec![AlignedChunk {
                chunk: TextChunk {
                    index: 0,
                    text: source.into(),
                    source_start: 0,
                    source_end: source.encode_utf16().count() as u32,
                    pause_ms: 0,
                },
                words: vec![WordSpan {
                    source_start: 0,
                    source_end: 1,
                    spoken_start: 0,
                    spoken_end: 1,
                }],
            }],
        }
    }

    fn read_at(source: &str) -> ReadRecord {
        read(source, NOW)
    }

    fn keep(limit: usize, retention: ReadHistoryRetention) -> Keep {
        Keep { limit, retention }
    }

    fn ids(history: &ReadHistory) -> Vec<i64> {
        history.entries().unwrap().iter().map(|e| e.id).collect()
    }

    #[test]
    fn limit_keeps_the_newest_entries() {
        let history = ReadHistory::open(&scratch("limit")).unwrap();
        let rule = keep(2, ReadHistoryRetention::KeepLimit);
        let written: Vec<i64> = (0..3)
            .map(|n| {
                history
                    .record(&read(&format!("read {n}"), NOW + n), 0, || rule, NOW + n)
                    .unwrap()
                    .unwrap()
            })
            .collect();
        assert_eq!(ids(&history), vec![written[2], written[1]]);
    }

    #[test]
    fn keep_nothing_writes_nothing_and_empties_the_store() {
        let history = ReadHistory::open(&scratch("keep-nothing")).unwrap();
        let limit = keep(5, ReadHistoryRetention::KeepLimit);
        history
            .record(&read("kept", NOW), 0, || limit, NOW)
            .unwrap();
        let nothing = keep(5, ReadHistoryRetention::KeepNothing);
        assert_eq!(
            history
                .record(&read("new", NOW), 0, || nothing, NOW)
                .unwrap(),
            None
        );
        assert!(history.entries().unwrap().is_empty());
        history
            .record(&read("kept", NOW), 0, || limit, NOW)
            .unwrap();
        assert_eq!(history.prune(nothing, NOW).unwrap(), 1);
        assert!(history.entries().unwrap().is_empty());
    }

    #[test]
    fn limit_zero_writes_nothing() {
        let history = ReadHistory::open(&scratch("limit-zero")).unwrap();
        let none = keep(0, ReadHistoryRetention::KeepLimit);
        assert_eq!(
            history.record(&read("new", NOW), 0, || none, NOW).unwrap(),
            None
        );
        assert!(history.entries().unwrap().is_empty());
    }

    #[test]
    fn time_retention_also_applies_the_limit() {
        let history = ReadHistory::open(&scratch("time")).unwrap();
        let wide = keep(100, ReadHistoryRetention::KeepLimit);
        let old = history
            .record(&read("old", NOW - 4 * DAY), 0, || wide, NOW)
            .unwrap()
            .unwrap();
        let rule = keep(5, ReadHistoryRetention::Days3);
        let fresh_read = |n: i64| {
            history
                .record(&read(&format!("fresh {n}"), NOW + n), 0, || wide, NOW)
                .unwrap()
                .unwrap()
        };
        let mut fresh = vec![fresh_read(0)];
        assert_eq!(history.prune(rule, NOW).unwrap(), 1);
        assert_eq!(ids(&history), fresh);
        fresh.extend((1..6).map(fresh_read));
        assert_eq!(history.prune(rule, NOW).unwrap(), 1);
        let kept = ids(&history);
        assert!(!kept.contains(&old));
        assert_eq!(
            kept,
            fresh.iter().rev().take(5).copied().collect::<Vec<_>>()
        );
    }

    #[test]
    fn clear_leaves_the_vocabulary_file() {
        let dir = scratch("clear");
        let vocabulary = dir.join(crate::tts::vocabulary::FILE_NAME);
        let bytes = br#"{"version":1,"extensions":{"md":"M D"}}"#;
        std::fs::write(&vocabulary, bytes).unwrap();
        let history = ReadHistory::open(&dir).unwrap();
        let rule = keep(5, ReadHistoryRetention::KeepLimit);
        history.record(&read("one", NOW), 0, || rule, NOW).unwrap();
        history.record(&read("two", NOW), 0, || rule, NOW).unwrap();
        assert_eq!(history.clear().unwrap(), 2);
        assert!(history.entries().unwrap().is_empty());
        assert_eq!(std::fs::read(&vocabulary).unwrap(), bytes);
    }

    #[test]
    fn entries_keep_their_alignment_after_a_vocabulary_edit() {
        let dir = scratch("alignment");
        let source = "Edit lib.sh today.";
        let builtin = Arc::new(Vocabulary::builtin());
        let chunks =
            prepare_reading(source, false, Some(builtin), TechnicalOptions::default()).unwrap();
        let history = ReadHistory::open(&dir).unwrap();
        let record = ReadRecord {
            chunks: chunks.clone(),
            ..read(source, NOW)
        };
        history
            .record(&record, 0, || keep(5, ReadHistoryRetention::KeepLimit), NOW)
            .unwrap();
        std::fs::write(
            dir.join(crate::tts::vocabulary::FILE_NAME),
            r#"{"version":1,"extensions":{"sh":"shell"}}"#,
        )
        .unwrap();
        let entries = history.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].chunks, chunks);
        assert!(entries[0].chunks[0].chunk.text.contains("lib dot S H"));
        assert_eq!(entries[0].source, source);
        assert_eq!(entries[0].speed, 1.25);
        assert!(entries[0].technical);
    }

    /// A stored table read keeps its chunks, and every span still points at one written cell
    /// word of the source: never a label, a wall or a border.
    #[test]
    fn table_reads_keep_their_alignment() {
        let dir = scratch("table-alignment");
        let source =
            include_str!("../../../crates/handy-tts-core/tests/fixtures/text/tables/multiline.txt");
        let builtin = Arc::new(Vocabulary::builtin());
        let chunks =
            prepare_reading(source, false, Some(builtin), TechnicalOptions::default()).unwrap();
        let history = ReadHistory::open(&dir).unwrap();
        let record = ReadRecord {
            chunks: chunks.clone(),
            ..read(source, NOW)
        };
        history
            .record(&record, 0, || keep(5, ReadHistoryRetention::KeepLimit), NOW)
            .unwrap();
        let entries = history.entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, source);
        assert_eq!(entries[0].chunks, chunks);
        let units: Vec<u16> = source.encode_utf16().collect();
        let written: Vec<String> = entries[0]
            .chunks
            .iter()
            .flat_map(|aligned| &aligned.words)
            .map(|span| {
                String::from_utf16(&units[span.source_start as usize..span.source_end as usize])
                    .unwrap()
            })
            .collect();
        for word in &written {
            assert!(
                !word.is_empty()
                    && !word.chars().any(|c| c.is_whitespace()
                        || c == '|'
                        || ('\u{2500}'..='\u{257F}').contains(&c)),
                "{word:?} is not one written word"
            );
        }
        assert_eq!(
            written.join(" "),
            "B, the walk Task B1 committed, working on B2. Opus E 9 files changed gpt-6.1-sol \
             B, the walk Opus Task B1 committed (b574c34). E gpt-6.1-sol 9 files changed, unstaged"
        );
    }

    #[test]
    fn the_store_lives_in_the_app_data_dir() {
        let dir = scratch("location");
        ReadHistory::open(&dir).unwrap();
        assert!(dir.join("tts-history.db").is_file());
    }

    #[test]
    fn a_limit_over_1000_is_refused() {
        assert_eq!(checked_limit(1000), Ok(1000));
        assert!(checked_limit(1001).is_err());
    }

    #[test]
    fn a_write_uses_the_retention_set_while_it_waited() {
        let history = Arc::new(ReadHistory::open(&scratch("stale-keep")).unwrap());
        let (reading, read) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let writer = {
            let history = history.clone();
            std::thread::spawn(move || {
                history
                    .record(
                        &read_at("pending"),
                        0,
                        move || {
                            reading.send(()).unwrap();
                            released.recv().unwrap();
                            keep(5, ReadHistoryRetention::KeepLimit)
                        },
                        NOW,
                    )
                    .unwrap()
            })
        };
        read.recv().unwrap();
        let (pruned, prune_done) = mpsc::channel();
        let setter = {
            let history = history.clone();
            std::thread::spawn(move || {
                let removed = history
                    .prune(keep(5, ReadHistoryRetention::KeepNothing), NOW)
                    .unwrap();
                pruned.send(()).unwrap();
                removed
            })
        };
        // A prune that is not held back by the waiting write finishes first.
        let _ = prune_done.recv_timeout(Duration::from_millis(300));
        release.send(()).unwrap();
        writer.join().unwrap();
        setter.join().unwrap();
        assert!(history.entries().unwrap().is_empty());
    }

    #[test]
    fn a_read_queued_before_clear_is_not_saved() {
        let history = ReadHistory::open(&scratch("queued-clear")).unwrap();
        let rule = keep(5, ReadHistoryRetention::KeepLimit);
        let queued = history.generation();
        history.clear().unwrap();
        assert_eq!(
            history
                .record(&read_at("queued"), queued, || rule, NOW)
                .unwrap(),
            None
        );
        assert!(history.entries().unwrap().is_empty());
        let fresh = history.generation();
        assert!(history
            .record(&read_at("fresh"), fresh, || rule, NOW)
            .unwrap()
            .is_some());
    }

    #[test]
    fn opening_the_store_never_holds_up_the_caller() {
        let dir = scratch("background-open");
        let (release, released) = mpsc::channel::<()>();
        let (opened, open_done) = mpsc::channel();
        let slot = HistorySlot::open_in_background(move || {
            let _ = released.recv_timeout(Duration::from_secs(5));
            let history = ReadHistory::open(&dir)
                .map(Arc::new)
                .map_err(|e| e.to_string());
            opened.send(()).unwrap();
            history
        });
        assert_eq!(slot.get().err().as_deref(), Some("tts.errors.starting"));
        release.send(()).unwrap();
        open_done.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut open = slot.get();
        for _ in 0..100 {
            if open.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            open = slot.get();
        }
        assert!(open.is_ok());
    }

    fn snapshot(document: u64, technical: bool, model_id: &str, voice: &str) -> ReadSnapshot {
        ReadSnapshot {
            document,
            timestamp: NOW,
            source: Arc::from("Edit lib.sh today."),
            origin: ReadOrigin::App,
            selection: Selection {
                model_id: model_id.into(),
                voice: voice.into(),
                speed: 1.0,
                pitch: 0.0,
                output_device: None,
                read_code: false,
                technical,
                full_paths: true,
                full_links: false,
                tables: handy_tts_core::formatted::tables::TableStyle::NameEach,
            },
            vocabulary: Some(Arc::new(Vocabulary::builtin())),
        }
    }

    fn open_slot(name: &str) -> Arc<HistorySlot> {
        HistorySlot::ready(Arc::new(ReadHistory::open(&scratch(name)).unwrap()))
    }

    #[test]
    fn keep_nothing_prepares_nothing() {
        let slot = open_slot("writer-nothing");
        let prepared = std::cell::Cell::new(0);
        let mut writer = Writer::new(
            slot.clone(),
            || keep(5, ReadHistoryRetention::KeepNothing),
            |snapshot: &ReadSnapshot| {
                prepared.set(prepared.get() + 1);
                prepare(snapshot)
            },
        );
        writer.write(0, &snapshot(1, true, "supertonic-3", "F1"));
        assert_eq!(prepared.get(), 0);
        let history = slot.get().unwrap();
        assert!(history.entries().unwrap().is_empty());
    }

    #[test]
    fn a_document_is_saved_again_only_when_its_reading_or_voice_changes() {
        let slot = open_slot("writer-dedup");
        let mut writer = Writer::new(
            slot.clone(),
            || keep(5, ReadHistoryRetention::KeepLimit),
            prepare,
        );
        writer.write(0, &snapshot(1, true, "supertonic-3", "F1"));
        writer.write(0, &snapshot(1, true, "supertonic-3", "F1"));
        assert_eq!(slot.get().unwrap().entries().unwrap().len(), 1);
        writer.write(0, &snapshot(1, false, "supertonic-3", "F1"));
        writer.write(0, &snapshot(1, false, "pocket-en", "alba"));
        writer.write(0, &snapshot(2, false, "pocket-en", "alba"));
        let entries = slot.get().unwrap().entries().unwrap();
        assert_eq!(entries.len(), 4);
        assert!(entries[3].chunks[0].chunk.text.contains("lib dot S H"));
        assert!(entries[2].chunks[0].chunk.text.contains("lib.sh"));
    }

    #[test]
    fn a_read_queued_while_the_store_opens_is_saved() {
        let dir = scratch("queued-while-opening");
        let (release, released) = mpsc::channel::<()>();
        let slot = HistorySlot::open_in_background(move || {
            let _ = released.recv_timeout(Duration::from_secs(10));
            ReadHistory::open(&dir)
                .map(Arc::new)
                .map_err(|e| e.to_string())
        });
        let (asked, keep_asked) = mpsc::channel();
        let asked = Mutex::new(asked);
        let save = recorder(
            slot.clone(),
            move || {
                let _ = asked.lock().unwrap().send(());
                keep(5, ReadHistoryRetention::KeepLimit)
            },
            prepare,
        );
        save(snapshot(1, true, "supertonic-3", "F1"));
        keep_asked.recv_timeout(Duration::from_secs(3)).unwrap();
        // The writer has passed its keep check and reached the store before it is opened.
        std::thread::sleep(Duration::from_millis(200));
        release.send(()).unwrap();
        let history = slot.wait().unwrap();
        let mut stored = history.entries().unwrap().len();
        for _ in 0..100 {
            if stored > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
            stored = history.entries().unwrap().len();
        }
        assert_eq!(stored, 1);
    }

    /// The schema exactly as migration 1 created it (frozen here: the fixture must not follow
    /// later edits to the migration list).
    const VERSION_1_SQL: &str = "CREATE TABLE read_history (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        voice TEXT NOT NULL,
        speed REAL NOT NULL,
        technical INTEGER NOT NULL,
        source TEXT NOT NULL,
        chunks TEXT NOT NULL
    );";

    /// The rows the version-1 fixture holds: (id, timestamp, model, voice, speed, technical, source, chunks).
    type OldRow = (
        i64,
        i64,
        &'static str,
        &'static str,
        f64,
        i64,
        &'static str,
        &'static str,
    );
    const OLD_ROWS: [OldRow; 2] = [
        (
            7,
            NOW - DAY,
            "pocket-en",
            "alba",
            1.25,
            1,
            "Old read one.",
            "[]",
        ),
        (9, NOW, "supertonic-3", "F1", 1.0, 0, "Old read two.", "[]"),
    ];

    /// A `tts-history.db` as version 1 of the app left it, holding [`OLD_ROWS`], closed.
    fn version_1_database(name: &str) -> PathBuf {
        let dir = scratch(name);
        let mut conn = Connection::open(dir.join(FILE_NAME)).unwrap();
        Migrations::new(vec![M::up(VERSION_1_SQL)])
            .to_latest(&mut conn)
            .unwrap();
        for row in OLD_ROWS {
            conn.execute(
                "INSERT INTO read_history (id, timestamp, model_id, voice, speed, technical, source, chunks)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7],
            )
            .unwrap();
        }
        assert_eq!(user_version(&conn), 1);
        drop(conn);
        dir
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn migration_keeps_old_rows_as_app() {
        let dir = version_1_database("origin-migration");
        let history = ReadHistory::open(&dir).unwrap();
        let entries = history.entries().unwrap();
        assert_eq!(entries.len(), 2);
        for (entry, row) in entries.iter().zip(OLD_ROWS.iter().rev()) {
            assert_eq!(entry.id, row.0);
            assert_eq!(entry.timestamp, row.1);
            assert_eq!(entry.model_id, row.2);
            assert_eq!(entry.voice, row.3);
            assert_eq!(f64::from(entry.speed), row.4);
            assert_eq!(entry.technical, row.5 == 1);
            assert_eq!(entry.source, row.6);
            assert!(entry.chunks.is_empty());
            assert_eq!(entry.origin, ReadOrigin::App);
        }
        drop(history);
        let conn = Connection::open(dir.join(FILE_NAME)).unwrap();
        assert_eq!(user_version(&conn), 2);
        let stored: Vec<(i64, String)> = conn
            .prepare("SELECT id, origin FROM read_history ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(stored, vec![(7, "app".to_string()), (9, "app".to_string())]);
    }

    #[test]
    fn reopening_a_migrated_store_changes_nothing() {
        let dir = version_1_database("origin-reopen");
        let first = ReadHistory::open(&dir).unwrap().entries().unwrap();
        let second = ReadHistory::open(&dir).unwrap().entries().unwrap();
        assert_eq!(first, second);
        assert_eq!(second.len(), 2);
    }

    #[test]
    fn version_1_code_refuses_a_migrated_store_and_leaves_its_rows() {
        let dir = version_1_database("origin-downgrade");
        let history = ReadHistory::open(&dir).unwrap();
        history
            .record(
                &ReadRecord {
                    origin: ReadOrigin::Agent,
                    ..read_at("from an agent")
                },
                0,
                || keep(100, ReadHistoryRetention::KeepLimit),
                NOW,
            )
            .unwrap();
        drop(history);
        // What 0.1.0 ran: one migration. A database at version 2 is refused, not rewritten.
        let mut conn = Connection::open(dir.join(FILE_NAME)).unwrap();
        let old_app = Migrations::new(vec![M::up(VERSION_1_SQL)]).to_latest(&mut conn);
        assert!(
            old_app.is_err(),
            "version-1 code accepted a version-2 store"
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM read_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 3);
        let sources: Vec<String> = conn
            .prepare("SELECT source FROM read_history ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(sources, ["Old read one.", "Old read two.", "from an agent"]);
        assert_eq!(user_version(&conn), 2);
    }

    #[test]
    fn agent_origin_round_trips() {
        let history = ReadHistory::open(&scratch("origin-agent")).unwrap();
        let rule = keep(5, ReadHistoryRetention::KeepLimit);
        let agent = ReadRecord {
            origin: ReadOrigin::Agent,
            ..read_at("agent read")
        };
        history.record(&agent, 0, || rule, NOW).unwrap();
        history
            .record(&read("own read", NOW - 1), 0, || rule, NOW)
            .unwrap();
        let entries = history.entries().unwrap();
        assert_eq!(entries[0].origin, ReadOrigin::Agent);
        assert_eq!(entries[1].origin, ReadOrigin::App);
    }

    #[test]
    fn unknown_stored_origin_reads_as_app() {
        assert_eq!(ReadOrigin::from_stored("robot"), ReadOrigin::App);
        assert_eq!(ReadOrigin::from_stored(""), ReadOrigin::App);
        assert_eq!(ReadOrigin::from_stored("agent"), ReadOrigin::Agent);
        assert_eq!(ReadOrigin::from_stored("app"), ReadOrigin::App);
        assert_eq!(ReadOrigin::App.as_str(), "app");
        assert_eq!(ReadOrigin::Agent.as_str(), "agent");
        assert_eq!(ReadOrigin::default(), ReadOrigin::App);
    }

    #[test]
    fn the_origin_serializes_in_lower_case() {
        assert_eq!(
            serde_json::to_string(&ReadOrigin::Agent).unwrap(),
            "\"agent\""
        );
        assert_eq!(serde_json::to_string(&ReadOrigin::App).unwrap(), "\"app\"");
    }

    #[test]
    fn writer_saves_the_snapshot_origin() {
        let slot = open_slot("writer-origin");
        let mut writer = Writer::new(
            slot.clone(),
            || keep(5, ReadHistoryRetention::KeepLimit),
            prepare,
        );
        writer.write(
            0,
            &ReadSnapshot {
                origin: ReadOrigin::Agent,
                ..snapshot(1, true, "supertonic-3", "F1")
            },
        );
        writer.write(0, &snapshot(2, true, "supertonic-3", "F1"));
        let entries = slot.get().unwrap().entries().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].origin, ReadOrigin::App);
        assert_eq!(entries[1].origin, ReadOrigin::Agent);
    }
}
