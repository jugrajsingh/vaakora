//! Background transcriptions (a file, or an entry transcribed again), one at
//! a time in chunks that yield to dictation. Progress is kept in memory.

use anyhow::{anyhow, Result};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cell::Cell;
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::actions::process_transcription_output;
use crate::audio_toolkit::{decode_audio_file, read_wav_samples, save_wav_file};
use crate::managers::history::{HistoryEntry, HistoryManager};
use crate::managers::transcription::{
    panic_payload_message, ChunkControl, Transcription, TranscriptionManager,
};
use crate::notices::{self, Notice, NoticeCode, NoticeSource};

/// How often a waiting chunk checks whether dictation has finished.
const DICTATION_POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TranscriptionJobStatus {
    /// Waiting behind another job.
    Queued,
    /// `percent` of the audio is transcribed.
    Running {
        percent: u8,
    },
    /// The entry has its new text, or the job was cancelled.
    Finished,
    Failed {
        error: String,
    },
}

/// A background transcription of one History entry.
#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct TranscriptionJob {
    pub entry_id: i64,
    pub status: TranscriptionJobStatus,
}

/// Why a file could not be added to History.
#[derive(Debug, thiserror::Error)]
pub enum AddFileError {
    /// There is no audio in the file that can be decoded.
    #[error("{0}")]
    NoAudio(String),
    /// The recording or its History entry could not be saved.
    #[error("{0}")]
    Storage(String),
}

/// Who waits for the end of an entry's job. A watcher is told every status
/// of its entry up to `Finished` or `Failed`, then dropped.
#[derive(Default)]
pub(crate) struct JobWatchers(Mutex<Vec<(i64, mpsc::Sender<TranscriptionJobStatus>)>>);

impl JobWatchers {
    fn lock(&self) -> MutexGuard<'_, Vec<(i64, mpsc::Sender<TranscriptionJobStatus>)>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts watching `entry_id`: the statuses arrive on the receiver.
    pub(crate) fn add(&self, entry_id: i64) -> mpsc::Receiver<TranscriptionJobStatus> {
        let (sender, receiver) = mpsc::channel();
        self.lock().push((entry_id, sender));
        receiver
    }

    /// Sends `status` to the watchers of `entry_id`. A watcher is removed
    /// after the end of the job, and when nobody listens any more.
    pub(crate) fn notify(&self, entry_id: i64, status: &TranscriptionJobStatus) {
        let ends = matches!(
            status,
            TranscriptionJobStatus::Finished | TranscriptionJobStatus::Failed { .. }
        );
        self.lock().retain(|(id, sender)| {
            *id != entry_id || (sender.send(status.clone()).is_ok() && !ends)
        });
    }
}

struct Running {
    entry_id: i64,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub(super) struct Jobs {
    /// Entry ids waiting to be transcribed again. They go before files:
    /// someone is waiting on them.
    retries: VecDeque<i64>,
    /// Entry ids of files waiting to be transcribed.
    files: VecDeque<i64>,
    running: Option<Running>,
}

impl Jobs {
    pub(super) fn queue(&mut self, entry_id: i64, retry: bool) -> bool {
        if self.has(entry_id) {
            return false;
        }
        if retry {
            self.retries.push_back(entry_id);
        } else {
            self.files.push_back(entry_id);
        }
        true
    }

    pub(super) fn start_next(&mut self) -> Option<(i64, Arc<AtomicBool>)> {
        let entry_id = self
            .retries
            .pop_front()
            .or_else(|| self.files.pop_front())?;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.running = Some(Running {
            entry_id,
            cancelled: Arc::clone(&cancelled),
        });
        Some((entry_id, cancelled))
    }

    pub(super) fn cancel(&mut self, entry_id: i64) -> bool {
        let was_queued = self.unqueue(entry_id);
        if let Some(running) = self.running.as_ref().filter(|r| r.entry_id == entry_id) {
            running.cancelled.store(true, Ordering::Release);
        }
        was_queued
    }

    pub(super) fn sync_active(&self, set_active: impl FnOnce(bool)) {
        set_active(!self.is_idle());
    }

