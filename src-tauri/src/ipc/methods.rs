//! The app's methods behind the control socket: `status`, `tts.*`,
//! `dictation.*` and `transcribe.file`. [`parse_call`] checks the method name and params first, so
//! bad input never reaches the app; the call then runs on the connection
//! thread. Nothing here logs, and every error message is fixed English text
//! that never quotes a request.

use std::path::PathBuf;
use std::sync::{mpsc, Arc};

use handy_tts_core::scheduler::PlaybackState;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::protocol::{ErrorKind, RpcError, PROTOCOL_VERSION};
use super::server::Methods;
use crate::managers::history::{HistoryEntry, HistoryManager};
use crate::managers::model::ModelManager;
use crate::managers::transcription_jobs::{
    AddFileError, TranscriptionJobManager, TranscriptionJobStatus,
};
use crate::tray::TrayIconState;
use crate::tts::history::ReadOrigin;
use crate::tts::service::{ExternalReadError, Ready, TtsService};
use crate::tts::session::SessionCommand;

const BUSY_MESSAGE: &str = "A dictation is in progress; try again when it ends.";
const UNAVAILABLE_MESSAGE: &str = "Read aloud is not available.";
const READ_PARAMS_MESSAGE: &str = "text must be a non-empty string";
const OBJECT_PARAMS_MESSAGE: &str = "params must be an object";
const POST_PROCESS_MESSAGE: &str = "post_process must be true or false";
const PATH_MESSAGE: &str = "path must be absolute";
const NO_FILE_MESSAGE: &str = "No such file.";
const SETUP_MESSAGE: &str = "Choose a speech-to-text model in Vaakora first.";
const STT_MODEL_MESSAGE: &str = "The selected speech-to-text model is not downloaded.";
const STOPPED_MESSAGE: &str = "The transcription stopped.";
const NO_TEXT_MESSAGE: &str = "The transcription was cancelled or found no speech.";
const READ_BACK_MESSAGE: &str = "The transcription could not be read back.";

/// The running app's methods.
pub struct AppMethods {
    app: AppHandle,
}

impl AppMethods {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }

    fn service(&self) -> Result<Arc<TtsService>, RpcError> {
        self.app
            .try_state::<Arc<TtsService>>()
            .map(|service| service.inner().clone())
            .ok_or_else(unavailable)
    }

    fn ready(&self) -> Result<(Arc<TtsService>, Ready), RpcError> {
        let service = self.service()?;
        let ready = service.ready().map_err(|_| unavailable())?;
        Ok((service, ready))
    }

    fn status(&self) -> Value {
        let settings = crate::settings::get_settings(&self.app);
        let selection = crate::tts::service::selection(&settings);
        let ready = self.ready().ok().map(|(_, ready)| ready);
        let voice_installed = ready.as_ref().is_some_and(|ready| {
            handy_tts_core::catalog::entry(&selection.model_id)
                .is_ok_and(|entry| handy_tts_core::download::is_downloaded(&ready.root, entry))
        });
        let stt_installed = self
            .app
            .try_state::<Arc<ModelManager>>()
            .and_then(|models| models.get_model_info(&settings.selected_model))
            .is_some_and(|info| info.is_downloaded);
        status_result(StatusFacts {
            dictation: crate::tray::dictation_state(&self.app),
            reader: ready.map(|ready| {
                let view = ready.session.snapshot();
                (view.snapshot.state, view.visible)
            }),
            voice_model: &selection.model_id,
            voice: &selection.voice,
            voice_installed,
            stt_model: &settings.selected_model,
            stt_installed,
        })
    }

    fn control(&self, op: ReadControl) -> Result<Value, RpcError> {
        let (service, ready) = self.ready()?;
        let view = ready.session.snapshot();
        run_control(
            op,
            view.snapshot.state,
            view.visible,
            |command| service.reading_command(command),
            || service.close(),
        )
    }

    /// `transcribe.file`: the file goes through History's own job queue, so it
    /// waits behind a dictation and shows in History. The queue registers the
    /// watcher before it queues the job, so no status is missed.
    fn transcribe(&self, path: PathBuf) -> Result<Value, RpcError> {
        let settings = crate::settings::get_settings(&self.app);
        let installed = self
            .app
            .try_state::<Arc<ModelManager>>()
            .and_then(|models| models.get_model_info(&settings.selected_model))
            .map(|info| info.is_downloaded);
        let (Some(jobs), Some(history)) = (
            self.app.try_state::<Arc<TranscriptionJobManager>>(),
            self.app.try_state::<Arc<HistoryManager>>(),
        ) else {
            return Err(read_back_error());
        };
        run_transcribe(
            path,
            &settings.selected_model,
            installed,
            |path| jobs.transcribe_file_watched(path),
            |id| tauri::async_runtime::block_on(history.get_entry_by_id(id)),
        )
    }

    fn voices(&self) -> Result<Value, RpcError> {
        let (_, ready) = self.ready()?;
        let selection = crate::tts::service::selection(&crate::settings::get_settings(&self.app));
        let entries = handy_tts_core::catalog::entries().map_err(|_| unavailable())?;
        Ok(voices_result(
            entries,
            |entry| handy_tts_core::download::is_downloaded(&ready.root, entry),
            &selection.model_id,
            &selection.voice,
        ))
    }
}

