use crate::audio_toolkit::audio::output_device_name;
use crate::settings::SoundTheme;
use crate::settings::{self, AppSettings};
use log::{debug, error, warn};
use rodio::cpal::traits::HostTrait;
use rodio::DeviceSinkBuilder;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub enum SoundType {
    Start,
    Stop,
}

fn resolve_sound_path(
    app: &AppHandle,
    settings: &AppSettings,
    sound_type: SoundType,
) -> Option<PathBuf> {
    let sound_file = get_sound_path(settings, sound_type);
    let base_dir = get_sound_base_dir(settings);
    match base_dir {
        tauri::path::BaseDirectory::AppData => {
            crate::portable::resolve_app_data(app, &sound_file).ok()
        }
        _ => app.path().resolve(&sound_file, base_dir).ok(),
    }
}

fn get_sound_path(settings: &AppSettings, sound_type: SoundType) -> String {
    match (settings.sound_theme, sound_type) {
        (SoundTheme::Custom, SoundType::Start) => "custom_start.wav".to_string(),
        (SoundTheme::Custom, SoundType::Stop) => "custom_stop.wav".to_string(),
        (_, SoundType::Start) => settings.sound_theme.to_start_path(),
        (_, SoundType::Stop) => settings.sound_theme.to_stop_path(),
    }
}

fn get_sound_base_dir(settings: &AppSettings) -> tauri::path::BaseDirectory {
    match settings.sound_theme {
        SoundTheme::Custom => tauri::path::BaseDirectory::AppData,
        _ => tauri::path::BaseDirectory::Resource,
    }
}

pub fn play_feedback_sound(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if !settings.audio_feedback {
        return;
    }
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_async(app, path);
    }
}

pub fn play_feedback_sound_blocking(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if !settings.audio_feedback {
        return;
    }
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_blocking(app, &path);
    }
}

pub fn play_test_sound(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_blocking(app, &path);
    }
}

fn play_sound_async(app: &AppHandle, path: PathBuf) {
    let app_handle = app.clone();
    thread::spawn(move || {
        if let Err(e) = play_sound_at_path(&app_handle, path.as_path()) {
            error!("Failed to play sound '{}': {}", path.display(), e);
        }
    });
}

fn play_sound_blocking(app: &AppHandle, path: &Path) {
    if let Err(e) = play_sound_at_path(app, path) {
        error!("Failed to play sound '{}': {}", path.display(), e);
    }
}

fn play_sound_at_path(app: &AppHandle, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let settings = settings::get_settings(app);
    let volume = settings.audio_feedback_volume;
    let selected_device = settings.selected_output_device.clone();
    play_audio_file(path, selected_device, volume)
}

fn play_audio_file(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), Box<dyn std::error::Error>> {
    let sink_builder = if let Some(device_name) = selected_device {
        if device_name == "Default" {
            debug!("Using default device");
            DeviceSinkBuilder::from_default_device()?
        } else {
            let host = crate::audio_toolkit::get_cpal_host();
            let found_device = host
                .output_devices()?
                .find(|device| output_device_name(device).as_deref() == Some(&device_name));

            match found_device {
                Some(device) => DeviceSinkBuilder::from_device(device)?,
                None => {
                    warn!("Device '{}' not found, using default device", device_name);
                    DeviceSinkBuilder::from_default_device()?
                }
            }
        }
    } else {
        debug!("Using default device");
        DeviceSinkBuilder::from_default_device()?
    };

    // rodio defaults to a fixed 2048-frame buffer, which some Bluetooth
    // outputs reject.
    let device_sink = sink_builder
        .with_buffer_size(rodio::cpal::BufferSize::Default)
        .open_stream()?;
    let mixer = device_sink.mixer();

    let file = File::open(path)?;
    let buf_reader = BufReader::new(file);

    let player = rodio::play(mixer, buf_reader)?;
    player.set_volume(volume);

    // Bound the wait: when the output device wedges (on Linux/ALSA the hardware
    // can keep a stale open handle), an unbounded wait parks this thread for
    // good while the stream keeps the device's output side locked, and every
    // other consumer of the device gets EBUSY for as long as the app lives.
    // Giving up drops the player and the stream, which releases the device.
    if !wait_until_done(|| player.empty(), FEEDBACK_MAX, FEEDBACK_POLL) {
        warn!(
            "Feedback sound did not finish within {}s (wedged output device?); dropping the output stream",
            FEEDBACK_MAX.as_secs()
        );
    }

    Ok(())
}

/// The longest a start or stop sound may keep the output device open.
const FEEDBACK_MAX: Duration = Duration::from_secs(30);
const FEEDBACK_POLL: Duration = Duration::from_millis(50);

/// Polls `done` every `poll` until it returns true or `cap` has passed.
/// Returns whether `done` returned true within `cap`.
fn wait_until_done(mut done: impl FnMut() -> bool, cap: Duration, poll: Duration) -> bool {
    let started = Instant::now();
    while !done() {
        if started.elapsed() >= cap {
            return false;
        }
        thread::sleep(poll);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_returns_once_done() {
        let mut polls = 0;
        let done = wait_until_done(
            || {
                polls += 1;
                polls == 4
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
        );
        assert!(done);
        assert_eq!(polls, 4);
    }

    #[test]
    fn wait_gives_up_after_the_cap() {
        let started = Instant::now();
        let done = wait_until_done(
            || false,
            Duration::from_millis(30),
            Duration::from_millis(5),
        );
        assert!(!done);
        assert!(started.elapsed() >= Duration::from_millis(30));
    }
}