    pub(super) fn finish(&mut self, set_active: impl FnOnce(bool)) -> bool {
        self.running = None;
        self.sync_active(set_active);
        self.is_idle()
    }

    fn has(&self, entry_id: i64) -> bool {
        self.running
            .as_ref()
            .is_some_and(|r| r.entry_id == entry_id)
            || self.retries.contains(&entry_id)
            || self.files.contains(&entry_id)
    }

    fn is_idle(&self) -> bool {
        self.running.is_none() && self.retries.is_empty() && self.files.is_empty()
    }

    /// Drops the entry from the queues; whether it was in one.
    fn unqueue(&mut self, entry_id: i64) -> bool {
        let before = self.retries.len() + self.files.len();
        self.retries.retain(|&id| id != entry_id);
        self.files.retain(|&id| id != entry_id);
        self.retries.len() + self.files.len() != before
    }
}

pub struct TranscriptionJobManager {
    app: AppHandle,
    jobs: Mutex<Jobs>,
    wake: Condvar,
    watchers: JobWatchers,
}

impl TranscriptionJobManager {
    /// Starts the thread that runs the jobs.
    pub fn new(app: &AppHandle) -> Arc<Self> {
        let manager = Arc::new(Self {
            app: app.clone(),
            jobs: Mutex::new(Jobs::default()),
            wake: Condvar::new(),
            watchers: JobWatchers::default(),
        });
        let runner = Arc::clone(&manager);
        thread::Builder::new()
            .name("transcription-jobs".into())
            .spawn(move || runner.run_jobs())
            .expect("Failed to start the transcription job thread");
        manager
    }

    fn lock(&self) -> MutexGuard<'_, Jobs> {
        self.jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Decodes `path` into a recording, then adds it to History and queues
    /// it. The recording exists first, so no entry is ever without audio.
    pub fn transcribe_file(&self, path: PathBuf) -> Result<HistoryEntry, AddFileError> {
        let entry = self.add_file(&path)?;
        self.queue_file(entry.id);
        Ok(entry)
    }

    /// Like `transcribe_file`, and the statuses of the job arrive on the
    /// receiver, from `Queued` on: the watcher exists before the job is
    /// queued, so none is missed.
    pub fn transcribe_file_watched(
        &self,
        path: PathBuf,
    ) -> Result<(HistoryEntry, mpsc::Receiver<TranscriptionJobStatus>), AddFileError> {
        let entry = self.add_file(&path)?;
        let statuses = self.watchers.add(entry.id);
        self.queue_file(entry.id);
        Ok((entry, statuses))
    }

    /// The History entry of the file, with its recording; not yet queued.
    fn add_file(&self, path: &Path) -> Result<HistoryEntry, AddFileError> {
        let samples = decode_samples(path, decode_audio_file)?;

        let hm = self.app.state::<Arc<HistoryManager>>();
        let file_name = format!("handy-file-{}.wav", chrono::Utc::now().timestamp_millis());
        let recording = hm.get_audio_file_path(&file_name);
        store_recording(&recording, &samples)?;
        drop(samples);

        let source_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        entry_or_cleanup(&recording, hm.save_file_entry(file_name, source_name))
    }

    fn queue_file(&self, entry_id: i64) {
        info!("Queued file transcription for history entry {}", entry_id);
        self.queue(entry_id, false);
    }

    /// Queues the entry to be transcribed again from its recording, ahead
    /// of any file.
    pub fn retry(&self, entry_id: i64) {
        self.queue(entry_id, true);
    }

    /// Queues the entry to be transcribed from its recording, unless it
    /// already is.
    fn queue(&self, entry_id: i64, retry: bool) {
        {
            let mut jobs = self.lock();
            if !jobs.queue(entry_id, retry) {
                return;
            }
            self.sync_job_active(&jobs);
        }
        self.emit(entry_id, TranscriptionJobStatus::Queued);
        crate::tray::update_tray_menu(&self.app);
        self.wake.notify_one();
    }