/// What `status` reports, gathered from the app.
pub(crate) struct StatusFacts<'a> {
    pub dictation: TrayIconState,
    /// The reader's playback state and visibility; `None` when read aloud is
    /// not available.
    pub reader: Option<(PlaybackState, bool)>,
    pub voice_model: &'a str,
    pub voice: &'a str,
    pub voice_installed: bool,
    pub stt_model: &'a str,
    pub stt_installed: bool,
}

/// The `status` result. Without read aloud the reader reads `idle`, not
/// visible, and the voice model counts as not installed.
pub(crate) fn status_result(facts: StatusFacts) -> Value {
    let (state, visible) = facts.reader.unwrap_or((PlaybackState::Waiting, false));
    json!({
        "server": crate::brand::PACKAGE_NAME,
        "protocol_version": PROTOCOL_VERSION,
        "app_version": env!("CARGO_PKG_VERSION"),
        "dictation": dictation_name(facts.dictation),
        "reading": { "state": reading_state_name(state), "visible": visible },
        "tts": {
            "available": facts.reader.is_some(),
            "model_id": facts.voice_model,
            "voice": facts.voice,
            "installed": facts.reader.is_some() && facts.voice_installed,
        },
        "stt": {
            "selected_model": facts.stt_model,
            "installed": facts.stt_installed,
        },
    })
}

/// Runs `op` on a reader in `state`: Pause and Play go to `command` (the
/// reader's own command path), Close to `close`. The result says whether
/// anything was done.
pub(crate) fn run_control(
    op: ReadControl,
    state: PlaybackState,
    visible: bool,
    command: impl FnOnce(SessionCommand) -> Result<(), String>,
    close: impl FnOnce(),
) -> Result<Value, RpcError> {
    let action = control_action(op, state, visible);
    match action {
        Some(ControlAction::Pause) => command(SessionCommand::Pause).map_err(reader_error)?,
        Some(ControlAction::Play) => command(SessionCommand::Play).map_err(reader_error)?,
        Some(ControlAction::Close) => close(),
        None => {}
    }
    Ok(json!({ "changed": action.is_some() }))
}

/// The `tts.voices` result: the catalog entries `downloaded` accepts, and the
/// selected model and voice.
pub(crate) fn voices_result(
    entries: &[handy_tts_core::catalog::ModelEntry],
    downloaded: impl Fn(&handy_tts_core::catalog::ModelEntry) -> bool,
    model_id: &str,
    voice: &str,
) -> Value {
    let models: Vec<Value> = entries
        .iter()
        .filter(|entry| downloaded(entry))
        .map(|entry| {
            json!({
                "id": entry.id,
                "name": entry.name,
                "voices": entry.voices,
                "default_voice": entry.default_voice,
            })
        })
        .collect();
    json!({ "model_id": model_id, "voice": voice, "models": models })
}

impl Methods for AppMethods {
    fn call(&self, method: &str, params: Option<&Value>) -> Result<Value, RpcError> {
        match parse_call(method, params)? {
            Call::Status => Ok(self.status()),
            Call::Read(text) => {
                self.service()?
                    .read_text(text, ReadOrigin::Agent)
                    .map_err(read_error)?;
                Ok(json!({}))
            }
            Call::Control(op) => self.control(op),
            Call::Voices => self.voices(),
            Call::Transcribe(path) => self.transcribe(path),
            Call::Toggle(binding) => {
                crate::signal_handle::send_transcription_input(&self.app, binding, "IPC");
                Ok(json!({}))
            }
            Call::Cancel => {
                crate::utils::cancel_current_operation(&self.app);
                Ok(json!({}))
            }
        }
    }
}

/// A request whose method and params were checked.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Call {
    Status,
    Read(String),
    Control(ReadControl),
    Voices,
    /// An absolute path to an existing file.
    Transcribe(PathBuf),
    /// The binding id `send_transcription_input` toggles.
    Toggle(&'static str),
    Cancel,
}

/// Names the call, or refuses it: an unknown method is `MethodNotFound`, bad
/// params `InvalidParams`.
pub(crate) fn parse_call(method: &str, params: Option<&Value>) -> Result<Call, RpcError> {
    let call = match method {
        "status" => Call::Status,
        "tts.read" => return read_params(params).map(Call::Read),
        "tts.pause" => Call::Control(ReadControl::Pause),
        "tts.resume" => Call::Control(ReadControl::Resume),
        "tts.stop" => Call::Control(ReadControl::Stop),
        "tts.voices" => Call::Voices,
        "transcribe.file" => return file_params(params).map(Call::Transcribe),
        "dictation.toggle" => return toggle_binding(params).map(Call::Toggle),
        "dictation.cancel" => Call::Cancel,
        _ => return Err(RpcError::new(ErrorKind::MethodNotFound, "unknown method")),
    };
    object_params(params)?;
    Ok(call)
}

/// Params are absent or an object. Fields a method does not know are ignored,
/// so adding one later is not a breaking change.
fn object_params(params: Option<&Value>) -> Result<(), RpcError> {
    match params {
        None | Some(Value::Object(_)) => Ok(()),
        Some(_) => Err(RpcError::new(
            ErrorKind::InvalidParams,
            OBJECT_PARAMS_MESSAGE,
        )),
    }
}

