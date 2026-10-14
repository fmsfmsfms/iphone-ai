//! iPhone AI desktop shell (Tauri 2, macOS).
//!
//! The shell owns no application logic. It shows a local splash page, starts the
//! bundled Node.js backend (see backend.rs), points its single window at the
//! backend once it reports `LISTENING <port>`, and stops the backend's process
//! group when the app quits. The page never gets IPC: no commands are registered
//! and no capabilities are granted; navigation is limited to the splash page and
//! the backend's own origin, and everything else opens in the default browser.

mod backend;
mod menu;
mod pages;
mod system;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use backend::Backend;

pub const MAIN_WINDOW: &str = "main";

const WIDTH: f64 = 1440.0;
const HEIGHT: f64 = 900.0;
const MIN_WIDTH: f64 = 1100.0;
const MIN_HEIGHT: f64 = 720.0;
/// Matches the splash page background, so the window never flashes white.
const BACKGROUND: Color = Color(11, 12, 16, 255);

fn main() {
    let app = tauri::Builder::default()
        .menu(menu::build)
        .on_menu_event(menu::handle)
        .setup(|app| {
            let handle = app.handle().clone();
            let backend = Backend::new(&handle);
            app.manage(Arc::clone(&backend));
            create_main_window(&handle, &backend)?;
            backend.start();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to initialise the iPhone AI shell");

    app.run(|app, event| match event {
        // Single-window app: closing the window (or Cmd-Q) quits; Tauri requests the exit
        // itself once the last window is gone. Stop the backend on the way out.
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(backend) = app.try_state::<Arc<Backend>>() {
                backend.shutdown();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}

fn create_main_window(app: &AppHandle, backend: &Arc<Backend>) -> tauri::Result<WebviewWindow> {
    let (width, height) = initial_size(app);
    let nav = Arc::clone(backend);
    let popup = Arc::clone(backend);
    let downloads = Arc::clone(backend);
    let shown = Arc::new(AtomicBool::new(false));
    let shown_on_load = Arc::clone(&shown);

    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("iPhone AI")
        .inner_size(width, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .center()
        .theme(Some(Theme::Dark))
        .background_color(BACKGROUND)
        // Shown once the splash has painted (or after a short fallback delay).
        .visible(false)
        // Let the page receive HTML5 drag-and-drop (e.g. importing a workflow file).
        .disable_drag_drop_handler()
        // Every input action leaves iPhone Mirroring frontmost; the first click back on this
        // window must reach the live viewer instead of only activating the app.
        .accept_first_mouse(true)
        .on_navigation(move |url| allow_navigation(&nav, url))
        .on_new_window(move |url, _features| {
            // target=_blank / window.open: external links go to the default browser.
            if !popup.is_backend_url(&url) && !pages::is_local_page(&url) {
                system::open_external(&url);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                // Exports from the backend (or blobs the UI created) are saved to ~/Downloads.
                let allowed = downloads.is_backend_url(&url) || matches!(url.scheme(), "blob" | "data");
                if allowed {
                    downloads.remember_download(&url, destination);
                }
                allowed
            }
            DownloadEvent::Finished { url, success, .. } => {
                downloads.finish_download(&url, success);
                true
            }
            _ => true,
        })
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                show_once(&window, &shown_on_load);
            }
        })
        .build()?;

    let fallback = window.clone();
    let _ = std::thread::Builder::new().name("show-window".into()).spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        show_once(&fallback, &shown);
    });
    Ok(window)
}

/// Only the splash/error page and the running backend may load in the window.
/// `/__shell/<action>` links on the error page are handled here and never load.
fn allow_navigation(backend: &Arc<Backend>, url: &Url) -> bool {
    if pages::is_local_page(url) {
        if let Some(action) = url.path().strip_prefix(pages::SHELL_ACTION_PREFIX) {
            backend.handle_shell_action(action);
            return false;
        }
        return true;
    }
    if backend.is_backend_url(url) || url.scheme() == "about" {
        return true;
    }
    system::open_external(url);
    false
}

fn show_once(window: &WebviewWindow, shown: &AtomicBool) {
    if !shown.swap(true, Ordering::SeqCst) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 1440×900, shrunk to fit smaller displays (never below the minimum size).
fn initial_size(app: &AppHandle) -> (f64, f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else { return (WIDTH, HEIGHT) };
    let scale = monitor.scale_factor().max(1.0);
    let area = monitor.work_area();
    let available_width = f64::from(area.size.width) / scale - 40.0;
    let available_height = f64::from(area.size.height) / scale - 40.0;
    (WIDTH.min(available_width).max(MIN_WIDTH), HEIGHT.min(available_height).max(MIN_HEIGHT))
}