    /// Stops the entry's job: a queued one is dropped, a running one stops
    /// before its next chunk.
    pub fn cancel(&self, entry_id: i64) {
        let (was_queued, idle) = {
            let mut jobs = self.lock();
            let was_queued = jobs.cancel(entry_id);
            self.sync_job_active(&jobs);
            (was_queued, jobs.is_idle())
        };
        // A running job reports its own end from the job loop; a queued one
        // never reaches it, so it is reported here.
        if was_queued {
            if idle && !crate::tray::dictation_in_progress(&self.app) {
                self.app
                    .state::<Arc<TranscriptionManager>>()
                    .maybe_unload_immediately("background transcription");
            }
            crate::tray::update_tray_menu(&self.app);
            self.emit(entry_id, TranscriptionJobStatus::Finished);
        }
    }

    /// Keeps the model held for as long as any job is queued or running.
    fn sync_job_active(&self, jobs: &Jobs) {
        jobs.sync_active(|active| {
            self.app
                .state::<Arc<TranscriptionManager>>()
                .set_job_active(active);
        });
    }

    fn emit(&self, entry_id: i64, status: TranscriptionJobStatus) {
        self.watchers.notify(entry_id, &status);
        if let Err(e) = (TranscriptionJob { entry_id, status }).emit(&self.app) {
            error!("Failed to emit transcription job event: {}", e);
        }
    }