/// `tts.read` `{text}`: a string that is not blank, kept as sent.
pub(crate) fn read_params(params: Option<&Value>) -> Result<String, RpcError> {
    match params
        .and_then(|params| params.get("text"))
        .and_then(Value::as_str)
    {
        Some(text) if !text.trim().is_empty() => Ok(text.to_owned()),
        _ => Err(RpcError::new(ErrorKind::InvalidParams, READ_PARAMS_MESSAGE)),
    }
}

/// `dictation.toggle` `{post_process?: bool}`: the binding the shortcut and
/// the `--toggle-transcription` / `--toggle-post-process` flags toggle.
pub(crate) fn toggle_binding(params: Option<&Value>) -> Result<&'static str, RpcError> {
    object_params(params)?;
    match params.and_then(|params| params.get("post_process")) {
        None | Some(Value::Bool(false)) => Ok("transcribe"),
        Some(Value::Bool(true)) => Ok("transcribe_with_post_process"),
        Some(_) => Err(RpcError::new(
            ErrorKind::InvalidParams,
            POST_PROCESS_MESSAGE,
        )),
    }
}

/// `transcribe.file` `{path}`: absolute and a regular file (a symlink to one
/// counts). The text never quotes the path.
pub(crate) fn file_params(params: Option<&Value>) -> Result<PathBuf, RpcError> {
    let path = params
        .and_then(|params| params.get("path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| RpcError::new(ErrorKind::InvalidParams, PATH_MESSAGE))?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(RpcError::new(ErrorKind::FileNotFound, NO_FILE_MESSAGE))
    }
}

/// The speech-to-text model must be chosen and downloaded before a file is
/// added to History. `installed` is `None` when the model is unknown.
pub(crate) fn stt_ready(selected_model: &str, installed: Option<bool>) -> Result<(), RpcError> {
    if selected_model.is_empty() {
        return Err(RpcError::new(ErrorKind::SetupRequired, SETUP_MESSAGE));
    }
    if installed != Some(true) {
        return Err(RpcError::new(
            ErrorKind::ModelNotInstalled,
            STT_MODEL_MESSAGE,
        ));
    }
    Ok(())
}

/// A refusal to add the file to History, as the call's error.
pub(crate) fn add_file_error(error: AddFileError) -> RpcError {
    match error {
        AddFileError::NoAudio(message) => RpcError::new(ErrorKind::UnsupportedAudio, message),
        AddFileError::Storage(message) => RpcError::new(ErrorKind::Internal, message),
    }
}

/// Waits for the job whose statuses arrive on `statuses`: `Finished` is
/// success, `Failed` its error, a closed channel a stopped transcription;
/// `Queued` and `Running` are skipped.
pub(crate) fn wait_job(statuses: &mpsc::Receiver<TranscriptionJobStatus>) -> Result<(), RpcError> {
    loop {
        match statuses.recv() {
            Ok(TranscriptionJobStatus::Finished) => return Ok(()),
            Ok(TranscriptionJobStatus::Failed { error }) => {
                return Err(RpcError::new(ErrorKind::Internal, error))
            }
            Ok(TranscriptionJobStatus::Queued | TranscriptionJobStatus::Running { .. }) => {}
            Err(_) => return Err(RpcError::new(ErrorKind::Internal, STOPPED_MESSAGE)),
        }
    }
}

/// The entry's cleaned text when it has one, else its transcript; `None`
/// when both are empty.
pub(crate) fn entry_text(entry: &HistoryEntry) -> Option<String> {
    entry
        .post_processed_text
        .as_deref()
        .filter(|text| !text.is_empty())
        .or(Some(entry.transcription_text.as_str()).filter(|text| !text.is_empty()))
        .map(str::to_owned)
}

/// A file added to History and the statuses of its job.
pub(crate) type Watched = (HistoryEntry, mpsc::Receiver<TranscriptionJobStatus>);

/// The `transcribe.file` call: checks the model, adds the file with `add`
/// (which also watches its job), waits for the job, then reads the entry
/// again with `reload`.
pub(crate) fn run_transcribe(
    path: PathBuf,
    selected_model: &str,
    installed: Option<bool>,
    add: impl FnOnce(PathBuf) -> Result<Watched, AddFileError>,
    reload: impl FnOnce(i64) -> anyhow::Result<Option<HistoryEntry>>,
) -> Result<Value, RpcError> {
    stt_ready(selected_model, installed)?;
    let (added, statuses) = add(path).map_err(add_file_error)?;
    wait_job(&statuses)?;
    let entry = reload(added.id)
        .ok()
        .flatten()
        .ok_or_else(read_back_error)?;
    let text =
        entry_text(&entry).ok_or_else(|| RpcError::new(ErrorKind::Internal, NO_TEXT_MESSAGE))?;
    Ok(json!({ "text": text, "history_id": entry.id }))
}

fn read_back_error() -> RpcError {
    RpcError::new(ErrorKind::Internal, READ_BACK_MESSAGE)
}

/// What a `tts.pause`, `tts.resume` or `tts.stop` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadControl {
    Pause,
    Resume,
    Stop,
}

/// What the reader is told to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControlAction {
    Pause,
    Play,
    Close,
}

