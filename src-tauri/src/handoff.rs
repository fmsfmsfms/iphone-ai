//! Hand-off from a copy in a privacy-protected folder to the installed copy.
//!
//! Spotlight indexes app bundles in ~/Documents (build outputs included) and registers
//! them with LaunchServices, so the Dock, Spotlight or Launchpad may start a copy whose
//! backend cannot run there (see `backend::protected_folder`). Such a copy opens
//! `/Applications/iPhone AI.app` instead and quits, but only when that is the same app
//! (bundle identifier) and at least as new; otherwise it starts normally and shows the
//! "move it to Applications" error page. The installed copy is never in a protected
//! folder, so it never hands off again.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::{backend, system};

const INSTALLED_APP: &str = "/Applications/iPhone AI.app";

/// Opens the installed copy when this one runs from a protected folder. Returns true when
/// it did; the caller then exits without starting Tauri.
pub fn hand_off_to_installed_copy(own_id: &str, own_version: &str) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(home) = home_dir() else { return false };
    // `cargo run`, or a copy outside the protected folders: start normally, no file access.
    let Some(own_app) = enclosing_app(&exe) else { return false };
    let Some(folder) = backend::protected_folder(&exe, &home) else { return false };

    let log_file = backend::default_log_file(&home);
    let own = format!("started from the {folder} folder ({}, {own_id}, version {own_version})", own_app.display());
    let Ok(installed) = fs::canonicalize(INSTALLED_APP) else {
        log(&log_file, &format!("{own}; no installed copy at {INSTALLED_APP} to hand off to"));
        return false;
    };
    let installed_id = plist_string(&installed, "CFBundleIdentifier").unwrap_or_default();
    let installed_version = plist_string(&installed, "CFBundleShortVersionString").unwrap_or_default();
    let target = format!(
        "{} ({}, version {})",
        installed.display(),
        if installed_id.is_empty() { "no bundle id" } else { &installed_id },
        if installed_version.is_empty() { "unknown" } else { &installed_version }
    );

    if let Err(reason) = should_hand_off(&exe, &home, &installed, &installed_id, own_id) {
        log(&log_file, &format!("{own}; not handing off to {target}: {reason}"));
        return false;
    }
    if !installed_is_at_least(&installed_version, own_version) {
        log(&log_file, &format!("{own}; not handing off to {target}: the installed copy is older"));
        return false;
    }
    match open_app(&installed) {
        Ok(()) => {
            log(&log_file, &format!("{own}; handed off to the installed copy {target}"));
            true
        }
        Err(err) => {
            log(&log_file, &format!("{own}; could not open the installed copy {target}: {err}"));
            false
        }
    }
}

/// Hand off only from a protected copy to a different, unprotected copy of the same app;
/// the error names the check that failed. All paths are compared in canonical form:
/// `installed` already is, the own bundle and `home` are canonicalized here, so neither a
/// symlink in /Applications pointing back at this copy nor a symlinked home folder
/// confuses the checks.
fn should_hand_off(
    exe: &Path,
    home: &Path,
    installed: &Path,
    installed_id: &str,
    own_id: &str,
) -> Result<(), &'static str> {
    let own_app = enclosing_app(exe).ok_or("this copy is not an app bundle")?;
    let own_app = fs::canonicalize(&own_app).unwrap_or(own_app);
    let home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if backend::protected_folder(&own_app, &home).is_none() {
        Err("this copy's real location is outside the protected folders")
    } else if own_id.is_empty() || installed_id != own_id {
        Err("the installed copy is a different app")
    } else if installed == own_app {
        Err("the installed path is this very copy")
    } else if backend::protected_folder(installed, &home).is_some() {
        Err("the installed copy is in a protected folder too")
    } else {
        Ok(())
    }
}

/// `<X>.app/Contents/MacOS/<exe>` -> `<X>.app`; None for an unbundled binary (`cargo run`).
fn enclosing_app(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent().filter(|dir| dir.file_name().is_some_and(|name| name == "MacOS"))?;
    let contents = macos.parent().filter(|dir| dir.file_name().is_some_and(|name| name == "Contents"))?;
    let app = contents.parent().filter(|dir| dir.extension().is_some_and(|ext| ext == "app"))?;
    Some(app.to_path_buf())
}

