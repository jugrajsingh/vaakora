use super::{
    history::ReadOrigin,
    manager::ManagerConfig,
    session::{ReadAloudSession, SessionCommand},
    window, TtsManager,
};
use handy_tts_core::{
    device::{Device, Ratings},
    download::{Downloader, Progress},
    handoff::PasteFence,
    referee::{Activity, Effect, Event, Referee},
    selection::Selection,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};
/// The read-aloud worker the package ships, resolved next to the running
/// binary so an AppImage finds its own copy.
fn installed_worker() -> PathBuf {
    crate::brand::install_dir()
        .join("tts")
        .join(crate::brand::WORKER_BINARY)
}
#[derive(Clone)]
pub struct Ready {
    pub manager: Arc<TtsManager>,
    pub session: Arc<ReadAloudSession>,
    pub root: PathBuf,
    pub ratings: Ratings,
    pub available: Vec<Device>,
    pub preparer: Arc<handy_tts_core::preparation::Preparer>,
}
pub struct TtsService {
    app: tauri::AppHandle,
    ready: Mutex<Result<Ready, String>>,
    refused_shortcut: AtomicBool,
    reading: AtomicBool,
    /// A read's audio is starting, buffering or playing: the tray says
    /// "Reading aloud" when dictation is idle.
    playing: Arc<AtomicBool>,
    tray_refresh: mpsc::SyncSender<()>,
    referee: Mutex<Referee>,
    binding: Mutex<String>,
    pub fence: Arc<PasteFence>,
    pipeline: Mutex<handy_tts_core::handoff::PipelineFence>,
    pub downloader: Downloader,
    vocabulary: Arc<super::vocabulary::UserVocabulary<super::vocabulary::AppHost>>,
    tray: Mutex<handy_tts_core::tray::TtsMenu>,
    preview: Arc<handy_tts_core::preview::PreviewCoordinator>,
    pub cancellations:
        Mutex<std::collections::BTreeMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// Held while a preview or a voice check has a voice model loaded, so one loads at a time.
    voice_slot: Arc<VoiceSlot>,
    pub voice_checks: super::voice_check::RunningCheck,
    pub capture: super::capture::CorrectionCapture<super::capture::AppRecorder>,
    history: Arc<super::history::HistorySlot>,
}
pub(crate) fn selection(settings: &crate::settings::AppSettings) -> Selection {
    Selection {
        model_id: settings.tts_model_id.clone(),
        voice: settings
            .tts_voice
            .get(&settings.tts_model_id)
            .cloned()
            .or_else(|| {
                handy_tts_core::catalog::entry(&settings.tts_model_id)
                    .ok()
                    .map(|entry| entry.default_voice.to_string())
            })
            .unwrap_or_else(|| "alba".into()),
        speed: settings.tts_speed,
        pitch: settings.tts_pitch_semitones,
        output_device: settings.tts_output_device.clone(),
        read_code: settings.tts_read_code_blocks,
        technical: settings.tts_technical_reading,
        full_paths: settings.tts_full_paths,
        full_links: settings.tts_full_links,
        tables: settings.tts_table_style,
    }
}
pub(crate) fn reading_cancel_with(effect: &Effect, set_owner: impl FnOnce(bool)) {
    match effect {
        Effect::OpenPopup { .. } => set_owner(true),
        Effect::ClosePopup => set_owner(false),
        _ => {}
    }
}
pub(crate) fn preview_with(
    reading: &impl handy_tts_core::preview::ReadingControl,
    coordinator: &handy_tts_core::preview::PreviewCoordinator,
    stop: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    launch: impl FnOnce(Arc<std::sync::atomic::AtomicBool>),
) -> Result<(), String> {
    let cancel = coordinator.begin(reading, stop)?;
    launch(cancel);
    Ok(())
}
/// Plays each item in turn, naming its model before it starts and `None` once the sequence ends or
/// is cancelled. A failing item does not stop the rest; the first failure is returned.
pub(crate) fn play_in_turn(
    items: &[(Selection, String)],
    cancel: &AtomicBool,
    on_start: &dyn Fn(Option<String>),
    mut play: impl FnMut(&Selection, &str) -> Result<(), String>,
) -> Result<(), String> {
    let mut first_error = None;
    for (chosen, text) in items {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        on_start(Some(chosen.model_id.clone()));
        if let Err(error) = play(chosen, text) {
            first_error.get_or_insert(error);
        }
    }
    on_start(None);
    first_error.map_or(Ok(()), Err)
}
/// One preview or check voice model loaded at a time: its holder loads, synthesizes and unloads.
#[derive(Default)]
pub(crate) struct VoiceSlot {
    taken: Mutex<bool>,
    freed: std::sync::Condvar,
}
pub(crate) struct SlotGuard<'a>(&'a VoiceSlot);
impl VoiceSlot {
    /// Waits for the slot, or returns `None` as soon as `cancel` is set, so a cancelled preview
    /// never waits out another holder's synthesis.
    pub(crate) fn acquire(&self, cancel: &AtomicBool) -> Option<SlotGuard<'_>> {
        let mut taken = self.taken.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if cancel.load(Ordering::Acquire) {
                return None;
            }
            if !*taken {
                *taken = true;
                return Some(SlotGuard(self));
            }
            taken = self
                .freed
                .wait_timeout(taken, std::time::Duration::from_millis(20))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }
}
impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        *self.0.taken.lock().unwrap_or_else(|p| p.into_inner()) = false;
        self.0.freed.notify_all();
    }
}
/// Synthesizes `text` on `worker` at the selection's speed and pitch and unloads the worker
/// before releasing `slot`, so only one preview or check voice model is loaded at a time. `None`
/// when cancelled.
fn synthesize_alone(
    slot: &VoiceSlot,
    worker: &TtsManager,
    chosen: &Selection,
    text: &str,
    cancel: &AtomicBool,
) -> Result<Option<handy_tts_core::protocol::Pcm>, String> {
    let raw = {
        let Some(_slot) = slot.acquire(cancel) else {
            return Ok(None);
        };
        if cancel.load(Ordering::Acquire) {
            return Ok(None);
        }
        let raw = worker.synthesize(chosen, 1, text);
        worker.unload();
        raw.map_err(|e| e.to_string())?
    };
    if cancel.load(Ordering::Acquire) {
        return Ok(None);
    }
    let model = handy_tts_core::catalog::entry(&chosen.model_id).map_err(|e| e.to_string())?;
    let plan =
        handy_tts_core::speed::plan(chosen.speed, model.native_speed).map_err(|e| e.to_string())?;
    handy_tts_core::dsp::stretch(raw, plan.stretch, chosen.pitch)
        .map(Some)
        .map_err(|e| e.to_string())
}
struct PreviewCompletion(Arc<(Mutex<bool>, std::sync::Condvar)>);
impl Drop for PreviewCompletion {
    fn drop(&mut self) {
        let (finished, wake) = self.0.as_ref();
        *finished.lock().unwrap_or_else(|p| p.into_inner()) = true;
        wake.notify_all();
    }
}
pub(crate) fn dictation_start_with(
    cancel_preview: impl FnOnce() -> Result<(), String>,
    stop_reading: impl FnOnce() -> Result<(), super::TtsError>,
    begin: impl FnOnce(),
    cancel_check: impl FnOnce(),
    cancel_capture: impl FnOnce(),
) -> Result<(), super::TtsError> {
    begin();
    if let Err(error) = cancel_preview() {
        log::warn!("Read-aloud preview stop failed during dictation: {error}");
    }
    cancel_check();
    cancel_capture();
    if let Err(error) = stop_reading() {
        log::warn!("Read-aloud stop acknowledgment failed during dictation: {error}");
    }
    Ok(())
}
fn read_shortcut_with(
    referee: &mut Referee,
    event: Event,
    ready: Result<(), String>,
    refused: &AtomicBool,
    log: impl FnOnce(&str),
    notify: impl FnOnce(),
) -> Vec<Effect> {
    if let Err(error) = ready {
        if !refused.swap(true, Ordering::AcqRel) {
            log(&error);
        }
        notify();
        return Vec::new();
    }
    refused.store(false, Ordering::Release);
    referee.apply(event)
}
/// Sends a popup command to the session. A replacement is remembered as the popup text so a
/// later capture is compared with the owner's edit. Play and autoplay replacements are refused
/// during a dictation.
fn forward_reading_command(
    referee: &mut Referee,
    command: SessionCommand,
    send: impl FnOnce(SessionCommand) -> Result<(), String>,
) -> Result<(), String> {
    if referee.activity == Activity::Dictating
        && matches!(
            command,
            SessionCommand::Play | SessionCommand::Replace { autoplay: true, .. }
        )
    {
        return Err("tts.errors.busy".into());
    }
    if let SessionCommand::Replace { text, .. } = &command {
        referee.popup_text.clone_from(text);
    }
    send(command)
}
/// Sends the reader its text in order with other session commands, then hides a notice still on
/// the overlay and shows the reader in one main-thread job, queued after any notice display.
fn open_popup_with(
    replace: impl FnOnce(),
    run_on_main: impl FnOnce(Box<dyn FnOnce() + Send>),
    dismiss_notice: impl FnOnce() + Send + 'static,
    show: impl FnOnce() + Send + 'static,
) {
    replace();
    run_on_main(Box::new(move || {
        dismiss_notice();
        show();
    }));
}
/// Why a read given its text (the socket) did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalReadError {
    /// Read aloud could not start.
    Unavailable,
    /// The selected voice model is unknown or not downloaded.
    ModelNotInstalled,
    /// A dictation records or completes its output; nothing changed.
    Dictating,
    /// A voice preview could not be stopped.
    Preview(String),
}
/// The session command that loads a popup's text and plays it, marked with who asked for it.
fn popup_replace(text: String, origin: ReadOrigin) -> SessionCommand {
    SessionCommand::Replace {
        client_revision: None,
        text,
        autoplay: true,
        origin,
    }
}
/// Applies a read given its text; during a dictation it is refused and the referee is untouched.
fn read_text_with(referee: &mut Referee, text: String) -> Result<Vec<Effect>, ExternalReadError> {
    if referee.activity == Activity::Dictating {
        return Err(ExternalReadError::Dictating);
    }
    Ok(referee.apply(Event::ReadText { text }))
}
/// Whether the voice model `model_id` is downloaded under `root`; an unknown or empty id is not.
fn model_installed(root: &std::path::Path, model_id: &str) -> bool {
    handy_tts_core::catalog::entry(model_id)
        .is_ok_and(|entry| handy_tts_core::download::is_downloaded(root, entry))
}
struct CaptureReservation<'a>(&'a PasteFence);
impl Drop for CaptureReservation<'_> {
    fn drop(&mut self) {
        self.0.release_capture();
    }
}