/// The action for `op` on the reader as it is now; `None` when it would change
/// nothing. A closed reader is never touched, so a resume after a close does
/// not start a hidden read.
pub(crate) fn control_action(
    op: ReadControl,
    state: PlaybackState,
    visible: bool,
) -> Option<ControlAction> {
    if !visible {
        return None;
    }
    match op {
        ReadControl::Pause => matches!(
            state,
            PlaybackState::Starting | PlaybackState::Buffering | PlaybackState::Playing
        )
        .then_some(ControlAction::Pause),
        ReadControl::Resume => (state == PlaybackState::Paused).then_some(ControlAction::Play),
        ReadControl::Stop => Some(ControlAction::Close),
    }
}

/// `status` `reading.state`.
pub(crate) fn reading_state_name(state: PlaybackState) -> &'static str {
    match state {
        PlaybackState::Waiting => "idle",
        PlaybackState::Starting => "starting",
        PlaybackState::Buffering => "buffering",
        PlaybackState::Playing => "playing",
        PlaybackState::Paused => "paused",
        PlaybackState::Finished => "finished",
        PlaybackState::Error => "error",
    }
}

/// `status` `dictation`.
pub(crate) fn dictation_name(state: TrayIconState) -> &'static str {
    match state {
        TrayIconState::Idle => "idle",
        TrayIconState::Recording => "recording",
        TrayIconState::Transcribing => "transcribing",
    }
}

fn unavailable() -> RpcError {
    RpcError::new(ErrorKind::TtsUnavailable, UNAVAILABLE_MESSAGE)
}

/// Why a `tts.read` did not start, for the client.
pub(crate) fn read_error(error: ExternalReadError) -> RpcError {
    match error {
        ExternalReadError::Dictating => RpcError::new(ErrorKind::Busy, BUSY_MESSAGE),
        ExternalReadError::Unavailable => unavailable(),
        ExternalReadError::ModelNotInstalled => RpcError::new(
            ErrorKind::TtsModelNotInstalled,
            "The selected voice model is not downloaded.",
        ),
        ExternalReadError::Preview(_) => {
            RpcError::new(ErrorKind::Internal, "Could not stop the voice preview.")
        }
    }
}

