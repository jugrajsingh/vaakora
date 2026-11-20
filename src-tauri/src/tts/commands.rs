use super::{
    manager::ManagerSnapshot,
    service::{selection, TtsService},
    session::{SessionCommand, SessionView},
};
use handy_tts_core::{
    catalog,
    device::{Device, ModelRating, Preparation, RunOn},
    download::{self, HttpTransport},
    selection::{clamp_selection, Selection},
};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, State};
/// A Hugging Face repository pinned to one commit.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct ModelRevision {
    pub repository: String,
    pub revision: String,
}
/// The machine and date the shipped ratings of one model were measured on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct TtsMeasurement {
    pub machine: String,
    pub date: String,
}
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TtsModelInfo {
    pub id: String,
    pub display_name: String,
    pub license: String,
    pub attribution: String,
    pub card_url: String,
    pub size_bytes: u64,
    pub voices: Vec<String>,
    pub default_voice: String,
    pub downloaded: bool,
    pub downloading: bool,
    pub active: bool,
    pub rating: ModelRating,
    pub run_on: RunOn,
    pub preparation: Preparation,
    pub npu_driver_too_old: bool,
    pub recommended: bool,
    pub needs_token: bool,
    pub languages: Vec<String>,
    pub measured: Option<TtsMeasurement>,
    pub memory_bytes: BTreeMap<Device, u64>,
    pub sources: Vec<ModelRevision>,
}
/// Text before the first `;` of a ratings metadata value, trimmed; `None` when absent or empty.
fn leading_part(value: Option<&String>) -> Option<String> {
    let part = value?.split(';').next()?.trim();
    (!part.is_empty()).then(|| part.to_string())
}
/// Reads the measuring machine and the measurement date of `id` from the ratings metadata.
fn measurement(metadata: &BTreeMap<String, String>, id: &str) -> Option<TtsMeasurement> {
    Some(TtsMeasurement {
        machine: leading_part(metadata.get("machine"))?,
        date: leading_part(metadata.get(&format!("measured_{id}")))?,
    })
}
/// Resident memory of one reading lane per device: base plus lane, for devices that measured both.
fn memory_bytes(rating: &ModelRating) -> BTreeMap<Device, u64> {
    rating
        .devices
        .iter()
        .filter_map(|(device, rating)| {
            let mib = rating.lanes.base_rss_mib? + rating.lanes.lane_rss_mib?;
            Some((*device, (mib * 1_048_576.0).round() as u64))
        })
        .collect()
}
/// Distinct pinned repositories of an entry's files, in file order.
fn sources(entry: &catalog::ModelEntry) -> Vec<ModelRevision> {
    let mut sources: Vec<ModelRevision> = Vec::new();
    for file in &entry.files {
        if !sources
            .iter()
            .any(|s| s.repository == file.repo && s.revision == file.revision)
        {
            sources.push(ModelRevision {
                repository: file.repo.clone(),
                revision: file.revision.clone(),
            });
        }
    }
    sources
}
pub(super) async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| "tts.errors.generic".to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn get_tts_models(
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<Vec<TtsModelInfo>, String> {
    let service = service.inner().clone();
    blocking(move || {
        let ready = service.ready()?;
        let settings = crate::settings::get_settings(&app);
        let snapshot = ready.manager.snapshot();
        let downloads = active_downloads(&service.cancellations);
        catalog::entries()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|entry| {
                let rating = ready
                    .ratings
                    .models
                    .get(entry.id)
                    .cloned()
                    .ok_or("tts.errors.invalidRatings")?;
                Ok(TtsModelInfo {
                    id: entry.id.into(),
                    display_name: entry.name.into(),
                    license: entry.license.into(),
                    attribution: entry.attribution.into(),
                    card_url: entry.card.into(),
                    size_bytes: entry.bytes,
                    voices: entry.voices.iter().map(|voice| voice.to_string()).collect(),
                    default_voice: entry.default_voice.into(),
                    downloaded: download::is_downloaded(&ready.root, entry),
                    downloading: downloads.contains(entry.id),
                    active: entry.id == settings.tts_model_id,
                    languages: entry.languages.iter().map(|tag| tag.to_string()).collect(),
                    measured: measurement(&ready.ratings.metadata, entry.id),
                    memory_bytes: memory_bytes(&rating),
                    sources: sources(entry),
                    rating,
                    run_on: settings
                        .tts_run_on
                        .get(entry.id)
                        .copied()
                        .unwrap_or_default(),
                    npu_driver_too_old: ready.manager.npu_driver_too_old(entry.id),
                    recommended: entry.recommended,
                    needs_token: entry.needs_token(),
                    preparation: handy_tts_core::preparation::visible_preparation(
                        entry.id == settings.tts_model_id,
                        &snapshot.preparation,
                        &ready.preparer.snapshot(entry.id),
                    ),
                })
            })
            .collect()
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn get_tts_status(
    service: State<'_, Arc<TtsService>>,
) -> Result<ManagerSnapshot, String> {
    let service = service.inner().clone();
    blocking(move || Ok(service.ready()?.manager.snapshot())).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_tts_devices(
    service: State<'_, Arc<TtsService>>,
) -> Result<Vec<handy_tts_core::device::Device>, String> {
    let service = service.inner().clone();
    blocking(move || Ok(service.ready()?.available)).await
}
#[tauri::command]
#[specta::specta]
pub async fn get_read_aloud_state(
    service: State<'_, Arc<TtsService>>,
) -> Result<SessionView, String> {
    let service = service.inner().clone();
    blocking(move || Ok(service.ready()?.session.snapshot())).await
}
#[tauri::command]
#[specta::specta]
pub async fn read_aloud_replace_text(
    text: String,
    client_revision: u64,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        service.reading_command(SessionCommand::Replace {
            client_revision: Some(client_revision),
            text,
            autoplay: false,
        })
    })
    .await
}
macro_rules! session_command {
    ($name:ident,$message:expr) => {
        #[tauri::command]
        #[specta::specta]
        pub async fn $name(service: State<'_, Arc<TtsService>>) -> Result<(), String> {
            let service = service.inner().clone();
            blocking(move || service.reading_command($message)).await
        }
    };
}
session_command!(read_aloud_play, SessionCommand::Play);
session_command!(read_aloud_pause, SessionCommand::Pause);
session_command!(read_aloud_stop, SessionCommand::Stop);
#[tauri::command]
#[specta::specta]
pub async fn read_aloud_read_clipboard(service: State<'_, Arc<TtsService>>) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        service.ready()?;
        service.read_clipboard();
        Ok(())
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn read_aloud_close(service: State<'_, Arc<TtsService>>) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        service.close();
        Ok(())
    })
    .await
}
pub fn set_selection(
    app: &AppHandle,
    service: &TtsService,
    chosen: Selection,
) -> Result<(), String> {
    let chosen = clamp_selection(chosen).map_err(|e| {
        log::warn!("TTS selection refused: {e}");
        e.to_string()
    })?;
    let entry = catalog::entry(&chosen.model_id).map_err(|e| e.to_string())?;
    if !entry.voices.contains(&chosen.voice) {
        log::warn!("TTS selection refused: tts.errors.invalidVoice");
        return Err("tts.errors.invalidVoice".into());
    }
    let ready = service.ready()?;
    let app = app.clone();
    let reader = app.clone();
    let result = select_with_store(
        chosen,
        download::availability(&ready.root, entry).map_err(|e| e.to_string())?,
        &ready.session,
        move || crate::settings::get_settings(&reader),
        move |settings| crate::settings::write_settings_checked(&app, settings),
    );
    service.refresh_tray();
    result
}
pub(super) fn select_with_store(
    chosen: Selection,
    downloaded: bool,
    session: &super::session::ReadAloudSession,
    read: impl FnOnce() -> crate::settings::AppSettings + Send + 'static,
    write: impl FnOnce(crate::settings::AppSettings) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let model = chosen.model_id.clone();
    log::info!("TTS selection requested: {model}");
    let result = if !downloaded {
        Err("tts.errors.notDownloaded".into())
    } else {
        session.select_and_wait(
            chosen,
            downloaded,
            Box::new(move |chosen| {
                let mut settings = read();
                settings.tts_model_id = chosen.model_id.clone();
                settings
                    .tts_voice
                    .insert(chosen.model_id.clone(), chosen.voice.clone());
                settings.tts_speed = chosen.speed;
                settings.tts_pitch_semitones = chosen.pitch;
                settings.tts_output_device = chosen.output_device.clone();
                settings.tts_read_code_blocks = chosen.read_code;
                settings.tts_technical_reading = chosen.technical;
                settings.tts_full_paths = chosen.full_paths;
                settings.tts_full_links = chosen.full_links;
                write(settings).map_err(|_| handy_tts_core::selection::SelectionError::Persist)
            }),
        )
    };
    match &result {
        Ok(()) => log::info!("TTS selection saved: {model}"),
        Err(error) => log::warn!("TTS selection failed: {model}: {error}"),
    }
    result
}
#[tauri::command]
#[specta::specta]
pub async fn set_tts_selection(
    chosen: Selection,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || set_selection(&app, &service, chosen)).await
}
#[tauri::command]
#[specta::specta]
pub async fn set_tts_model(
    model_id: String,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let entry = catalog::entry(&model_id).map_err(|e| e.to_string())?;
        let mut chosen = selection(&crate::settings::get_settings(&app));
        chosen.model_id = model_id;
        chosen.voice = crate::settings::get_settings(&app)
            .tts_voice
            .get(entry.id)
            .cloned()
            .unwrap_or_else(|| entry.default_voice.into());
        set_selection(&app, &service, chosen)
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn set_tts_run_on(
    model_id: String,
    choice: RunOn,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        catalog::entry(&model_id).map_err(|e| e.to_string())?;
        let ready = service.ready()?;
        let mut settings = crate::settings::get_settings(&app);
        settings.tts_run_on.insert(model_id.clone(), choice);
        crate::settings::write_settings_checked(&app, settings.clone())?;
        ready
            .manager
            .set_run_on(&model_id, choice)
            .map_err(|e| e.to_string())?;
        if settings.tts_model_id == model_id {
            ready.session.select_and_wait(
                selection(&settings),
                ready
                    .manager
                    .availability(&model_id)
                    .map_err(|e| e.to_string())?,
                Box::new(|_| Ok(())),
            )?;
        }
        super::preparation::prepare(&ready, &model_id, choice)?;
        Ok(())
    })
    .await
}
fn unload_after_stop(
    stop: impl FnOnce() -> Result<(), String>,
    unload: impl FnOnce(),
) -> Result<(), String> {
    stop()?;
    unload();
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn unload_tts_model(service: State<'_, Arc<TtsService>>) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let ready = service.ready()?;
        unload_after_stop(
            || ready.session.stop_and_wait().map_err(|e| e.to_string()),
            || ready.manager.unload(),
        )
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn download_tts_model(
    model_id: String,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let ready = service.ready()?;
        let entry = catalog::entry(&model_id).map_err(|e| e.to_string())?;
        let cancel = Arc::new(AtomicBool::new(false));
        let _ownership =
            DownloadOwnership::claim(&service.cancellations, &model_id, cancel.clone())?;
        let transport = HttpTransport::new("https://huggingface.co").map_err(|e| e.to_string())?;
        let result = service
            .downloader
            .download(&ready.root, entry, &transport, &cancel, |progress| {
                service.download_progress(progress)
            })
            .map(|_| ())
            .map_err(|e| e.to_string());
        service.refresh_tray();
        if result.is_ok() {
            super::preparation::prepare(
                &ready,
                &model_id,
                ready
                    .manager
                    .configuration()
                    .run_on
                    .get(&model_id)
                    .copied()
                    .unwrap_or_default(),
            )?;
        }
        result
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn cancel_tts_download(
    model_id: String,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        if let Some(cancel) = service
            .cancellations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&model_id)
        {
            cancel.store(true, Ordering::Release);
        }
        Ok(())
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn delete_tts_model(
    model_id: String,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let ready = service.ready()?;
        ready.preparer.cancel(&model_id);
        if ready.manager.has_model(&model_id) {
            ready.session.stop_and_wait().map_err(|e| e.to_string())?;
            ready.manager.selected();
        }
        let entry = catalog::entry(&model_id).map_err(|e| e.to_string())?;
        let result = download::delete(&ready.root, entry).map_err(|e| e.to_string());
        service.refresh_tray();
        result
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn set_tts_hf_token(
    token: String,
    service: State<'_, Arc<TtsService>>,
) -> Result<bool, String> {
    let service = service.inner().clone();
    blocking(move || {
        service.downloader.credentials.set(token);
        Ok(service.downloader.credentials.session_configured())
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn preview_tts_voice(
    voice: String,
    text: String,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let service = service.inner().clone();
    blocking(move || {
        let mut chosen = selection(&crate::settings::get_settings(&app));
        chosen.voice = voice;
        let ready = service.ready()?;
        let entry = catalog::entry(&chosen.model_id).map_err(|e| e.to_string())?;
        if !entry.voices.contains(&chosen.voice) {
            return Err("tts.errors.invalidVoice".into());
        }
        if !download::availability(&ready.root, entry).map_err(|e| e.to_string())? {
            return Err("tts.errors.notDownloaded".into());
        }
        service.preview(chosen, text)
    })
    .await
}

struct DownloadOwnership<'a> {
    map: &'a std::sync::Mutex<std::collections::BTreeMap<String, Arc<AtomicBool>>>,
    model: &'a str,
}
fn active_downloads(
    map: &std::sync::Mutex<std::collections::BTreeMap<String, Arc<AtomicBool>>>,
) -> std::collections::BTreeSet<String> {
    map.lock()
        .unwrap_or_else(|p| p.into_inner())
        .keys()
        .cloned()
        .collect()
}
impl<'a> DownloadOwnership<'a> {
    fn claim(
        map: &'a std::sync::Mutex<std::collections::BTreeMap<String, Arc<AtomicBool>>>,
        model: &'a str,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let mut entries = map.lock().unwrap_or_else(|p| p.into_inner());
        if entries.contains_key(model) {
            return Err("tts.errors.downloading".into());
        }
        entries.insert(model.into(), cancel);
        Ok(Self { map, model })
    }
}
impl Drop for DownloadOwnership<'_> {
    fn drop(&mut self) {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(self.model);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "current_thread")]
    async fn selection_prepare_and_commit_leave_ui_responsive() {
        let (release, busy) = std::sync::mpsc::channel();
        let invoking = std::thread::current().id();
        let job = blocking(move || {
            assert_ne!(std::thread::current().id(), invoking);
            let _ = busy.recv_timeout(std::time::Duration::from_secs(2));
            Ok(())
        });
        tokio::pin!(job);
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
            _ = &mut job => panic!("selection prepare blocked the UI heartbeat"),
        }
        release.send(()).unwrap();
        assert!(job.await.is_ok());
    }

    #[test]
    fn download_snapshot_tracks_backend_ownership_until_job_settles() {
        let map = std::sync::Mutex::new(std::collections::BTreeMap::new());
        assert!(active_downloads(&map).is_empty());
        let cancel = Arc::new(AtomicBool::new(false));
        let job = DownloadOwnership::claim(&map, "pocket-en", cancel.clone()).unwrap();
        assert!(active_downloads(&map).contains("pocket-en"));
        cancel.store(true, Ordering::Release);
        assert!(active_downloads(&map).contains("pocket-en"));
        drop(job);
        assert!(active_downloads(&map).is_empty());
    }
    #[test]
    fn measurement_reads_machine_and_date() {
        let metadata = |pairs: &[(&str, &str)]| -> std::collections::BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let measured = |machine: &str, date: &str| TtsMeasurement {
            machine: machine.into(),
            date: date.into(),
        };
        assert_eq!(
            measurement(
                &metadata(&[
                    ("machine", "M"),
                    ("measured_x", "2026-11-08; max load1 1.5")
                ]),
                "x"
            ),
            Some(measured("M", "2026-11-08"))
        );
        assert_eq!(
            measurement(
                &metadata(&[("machine", "CPU X; 8 cores"), ("measured_x", "2026-11-08")]),
                "x"
            ),
            Some(measured("CPU X", "2026-11-08"))
        );
        for missing in [
            metadata(&[("machine", "M")]),
            metadata(&[("measured_x", "2026-11-08")]),
            metadata(&[("machine", " ; 8 cores"), ("measured_x", "2026-11-08")]),
            metadata(&[("machine", "M"), ("measured_x", "; max load1 1.5")]),
        ] {
            assert_eq!(measurement(&missing, "x"), None);
        }
        let shipped: handy_tts_core::device::Ratings =
            serde_json::from_str(include_str!("../../resources/tts/ratings.json")).unwrap();
        for id in catalog::ids().unwrap() {
            assert_eq!(
                measurement(&shipped.metadata, id),
                Some(measured("Intel Core Ultra 7 258V", "2026-11-08")),
                "{id}"
            );
        }
    }
    #[test]
    fn memory_needs_base_and_lane() {
        let rating: ModelRating = serde_json::from_value(serde_json::json!({
            "quality": 9,
            "devices": {
                "cpu": {"supported": true, "placement": {}, "recommended": true,
                        "base_rss_mib": 9.640625, "lane_rss_mib": 422.625},
                "gpu": {"supported": true, "placement": {}, "recommended": false,
                        "base_rss_mib": 9.703125},
                "npu": {"supported": false, "placement": {}, "recommended": false,
                        "lane_rss_mib": 12.0}
            }
        }))
        .unwrap();
        assert_eq!(
            memory_bytes(&rating),
            std::collections::BTreeMap::from([(Device::Cpu, 453_263_360)])
        );
    }
    #[test]
    fn sources_are_distinct_in_file_order() {
        let revision = |repository: &str, revision: &str| ModelRevision {
            repository: repository.into(),
            revision: revision.into(),
        };
        assert_eq!(
            sources(catalog::entry("pocket-en").unwrap()),
            [
                revision(
                    "KevinAHM/pocket-tts-onnx",
                    "58a6d00cf13d239b6748cb0769f35c580a8f606c"
                ),
                revision(
                    "kyutai/pocket-tts",
                    "75cfe24e3142233bb81887fed3482e9652bb4a6e"
                ),
            ]
        );
        for entry in catalog::entries().unwrap() {
            let listed = sources(entry);
            assert!(!listed.is_empty(), "{}", entry.id);
            assert!(entry.files.iter().all(|file| listed
                .iter()
                .any(|s| s.repository == file.repo && s.revision == file.revision)));
            for (i, source) in listed.iter().enumerate() {
                assert!(!listed[..i].contains(source), "{}", entry.id);
            }
        }
    }
    #[test]
    fn second_download_cannot_steal_cancel_ownership_and_error_drop_releases_it() {
        let map = std::sync::Mutex::new(std::collections::BTreeMap::new());
        let original = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        let first = DownloadOwnership::claim(&map, "pocket-en", original.clone()).unwrap();
        assert!(DownloadOwnership::claim(&map, "pocket-en", second.clone()).is_err());
        map.lock()
            .unwrap()
            .get("pocket-en")
            .unwrap()
            .store(true, Ordering::Release);
        assert!(original.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        drop(first);
        assert!(map.lock().unwrap().is_empty());
        assert!(DownloadOwnership::claim(&map, "pocket-en", second).is_ok());
    }
}

#[cfg(test)]
mod wbfix_tests {
    use super::*;
    #[test]
    fn wbfix_unload_requires_stop_acknowledgement() {
        let stopped = std::cell::Cell::new(false);
        let unloaded = std::cell::Cell::new(false);
        unload_after_stop(
            || {
                stopped.set(true);
                Ok(())
            },
            || {
                assert!(stopped.get(), "stop must precede unload");
                unloaded.set(true);
            },
        )
        .unwrap();
        assert!(unloaded.get());
        unloaded.set(false);
        assert!(unload_after_stop(|| Err("stop pending".into()), || unloaded.set(true)).is_err());
        assert!(!unloaded.get(), "unacknowledged stop must never unload");
    }
}