/// Numeric `x.y.z` versions compare part by part; anything else (pre-release tags, an
/// unreadable or empty version) only counts when both strings are identical.
fn installed_is_at_least(installed: &str, own: &str) -> bool {
    match (numeric_version(installed), numeric_version(own)) {
        (Some(installed), Some(own)) => installed >= own,
        _ => !installed.is_empty() && installed == own,
    }
}

fn numeric_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.').map(|part| {
        if !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()) {
            part.parse::<u64>().ok()
        } else {
            None
        }
    });
    let parsed = [parts.next()??, parts.next()??, parts.next()??];
    parts.next().is_none().then_some(parsed)
}

/// One string value from `<app>/Contents/Info.plist`.
fn plist_string(app: &Path, key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// LaunchServices launches the app, or activates it when it already runs. It matches
/// running apps by bundle path, not identifier (checked on macOS 27 with two same-id
/// bundles), so this starts the installed copy even while this copy is still running.
fn open_app(app: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .arg(app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("could not run /usr/bin/open: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("/usr/bin/open failed ({status})"))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(|| system::passwd_entry().map(|(_, home)| home))
}

fn log(log_file: &Path, message: &str) {
    if cfg!(debug_assertions) {
        eprintln!("[iphone-ai] {message}");
    }
    if let Some(dir) = log_file.parent() {
        let _ = system::ensure_private_dir(dir);
    }
    system::append_log_line(log_file, &format!("[shell] {message}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/me";
    const ID: &str = "me.alsaud.iphoneai";
    const DOCS_APP: &str = "/Users/me/Documents/GitHub/iphone ai/release/iPhone AI.app";
    const DOCS_EXE: &str = "/Users/me/Documents/GitHub/iphone ai/release/iPhone AI.app/Contents/MacOS/iphone-ai";
    const CARGO_EXE: &str = "/Users/me/Documents/GitHub/iphone ai/src-tauri/target/debug/iphone-ai";
    const ICLOUD_EXE: &str =
        "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/iPhone AI.app/Contents/MacOS/iphone-ai";

    #[test]
    fn finds_the_enclosing_app_bundle() {
        assert_eq!(enclosing_app(Path::new(DOCS_EXE)), Some(PathBuf::from(DOCS_APP)));
        assert_eq!(
            enclosing_app(Path::new("/Applications/iPhone AI.app/Contents/MacOS/iphone-ai")),
            Some(PathBuf::from(INSTALLED_APP))
        );
        // cargo run / cargo test binaries are not bundled.
        assert_eq!(enclosing_app(Path::new(CARGO_EXE)), None);
        assert_eq!(enclosing_app(Path::new("/Users/me/Documents/x.app/target/debug/iphone-ai")), None);
        assert_eq!(enclosing_app(Path::new("/Users/me/Documents/x/Contents/MacOS/iphone-ai")), None);
        assert_eq!(enclosing_app(Path::new("iphone-ai")), None);
    }

    #[test]
    fn hands_off_only_from_a_protected_copy_to_another_unprotected_copy_of_the_same_app() {
        let home = Path::new(HOME);
        let exe = Path::new(DOCS_EXE);
        let installed = Path::new(INSTALLED_APP);
        assert_eq!(should_hand_off(exe, home, installed, ID, ID), Ok(()));
        let icloud_exe = Path::new(ICLOUD_EXE);
        assert_eq!(
            should_hand_off(icloud_exe, home, Path::new("/Users/me/Applications/iPhone AI.app"), ID, ID),
            Ok(())
        );

        let different_app = Err("the installed copy is a different app");
        assert_eq!(should_hand_off(exe, home, installed, "com.example.other", ID), different_app);
        assert_eq!(should_hand_off(exe, home, installed, "", ID), different_app, "unreadable Info.plist");
        assert_eq!(should_hand_off(exe, home, installed, "", ""), different_app);
        // The installed copy would hand off again.
        let desktop = Path::new("/Users/me/Desktop/iPhone AI.app");
        assert_eq!(should_hand_off(exe, home, desktop, ID, ID), Err("the installed copy is in a protected folder too"));
        assert_eq!(
            should_hand_off(exe, home, Path::new(DOCS_APP), ID, ID),
            Err("the installed path is this very copy")
        );
        assert_eq!(
            should_hand_off(Path::new(CARGO_EXE), home, installed, ID, ID),
            Err("this copy is not an app bundle")
        );
        let installed_exe = Path::new("/Applications/iPhone AI.app/Contents/MacOS/iphone-ai");
        assert_eq!(
            should_hand_off(installed_exe, home, installed, ID, ID),
            Err("this copy's real location is outside the protected folders")
        );
    }

    #[test]
    fn compares_canonical_paths_when_home_is_a_symlink() {
        // temp_dir is under /var (itself a symlink to /private/var); `link` adds another hop.
        let root = std::env::temp_dir().join(format!("iphone-ai-handoff-home-test-{}", std::process::id()));
        let real_home = root.join("real");
        let link_home = root.join("link");
        let own_app = real_home.join("Documents/build/iPhone AI.app");
        let other_app = real_home.join("Desktop/iPhone AI.app");
        std::fs::create_dir_all(own_app.join("Contents/MacOS")).unwrap();
        std::fs::create_dir_all(&other_app).unwrap();
        std::os::unix::fs::symlink(&real_home, &link_home).unwrap();

        let exe = link_home.join("Documents/build/iPhone AI.app/Contents/MacOS/iphone-ai");
        let installed = Path::new(INSTALLED_APP);
        let result = should_hand_off(&exe, &link_home, installed, ID, ID);
        // A canonical installed path inside the real home's protected folders is still protected.
        let other_app = std::fs::canonicalize(&other_app).unwrap();
        let protected_target = should_hand_off(&exe, &link_home, &other_app, ID, ID);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result, Ok(()));
        assert_eq!(protected_target, Err("the installed copy is in a protected folder too"));
    }

    #[test]
    fn hands_off_only_to_an_installed_copy_at_least_as_new() {
        assert!(installed_is_at_least("0.2.0", "0.2.0"));
        assert!(installed_is_at_least("0.3.0", "0.2.9"));
        assert!(installed_is_at_least("0.10.0", "0.9.0"));
        assert!(installed_is_at_least("1.0.0", "0.99.99"));
        assert!(!installed_is_at_least("0.2.0", "0.2.1"));
        assert!(!installed_is_at_least("0.9.0", "0.10.0"));
        assert!(!installed_is_at_least("", "0.2.0"));
        assert!(!installed_is_at_least("", ""));
        // Anything but plain x.y.z only matches itself.
        assert!(installed_is_at_least("0.3.0-beta.1", "0.3.0-beta.1"));
        assert!(!installed_is_at_least("0.3.0-beta.1", "0.2.0"));
        assert!(!installed_is_at_least("0.3.0", "0.3.0-beta.1"));
        assert!(!installed_is_at_least("0.3", "0.2.0"));
        assert!(!installed_is_at_least("0.3.0.1", "0.2.0"));
        assert!(!installed_is_at_least("+1.0.0", "0.2.0"));
        assert!(!installed_is_at_least("99999999999999999999.0.0", "0.2.0"));
    }

    #[test]
    fn reads_strings_from_a_bundle_info_plist() {
        let app = std::env::temp_dir().join(format!("iphone-ai-handoff-test-{}/Fake.app", std::process::id()));
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>me.alsaud.iphoneai</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
</dict></plist>
"#,
        )
        .unwrap();
        assert_eq!(plist_string(&app, "CFBundleIdentifier").as_deref(), Some(ID));
        assert_eq!(plist_string(&app, "CFBundleShortVersionString").as_deref(), Some("0.2.0"));
        assert_eq!(plist_string(&app, "CFBundleVersion"), None);
        assert_eq!(plist_string(&app.with_file_name("Missing.app"), "CFBundleIdentifier"), None);
        std::fs::remove_dir_all(app.parent().unwrap()).unwrap();
    }
}