/// A reader command's error key, for the client: a Play refused during a
/// dictation is `Busy`.
pub(crate) fn reader_error(error: String) -> RpcError {
    if error == "tts.errors.busy" {
        RpcError::new(ErrorKind::Busy, BUSY_MESSAGE)
    } else {
        RpcError::new(ErrorKind::Internal, "Read aloud failed.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STATES: [PlaybackState; 7] = [
        PlaybackState::Waiting,
        PlaybackState::Starting,
        PlaybackState::Buffering,
        PlaybackState::Playing,
        PlaybackState::Paused,
        PlaybackState::Finished,
        PlaybackState::Error,
    ];

    /// The production part of this file, without this test module.
    fn production_source(source: &str) -> &str {
        source
            .split("#[cfg(test)]")
            .next()
            .expect("split always yields a first part")
    }

    mod control {
        use super::*;

        #[test]
        fn control_action_table() {
            for op in [ReadControl::Pause, ReadControl::Resume, ReadControl::Stop] {
                for state in STATES {
                    for visible in [false, true] {
                        let expected = if !visible {
                            None
                        } else {
                            match op {
                                ReadControl::Pause => matches!(
                                    state,
                                    PlaybackState::Starting
                                        | PlaybackState::Buffering
                                        | PlaybackState::Playing
                                )
                                .then_some(ControlAction::Pause),
                                ReadControl::Resume => {
                                    (state == PlaybackState::Paused).then_some(ControlAction::Play)
                                }
                                ReadControl::Stop => Some(ControlAction::Close),
                            }
                        };
                        assert_eq!(
                            control_action(op, state, visible),
                            expected,
                            "{op:?} {state:?} visible={visible}"
                        );
                    }
                }
            }
        }

        #[test]
        fn resume_after_close_changes_nothing() {
            assert_eq!(
                control_action(ReadControl::Resume, PlaybackState::Paused, false),
                None
            );
        }

        #[test]
        fn stop_when_closed_changes_nothing() {
            for state in STATES {
                assert_eq!(control_action(ReadControl::Stop, state, false), None);
            }
        }
    }

    mod names {
        use super::*;
        use crate::tray::TrayIconState;

        #[test]
        fn reading_state_names() {
            let names: Vec<_> = STATES.into_iter().map(reading_state_name).collect();
            assert_eq!(
                names,
                [
                    "idle",
                    "starting",
                    "buffering",
                    "playing",
                    "paused",
                    "finished",
                    "error"
                ]
            );
        }

        #[test]
        fn dictation_names() {
            assert_eq!(dictation_name(TrayIconState::Idle), "idle");
            assert_eq!(dictation_name(TrayIconState::Recording), "recording");
            assert_eq!(dictation_name(TrayIconState::Transcribing), "transcribing");
        }
    }

    mod params {
        use super::*;

        const READ_INVALID: &str = "text must be a non-empty string";

        #[test]
        fn read_params_rejects_blank_without_echo() {
            let blank = json!({"text": "  "});
            let number = json!({"text": 3});
            let not_object = json!("secret words");
            let missing = json!({});
            for params in [
                Some(&blank),
                Some(&number),
                Some(&not_object),
                Some(&missing),
                None,
            ] {
                let error = read_params(params).expect_err("must be refused");
                assert_eq!(error.kind, ErrorKind::InvalidParams, "{params:?}");
                assert_eq!(error.message, READ_INVALID, "{params:?}");
            }
        }

        #[test]
        fn read_params_keeps_text() {
            assert_eq!(
                read_params(Some(&json!({"text": "Hello."}))).unwrap(),
                "Hello."
            );
        }

        #[test]
        fn toggle_binding_defaults_to_plain() {
            assert_eq!(toggle_binding(None).unwrap(), "transcribe");
            assert_eq!(
                toggle_binding(Some(&json!({"post_process": false}))).unwrap(),
                "transcribe"
            );
            assert_eq!(
                toggle_binding(Some(&json!({"post_process": true}))).unwrap(),
                "transcribe_with_post_process"
            );
            for bad in [json!({"post_process": "yes"}), json!([true]), json!("x")] {
                assert_eq!(
                    toggle_binding(Some(&bad)).unwrap_err().kind,
                    ErrorKind::InvalidParams,
                    "{bad}"
                );
            }
        }

        #[test]
        fn every_method_is_routed() {
            let read = json!({"text": "Hello."});
            let cases = [
                ("status", None, Call::Status),
                ("tts.read", Some(&read), Call::Read("Hello.".into())),
                ("tts.pause", None, Call::Control(ReadControl::Pause)),
                ("tts.resume", None, Call::Control(ReadControl::Resume)),
                ("tts.stop", None, Call::Control(ReadControl::Stop)),
                ("tts.voices", None, Call::Voices),
                ("dictation.toggle", None, Call::Toggle("transcribe")),
                ("dictation.cancel", None, Call::Cancel),
            ];
            for (method, params, call) in cases {
                assert_eq!(parse_call(method, params).unwrap(), call, "{method}");
            }
        }

        #[test]
        fn unknown_method_is_not_found() {
            for method in ["tts.speak", "", "status ", "initialize2"] {
                let error = parse_call(method, None).unwrap_err();
                assert_eq!(error.kind, ErrorKind::MethodNotFound, "{method:?}");
                assert_eq!(error.message, "unknown method");
            }
        }

        #[test]
        fn every_method_refuses_bad_params() {
            let methods = [
                "status",
                "tts.read",
                "tts.pause",
                "tts.resume",
                "tts.stop",
                "tts.voices",
                "dictation.toggle",
                "dictation.cancel",
                "transcribe.file",
            ];
            for method in methods {
                for bad in [json!([1]), json!("secret words"), json!(7), json!(true)] {
                    let error = parse_call(method, Some(&bad)).unwrap_err();
                    assert_eq!(error.kind, ErrorKind::InvalidParams, "{method} {bad}");
                    assert!(!error.message.contains("secret"), "{method} echoes params");
                }
            }
            // An object, with or without fields, is accepted by methods without params.
            for method in ["status", "tts.pause", "tts.voices", "dictation.cancel"] {
                assert!(parse_call(method, Some(&json!({}))).is_ok(), "{method}");
                assert!(
                    parse_call(method, Some(&json!({"x": 1}))).is_ok(),
                    "{method}"
                );
            }
        }

        #[test]
        fn blank_read_is_refused_before_the_service() {
            let error = parse_call("tts.read", Some(&json!({"text": " \n\t "}))).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidParams);
        }
    }

    mod errors {
        use super::*;
        use crate::tts::service::ExternalReadError;

        #[test]
        fn read_error_kinds() {
            let cases = [
                (
                    ExternalReadError::Dictating,
                    ErrorKind::Busy,
                    1000,
                    "A dictation is in progress; try again when it ends.",
                ),
                (
                    ExternalReadError::Unavailable,
                    ErrorKind::TtsUnavailable,
                    1100,
                    "Read aloud is not available.",
                ),
                (
                    ExternalReadError::ModelNotInstalled,
                    ErrorKind::TtsModelNotInstalled,
                    1101,
                    "The selected voice model is not downloaded.",
                ),
                (
                    ExternalReadError::Preview("worker gone".into()),
                    ErrorKind::Internal,
                    1006,
                    "Could not stop the voice preview.",
                ),
            ];
            for (error, kind, code, message) in cases {
                let mapped = read_error(error);
                assert_eq!(mapped.kind, kind);
                assert_eq!(mapped.kind.code(), code);
                assert_eq!(mapped.message, message);
            }
        }

        #[test]
        fn reader_busy_maps_to_busy() {
            let busy = reader_error("tts.errors.busy".into());
            assert_eq!(busy.kind, ErrorKind::Busy);
            assert_eq!(
                busy.message,
                "A dictation is in progress; try again when it ends."
            );
            let other = reader_error("tts.errors.generic".into());
            assert_eq!(other.kind, ErrorKind::Internal);
            assert_eq!(other.message, "Read aloud failed.");
        }
    }

    mod results {
        use super::*;
        use crate::tray::TrayIconState;
        use std::cell::RefCell;

        fn facts(reader: Option<(PlaybackState, bool)>) -> StatusFacts<'static> {
            StatusFacts {
                dictation: TrayIconState::Recording,
                reader,
                voice_model: "pocket-en",
                voice: "alba",
                voice_installed: true,
                stt_model: "parakeet",
                stt_installed: true,
            }
        }

        #[test]
        fn status_reports_every_field() {
            let result = status_result(facts(Some((PlaybackState::Paused, true))));
            assert_eq!(
                result,
                json!({
                    "server": "vaakora",
                    "protocol_version": 1,
                    "app_version": env!("CARGO_PKG_VERSION"),
                    "dictation": "recording",
                    "reading": { "state": "paused", "visible": true },
                    "tts": {
                        "available": true,
                        "model_id": "pocket-en",
                        "voice": "alba",
                        "installed": true,
                    },
                    "stt": { "selected_model": "parakeet", "installed": true },
                })
            );
        }

        #[test]
        fn status_without_read_aloud_uses_the_defaults() {
            let mut unavailable = facts(None);
            unavailable.stt_model = "";
            unavailable.stt_installed = false;
            let result = status_result(unavailable);
            assert_eq!(
                result["reading"],
                json!({ "state": "idle", "visible": false })
            );
            assert_eq!(
                result["tts"],
                json!({
                    "available": false,
                    "model_id": "pocket-en",
                    "voice": "alba",
                    "installed": false,
                })
            );
            assert_eq!(
                result["stt"],
                json!({ "selected_model": "", "installed": false })
            );
            assert_eq!(result["server"], "vaakora");
        }

        /// Runs a control, recording the reader commands sent and whether it was closed.
        fn control(
            op: ReadControl,
            state: PlaybackState,
            visible: bool,
            reply: Result<(), String>,
        ) -> (Result<Value, RpcError>, Vec<&'static str>, bool) {
            let sent = RefCell::new(Vec::new());
            let closed = RefCell::new(false);
            let result = run_control(
                op,
                state,
                visible,
                |command| {
                    sent.borrow_mut().push(match command {
                        SessionCommand::Pause => "pause",
                        SessionCommand::Play => "play",
                        _ => "other",
                    });
                    reply
                },
                || *closed.borrow_mut() = true,
            );
            (result, sent.into_inner(), closed.into_inner())
        }

        #[test]
        fn controls_invoke_their_operation() {
            let changed = Ok(json!({ "changed": true }));
            assert_eq!(
                control(ReadControl::Pause, PlaybackState::Playing, true, Ok(())),
                (changed.clone(), vec!["pause"], false)
            );
            assert_eq!(
                control(ReadControl::Resume, PlaybackState::Paused, true, Ok(())),
                (changed.clone(), vec!["play"], false)
            );
            assert_eq!(
                control(ReadControl::Stop, PlaybackState::Playing, true, Ok(())),
                (changed, vec![], true)
            );
        }

        #[test]
        fn controls_that_change_nothing_touch_nothing() {
            let unchanged = Ok(json!({ "changed": false }));
            for (op, state, visible) in [
                (ReadControl::Stop, PlaybackState::Playing, false),
                (ReadControl::Resume, PlaybackState::Paused, false),
                (ReadControl::Pause, PlaybackState::Paused, true),
                (ReadControl::Resume, PlaybackState::Playing, true),
            ] {
                assert_eq!(
                    control(op, state, visible, Ok(())),
                    (unchanged.clone(), vec![], false),
                    "{op:?} {state:?} visible={visible}"
                );
            }
        }

        #[test]
        fn refused_play_is_busy() {
            let (result, sent, closed) = control(
                ReadControl::Resume,
                PlaybackState::Paused,
                true,
                Err("tts.errors.busy".into()),
            );
            assert_eq!(result.unwrap_err().kind, ErrorKind::Busy);
            assert_eq!((sent, closed), (vec!["play"], false));
        }

        #[test]
        fn voices_lists_downloaded_models_only() {
            let entries = handy_tts_core::catalog::entries().unwrap();
            assert!(entries.len() >= 2, "the catalog has more than one model");
            let kept = &entries[1];
            let result = voices_result(entries, |entry| entry.id == kept.id, "pocket-en", "alba");
            assert_eq!(
                result,
                json!({
                    "model_id": "pocket-en",
                    "voice": "alba",
                    "models": [{
                        "id": kept.id,
                        "name": kept.name,
                        "voices": kept.voices,
                        "default_voice": kept.default_voice,
                    }],
                })
            );
            let none = voices_result(entries, |_| false, "pocket-en", "alba");
            assert_eq!(none["models"], json!([]));
        }
    }

    mod transcribe {
        use super::*;
        use crate::managers::history::HistoryEntry;
        use crate::managers::transcription_jobs::{AddFileError, TranscriptionJobStatus};
        use std::sync::mpsc;

        fn entry(id: i64, raw: &str, cleaned: Option<&str>) -> HistoryEntry {
            HistoryEntry {
                id,
                file_name: "handy-file-1.wav".into(),
                timestamp: 0,
                saved: false,
                title: String::new(),
                transcription_text: raw.into(),
                post_processed_text: cleaned.map(str::to_owned),
                post_process_prompt: None,
                post_process_requested: false,
                source_name: Some("a.wav".into()),
                language: None,
                language_source: None,
                post_process_provider: None,
                post_process_model: None,
            }
        }

        /// A job that already sent `statuses` by the time the wait starts.
        fn watched(
            id: i64,
            statuses: impl IntoIterator<Item = TranscriptionJobStatus>,
        ) -> Result<Watched, AddFileError> {
            let (tx, rx) = mpsc::channel();
            for status in statuses {
                tx.send(status).unwrap();
            }
            Ok((entry(id, "", None), rx))
        }

        fn finished() -> [TranscriptionJobStatus; 1] {
            [TranscriptionJobStatus::Finished]
        }

        #[test]
        fn file_params_rules() {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("a.wav");
            std::fs::write(&file, b"x").unwrap();
            let relative = file_params(Some(&json!({"path": "a.wav"}))).unwrap_err();
            assert_eq!(relative.kind, ErrorKind::InvalidParams);
            assert_eq!(relative.message, "path must be absolute");
            for params in [
                None,
                Some(json!({})),
                Some(json!({"path": 7})),
                Some(json!(["/a"])),
            ] {
                let error = file_params(params.as_ref()).unwrap_err();
                assert_eq!(error.kind, ErrorKind::InvalidParams, "{params:?}");
                assert_eq!(error.message, "path must be absolute");
            }
            let missing = dir.path().join("missing.wav");
            let error = file_params(Some(&json!({"path": missing}))).unwrap_err();
            assert_eq!(error.kind, ErrorKind::FileNotFound);
            assert_eq!(error.message, "No such file.");
            let error = file_params(Some(&json!({"path": dir.path()}))).unwrap_err();
            assert_eq!(error.kind, ErrorKind::FileNotFound);
            assert_eq!(file_params(Some(&json!({"path": file}))).unwrap(), file);
        }

        #[test]
        fn parse_call_names_the_file() {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("a.wav");
            std::fs::write(&file, b"x").unwrap();
            assert_eq!(
                parse_call("transcribe.file", Some(&json!({"path": file}))).unwrap(),
                Call::Transcribe(file)
            );
            assert_eq!(
                parse_call("transcribe.file", None).unwrap_err().kind,
                ErrorKind::InvalidParams
            );
        }

        #[test]
        fn wait_job_maps_outcomes() {
            let (_, rx) = watched(7, finished()).unwrap();
            assert!(wait_job(&rx).is_ok());

            let (_, rx) = watched(
                7,
                [TranscriptionJobStatus::Failed {
                    error: "Recording contains no speech".into(),
                }],
            )
            .unwrap();
            let error = wait_job(&rx).unwrap_err();
            assert_eq!(error.kind, ErrorKind::Internal);
            assert_eq!(error.message, "Recording contains no speech");

            let (tx, rx) = mpsc::channel::<TranscriptionJobStatus>();
            drop(tx);
            let error = wait_job(&rx).unwrap_err();
            assert_eq!(error.kind, ErrorKind::Internal);
            assert_eq!(error.message, "The transcription stopped.");
        }

        #[test]
        fn wait_job_skips_progress_and_stops_at_the_end() {
            let (_, rx) = watched(
                7,
                [
                    TranscriptionJobStatus::Queued,
                    TranscriptionJobStatus::Running { percent: 40 },
                    TranscriptionJobStatus::Finished,
                    TranscriptionJobStatus::Queued,
                ],
            )
            .unwrap();
            assert!(wait_job(&rx).is_ok());
            // It stopped at the end: the later status is still queued.
            assert_eq!(rx.try_recv().unwrap(), TranscriptionJobStatus::Queued);
        }

        #[test]
        fn entry_text_prefers_cleaned_text() {
            assert_eq!(entry_text(&entry(1, "A", Some("B"))).as_deref(), Some("B"));
            assert_eq!(entry_text(&entry(1, "A", Some(""))).as_deref(), Some("A"));
            assert_eq!(entry_text(&entry(1, "A", None)).as_deref(), Some("A"));
            assert_eq!(entry_text(&entry(1, "", Some(""))), None);
            assert_eq!(entry_text(&entry(1, "", None)), None);
        }

        #[test]
        fn add_file_error_kinds() {
            let no_audio = add_file_error(AddFileError::NoAudio("The file has no audio".into()));
            assert_eq!(no_audio.kind, ErrorKind::UnsupportedAudio);
            assert_eq!(no_audio.kind.code(), 1004);
            assert_eq!(no_audio.message, "The file has no audio");
            let storage = add_file_error(AddFileError::Storage("disk full".into()));
            assert_eq!(storage.kind, ErrorKind::Internal);
            assert_eq!(storage.kind.code(), 1006);
            assert_eq!(storage.message, "disk full");
        }

        #[test]
        fn stt_ready_rules() {
            let none = stt_ready("", Some(true)).unwrap_err();
            assert_eq!(none.kind, ErrorKind::SetupRequired);
            assert_eq!(
                none.message,
                "Choose a speech-to-text model in Vaakora first."
            );
            for installed in [None, Some(false)] {
                let error = stt_ready("small", installed).unwrap_err();
                assert_eq!(error.kind, ErrorKind::ModelNotInstalled, "{installed:?}");
                assert_eq!(
                    error.message,
                    "The selected speech-to-text model is not downloaded."
                );
            }
            assert!(stt_ready("small", Some(true)).is_ok());
        }

        fn run(
            selected: &str,
            installed: Option<bool>,
            add: impl FnOnce(PathBuf) -> Result<Watched, AddFileError>,
            reload: impl FnOnce(i64) -> anyhow::Result<Option<HistoryEntry>>,
        ) -> Result<Value, RpcError> {
            run_transcribe(PathBuf::from("/a.wav"), selected, installed, add, reload)
        }

        #[test]
        fn a_missing_model_stops_before_the_file_is_added() {
            let added = std::cell::Cell::new(false);
            let error = run(
                "",
                Some(true),
                |_| {
                    added.set(true);
                    watched(7, finished())
                },
                |_| Ok(None),
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::SetupRequired);
            let error = run(
                "small",
                Some(false),
                |_| {
                    added.set(true);
                    watched(7, finished())
                },
                |_| Ok(None),
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::ModelNotInstalled);
            assert!(!added.get(), "the file reached History without a model");
        }

        #[test]
        fn an_unreadable_file_is_unsupported_audio() {
            let error = run(
                "small",
                Some(true),
                |_| Err(AddFileError::NoAudio("The file has no audio".into())),
                |_| Ok(None),
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::UnsupportedAudio);
            let error = run(
                "small",
                Some(true),
                |_| Err(AddFileError::Storage("disk full".into())),
                |_| Ok(None),
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::Internal);
        }

        #[test]
        fn the_result_carries_the_text_and_the_history_id() {
            let asked = std::cell::RefCell::new(None);
            let result = run(
                "small",
                Some(true),
                |path| {
                    *asked.borrow_mut() = Some(path);
                    watched(7, finished())
                },
                |id| {
                    assert_eq!(id, 7);
                    Ok(Some(entry(7, "raw", Some("cleaned"))))
                },
            )
            .unwrap();
            assert_eq!(result, json!({"text": "cleaned", "history_id": 7}));
            assert_eq!(asked.take(), Some(PathBuf::from("/a.wav")));
        }

        #[test]
        fn a_job_that_ended_before_the_wait_started_is_still_seen() {
            let result = run(
                "small",
                Some(true),
                |_| {
                    watched(
                        7,
                        [
                            TranscriptionJobStatus::Queued,
                            TranscriptionJobStatus::Running { percent: 0 },
                            TranscriptionJobStatus::Finished,
                        ],
                    )
                },
                |_| Ok(Some(entry(7, "raw", None))),
            )
            .unwrap();
            assert_eq!(result, json!({"text": "raw", "history_id": 7}));
        }

        #[test]
        fn a_failed_job_is_internal_with_its_error() {
            let error = run(
                "small",
                Some(true),
                |_| {
                    watched(
                        7,
                        [TranscriptionJobStatus::Failed {
                            error: "Failed to load audio".into(),
                        }],
                    )
                },
                |_| Ok(None),
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::Internal);
            assert_eq!(error.message, "Failed to load audio");
        }

        #[test]
        fn a_cancelled_or_silent_entry_is_internal() {
            let error = run(
                "small",
                Some(true),
                |_| watched(7, finished()),
                |_| Ok(Some(entry(7, "", Some("")))),
            )
            .unwrap_err();
            assert_eq!(error.kind, ErrorKind::Internal);
            assert_eq!(
                error.message,
                "The transcription was cancelled or found no speech."
            );
        }

        #[test]
        fn a_lost_or_unreadable_entry_is_internal() {
            for reloaded in [Ok(None), Err(anyhow::anyhow!("secret db path"))] {
                let error = run(
                    "small",
                    Some(true),
                    |_| watched(7, finished()),
                    |_| reloaded,
                )
                .unwrap_err();
                assert_eq!(error.kind, ErrorKind::Internal);
                assert_eq!(error.message, "The transcription could not be read back.");
            }
        }
    }

    mod wiring {
        use super::*;

        #[test]
        fn read_carries_the_agent_origin() {
            let source = production_source(include_str!("methods.rs"));
            assert_eq!(
                source.matches("read_text(text, ReadOrigin::Agent)").count(),
                1
            );
            assert!(!source.contains("ReadOrigin::App"));
        }

        #[test]
        fn dictation_uses_the_existing_paths() {
            let source = production_source(include_str!("methods.rs"));
            assert_eq!(
                source
                    .matches("crate::signal_handle::send_transcription_input(&self.app, binding, \"IPC\")")
                    .count(),
                1
            );
            assert_eq!(
                source
                    .matches("crate::utils::cancel_current_operation(&self.app)")
                    .count(),
                1
            );
        }

        #[test]
        fn the_call_adds_the_file_with_a_watcher() {
            let source = production_source(include_str!("methods.rs"));
            assert_eq!(source.matches(".transcribe_file_watched(").count(), 1);
            assert_eq!(source.matches(".transcribe_file(").count(), 0);
        }

        #[test]
        fn methods_log_nothing() {
            let source = production_source(include_str!("methods.rs"));
            for mac in [
                "info!",
                "warn!",
                "debug!",
                "error!",
                "trace!",
                "println!",
                "eprintln!",
            ] {
                assert!(!source.contains(mac), "{mac}");
            }
        }

        #[test]
        fn server_starts_after_the_headless_return() {
            let lib = include_str!("../lib.rs");
            assert_eq!(lib.matches("ipc::start(").count(), 1);
            let start = lib.find("ipc::start(").unwrap();
            let core = lib
                .find("initialize_core_logic(&app_handle);")
                .expect("core logic is initialized in setup");
            let headless = lib
                .find("run_headless_transcription(&handle, &args)")
                .expect("the headless worker is started in setup");
            let headless_return = headless
                + lib[headless..]
                    .find("return Ok(());")
                    .expect("the headless branch returns");
            assert!(
                headless_return < core,
                "core logic runs after the headless return"
            );
            assert!(core < start, "the server starts after the core logic");
        }
    }
}
