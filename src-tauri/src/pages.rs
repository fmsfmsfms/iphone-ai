//! The local splash page (src-tauri/splash) doubles as the startup-error page.
//! Its state travels in the URL fragment; its buttons are plain links to
//! `tauri://localhost/__shell/<action>` that the navigation handler intercepts,
//! so the page needs no IPC.

use std::path::Path;

use tauri::{AppHandle, Manager, Url, UserAttentionType};

use crate::system::{percent_encode, truncate_chars};
use crate::MAIN_WINDOW;

/// Origin of the embedded splash assets on macOS (`frontendDist`, no devUrl).
const LOCAL_ORIGIN: &str = "tauri://localhost";
/// Path prefix of the action links on the error page.
pub const SHELL_ACTION_PREFIX: &str = "/__shell/";
/// Lines of recent backend output shown on the error page.
const ERROR_PAGE_LINES: usize = 25;

/// Is this one of the shell's own (embedded) pages?
pub fn is_local_page(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

pub fn splash_url() -> Url {
    parse_local("/index.html#starting")
}

pub fn error_url(title: &str, message: &str, log_file: &Path, recent: &[String]) -> Url {
    let start = recent.len().saturating_sub(ERROR_PAGE_LINES);
    let lines: Vec<String> = recent[start..].iter().map(|line| truncate_chars(line, 300)).collect();
    let payload = serde_json::json!({
        "title": title,
        "message": message,
        "log": log_file.display().to_string(),
        "lines": lines,
    });
    parse_local(&format!("/index.html#error={}", percent_encode(&payload.to_string())))
}

pub fn show_splash(app: &AppHandle) {
    navigate(app, splash_url());
}

pub fn show_error(app: &AppHandle, title: &str, message: &str, log_file: &Path, recent: &[String]) {
    navigate(app, error_url(title, message, log_file, recent));
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        // Bounce the Dock icon instead of stealing focus.
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(err) = window.navigate(url) {
            eprintln!("[iphone-ai] could not navigate the main window: {err}");
        }
    }
}

fn parse_local(path_and_fragment: &str) -> Url {
    let raw = format!("{LOCAL_ORIGIN}{path_and_fragment}");
    // The inputs are constant or percent-encoded, so this cannot fail; keep a safe fallback anyway.
    raw.parse().unwrap_or_else(|_| Url::parse(LOCAL_ORIGIN).expect("static URL"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn error_url_round_trips_through_the_fragment() {
        let recent: Vec<String> = (0..40).map(|i| format!("line {i} with # and %")).collect();
        let url = error_url("Title", "Bad \"thing\" happened", &PathBuf::from("/tmp/a b.log"), &recent);
        assert!(is_local_page(&url));
        assert_eq!(url.path(), "/index.html");
        let fragment = url.fragment().unwrap();
        let encoded = fragment.strip_prefix("error=").unwrap();
        assert!(encoded.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.~%".contains(&b)));
        // Only the last 25 lines (15..=39) are kept.
        assert!(!encoded.contains("line%2014%20"));
        assert!(encoded.contains("line%2015%20"));
        assert!(encoded.contains("line%2039%20"));
    }

    #[test]
    fn splash_url_is_local() {
        let url = splash_url();
        assert!(is_local_page(&url));
        assert_eq!(url.fragment(), Some("starting"));
    }
}