    fn run_jobs(&self) {
        loop {
            let (entry_id, cancelled) = {
                let mut jobs = self.lock();
                loop {
                    if let Some(job) = jobs.start_next() {
                        break job;
                    }
                    jobs = self
                        .wake
                        .wait(jobs)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            };
            self.emit(entry_id, TranscriptionJobStatus::Running { percent: 0 });

            // A panic fails only this job; the rest of the loop still has to
            // run, or the model would stay held and the queue stuck.
            let status = execute_job(
                entry_id,
                &cancelled,
                || self.run_job(entry_id, &cancelled),
                || {
                    let tm = self.app.state::<Arc<TranscriptionManager>>();
                    let idle = self.lock().finish(|active| tm.set_job_active(active));
                    if idle {
                        // A dictation under way unloads the model itself when it ends.
                        if !crate::tray::dictation_in_progress(&self.app) {
                            tm.maybe_unload_immediately("background transcription");
                        }
                        crate::tray::update_tray_menu(&self.app);
                    }
                },
                |notice| match notice {
                    Some(notice) => notices::raise(&self.app, notice),
                    None => notices::clear(&self.app, NoticeSource::File),
                },
            );
            self.emit(entry_id, status);
        }
    }

    fn run_job(&self, entry_id: i64, cancelled: &AtomicBool) -> Result<JobEnd> {
        let hm = Arc::clone(&self.app.state::<Arc<HistoryManager>>());
        let tm = Arc::clone(&self.app.state::<Arc<TranscriptionManager>>());
        let entry = tauri::async_runtime::block_on(hm.get_entry_by_id(entry_id))?
            .ok_or_else(|| anyhow!("History entry {} not found", entry_id))?;
        let samples = read_wav_samples(hm.get_audio_file_path(&entry.file_name))
            .map_err(|e| anyhow!("Failed to load audio: {}", e))?;
        if samples.is_empty() {
            return Err(anyhow!("Recording has no audio samples"));
        }

        let control = Control {
            manager: self,
            entry_id: entry.id,
            cancelled,
            percent: Cell::new(0),
        };
        let Some(Transcription { text, language }) = tm.transcribe_in_chunks(samples, &control)?
        else {
            return Ok(JobEnd::Cancelled);
        };
        if text.is_empty() {
            return Err(anyhow!("Recording contains no speech"));
        }
        if cancelled.load(Ordering::Acquire) {
            return Ok(JobEnd::Cancelled);
        }

        let processed = tauri::async_runtime::block_on(process_transcription_output(
            &self.app,
            &text,
            entry.post_process_requested,
        ));
        // Post-processing can take a while; a cancel during it still wins.
        if cancelled.load(Ordering::Acquire) {
            return Ok(JobEnd::Cancelled);
        }
        let post_process_failed = processed.post_process_failed;
        hm.update_transcription(
            entry.id,
            text,
            processed.post_processed_text,
            processed.post_process_prompt,
            language,
            processed.provenance,
        )?;
        Ok(JobEnd::Finished {
            post_process_failed,
        })
    }
}

/// A cancelled job changes no notices.
pub(super) enum JobEnd {
    Finished { post_process_failed: bool },
    Cancelled,
}

pub(super) fn execute_job(
    entry_id: i64,
    cancelled: &AtomicBool,
    run: impl FnOnce() -> Result<JobEnd>,
    finish: impl FnOnce(),
    mut notify: impl FnMut(Option<Notice>),
) -> TranscriptionJobStatus {
    let result = catch_unwind(AssertUnwindSafe(run))
        .unwrap_or_else(|payload| Err(crashed(payload.as_ref())));
    finish();
    match result {
        Err(e) if !cancelled.load(Ordering::Acquire) => {
            warn!("Transcription of history entry {} failed: {}", entry_id, e);
            notify(Some(
                Notice::new(NoticeCode::FileTranscriptionFailed, NoticeSource::File)
                    .with_detail(e.to_string()),
            ));
            TranscriptionJobStatus::Failed {
                error: e.to_string(),
            }
        }
        Ok(JobEnd::Finished {
            post_process_failed,
        }) => {
            // Clear first, so the warning about this job survives it.
            notify(None);
            if post_process_failed {
                notify(Some(Notice::new(
                    NoticeCode::FilePostProcessFailed,
                    NoticeSource::File,
                )));
            }
            TranscriptionJobStatus::Finished
        }
        _ => TranscriptionJobStatus::Finished,
    }
}

/// The samples `decode` reads from `path`. A malformed file may panic the
/// decoder; that and a file without audio are refused like any decode error.
fn decode_samples(
    path: &Path,
    decode: impl FnOnce(&Path) -> Result<Vec<f32>>,
) -> Result<Vec<f32>, AddFileError> {
    let samples = catch_unwind(AssertUnwindSafe(|| decode(path)))
        .unwrap_or_else(|payload| {
            Err(anyhow!(
                "Failed to read the file: {}",
                panic_payload_message(payload.as_ref())
            ))
        })
        .map_err(|e| AddFileError::NoAudio(e.to_string()))?;
    if samples.is_empty() {
        return Err(AddFileError::NoAudio("The file has no audio".into()));
    }
    Ok(samples)
}

/// Writes the samples to `recording`, aside and renamed, so a crash never
/// leaves a partial one.
fn store_recording(recording: &Path, samples: &[f32]) -> Result<(), AddFileError> {
    let partial = recording.with_extension("wav.partial");
    save_wav_file(&partial, samples)
        .and_then(|()| std::fs::rename(&partial, recording).map_err(Into::into))
        .map_err(|e| {
            remove_recording(&partial);
            AddFileError::Storage(e.to_string())
        })
}

/// The saved entry; when History refused it, the recording goes too.
fn entry_or_cleanup<T>(recording: &Path, saved: Result<T>) -> Result<T, AddFileError> {
    saved.map_err(|e| {
        remove_recording(recording);
        AddFileError::Storage(e.to_string())
    })
}

/// Best-effort cleanup; the caller is already reporting the failure.
fn remove_recording(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            error!("Failed to remove {}: {}", path.display(), e);
        }
    }
}

fn crashed(payload: &(dyn std::any::Any + Send)) -> anyhow::Error {
    anyhow!("Transcription crashed: {}", panic_payload_message(payload))
}

struct Control<'a> {
    manager: &'a TranscriptionJobManager,
    entry_id: i64,
    cancelled: &'a AtomicBool,
    /// The last percent reported; the job starts at 0.
    percent: Cell<u8>,
}

