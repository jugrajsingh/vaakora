use crate::settings::OverlayPosition;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
/// Set once the reader window became a GTK layer surface.
static READER_LAYER_SHELL: AtomicBool = AtomicBool::new(false);
const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 200.0;
#[derive(Debug, Clone, PartialEq)]
pub struct WindowPolicy {
    pub width: f64,
    pub height: f64,
    pub focusable: bool,
    pub keyboard_on_demand: bool,
}
pub fn policy(layer_shell: bool) -> WindowPolicy {
    WindowPolicy {
        width: WIDTH,
        height: HEIGHT,
        focusable: true,
        keyboard_on_demand: layer_shell,
    }
}
trait Focusable: Sized {
    fn focusable(self, focusable: bool) -> Self;
}
impl<'a, R: tauri::Runtime, M: tauri::Manager<R>> Focusable
    for tauri::WebviewWindowBuilder<'a, R, M>
{
    fn focusable(self, focusable: bool) -> Self {
        self.focusable(focusable)
    }
}
fn configure_builder<B: Focusable>(builder: B, policy: &WindowPolicy) -> B {
    builder.focusable(policy.focusable)
}
#[cfg(target_os = "linux")]
trait KeyboardSurface {
    fn set_keyboard_mode(&self, mode: gtk_layer_shell::KeyboardMode);
}
#[cfg(target_os = "linux")]
impl KeyboardSurface for gtk::ApplicationWindow {
    fn set_keyboard_mode(&self, mode: gtk_layer_shell::KeyboardMode) {
        gtk_layer_shell::LayerShell::set_keyboard_mode(self, mode);
    }
}
#[cfg(target_os = "linux")]
fn configure_keyboard(surface: &impl KeyboardSurface, policy: &WindowPolicy) {
    surface.set_keyboard_mode(if policy.keyboard_on_demand {
        gtk_layer_shell::KeyboardMode::OnDemand
    } else {
        gtk_layer_shell::KeyboardMode::None
    });
}
pub fn create(app: &tauri::AppHandle, position: OverlayPosition) -> Result<(), String> {
    if app.get_webview_window("read_aloud").is_some() {
        return Ok(());
    }
    let p = policy(true);
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "read_aloud",
        tauri::WebviewUrl::App("src/read-aloud/index.html".into()),
    )
    .title("read_aloud")
    .inner_size(p.width, p.height)
    .visible(false)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .always_on_top(true)
    .focused(false);
    let window = configure_builder(builder, &p)
        .build()
        .map_err(|_| "tts.errors.window".to_string())?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::{GtkWindowExt, WidgetExt};
        use gtk_layer_shell::{Layer, LayerShell};
        if !crate::utils::env_flag_enabled("HANDY_NO_GTK_LAYER_SHELL")
            && gtk_layer_shell::is_supported()
        {
            if let Ok(gtk) = window.gtk_window() {
                gtk.init_layer_shell();
                gtk.set_layer(Layer::Overlay);
                configure_keyboard(&gtk, &p);
                gtk.set_exclusive_zone(0);
                crate::overlay::configure_layer_shell_surface(&gtk, position, p.width, p.height);
                gtk.set_size_request(p.width as i32, p.height as i32);
                gtk.resize(1, 1);
                READER_LAYER_SHELL.store(gtk.is_layer_window(), Ordering::SeqCst);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = position;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(service) = handle.try_state::<std::sync::Arc<super::service::TtsService>>()
            {
                let service = service.inner().clone();
                std::thread::spawn(move || service.close());
            }
            hide(&handle);
        }
    });
    Ok(())
}
fn place(app: &tauri::AppHandle, window: &tauri::webview::WebviewWindow) {
    crate::overlay::place_floating_window(
        app,
        window,
        WIDTH,
        HEIGHT,
        READER_LAYER_SHELL.load(Ordering::SeqCst),
    );
}
/// True when opening the reader asks for keyboard focus: only an empty one does.
pub(crate) fn takes_focus(text: &str) -> bool {
    text.trim().is_empty()
}
fn show_with(place: impl FnOnce(), show: impl FnOnce(), focus: bool, do_focus: impl FnOnce()) {
    place();
    show();
    if focus {
        do_focus();
    }
}
/// Places the reader by the overlay's position rules, then shows it, focusing it when `focus`. Main thread only.
pub fn show(app: &tauri::AppHandle, focus: bool) {
    if let Some(w) = app.get_webview_window("read_aloud") {
        show_with(
            || place(app, &w),
            || {
                let _ = w.show();
            },
            focus,
            || {
                let _ = w.set_focus();
            },
        );
    }
}
/// Re-places the reader when it is visible. Main thread only.
pub fn reposition(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("read_aloud") {
        if w.is_visible().unwrap_or(false) {
            place(app, &w);
        }
    }
}
pub fn hide(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("read_aloud") {
        let _ = w.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn show_places_before_showing() {
        let calls = std::cell::RefCell::new(Vec::new());
        show_with(
            || calls.borrow_mut().push("place"),
            || calls.borrow_mut().push("show"),
            true,
            || calls.borrow_mut().push("focus"),
        );
        assert_eq!(calls.into_inner(), ["place", "show", "focus"]);
    }
    #[test]
    fn reader_focuses_only_when_opened_empty() {
        for (text, expected) in [
            ("", vec!["place", "show", "focus"]),
            ("  \n", vec!["place", "show", "focus"]),
            ("Plan", vec!["place", "show"]),
        ] {
            let calls = std::cell::RefCell::new(Vec::new());
            show_with(
                || calls.borrow_mut().push("place"),
                || calls.borrow_mut().push("show"),
                takes_focus(text),
                || calls.borrow_mut().push("focus"),
            );
            assert_eq!(calls.into_inner(), expected, "opened with {text:?}");
        }
    }
    #[test]
    fn popup_is_focusable_and_layer_shell_keyboard_policy_is_on_demand() {
        struct Builder {
            applied: Option<bool>,
        }
        impl Focusable for Builder {
            fn focusable(mut self, focusable: bool) -> Self {
                self.applied = Some(focusable);
                self
            }
        }
        let layer = policy(true);
        assert_eq!((layer.width, layer.height), (560.0, 200.0));
        assert!(layer.focusable && layer.keyboard_on_demand);
        assert_eq!(
            configure_builder(Builder { applied: None }, &layer).applied,
            Some(true)
        );
        let plain = policy(false);
        assert!(!plain.keyboard_on_demand);
        assert!(plain.focusable);
        assert_eq!(
            configure_builder(Builder { applied: None }, &plain).applied,
            Some(true)
        );
        #[cfg(target_os = "linux")]
        {
            struct Surface(std::cell::Cell<Option<gtk_layer_shell::KeyboardMode>>);
            impl KeyboardSurface for Surface {
                fn set_keyboard_mode(&self, mode: gtk_layer_shell::KeyboardMode) {
                    self.0.set(Some(mode));
                }
            }
            let surface = Surface(std::cell::Cell::new(None));
            configure_keyboard(&surface, &layer);
            assert!(matches!(
                surface.0.get(),
                Some(gtk_layer_shell::KeyboardMode::OnDemand)
            ));
            configure_keyboard(&surface, &plain);
            assert!(matches!(
                surface.0.get(),
                Some(gtk_layer_shell::KeyboardMode::None)
            ));
        }
    }
}
