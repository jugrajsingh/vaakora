//! Commands for read-aloud history: the list, Clear history and its two settings.

use super::{
    commands::blocking,
    history::{checked_limit, Keep, ReadHistory, ReadHistoryEntry},
    service::TtsService,
};
use crate::settings::{get_settings, write_settings, AppSettings, ReadHistoryRetention};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Applies `change` to `settings` once the store is open; a store still opening, or one that
/// failed, refuses the change so a setting is never saved without its prune.
fn change_with_store(
    history: Result<Arc<ReadHistory>, String>,
    mut settings: AppSettings,
    change: impl FnOnce(&mut AppSettings),
) -> Result<(AppSettings, Arc<ReadHistory>, Keep), String> {
    let history = history?;
    change(&mut settings);
    let keep = Keep::from_settings(&settings);
    Ok((settings, history, keep))
}

/// Saves `change` to the settings, then prunes the store with the new keep rules.
async fn apply_setting(
    app: AppHandle,
    history: Result<Arc<ReadHistory>, String>,
    change: impl FnOnce(&mut AppSettings) + Send + 'static,
) -> Result<(), String> {
    blocking(move || {
        let (settings, history, keep) = change_with_store(history, get_settings(&app), change)?;
        write_settings(&app, settings);
        history
            .prune(keep, chrono::Utc::now().timestamp())
            .map(|_| ())
            .map_err(|error| format!("{error:#}"))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_tts_history(
    service: State<'_, Arc<TtsService>>,
) -> Result<Vec<ReadHistoryEntry>, String> {
    let history = service.history()?;
    blocking(move || history.entries().map_err(|error| format!("{error:#}"))).await
}

#[tauri::command]
#[specta::specta]
pub async fn clear_tts_history(service: State<'_, Arc<TtsService>>) -> Result<usize, String> {
    let history = service.history()?;
    blocking(move || history.clear().map_err(|error| format!("{error:#}"))).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_tts_history_limit(
    limit: usize,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    let limit = checked_limit(limit)?;
    apply_setting(app, service.history(), move |settings| {
        settings.tts_history_limit = limit;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_tts_history_retention(
    retention: ReadHistoryRetention,
    app: AppHandle,
    service: State<'_, Arc<TtsService>>,
) -> Result<(), String> {
    apply_setting(app, service.history(), move |settings| {
        settings.tts_history_retention = retention;
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pending_store_refuses_a_setting_change() {
        let mut changed = false;
        let result = change_with_store(
            Err("tts.errors.starting".into()),
            crate::settings::get_default_settings(),
            |settings| {
                changed = true;
                settings.tts_history_retention = ReadHistoryRetention::KeepNothing;
            },
        );
        assert_eq!(result.err().as_deref(), Some("tts.errors.starting"));
        assert!(!changed, "the change ran before the store was resolved");
    }
}