impl ChunkControl for Control<'_> {
    fn proceed(&self) -> bool {
        // Dictation goes first: wait out a recording and its transcription.
        // A chunk started while a stream is open would end that stream.
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return false;
            }
            if !crate::tray::dictation_in_progress(&self.manager.app) {
                return true;
            }
            thread::sleep(DICTATION_POLL);
        }
    }

    fn progress(&self, done: usize, total: usize) {
        // The chunk a cancel caught still finishes; don't report it as running.
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        let percent = (done * 100 / total.max(1)).min(100) as u8;
        if self.percent.replace(percent) == percent {
            return;
        }
        self.manager
            .emit(self.entry_id, TranscriptionJobStatus::Running { percent });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(error: &AddFileError) -> &str {
        match error {
            AddFileError::NoAudio(text) | AddFileError::Storage(text) => text,
        }
    }

    mod decoding {
        use super::*;

        #[test]
        fn a_decoder_error_is_no_audio_with_its_message() {
            let error =
                decode_samples(Path::new("a.wav"), |_| Err(anyhow!("bad header"))).unwrap_err();
            assert!(matches!(error, AddFileError::NoAudio(_)), "{error:?}");
            assert_eq!(text_of(&error), "bad header");
        }

        #[test]
        fn a_decoder_panic_is_no_audio_with_its_message() {
            let error = decode_samples(Path::new("a.wav"), |_| panic!("boom")).unwrap_err();
            assert!(matches!(error, AddFileError::NoAudio(_)), "{error:?}");
            assert_eq!(text_of(&error), "Failed to read the file: boom");
        }

        #[test]
        fn a_file_without_samples_is_no_audio() {
            let error = decode_samples(Path::new("a.wav"), |_| Ok(Vec::new())).unwrap_err();
            assert!(matches!(error, AddFileError::NoAudio(_)), "{error:?}");
            assert_eq!(text_of(&error), "The file has no audio");
        }

        #[test]
        fn samples_pass_through() {
            let samples = decode_samples(Path::new("a.wav"), |_| Ok(vec![0.25, -0.25])).unwrap();
            assert_eq!(samples, vec![0.25, -0.25]);
        }
    }

    mod storing {
        use super::*;

        #[test]
        fn the_recording_is_renamed_into_place() {
            let dir = tempfile::tempdir().unwrap();
            let recording = dir.path().join("handy-file-1.wav");
            store_recording(&recording, &[0.1, 0.2, 0.3]).unwrap();
            assert!(recording.exists());
            assert!(!recording.with_extension("wav.partial").exists());
        }

        #[test]
        fn a_failed_save_is_storage_and_leaves_nothing() {
            let dir = tempfile::tempdir().unwrap();
            let recording = dir.path().join("missing-dir").join("handy-file-1.wav");
            let error = store_recording(&recording, &[0.1]).unwrap_err();
            assert!(matches!(error, AddFileError::Storage(_)), "{error:?}");
            assert!(!recording.exists());
            assert!(!recording.with_extension("wav.partial").exists());
        }

        #[test]
        fn a_failed_rename_is_storage_and_removes_the_partial_file() {
            let dir = tempfile::tempdir().unwrap();
            let recording = dir.path().join("handy-file-1.wav");
            // A directory in the way makes the rename fail after the save succeeded.
            std::fs::create_dir(&recording).unwrap();
            let error = store_recording(&recording, &[0.1]).unwrap_err();
            assert!(matches!(error, AddFileError::Storage(_)), "{error:?}");
            assert!(!recording.with_extension("wav.partial").exists());
        }

        #[test]
        fn a_failed_history_insert_is_storage_and_removes_the_recording() {
            let dir = tempfile::tempdir().unwrap();
            let recording = dir.path().join("handy-file-1.wav");
            std::fs::write(&recording, b"audio").unwrap();
            let error = entry_or_cleanup(&recording, Err(anyhow!("database is locked")))
                .map(|_: ()| ())
                .unwrap_err();
            assert!(matches!(error, AddFileError::Storage(_)), "{error:?}");
            assert_eq!(text_of(&error), "database is locked");
            assert!(!recording.exists());
        }

        #[test]
        fn a_saved_entry_keeps_the_recording() {
            let dir = tempfile::tempdir().unwrap();
            let recording = dir.path().join("handy-file-1.wav");
            std::fs::write(&recording, b"audio").unwrap();
            assert_eq!(entry_or_cleanup(&recording, Ok(7)).unwrap(), 7);
            assert!(recording.exists());
        }
    }

    mod watchers {
        use super::*;
        use std::sync::mpsc::TryRecvError;

        /// The production part of this file, without this test module.
        fn production_source() -> &'static str {
            include_str!("transcription_jobs.rs")
                .split("#[cfg(test)]")
                .next()
                .expect("split always yields a first part")
        }

        /// The text of `fn <name>` up to the next function of the same indent.
        fn body_of<'a>(source: &'a str, name: &str) -> &'a str {
            let start = source
                .find(&format!("fn {name}("))
                .unwrap_or_else(|| panic!("no fn {name}"));
            let rest = &source[start..];
            let end = [rest[1..].find("\n    fn "), rest[1..].find("\n    pub fn ")]
                .into_iter()
                .flatten()
                .min()
                .map_or(rest.len(), |at| at + 1);
            &rest[..end]
        }

        #[test]
        fn watchers_get_statuses_until_the_end() {
            let watchers = JobWatchers::default();
            let rx = watchers.add(7);
            watchers.notify(7, &TranscriptionJobStatus::Running { percent: 0 });
            watchers.notify(7, &TranscriptionJobStatus::Finished);
            watchers.notify(7, &TranscriptionJobStatus::Queued);
            assert_eq!(
                rx.try_recv().unwrap(),
                TranscriptionJobStatus::Running { percent: 0 }
            );
            assert_eq!(rx.try_recv().unwrap(), TranscriptionJobStatus::Finished);
            assert_eq!(rx.try_recv(), Err(TryRecvError::Disconnected));
        }

        #[test]
        fn a_failure_ends_the_watch_too() {
            let watchers = JobWatchers::default();
            let rx = watchers.add(7);
            let failed = TranscriptionJobStatus::Failed {
                error: "no speech".into(),
            };
            watchers.notify(7, &failed);
            watchers.notify(7, &TranscriptionJobStatus::Queued);
            assert_eq!(rx.try_recv().unwrap(), failed);
            assert_eq!(rx.try_recv(), Err(TryRecvError::Disconnected));
        }

        #[test]
        fn watchers_ignore_other_entries() {
            let watchers = JobWatchers::default();
            let rx = watchers.add(7);
            watchers.notify(8, &TranscriptionJobStatus::Finished);
            assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));
            // The other entry's end did not drop this watcher.
            watchers.notify(7, &TranscriptionJobStatus::Finished);
            assert_eq!(rx.try_recv().unwrap(), TranscriptionJobStatus::Finished);
        }

        #[test]
        fn every_watcher_of_an_entry_hears_it() {
            let watchers = JobWatchers::default();
            let (first, second) = (watchers.add(7), watchers.add(7));
            watchers.notify(7, &TranscriptionJobStatus::Finished);
            assert_eq!(first.try_recv().unwrap(), TranscriptionJobStatus::Finished);
            assert_eq!(second.try_recv().unwrap(), TranscriptionJobStatus::Finished);
        }

        #[test]
        fn a_watcher_whose_receiver_is_gone_is_removed() {
            let watchers = JobWatchers::default();
            drop(watchers.add(7));
            let kept = watchers.add(7);
            watchers.notify(7, &TranscriptionJobStatus::Queued);
            assert_eq!(watchers.0.lock().unwrap().len(), 1);
            assert_eq!(kept.try_recv().unwrap(), TranscriptionJobStatus::Queued);
        }

        #[test]
        fn watcher_is_added_before_the_job_is_queued() {
            let body = body_of(production_source(), "transcribe_file_watched");
            let add = body.find("watchers.add(").expect("the watcher is added");
            let queue = body.find("self.queue").expect("the job is queued");
            assert!(
                add < queue,
                "the watcher must exist before the job can emit"
            );
        }

        #[test]
        fn emit_notifies_the_watchers_before_the_event() {
            let body = body_of(production_source(), "emit");
            let notify = body.find("self.watchers.notify(").expect("emit notifies");
            let event = body.find(".emit(&self.app)").expect("emit sends the event");
            assert!(notify < event);
        }

        #[test]
        fn the_plain_add_does_not_watch() {
            let body = body_of(production_source(), "transcribe_file");
            assert!(!body.contains("watchers"));
        }
    }

    #[test]
    fn the_messages_are_the_text_inside() {
        assert_eq!(
            AddFileError::NoAudio("The file has no audio".into()).to_string(),
            "The file has no audio"
        );
        assert_eq!(
            AddFileError::Storage("disk full".into()).to_string(),
            "disk full"
        );
    }
}
