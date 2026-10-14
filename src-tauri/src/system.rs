//! Small OS helpers: random tokens, user info, log appends, Finder/browser hand-off.

use std::ffi::{CStr, OsStr, OsString};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Url;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// 32 bytes from the kernel CSPRNG, hex encoded (64 characters, URL safe).
pub fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Login name and home directory from the password database.
pub fn passwd_entry() -> Option<(OsString, PathBuf)> {
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer refers to live, correctly sized storage owned by this frame.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() || pwd.pw_name.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so both fields are NUL-terminated strings inside `buf`.
    let (name, dir) = unsafe { (CStr::from_ptr(pwd.pw_name), CStr::from_ptr(pwd.pw_dir)) };
    Some((OsStr::from_bytes(name.to_bytes()).to_owned(), PathBuf::from(OsStr::from_bytes(dir.to_bytes()))))
}

/// The per-user temporary directory (what launchd puts in TMPDIR).
pub fn darwin_user_temp_dir() -> Option<PathBuf> {
    let mut buf = vec![0 as libc::c_char; 1024];
    // SAFETY: confstr writes at most `buf.len()` bytes including the terminator.
    let needed = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buf.as_mut_ptr(), buf.len()) };
    if needed == 0 || needed > buf.len() {
        return None;
    }
    // SAFETY: confstr NUL-terminated the value inside `buf`.
    let value = unsafe { CStr::from_ptr(buf.as_ptr()) };
    Some(PathBuf::from(OsStr::from_bytes(value.to_bytes())))
}

/// Creates a directory (and parents) and restricts it to the owner.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

/// Appends one timestamped line to `file` (mode 0600), rotating to `<file>.1` past 5 MB.
/// The file is reopened for every line so rotation by another writer is harmless.
pub fn append_log_line(file: &Path, line: &str) {
    if let Ok(meta) = fs::metadata(file) {
        if meta.len() >= MAX_LOG_BYTES {
            let mut rotated = file.as_os_str().to_owned();
            rotated.push(".1");
            let _ = fs::rename(file, PathBuf::from(rotated));
        }
    }
    let opened = OpenOptions::new().create(true).append(true).mode(0o600).open(file);
    if let Ok(mut handle) = opened {
        let _ = handle.write_all(format!("{} {line}\n", iso_timestamp(SystemTime::now())).as_bytes());
    }
}

/// RFC 3339 UTC timestamp with milliseconds, e.g. `2026-10-14T19:45:01.123Z`.
pub fn iso_timestamp(time: SystemTime) -> String {
    let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since_epoch.as_secs() as i64;
    let (days, secs_of_day) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
        since_epoch.subsec_millis()
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Percent-encodes everything except RFC 3986 unreserved characters
/// (the inverse of JavaScript's `decodeURIComponent`).
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// Truncates to at most `max` characters (on a char boundary), marking the cut.
pub fn truncate_chars(input: &str, max: usize) -> String {
    match input.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…", &input[..idx]),
        None => input.to_owned(),
    }
}

/// URLs the shell may hand to the default browser / System Settings.
pub fn is_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "x-apple.systempreferences")
}

/// Opens a URL with LaunchServices (default browser, mail client or System Settings).
pub fn open_external(url: &Url) {
    if !is_external_url(url) {
        return;
    }
    spawn_detached(Command::new("/usr/bin/open").arg(url.as_str()));
}

/// Selects `path` in Finder, or opens its folder when the file does not exist yet.
pub fn reveal_in_finder(path: &Path) {
    if path.exists() {
        spawn_detached(Command::new("/usr/bin/open").arg("-R").arg(path));
    } else if let Some(parent) = path.parent() {
        open_path(parent);
    }
}

/// Opens a folder or file with its default application.
pub fn open_path(path: &Path) {
    spawn_detached(Command::new("/usr/bin/open").arg(path));
}

/// Fire-and-forget helper process; a reaper thread collects its exit status.
fn spawn_detached(command: &mut Command) {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Ok(mut child) = command.spawn() {
        let _ = std::thread::Builder::new().name("open-reaper".into()).spawn(move || {
            let _ = child.wait();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn token_is_64_hex_chars_and_random() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn iso_timestamp_formats_known_instants() {
        assert_eq!(iso_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(1_791_999_901_123);
        assert_eq!(iso_timestamp(t), "2026-10-14T17:45:01.123Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400); // 2000-02-29
        assert_eq!(iso_timestamp(leap), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn percent_encode_matches_encode_uri_component() {
        assert_eq!(percent_encode("a-Z_0.~"), "a-Z_0.~");
        assert_eq!(percent_encode("{\"a\": \"é/#%\"}"), "%7B%22a%22%3A%20%22%C3%A9%2F%23%25%22%7D");
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate_chars("héllo", 10), "héllo");
        assert_eq!(truncate_chars("héllo", 2), "hé…");
    }

    #[test]
    fn only_safe_schemes_open_externally() {
        assert!(is_external_url(&"https://example.com".parse().unwrap()));
        assert!(is_external_url(&"x-apple.systempreferences:com.apple.preference.security".parse().unwrap()));
        assert!(!is_external_url(&"file:///etc/passwd".parse().unwrap()));
        assert!(!is_external_url(&"javascript:alert(1)".parse().unwrap()));
    }

    #[test]
    fn user_lookups_work() {
        assert!(passwd_entry().is_some());
        assert!(darwin_user_temp_dir().is_some());
    }
}