fn capture_with(fence: &PasteFence, revision: u64, capture: impl FnOnce(), refused: impl FnOnce()) {
    if !fence.reserve_capture_since(revision) {
        refused();
        return;
    }
    let _reservation = CaptureReservation(fence);
    capture();
}

/// A capture that could not read the clipboard is reported, never read as empty text.
fn capture_event(ticket: u64, text: Result<String, super::TtsError>) -> Event {
    match text {
        Ok(text) => Event::Clipboard { ticket, text },
        Err(_) => Event::ClipboardUnreadable { ticket },
    }
}

fn capture_off_thread(job: impl FnOnce() + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(job)
}
fn apply_ordered(
    referee: &Mutex<Referee>,
    event: Event,
    dispatch: impl FnOnce(&Referee, Vec<Effect>),
) {
    let mut referee = referee.lock().unwrap_or_else(|p| p.into_inner());
    let effects = referee.apply(event);
    dispatch(&referee, effects);
}
fn driver_or_cpu<T, E: std::fmt::Display>(result: Result<Option<T>, E>) -> Option<T> {
    result.unwrap_or_else(|error| {
        log::warn!("NPU driver discovery failed; using no driver: {error}");
        None
    })
}
fn available_or_cpu(output: Option<&str>) -> Vec<Device> {
    let devices = output
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("available").and_then(|v| v.as_array()).cloned());
    let mut result = vec![Device::Cpu];
    if let Some(devices) = devices {
        for value in devices {
            let device = match value.as_str() {
                Some("GPU") => Device::Gpu,
                Some("NPU") => Device::Npu,
                _ => continue,
            };
            if !result.contains(&device) {
                result.push(device);
            }
        }
    }
    result
}
/// Whether the tray shows the read as playing: its audio is starting,
/// buffering or playing and it has not failed. Paused, stopped, finished and
/// failed reads are not.
fn read_playing(snapshot: &handy_tts_core::session::SessionSnapshot) -> bool {
    use handy_tts_core::scheduler::PlaybackState;
    snapshot.error.is_none()
        && matches!(
            snapshot.state,
            PlaybackState::Starting | PlaybackState::Buffering | PlaybackState::Playing
        )
}
/// Records whether a read is playing and calls `changed` when that flips, so
/// the tray re-syncs once per start or end, not on every progress event.
fn note_read_playing(flag: &AtomicBool, playing: bool, changed: impl FnOnce()) {
    if flag.swap(playing, Ordering::AcqRel) != playing {
        changed();
    }
}
/// The read-aloud session's state callback: records whether a read is playing
/// (re-syncing the tray when that flips), then hands the state to the reader.
fn session_events(
    playing: Arc<AtomicBool>,
    resync_tray: impl Fn() + Send + Sync + 'static,
    forward: impl Fn(super::session::SessionEvent) + Send + Sync + 'static,
) -> Arc<dyn Fn(super::session::SessionEvent) + Send + Sync> {
    Arc::new(move |state| {
        note_read_playing(&playing, read_playing(&state.snapshot), &resync_tray);
        forward(state);
    })
}
fn run_tray_refreshes(events: mpsc::Receiver<()>, mut refresh: impl FnMut() -> bool) {
    while events.recv().is_ok() {
        if !refresh() {
            break;
        }
    }
}
/// Ends every Read aloud notice and forgets the reported vocabulary errors with them, so a
/// file that is still broken warns again on the next read.
fn clear_read_aloud_notices<H: super::vocabulary::Host>(
    vocabulary: &super::vocabulary::UserVocabulary<H>,
    clear: impl FnOnce(),
) {
    clear();
    vocabulary.forget();
}
impl TtsService {
    pub fn initialize(app: &tauri::AppHandle) -> Arc<Self> {
        let (tray_refresh, refreshes) = mpsc::sync_channel(1);
        let service = Arc::new(Self {
            app: app.clone(),
            refused_shortcut: AtomicBool::new(false),
            reading: AtomicBool::new(false),
            playing: Arc::new(AtomicBool::new(false)),
            tray_refresh,
            ready: Mutex::new(Err("tts.errors.starting".into())),
            referee: Mutex::new(Referee::default()),
            binding: Mutex::new("transcribe".into()),
            fence: Arc::new(PasteFence::default()),
            pipeline: Mutex::new(handy_tts_core::handoff::PipelineFence::default()),
            downloader: Downloader::default(),
            vocabulary: Arc::new(super::vocabulary::UserVocabulary::new(
                super::vocabulary::AppHost(app.clone()),
            )),
            tray: Mutex::new(handy_tts_core::tray::tts_menu(
                &[],
                None,
                handy_tts_core::lifecycle::State::Unloaded,
            )),
            preview: Arc::new(handy_tts_core::preview::PreviewCoordinator::default()),
            cancellations: Mutex::new(std::collections::BTreeMap::new()),
            voice_slot: Arc::new(VoiceSlot::default()),
            voice_checks: super::voice_check::RunningCheck::default(),
            capture: super::capture::CorrectionCapture::new(super::capture::AppRecorder(
                app.clone(),
            )),
            history: {
                let app = app.clone();
                super::history::HistorySlot::open_in_background(move || {
                    super::history::open_in_app(&app)
                })
            },
        });
        let started = service.clone();
        std::thread::spawn(move || {
            let result = started.boot();
            *started.ready.lock().unwrap_or_else(|p| p.into_inner()) = result;
            started.refresh_tray();
            let weak = Arc::downgrade(&started);
            drop(started);
            run_tray_refreshes(refreshes, || {
                let Some(service) = weak.upgrade() else {
                    return false;
                };
                service.update_tray_snapshot();
                true
            });
        });
        service
    }
    fn boot(&self) -> Result<Ready, String> {
        let settings = crate::settings::get_settings(&self.app);
        let root = self
            .app
            .path()
            .app_data_dir()
            .map_err(|_| "tts.errors.path".to_string())?
            .join("models/tts");
        let home = self
            .app
            .path()
            .home_dir()
            .map_err(|_| "tts.errors.path".to_string())?;
        let cache = self
            .app
            .path()
            .app_cache_dir()
            .map_err(|_| "tts.errors.path".to_string())?
            .join("tts-ov-cache");
        let resource = self
            .app
            .path()
            .resolve(
                "resources/tts/ratings.json",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|_| "tts.errors.path".to_string())?;
        let ratings: Ratings = serde_json::from_slice(
            &std::fs::read(resource).map_err(|_| "tts.errors.invalidRatings".to_string())?,
        )
        .map_err(|_| "tts.errors.invalidRatings".to_string())?;
        let binary = std::env::var_os("HANDY_TTS_WORKER")
            .map(PathBuf::from)
            .unwrap_or_else(installed_worker);
        let mut command = std::process::Command::new(&binary);
        command
            .arg("--list-devices")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let driver_result =
            handy_tts_core::worker_env::discover_driver(&home.join(".local/share/intel-npu"));
        let driver_failed = driver_result.is_err();
        let driver = driver_or_cpu(driver_result);
        let parent = binary
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .as_os_str();
        command.env("LD_LIBRARY_PATH", parent).envs(
            handy_tts_core::worker_env::worker_environment(
                Device::Npu,
                driver.as_ref(),
                Some(parent),
            ),
        );
        if binary.with_file_name("libopenvino_c.so.2641").is_file() {
            command.env(
                "HANDY_OPENVINO_LIBRARY",
                binary.with_file_name("libopenvino_c.so.2641"),
            );
        }
        #[cfg(target_os = "linux")]
        crate::process_supervisor::set_parent_death_signal(&mut command);
        let output = super::clipboard::capture_command_with_timeout(
            command,
            std::time::Duration::from_secs(30),
        )
        .ok();
        let available = available_or_cpu(if driver_failed {
            None
        } else {
            output.as_deref()
        });
        let config = ManagerConfig {
            root: root.clone(),
            binary,
            cache,
            home,
            ratings: ratings.clone(),
            available: available.clone(),
            run_on: settings.tts_run_on.clone(),
        };
        let manager = TtsManager::new(config).map_err(|e| e.to_string())?;
        let app = self.app.clone();
        let session = ReadAloudSession::spawn(
            manager.clone(),
            selection(&settings),
            {
                let app = self.app.clone();
                Arc::new(move || crate::settings::get_settings(&app).selected_output_device)
            },
            {
                let vocabulary = self.vocabulary.clone();
                Arc::new(move || vocabulary.load())
            },
            {
                let app = self.app.clone();
                super::history::recorder(
                    self.history.clone(),
                    move || {
                        super::history::Keep::from_settings(&crate::settings::get_settings(&app))
                    },
                    super::history::prepare,
                )
            },
            session_events(
                self.playing.clone(),
                {
                    let app = self.app.clone();
                    move || crate::tray::update_tray_menu(&app)
                },
                move |state| {
                    let _ = app.emit("read-aloud-state", state);
                },
            ),
        );
        manager.spawn_idle(self.app.clone(), session.busy.clone());
        let app = self.app.clone();
        let position = settings.overlay_position;
        let (created, wait) = mpsc::channel();
        let created = self
            .app
            .run_on_main_thread(move || {
                let _ = created.send(window::create(&app, position));
            })
            .map_err(|_| "tts.errors.window".to_string())
            .and_then(|()| {
                wait.recv_timeout(std::time::Duration::from_secs(30))
                    .unwrap_or_else(|_| Err("tts.errors.window".into()))
            });
        if let Err(error) = created {
            session.shutdown();
            manager.unload();
            return Err(error);
        }
        let refresh = self.tray_refresh.clone();
        manager.on_status_change(Arc::new(move || {
            let _ = refresh.try_send(());
        }));
        self.app.manage(manager.clone());
        self.app.manage(session.clone());
        Ok(Ready {
            manager,
            session,
            root,
            ratings,
            available,
            preparer: Arc::new(handy_tts_core::preparation::Preparer::default()),
        })
    }
    pub fn cancel_preview(&self) -> Result<(), String> {
        self.preview.cancel()
    }
    pub fn reading_command(&self, command: SessionCommand) -> Result<(), String> {
        if matches!(command, SessionCommand::Stop | SessionCommand::Close) {
            return self.preview.stopping_command(|| {
                self.ready()?
                    .session
                    .send(command)
                    .map_err(|e| e.to_string())
            });
        }
        self.preview.reading_command(|| {
            let mut referee = self.referee.lock().unwrap_or_else(|p| p.into_inner());
            forward_reading_command(&mut referee, command, |command| {
                self.ready()?
                    .session
                    .send(command)
                    .map_err(|e| e.to_string())
            })
        })
    }
    pub fn preview(&self, chosen: Selection, text: String) -> Result<(), String> {
        self.preview_sequence(vec![(chosen, text)], Arc::new(|_| {}))
    }
    /// Plays each item in turn on one preview worker, one voice model loaded at a time:
    /// `on_start(Some(id))` before each, `on_start(None)` at the end or on cancel. Dictation and a
    /// read cancel it like a single preview.
    pub fn preview_sequence(
        &self,
        items: Vec<(Selection, String)>,
        on_start: Arc<dyn Fn(Option<String>) + Send + Sync>,
    ) -> Result<(), String> {
        let ready = self.ready()?;
        let preview = ready.manager.fork().map_err(|e| e.to_string())?;
        let completed = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let stop = {
            let preview = preview.clone();
            let completed = completed.clone();
            Arc::new(move || {
                preview.cancel(1);
                preview.interrupt();
                let (finished, wake) = completed.as_ref();
                let finished = finished.lock().unwrap_or_else(|p| p.into_inner());
                let (finished, _) = wake
                    .wait_timeout_while(finished, std::time::Duration::from_secs(5), |finished| {
                        !*finished
                    })
                    .map_err(|_| "tts.errors.generic".to_owned())?;
                if *finished {
                    Ok(())
                } else {
                    Err("tts.errors.generic".into())
                }
            }) as Arc<dyn Fn() -> Result<(), String> + Send + Sync>
        };
        let coordinator = self.preview.clone();
        let app = self.app.clone();
        let slot = self.voice_slot.clone();
        preview_with(ready.session.as_ref(), &self.preview, stop, |cancel| {
            std::thread::spawn(move || {
                let _completed = PreviewCompletion(completed);
                use handy_tts_core::{
                    feed::Segment,
                    playback::segment::{OutputEvent, Playback},
                };
                let result = play_in_turn(&items, &cancel, on_start.as_ref(), |chosen, text| {
                    let Some(pcm) = synthesize_alone(&slot, &preview, chosen, text, &cancel)?
                    else {
                        return Ok(());
                    };
                    let handy = crate::settings::get_settings(&app).selected_output_device;
                    let mut output = Playback::new(
                        super::playback::RodioOutput::default(),
                        chosen.output_device.as_deref(),
                        handy.as_deref(),
                    )
                    .map_err(|e| e.to_string())?;
                    output
                        .output
                        .set_sample_rate(pcm.sample_rate)
                        .map_err(|e| e.to_string())?;
                    if cancel.load(std::sync::atomic::Ordering::Acquire) {
                        return Ok(());
                    }
                    output
                        .append(Segment {
                            epoch: 0,
                            index: 0,
                            speech: pcm.samples,
                            pause: 0,
                        })
                        .map_err(|e| e.to_string())?;
                    while !cancel.load(std::sync::atomic::Ordering::Acquire) {
                        if output
                            .events()
                            .map_err(|e| e.to_string())?
                            .iter()
                            .any(|event| matches!(event, OutputEvent::Finished { index: 0, .. }))
                        {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    output.stop();
                    Ok(())
                });
                preview.unload();
                coordinator.finish(&cancel);
                if let Err(error) = result {
                    if !cancel.load(std::sync::atomic::Ordering::Acquire) {
                        let _ = app.emit("tts-preview-error", error);
                    }
                }
            });
        })
    }
    /// What one voice says for `text`, synthesized on `worker` while no other preview or check
    /// voice model is loaded; `None` when cancelled.
    pub fn synthesize_alone(
        &self,
        worker: &TtsManager,
        chosen: &Selection,
        text: &str,
        cancel: &AtomicBool,
    ) -> Result<Option<handy_tts_core::protocol::Pcm>, String> {
        synthesize_alone(&self.voice_slot, worker, chosen, text, cancel)
    }
    /// The vocabulary a document started now would read with: built-in plus the owner's file.
    pub fn vocabulary(&self) -> Arc<handy_tts_core::vocabulary::Vocabulary> {
        self.vocabulary.load()
    }
    /// Queues a tray refresh after download or selection changes.
    pub fn refresh_tray(&self) {
        let _ = self.tray_refresh.try_send(());
    }
    fn update_tray_snapshot(&self) {
        let Ok(ready) = self.ready() else {
            return;
        };
        let settings = crate::settings::get_settings(&self.app);
        let downloaded = handy_tts_core::catalog::entries()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| handy_tts_core::download::is_downloaded(&ready.root, entry))
                    .map(|entry| (entry.id.to_owned(), entry.name.to_owned()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let desired = handy_tts_core::tray::tts_menu(
            &downloaded,
            Some(&settings.tts_model_id),
            ready.manager.status(),
        );
        let changed = {
            let mut cached = self.tray.lock().unwrap_or_else(|p| p.into_inner());
            if *cached == desired {
                false
            } else {
                *cached = desired;
                true
            }
        };
        if changed {
            crate::tray::update_tray_menu(&self.app);
        }
    }
    /// Returns the tray snapshot updated by download, selection and status events.
    pub fn tray_snapshot(&self) -> handy_tts_core::tray::TtsMenu {
        self.tray.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// Whether a read is playing, for the tray's state line.
    pub fn read_playing(&self) -> bool {
        self.playing.load(Ordering::Acquire)
    }
    /// The read-aloud history store, or why it could not be opened.
    pub fn history(&self) -> Result<Arc<super::history::ReadHistory>, String> {
        self.history.get()
    }
    pub fn ready(&self) -> Result<Ready, String> {
        self.ready.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn is_reading(&self) -> bool {
        self.reading.load(Ordering::Acquire)
    }
    pub fn close(&self) {
        self.apply(Event::Close);
        let _ = self.cancel_preview();
    }
    pub fn apply(&self, event: Event) {
        apply_ordered(&self.referee, event, |referee, effects| {
            self.preview
                .set_dictating(referee.activity == Activity::Dictating);
            self.reading.store(
                referee.popup_open || referee.activity == Activity::Reading,
                Ordering::Release,
            );
            self.dispatch_effects(effects, referee.popup_open, ReadOrigin::App);
        });
    }
    fn refuse(&self, code: crate::notices::NoticeCode, reader_open: bool) {
        crate::notices::raise_beside_reader(
            &self.app,
            crate::notices::Notice::new(code, crate::notices::NoticeSource::ReadAloud),
            reader_open,
        );
    }
    fn dispatch_effects(&self, effects: Vec<Effect>, reader_open: bool, origin: ReadOrigin) {
        for effect in effects {
            reading_cancel_with(&effect, |active| {
                crate::shortcut::cancel::set(
                    &self.app,
                    crate::shortcut::cancel::Owner::Reading,
                    active,
                )
            });
            match effect {
                Effect::StopReading => {
                    if let Ok(ready) = self.ready() {
                        let _ = ready.session.send(SessionCommand::Close);
                    }
                }
                Effect::ClosePopup => {
                    let app = self.app.clone();
                    let _ = self.app.run_on_main_thread(move || window::hide(&app));
                }
                Effect::OpenPopup { text } => {
                    let (overlay_app, reader_app) = (self.app.clone(), self.app.clone());
                    let focus = window::takes_focus(&text);
                    open_popup_with(
                        || {
                            if let Ok(ready) = self.ready() {
                                let _ = ready.session.send(popup_replace(text, origin));
                            }
                        },
                        |job| {
                            let _ = self.app.run_on_main_thread(job);
                        },
                        move || crate::overlay::dismiss_overlay_notice(&overlay_app),
                        move || window::show(&reader_app, focus),
                    )
                }
                Effect::FinishRecording => {
                    if let Some(coordinator) =
                        self.app.try_state::<crate::TranscriptionCoordinator>()
                    {
                        let binding = self
                            .binding
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .clone();
                        coordinator.stop_recording(&binding, "read_aloud");
                    }
                }
                Effect::CaptureRefused => self.refuse(
                    crate::notices::NoticeCode::ReadAloudBusyPasting,
                    reader_open,
                ),
                Effect::ClipboardUnreadable => self.refuse(
                    crate::notices::NoticeCode::ReadAloudClipboardUnreadable,
                    reader_open,
                ),
                Effect::StartDictation | Effect::Capture { .. } => {}
            }
        }
    }
    pub fn read_shortcut(self: &Arc<Self>) {
        self.start_read(Event::ReadShortcut);
    }
    pub fn read_clipboard(self: &Arc<Self>) {
        self.start_read(Event::ReadClipboard);
    }
    /// Reads `text` aloud in the popup, replacing any read, without touching the clipboard; the
    /// read is recorded with `origin`. A read during a dictation is refused and changes nothing.
    pub fn read_text(&self, text: String, origin: ReadOrigin) -> Result<(), ExternalReadError> {
        let ready = self.ready().map_err(|_| ExternalReadError::Unavailable)?;
        let model_id = crate::settings::get_settings(&self.app).tts_model_id;
        if !model_installed(&ready.root, &model_id) {
            return Err(ExternalReadError::ModelNotInstalled);
        }
        self.cancel_preview().map_err(ExternalReadError::Preview)?;
        let mut referee = self.referee.lock().unwrap_or_else(|p| p.into_inner());
        let effects = read_text_with(&mut referee, text)?;
        self.reading.store(
            referee.popup_open || referee.activity == Activity::Reading,
            Ordering::Release,
        );
        clear_read_aloud_notices(&self.vocabulary, || {
            crate::notices::clear(&self.app, crate::notices::NoticeSource::ReadAloud)
        });
        self.dispatch_effects(effects, referee.popup_open, origin);
        Ok(())
    }
    fn start_read(self: &Arc<Self>, event: Event) {
        let revision = self.fence.revision();
        let ticket = {
            let mut referee = self.referee.lock().unwrap_or_else(|p| p.into_inner());
            if self.ready().is_ok() {
                clear_read_aloud_notices(&self.vocabulary, || {
                    crate::notices::clear(&self.app, crate::notices::NoticeSource::ReadAloud)
                });
            }
            let reader_open = referee.popup_open;
            let effects = read_shortcut_with(
                &mut referee,
                event,
                self.ready().map(|_| ()),
                &self.refused_shortcut,
                |error| log::warn!("Read-aloud shortcut refused before readiness: {error}"),
                || {
                    self.refuse(
                        crate::notices::NoticeCode::ReadAloudUnavailable,
                        reader_open,
                    )
                },
            );
            self.reading.store(
                referee.popup_open || referee.activity == Activity::Reading,
                Ordering::Release,
            );
            if let Some(Effect::Capture { ticket }) = effects.first() {
                Some(*ticket)
            } else {
                self.dispatch_effects(effects, referee.popup_open, ReadOrigin::App);
                None
            }
        };
        let service = self.clone();
        capture_off_thread(move || {
            if let Some(ticket) = ticket {
                service.capture_shortcut(ticket, revision);
            } else {
                let _ = service.cancel_preview();
            }
        });
    }
    fn capture_shortcut(self: &Arc<Self>, ticket: u64, revision: u64) {
        capture_with(
            &self.fence,
            revision,
            || {
                #[cfg(target_os = "linux")]
                let text = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                    super::clipboard::capture_wayland()
                } else {
                    let mut command = std::process::Command::new("xclip");
                    command.args(["-selection", "clipboard", "-o", "-t", "UTF8_STRING"]);
                    super::clipboard::capture_clipboard_with_timeout(
                        command,
                        std::time::Duration::from_secs(30),
                    )
                };
                #[cfg(not(target_os = "linux"))]
                let text = {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    super::clipboard::plugin_clipboard_text(self.app.clipboard().read_text())
                };
                if let Err(error) = self.cancel_preview() {
                    let _ = self.app.emit("tts-preview-error", error);
                    self.apply(Event::Close);
                } else {
                    self.apply(capture_event(ticket, text));
                }
            },
            || self.apply(Event::CaptureRefused { ticket }),
        );
    }
    pub fn dictation_start(&self, binding: &str) -> Result<(), super::TtsError> {
        dictation_start_with(
            || self.cancel_preview(),
            || {
                self.ready()
                    .map_or(Ok(()), |ready| ready.session.stop_and_wait())
            },
            || {
                self.pipeline
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .begin();
                *self.binding.lock().unwrap_or_else(|p| p.into_inner()) = binding.into();
                self.apply(Event::DictationStart);
            },
            || self.voice_checks.cancel(),
            || {
                self.capture.cancel();
            },
        )
    }
    /// A dictation records or completes its output.
    pub fn dictating(&self) -> bool {
        self.referee
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .activity
            == Activity::Dictating
    }

    pub fn generation(&self) -> u64 {
        self.pipeline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generation
    }
    pub fn paste_queued(&self, generation: u64) {
        self.pipeline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .queued(generation);
    }
    pub fn pipeline_finished(&self, generation: u64) -> bool {
        let finished = self
            .pipeline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .finish(generation);
        if finished {
            self.dictation_finished();
        }
        finished
    }
    pub fn paste_completed(&self, generation: u64) {
        self.pipeline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pasted(generation);
        if self.pipeline_finished(generation) {
            if let Some(c) = self.app.try_state::<crate::TranscriptionCoordinator>() {
                c.notify_processing_finished();
            }
        }
    }
    pub fn dictation_aborted(&self) {
        self.apply(Event::Cancel);
    }
    pub fn dictation_processing(&self) {
        self.apply(Event::DictationProcessing);
    }
    pub fn dictation_finished(&self) {
        self.apply(Event::DictationFinished);
    }
    pub fn download_progress(&self, progress: Progress) {
        let _ = self.app.emit("tts-download-progress", progress);
    }
    pub fn shutdown(&self) {
        let _ = self.cancel_preview();
        if let Ok(ready) = self.ready() {
            ready.preparer.shutdown();
            let _ = ready.session.shutdown();
            ready.manager.unload();
        }
    }
}

impl handy_tts_core::preview::ReadingControl for ReadAloudSession {
    fn pause_for_preview(&self) -> Result<(), String> {
        self.pause_and_wait().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::NoticeSource;
    use crate::overlay::OverlayHold;
    use crate::tts::vocabulary::{testing, UserVocabulary};
    #[test]
    fn installed_worker_lives_under_the_install_dir() {
        assert_eq!(
            installed_worker(),
            crate::brand::install_dir()
                .join("tts")
                .join(crate::brand::WORKER_BINARY)
        );
        assert!(crate::brand::WORKER_BINARY.starts_with("vaakora"));
    }
    #[test]
    fn clearing_read_aloud_notices_forgets_reported_vocabulary_errors() {
        let dir = testing::scratch("service-forget");
        std::fs::write(dir.join(super::super::vocabulary::FILE_NAME), "{ not json").unwrap();
        let vocabulary = UserVocabulary::new(testing::LogHost::new(&dir));
        let _ = vocabulary.load();
        let _ = vocabulary.load();
        assert_eq!(vocabulary.host().raised(), 1, "a repeat is deduplicated");
        let mut cleared = false;
        clear_read_aloud_notices(&vocabulary, || cleared = true);
        assert!(cleared);
        let _ = vocabulary.load();
        assert_eq!(
            vocabulary.host().raised(),
            2,
            "a file already broken warns again on the first read after the clear"
        );
    }
    #[test]
    fn capture_error_becomes_clipboard_unreadable() {
        assert_eq!(
            capture_event(7, Err(super::super::TtsError::Clipboard)),
            Event::ClipboardUnreadable { ticket: 7 }
        );
        assert_eq!(
            capture_event(7, Ok("copied".into())),
            Event::Clipboard {
                ticket: 7,
                text: "copied".into()
            }
        );
    }
    #[test]
    fn nothing_copied_stays_empty_text_and_other_failures_are_unreadable() {
        use std::{process::Command, time::Duration};
        let event = |command: Command, timeout: Duration| {
            capture_event(
                3,
                super::super::clipboard::capture_clipboard_with_timeout(command, timeout),
            )
        };
        let sh = |script: &str| {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            command
        };
        let second = Duration::from_secs(2);
        assert_eq!(
            event(sh("echo 'Nothing is copied' >&2; exit 1"), second),
            Event::Clipboard {
                ticket: 3,
                text: String::new()
            },
            "a clean non-zero exit is an empty or non-text clipboard"
        );
        let unreadable = Event::ClipboardUnreadable { ticket: 3 };
        assert_eq!(
            event(Command::new("handy-missing-clipboard-tool"), second),
            unreadable,
            "spawn failure"
        );
        assert_eq!(
            event(sh("exec sleep 3"), Duration::from_millis(30)),
            unreadable,
            "timeout"
        );
        assert_eq!(
            event(sh("kill -9 $$"), second),
            unreadable,
            "killed by a signal"
        );
        assert_eq!(
            event(sh("printf '\\377'"), second),
            unreadable,
            "decode failure"
        );
    }
    fn item(model_id: &str) -> (Selection, String) {
        let mut chosen = selection(&crate::settings::get_default_settings());
        chosen.model_id = model_id.into();
        (chosen, "G P U".into())
    }
    #[test]
    fn preview_sequence_announces_each_model_then_none() {
        let announced = Mutex::new(Vec::new());
        let played = std::cell::RefCell::new(Vec::new());
        let result = play_in_turn(
            &[item("supertonic-3"), item("pocket-en")],
            &AtomicBool::new(false),
            &|model| announced.lock().unwrap().push(model),
            |chosen, text| {
                played
                    .borrow_mut()
                    .push((chosen.model_id.clone(), text.to_string()));
                if chosen.model_id == "supertonic-3" {
                    Err("tts.errors.worker".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(
            *announced.lock().unwrap(),
            [
                Some("supertonic-3".to_string()),
                Some("pocket-en".to_string()),
                None
            ]
        );
        assert_eq!(
            *played.borrow(),
            [
                ("supertonic-3".to_string(), "G P U".to_string()),
                ("pocket-en".to_string(), "G P U".to_string())
            ],
            "a failing voice does not stop the next"
        );
        assert_eq!(result, Err("tts.errors.worker".into()));
    }
    #[test]
    fn a_cancelled_sequence_plays_nothing_more_and_ends_with_none() {
        let announced = Mutex::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let result = play_in_turn(
            &[item("supertonic-3"), item("pocket-en")],
            &cancel,
            &|model| announced.lock().unwrap().push(model),
            |_, _| {
                cancel.store(true, Ordering::Release);
                Ok(())
            },
        );
        assert_eq!(result, Ok(()));
        assert_eq!(
            *announced.lock().unwrap(),
            [Some("supertonic-3".to_string()), None]
        );
    }
    #[test]
    fn missing_voice_falls_back_to_the_model_default() {
        let mut settings = crate::settings::get_default_settings();
        settings.tts_model_id = "kokoro-82m-int8".into();
        settings.tts_voice.clear();
        assert_eq!(selection(&settings).voice, "af_heart");
        settings.tts_model_id = "ghost".into();
        assert_eq!(selection(&settings).voice, "alba");
    }
    #[test]
    fn selection_reads_technical_by_default_with_full_paths_and_short_links() {
        let chosen = selection(&crate::settings::get_default_settings());
        assert!(chosen.technical);
        assert!(chosen.full_paths);
        assert!(!chosen.full_links);
    }
    #[test]
    fn selection_follows_the_technical_reading_settings() {
        let mut settings = crate::settings::get_default_settings();
        settings.tts_technical_reading = false;
        settings.tts_full_paths = false;
        settings.tts_full_links = true;
        let chosen = selection(&settings);
        assert!(!chosen.technical);
        assert!(!chosen.full_paths);
        assert!(chosen.full_links);
    }
    #[test]
    fn selection_carries_the_table_style() {
        use handy_tts_core::formatted::tables::TableStyle;
        let mut settings = crate::settings::get_default_settings();
        assert_eq!(selection(&settings).tables, TableStyle::NameEach);
        settings.tts_table_style = TableStyle::NamesOnce;
        assert_eq!(selection(&settings).tables, TableStyle::NamesOnce);
    }
    #[test]
    fn wbfix3_capture_reservation_releases_on_unwind() {
        let fence = PasteFence::default();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            capture_with(
                &fence,
                fence.revision(),
                || panic!("fixture unwind"),
                || panic!("unexpected refusal"),
            );
        }));
        assert!(result.is_err());
        assert!(fence.reserve_capture(), "capture must release on unwind");
        fence.release_capture();
    }

    #[test]
    fn wbfix3_busy_capture_settles_without_changing_dictation() {
        let fence = PasteFence::default();
        let mut referee = Referee::default();
        referee.apply(Event::DictationStart);
        referee.apply(Event::DictationProcessing);
        referee.apply(Event::ReadShortcut);
        let ticket = referee.ticket;
        assert!(
            referee
                .apply(Event::CaptureRefused {
                    ticket: ticket.wrapping_sub(1)
                })
                .is_empty(),
            "stale capture refusal must be ignored"
        );
        assert!(referee.capture_pending);
        assert!(fence.reserve_capture());
        let mut effects = Vec::new();
        capture_with(
            &fence,
            fence.revision(),
            || panic!("busy capture must not read"),
            || {
                effects = referee.apply(Event::CaptureRefused { ticket });
            },
        );
        assert_eq!(
            effects,
            [Effect::CaptureRefused],
            "busy capture must emit a visible refusal"
        );
        assert_eq!(referee.activity, Activity::Dictating);
        assert!(!referee.popup_open && !referee.capture_pending && referee.captured.is_none());
        assert!(
            referee.apply(Event::DictationFinished).is_empty(),
            "refused capture must never open a popup"
        );
        fence.release_capture();
        referee.apply(Event::ReadShortcut);
        assert_eq!(
            referee.apply(Event::Clipboard {
                ticket: referee.ticket,
                text: String::new()
            }),
            [Effect::OpenPopup {
                text: String::new()
            }]
        );
    }

    #[test]
    fn wbfix_shortcut_returns_before_capture_work_finishes() {
        let (release, wait) = mpsc::channel();
        let caller = std::thread::current().id();
        let began = std::time::Instant::now();
        let worker = capture_off_thread(move || {
            assert_ne!(std::thread::current().id(), caller);
            wait.recv().unwrap();
        });
        assert!(began.elapsed() < std::time::Duration::from_millis(50));
        release.send(()).unwrap();
        worker.join().unwrap();
    }
    #[test]
    fn wbfix_referee_effects_cannot_overtake_an_earlier_transition() {
        let referee = Arc::new(Mutex::new(Referee::default()));
        let trace = Arc::new(Mutex::new(Vec::new()));
        let ticket = match referee.lock().unwrap().apply(Event::ReadShortcut)[0] {
            Effect::Capture { ticket } => ticket,
            _ => panic!(),
        };
        let (entered, wait) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let state = referee.clone();
        let observed = trace.clone();
        let capture = std::thread::spawn(move || {
            apply_ordered(
                &state,
                Event::Clipboard {
                    ticket,
                    text: "original".into(),
                },
                |_, effects| {
                    entered.send(()).unwrap();
                    blocked.recv().unwrap();
                    observed.lock().unwrap().extend(effects);
                },
            )
        });
        wait.recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let state = referee.clone();
        let observed = trace.clone();
        let (applied, applied_wait) = mpsc::channel();
        let dictation = std::thread::spawn(move || {
            apply_ordered(&state, Event::DictationStart, |_, effects| {
                observed.lock().unwrap().extend(effects);
                applied.send(()).unwrap();
            })
        });
        let overtook = applied_wait
            .recv_timeout(std::time::Duration::from_millis(100))
            .is_ok();
        release.send(()).unwrap();
        capture.join().unwrap();
        dictation.join().unwrap();
        assert!(!overtook, "effects must dispatch in referee order");
        assert_eq!(
            *trace.lock().unwrap(),
            [
                Effect::OpenPopup {
                    text: "original".into()
                },
                Effect::StopReading,
                Effect::ClosePopup,
                Effect::StartDictation
            ]
        );
        assert!(referee
            .lock()
            .unwrap()
            .apply(Event::Clipboard {
                ticket,
                text: "stale".into()
            })
            .is_empty());
    }
    #[test]
    fn every_refused_press_notifies_but_logs_once() {
        let mut referee = Referee::default();
        let refused = AtomicBool::new(false);
        let logs = std::cell::Cell::new(0);
        let notices = std::cell::Cell::new(0);
        let mut press = |ready: Result<(), String>| {
            read_shortcut_with(
                &mut referee,
                Event::ReadShortcut,
                ready,
                &refused,
                |_| logs.set(logs.get() + 1),
                || notices.set(notices.get() + 1),
            )
        };
        for _ in 0..2 {
            assert!(press(Err("tts.errors.starting".into())).is_empty());
        }
        assert_eq!(
            notices.get(),
            2,
            "unavailable shortcut must report visibly on every press"
        );
        assert_eq!(logs.get(), 1, "a refusal streak logs once");
        assert!(!press(Ok(())).is_empty());
        assert_eq!(notices.get(), 2, "a ready press raises nothing");
        assert!(press(Err("tts.errors.starting".into())).is_empty());
        assert_eq!(
            (logs.get(), notices.get()),
            (2, 3),
            "a ready press ends the refusal streak"
        );
    }
    #[test]
    fn opening_the_reader_hides_a_notice_queued_before_it() {
        type Job = Box<dyn FnOnce() + Send>;
        let main_thread = Mutex::new(std::collections::VecDeque::<Job>::new());
        let notice_visible = Arc::new(AtomicBool::new(false));
        let reader_visible = Arc::new(AtomicBool::new(false));
        let trace = Arc::new(Mutex::new(Vec::new()));
        let shown = notice_visible.clone();
        main_thread
            .lock()
            .unwrap()
            .push_back(Box::new(move || shown.store(true, Ordering::SeqCst)));
        let (hidden, dismissed, opened, reader) = (
            notice_visible.clone(),
            trace.clone(),
            trace.clone(),
            reader_visible.clone(),
        );
        open_popup_with(
            || trace.lock().unwrap().push("replace"),
            |job| main_thread.lock().unwrap().push_back(job),
            move || {
                hidden.store(false, Ordering::SeqCst);
                dismissed.lock().unwrap().push("dismiss");
            },
            move || {
                reader.store(true, Ordering::SeqCst);
                opened.lock().unwrap().push("show");
            },
        );
        let jobs = std::mem::take(&mut *main_thread.lock().unwrap());
        for job in jobs {
            job();
        }
        assert!(
            !notice_visible.load(Ordering::SeqCst),
            "a refusal queued before the reader must not stay beside it"
        );
        assert!(reader_visible.load(Ordering::SeqCst));
        assert_eq!(*trace.lock().unwrap(), ["replace", "dismiss", "show"]);
    }
    #[test]
    fn opening_the_reader_hides_a_held_dictation_notice() {
        let hold = Arc::new(Mutex::new(OverlayHold::new()));
        let session = Arc::new(AtomicBool::new(true));
        assert!(hold.lock().unwrap().take(NoticeSource::Dictation, &session));
        let reader_visible = Arc::new(AtomicBool::new(false));
        let (held, ended, reader) = (hold.clone(), session.clone(), reader_visible.clone());
        open_popup_with(
            || {},
            |job| job(),
            move || held.lock().unwrap().release(&ended),
            move || reader.store(true, Ordering::SeqCst),
        );
        assert!(reader_visible.load(Ordering::SeqCst));
        assert!(
            !hold.lock().unwrap().dictation_showing(&session),
            "opening the reader hides a dictation notice too"
        );
    }
    #[test]
    fn wbfix_bad_driver_and_device_probes_keep_cpu_available() {
        assert!(driver_or_cpu::<(), _>(Err("unreadable driver")).is_none());
        for output in [
            None,
            Some("not json"),
            Some("{}"),
            Some(r#"{"available":[]}"#),
        ] {
            assert_eq!(available_or_cpu(output), [Device::Cpu]);
        }
        assert_eq!(
            available_or_cpu(Some(r#"{"available":["CPU","GPU"]}"#)),
            [Device::Cpu, Device::Gpu]
        );
    }
    #[test]
    fn wbfix_dictation_is_active_before_preview_cancellation() {
        let active = std::cell::Cell::new(false);
        dictation_start_with(
            || {
                assert!(
                    active.get(),
                    "dictation must block new previews before cancellation"
                );
                Ok(())
            },
            || Ok(()),
            || active.set(true),
            || {},
            || {},
        )
        .unwrap();
    }
    #[test]
    fn dictation_start_cancels_the_voice_check_once_the_dictation_is_marked() {
        let running = super::super::voice_check::RunningCheck::default();
        let check = running.begin();
        let dictating = std::cell::Cell::new(false);
        dictation_start_with(
            || Ok(()),
            || Ok(()),
            || dictating.set(true),
            || {
                assert!(
                    dictating.get(),
                    "the dictation is marked first, so a check admitted now is refused"
                );
                running.cancel();
            },
            || {},
        )
        .unwrap();
        assert!(check.load(Ordering::Acquire));
    }
    mod check_admission {
        use super::*;
        use crate::tts::voice_check::{check_refusal, check_voices, RunningCheck, VoiceText};
        use std::time::Duration;

        /// The check's work after admission: synthesized, transcribed and released counts.
        fn run_check(running: &RunningCheck, cancelled: &AtomicBool) -> (usize, usize, usize) {
            let synthesized = std::cell::Cell::new(0);
            let transcribed = std::cell::Cell::new(0);
            check_voices(
                &[VoiceText {
                    model_id: "pocket-en".into(),
                    spoken: "G P U".into(),
                }],
                &|_, _| {
                    synthesized.set(synthesized.get() + 1);
                    Ok(vec![0.0; 16])
                },
                &|_| {
                    transcribed.set(transcribed.get() + 1);
                    Ok("GPU".into())
                },
                cancelled,
            );
            let mut released = 0;
            running.finish(cancelled, || released += 1);
            (synthesized.get(), transcribed.get(), released)
        }

        fn start_dictation(running: &RunningCheck, dictating: &AtomicBool, begun: impl FnOnce()) {
            dictation_start_with(
                || Ok(()),
                || Ok(()),
                || {
                    dictating.store(true, Ordering::Release);
                    begun();
                },
                || running.cancel(),
                || {},
            )
            .unwrap();
        }

        #[test]
        fn a_check_paused_after_its_eligibility_check_loses_to_the_dictation_that_started() {
            let running = &RunningCheck::default();
            let dictating = &AtomicBool::new(false);
            let (checked, checked_wait) = mpsc::channel();
            let (resume, resume_wait) = mpsc::channel::<()>();
            let (begun, begun_wait) = mpsc::channel();
            let (started, started_wait) = mpsc::channel();
            std::thread::scope(|scope| {
                let check = scope.spawn(move || {
                    running.admit(|| {
                        let eligible =
                            check_refusal(dictating.load(Ordering::Acquire), false, false);
                        checked.send(()).unwrap();
                        resume_wait.recv().unwrap();
                        eligible
                    })
                });
                checked_wait.recv_timeout(Duration::from_secs(2)).unwrap();
                scope.spawn(move || {
                    start_dictation(running, dictating, || begun.send(()).unwrap());
                    started.send(()).unwrap();
                });
                begun_wait.recv_timeout(Duration::from_secs(2)).unwrap();
                let early = started_wait.recv_timeout(Duration::from_millis(300));
                resume.send(()).unwrap();
                let admitted = check.join().unwrap();
                if early.is_err() {
                    started_wait.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                match admitted {
                    Err(error) => assert_eq!(error, "tts.vocabulary.check.dictating"),
                    Ok(cancelled) => {
                        assert!(
                            cancelled.load(Ordering::Acquire),
                            "the dictation cancels a check admitted before it took the model"
                        );
                        assert_eq!(
                            run_check(running, &cancelled),
                            (0, 0, 0),
                            "no synthesis, raw transcription or release after the dictation"
                        );
                    }
                }
            });
        }

        #[test]
        fn a_check_registered_first_is_cancelled_by_the_dictation() {
            let running = RunningCheck::default();
            let dictating = AtomicBool::new(false);
            let cancelled = running
                .admit(|| check_refusal(dictating.load(Ordering::Acquire), false, false))
                .expect("no dictation yet");
            start_dictation(&running, &dictating, || {});
            assert!(cancelled.load(Ordering::Acquire));
            assert_eq!(run_check(&running, &cancelled), (0, 0, 0));
        }

        #[test]
        fn a_check_after_the_dictation_started_is_refused() {
            let running = RunningCheck::default();
            let dictating = AtomicBool::new(false);
            start_dictation(&running, &dictating, || {});
            assert_eq!(
                running
                    .admit(|| check_refusal(dictating.load(Ordering::Acquire), false, false))
                    .err(),
                Some("tts.vocabulary.check.dictating".to_string())
            );
        }
    }
    #[test]
    fn dictation_start_cancels_the_correction_capture() {
        use super::super::capture::{testing::FakeRecorder, CaptureError, CorrectionCapture};
        let capture = CorrectionCapture::new(FakeRecorder::default());
        capture.start().unwrap();
        let dictating = std::cell::Cell::new(false);
        dictation_start_with(
            || Ok(()),
            || Ok(()),
            || dictating.set(true),
            || {},
            || {
                assert!(
                    dictating.get(),
                    "the dictation is marked first, so a capture starting now is refused"
                );
                capture.cancel();
            },
        )
        .unwrap();
        assert_eq!(capture.recorder().cancelled.get(), 1);
        assert_eq!(
            capture.stop(|_| panic!("speech-to-text must not run"), || {}),
            Err(CaptureError::NotCapturing),
            "the field stays as it was"
        );
    }
    mod voice_slot {
        use super::*;
        use std::time::Duration;

        #[test]
        fn a_cancelled_wait_returns_without_the_slot_while_another_holder_synthesizes() {
            let slot = VoiceSlot::default();
            let held = slot.acquire(&AtomicBool::new(false)).expect("free slot");
            let cancel = AtomicBool::new(false);
            let (done, done_wait) = mpsc::channel();
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    done.send(slot.acquire(&cancel).is_none()).unwrap();
                });
                cancel.store(true, Ordering::Release);
                let returned = done_wait.recv_timeout(Duration::from_secs(2));
                drop(held);
                assert_eq!(
                    returned,
                    Ok(true),
                    "a cancelled preview stops waiting before the holder releases"
                );
            });
        }

        #[test]
        fn a_second_holder_waits_for_the_first_to_release() {
            let slot = VoiceSlot::default();
            let held = slot.acquire(&AtomicBool::new(false)).expect("free slot");
            let (done, done_wait) = mpsc::channel();
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let second = slot.acquire(&AtomicBool::new(false));
                    done.send(second.is_some()).unwrap();
                });
                let early = done_wait.recv_timeout(Duration::from_millis(200));
                drop(held);
                assert!(early.is_err(), "one voice model loads at a time");
                assert_eq!(done_wait.recv_timeout(Duration::from_secs(2)), Ok(true));
            });
        }
    }
    #[test]
    fn tray_refresh_waits_for_events_without_periodic_model_scans() {
        let (refresh, events) = mpsc::channel();
        let (scanned, scans) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            run_tray_refreshes(events, || {
                scanned.send(()).unwrap();
                true
            })
        });
        assert!(
            scans
                .recv_timeout(std::time::Duration::from_millis(650))
                .is_err(),
            "idle tray must not scan models"
        );
        for _ in 0..2 {
            refresh.send(()).unwrap();
            scans
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            assert!(
                scans
                    .recv_timeout(std::time::Duration::from_millis(650))
                    .is_err(),
                "tray scans must be driven by events"
            );
        }
        drop(refresh);
        worker.join().unwrap();
    }
    fn session_snapshot(
        state: handy_tts_core::scheduler::PlaybackState,
        progress: f64,
        error: Option<&str>,
    ) -> handy_tts_core::session::SessionSnapshot {
        handy_tts_core::session::SessionSnapshot {
            epoch: 0,
            state,
            source_start: 0,
            source_end: 0,
            elapsed_seconds: progress,
            remaining_seconds: 0.0,
            progress,
            error: error.map(String::from),
            output_fallback: false,
            queued_audio_seconds: 0.0,
            buffering_pauses: 0,
            head_start_seconds: None,
        }
    }
    #[test]
    fn read_start_stop_finish_and_error_each_resync_the_tray_once() {
        use handy_tts_core::scheduler::PlaybackState::{
            Buffering, Error, Finished, Paused, Playing, Starting, Waiting,
        };
        let playing = AtomicBool::new(false);
        let mut resyncs = Vec::new();
        // The session's events in order, as the reader shows them; progress
        // events repeat a state and must not re-sync the tray.
        for (step, state, progress, error, expect_playing) in [
            ("reader opens", Waiting, 0.0, None, false),
            ("read starts", Starting, 0.0, None, true),
            ("first sentence buffers", Buffering, 0.0, None, true),
            ("audio plays", Playing, 0.1, None, true),
            ("progress", Playing, 0.2, None, true),
            ("paused", Paused, 0.2, None, false),
            ("resumed", Playing, 0.3, None, true),
            ("finished", Finished, 1.0, None, false),
            ("replayed", Starting, 0.0, None, true),
            ("stopped", Waiting, 0.0, None, false),
            ("read again", Playing, 0.1, None, true),
            (
                "worker failed",
                Error,
                0.1,
                Some("tts.errors.generic"),
                false,
            ),
            ("read again", Playing, 0.1, None, true),
            // A session that cannot start keeps the old state and sets the error.
            (
                "session failed",
                Playing,
                0.1,
                Some("tts.errors.generic"),
                false,
            ),
        ] {
            let snapshot = session_snapshot(state, progress, error);
            note_read_playing(&playing, read_playing(&snapshot), || resyncs.push(step));
            assert_eq!(playing.load(Ordering::Acquire), expect_playing, "{step}");
        }
        assert_eq!(
            resyncs,
            [
                "read starts",
                "paused",
                "resumed",
                "finished",
                "replayed",
                "stopped",
                "read again",
                "worker failed",
                "read again",
                "session failed",
            ]
        );
    }
    #[test]
    fn session_events_set_the_playing_flag_before_the_reader_gets_them() {
        use handy_tts_core::scheduler::PlaybackState::{Finished, Playing, Starting};
        let playing = Arc::new(AtomicBool::new(false));
        let resyncs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let forwarded = Arc::new(Mutex::new(Vec::new()));
        let events = session_events(
            playing.clone(),
            {
                let resyncs = resyncs.clone();
                move || {
                    resyncs.fetch_add(1, Ordering::SeqCst);
                }
            },
            {
                let forwarded = forwarded.clone();
                let playing = playing.clone();
                move |event: super::super::session::SessionEvent| {
                    forwarded
                        .lock()
                        .unwrap()
                        .push((event.snapshot.state, playing.load(Ordering::Acquire)));
                }
            },
        );
        for state in [Starting, Playing, Playing, Finished] {
            events(super::super::session::SessionEvent {
                client_revision: None,
                document_id: 1,
                text: None,
                grid_blocks: Vec::new(),
                visible: true,
                snapshot: session_snapshot(state, 0.0, None),
            });
        }
        assert_eq!(resyncs.load(Ordering::SeqCst), 2, "start and finish");
        assert_eq!(
            *forwarded.lock().unwrap(),
            [
                (Starting, true),
                (Playing, true),
                (Playing, true),
                (Finished, false)
            ]
        );
        // The other end of the route: the tray snapshot reads the flag.
        let tray = include_str!("../tray.rs");
        let production = tray.split("#[cfg(test)]").next().unwrap();
        assert!(
            production.contains(".is_some_and(|service| service.read_playing())"),
            "the tray snapshot reads whether a read is playing"
        );
    }
    fn open_popup_referee(text: &str) -> Referee {
        let mut referee = Referee::default();
        referee.apply(Event::ReadShortcut);
        let ticket = referee.ticket;
        referee.apply(Event::Clipboard {
            ticket,
            text: text.into(),
        });
        referee
    }
    fn shortcut_capture(referee: &mut Referee) -> u64 {
        let Effect::Capture { ticket } = referee.apply(Event::ReadShortcut)[0] else {
            panic!("expected a capture")
        };
        ticket
    }
    fn edit(text: &str) -> SessionCommand {
        SessionCommand::Replace {
            client_revision: Some(1),
            text: text.into(),
            autoplay: false,
            origin: ReadOrigin::App,
        }
    }
    #[test]
    fn owner_edits_sent_through_the_command_path_are_what_a_later_capture_is_compared_with() {
        for (clipboard, expected) in [
            (
                "copied, then edited",
                vec![Effect::StopReading, Effect::ClosePopup],
            ),
            (
                "copied",
                vec![Effect::OpenPopup {
                    text: "copied".into(),
                }],
            ),
        ] {
            let mut referee = open_popup_referee("copied");
            let mut sent = 0;
            forward_reading_command(&mut referee, edit("copied, then edited"), |_| {
                sent += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(sent, 1);
            let ticket = shortcut_capture(&mut referee);
            assert_eq!(
                referee.apply(Event::Clipboard {
                    ticket,
                    text: clipboard.into()
                }),
                expected
            );
        }
    }
    #[test]
    fn commands_other_than_a_replacement_leave_the_remembered_popup_text() {
        let mut referee = open_popup_referee("copied");
        forward_reading_command(&mut referee, SessionCommand::Play, |_| Ok(())).unwrap();
        assert_eq!(referee.popup_text, "copied");
    }
    #[test]
    fn refused_commands_during_dictation_are_neither_sent_nor_remembered() {
        let mut referee = open_popup_referee("copied");
        referee.apply(Event::DictationStart);
        let command = SessionCommand::Replace {
            client_revision: None,
            text: "autoplayed".into(),
            autoplay: true,
            origin: ReadOrigin::App,
        };
        let result = forward_reading_command(&mut referee, command, |_| panic!("sent"));
        assert_eq!(result, Err("tts.errors.busy".into()));
        assert_eq!(referee.popup_text, "copied");
    }
    mod external_read {
        use super::*;

        #[test]
        fn read_text_with_refuses_dictation_and_keeps_the_referee() {
            for processing in [false, true] {
                let mut referee = Referee::default();
                referee.apply(Event::DictationStart);
                if processing {
                    referee.apply(Event::DictationProcessing);
                }
                let (ticket, activity, popup_open) =
                    (referee.ticket, referee.activity, referee.popup_open);
                let before = format!("{referee:?}");
                assert_eq!(
                    read_text_with(&mut referee, "plan".into()),
                    Err(ExternalReadError::Dictating)
                );
                assert_eq!(
                    (referee.ticket, referee.activity, referee.popup_open),
                    (ticket, activity, popup_open)
                );
                assert_eq!(format!("{referee:?}"), before);
            }
        }

        #[test]
        fn read_text_with_opens_the_popup() {
            let mut referee = Referee::default();
            assert_eq!(
                read_text_with(&mut referee, "plan".into()),
                Ok(vec![Effect::OpenPopup {
                    text: "plan".into()
                }])
            );
            assert!(referee.popup_open);
            assert_eq!(referee.activity, Activity::Reading);
        }

        #[test]
        fn popup_replace_carries_the_origin() {
            assert!(matches!(
                popup_replace("x".into(), ReadOrigin::Agent),
                SessionCommand::Replace {
                    client_revision: None,
                    autoplay: true,
                    origin: ReadOrigin::Agent,
                    ref text,
                } if text == "x"
            ));
            assert!(matches!(
                popup_replace("x".into(), ReadOrigin::App),
                SessionCommand::Replace {
                    origin: ReadOrigin::App,
                    ..
                }
            ));
        }

        #[test]
        fn unknown_or_empty_model_is_not_installed() {
            let root = std::path::Path::new("/nonexistent-vaakora-tts-root");
            for id in ["", "ghost", "kokoro-82m-int8"] {
                assert!(!model_installed(root, id), "{id:?}");
            }
        }
    }
    #[test]
    fn capture_finishing_after_the_popup_closed_opens_nothing_through_the_ordered_path() {
        let referee = Mutex::new(open_popup_referee("old"));
        let ticket = shortcut_capture(&mut referee.lock().unwrap());
        apply_ordered(&referee, Event::Close, |_, _| {});
        let mut dispatched = Vec::new();
        apply_ordered(
            &referee,
            Event::Clipboard {
                ticket,
                text: "late".into(),
            },
            |state, effects| {
                assert!(!state.popup_open);
                dispatched = effects;
            },
        );
        assert!(dispatched.is_empty());
    }
    #[test]
    fn early_shortcut_leaves_referee_unchanged_and_logs_once_until_ready() {
        for dictating in [false, true] {
            let mut referee = Referee::default();
            if dictating {
                referee.apply(Event::DictationStart);
            }
            let before = format!("{referee:?}");
            let refused = AtomicBool::new(false);
            let mut logs = 0;
            for _ in 0..2 {
                assert!(read_shortcut_with(
                    &mut referee,
                    Event::ReadShortcut,
                    Err("tts.errors.starting".into()),
                    &refused,
                    |_| logs += 1,
                    || {}
                )
                .is_empty());
                assert_eq!(format!("{referee:?}"), before);
            }
            assert_eq!(logs, 1);
            assert!(matches!(
                read_shortcut_with(
                    &mut referee,
                    Event::ReadShortcut,
                    Ok(()),
                    &refused,
                    |_| logs += 1,
                    || {}
                )
                .as_slice(),
                [Effect::Capture { .. }]
            ));
            assert!(!refused.load(Ordering::Acquire));
        }
    }
}
