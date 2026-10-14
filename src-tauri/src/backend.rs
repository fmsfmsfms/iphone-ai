//! Backend sidecar lifecycle.
//!
//! Spawns `Contents/MacOS/node --disable-warning=ExperimentalWarning
//! Contents/Resources/server/server.mjs` as the leader of its own process group
//! with a cleared, explicit environment and a fresh random desktop token. Waits
//! for `LISTENING <port>` on stdout, then points the main window at
//! `http://127.0.0.1:<port>/auth/desktop?token=…`. stdin stays an open pipe for
//! the backend's whole life: it exits on EOF, so it never outlives this app.
//! On quit the whole group (node, Mirroir, osascript, the capture helper, …) gets
//! SIGTERM, then SIGKILL after 3 s. Early exits and startup timeouts show the error page.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::{pages, system, MAIN_WINDOW};

/// The backend must print `LISTENING <port>` within this time.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Grace period between SIGTERM and SIGKILL (Mirroir releases held touches on SIGTERM).
const STOP_GRACE: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// Apps launched from Finder get a minimal PATH; Mirroir lives in /opt/homebrew/bin.
const CHILD_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
/// Must match the backend's default (packages/server/src/core/paths.ts).
const DATA_DIR_NAME: &str = "iPhone AI";
/// Relative to the data folder.
const LOG_FILE: &str = "logs/backend.log";
const RECENT_LINES: usize = 60;
const MAX_LINE_BYTES: u64 = 64 * 1024;

const TITLE_START_FAILED: &str = "iPhone AI couldn’t start";
const TITLE_STOPPED: &str = "iPhone AI stopped working";

/// Where the bundled pieces live (same layout in the .app and in target/<profile>).
pub struct ShellPaths {
    /// `Contents/MacOS/node` (externalBin, target-triple suffix removed by the bundler).
    pub node: PathBuf,
    /// `Contents/MacOS/iphone-ai-capture` (externalBin): the ScreenCaptureKit live-view
    /// helper the backend spawns while someone watches the screen.
    pub capture: PathBuf,
    pub server_script: PathBuf,
    pub web_dir: PathBuf,
    pub claude_code: PathBuf,
    /// `~/Library/Application Support/iPhone AI`
    pub data_dir: PathBuf,
    pub log_file: PathBuf,
}

impl ShellPaths {
    fn resolve(app: &AppHandle) -> Self {
        let exe_dir =
            std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)).unwrap_or_default();
        let resource_dir = app.path().resource_dir().unwrap_or_else(|_| exe_dir.join("../Resources"));
        let data_dir = app.path().data_dir().map(|dir| dir.join(DATA_DIR_NAME)).unwrap_or_else(|_| {
            let home = system::passwd_entry().map(|(_, home)| home).unwrap_or_else(|| PathBuf::from("/tmp"));
            default_data_dir(&home)
        });
        Self {
            node: exe_dir.join("node"),
            capture: exe_dir.join("iphone-ai-capture"),
            server_script: resource_dir.join("server/server.mjs"),
            web_dir: resource_dir.join("web"),
            claude_code: resource_dir.join("claude-code/claude"),
            log_file: data_dir.join(LOG_FILE),
            data_dir,
        }
    }
}

/// `~/Library/Application Support/iPhone AI` (what Tauri's data dir resolves to on macOS).
fn default_data_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support").join(DATA_DIR_NAME)
}

/// The backend log file, for logging before Tauri has started (see handoff.rs).
pub(crate) fn default_log_file(home: &Path) -> PathBuf {
    default_data_dir(home).join(LOG_FILE)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Starting,
    Running { port: u16 },
    Failed,
    Stopping,
}

struct State {
    /// Incremented for every launch; output and events of older launches are ignored.
    generation: u64,
    phase: Phase,
    child: Option<Child>,
    /// Recent non-protocol output, shown on the error page.
    recent: VecDeque<String>,
}

pub struct Backend {
    app: AppHandle,
    paths: ShellPaths,
    bundle_id: String,
    state: Mutex<State>,
    /// Download URL -> destination (macOS does not report the path on completion).
    downloads: Mutex<HashMap<String, PathBuf>>,
}

impl Backend {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        let paths = ShellPaths::resolve(app);
        if let Some(logs) = paths.log_file.parent() {
            let _ = system::ensure_private_dir(logs);
        }
        Arc::new(Self {
            app: app.clone(),
            paths,
            bundle_id: app.config().identifier.clone(),
            state: Mutex::new(State { generation: 0, phase: Phase::Idle, child: None, recent: VecDeque::new() }),
            downloads: Mutex::new(HashMap::new()),
        })
    }

    pub fn log_file(&self) -> &Path {
        &self.paths.log_file
    }

    pub fn data_dir(&self) -> &Path {
        &self.paths.data_dir
    }

    /// Launches the backend (app start-up).
    pub fn start(self: &Arc<Self>) {
        if let Some(generation) = self.begin_launch() {
            self.launch(generation);
        }
    }

    /// "Try Again" on the error page: back to the splash, launch a fresh backend.
    /// Runs on a background thread (see `handle_shell_action`).
    fn retry(self: &Arc<Self>) {
        let Some(generation) = self.begin_launch() else { return };
        pages::show_splash(&self.app);
        self.launch(generation);
    }

    /// Final stop when the app quits: SIGTERM the process group, SIGKILL after 3 s.
    pub fn shutdown(&self) {
        let child = {
            let mut st = self.lock();
            st.phase = Phase::Stopping;
            st.child.take()
        };
        if let Some(child) = child {
            self.shell_log("stopping backend");
            terminate(child);
            self.shell_log("backend stopped");
        }
    }

    /// Actions requested by the error page's links (`/__shell/<action>`).
    /// Honoured only while the error page is showing.
    pub fn handle_shell_action(self: &Arc<Self>, action: &str) {
        if self.lock().phase != Phase::Failed {
            return;
        }
        let me = Arc::clone(self);
        let requested = action.to_owned();
        // Act outside WebKit's navigation callback; window calls made from another
        // thread are queued to the event loop.
        let spawned = thread::Builder::new().name("shell-action".into()).spawn(move || match requested.as_str() {
            "retry" => me.retry(),
            "quit" => me.app.exit(0),
            "reveal-log" => system::reveal_in_finder(&me.paths.log_file),
            _ => {}
        });
        if let Err(err) = spawned {
            self.shell_log(&format!("could not handle the \"{action}\" action: {err}"));
        }
    }

    /// Is `url` served by the running backend (the only remote origin the window may show)?
    pub fn is_backend_url(&self, url: &Url) -> bool {
        let Phase::Running { port } = self.lock().phase else { return false };
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(port)
    }

    pub fn remember_download(&self, url: &Url, destination: &Path) {
        self.downloads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(url.to_string(), destination.to_path_buf());
    }

    /// Reveals a finished download in Finder (the window has no download UI of its own).
    pub fn finish_download(&self, url: &Url, success: bool) {
        let path = self.downloads.lock().unwrap_or_else(PoisonError::into_inner).remove(url.as_str());
        match (path, success) {
            (Some(path), true) => {
                self.shell_log(&format!("download saved to {}", path.display()));
                system::reveal_in_finder(&path);
            }
            (_, false) => self.shell_log(&format!("download failed: {}", redact_query(url))),
            (None, true) => {}
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Moves Idle/Failed -> Starting and returns the new generation, or None if a launch
    /// is already in progress / running / the app is quitting.
    fn begin_launch(&self) -> Option<u64> {
        let mut st = self.lock();
        if !matches!(st.phase, Phase::Idle | Phase::Failed) {
            return None;
        }
        st.generation += 1;
        st.phase = Phase::Starting;
        st.recent.clear();
        Some(st.generation)
    }

    fn launch(self: &Arc<Self>, generation: u64) {
        self.shell_log(&format!(
            "starting backend: {} {}",
            self.paths.node.display(),
            self.paths.server_script.display()
        ));
        if !self.paths.capture.is_file() {
            self.shell_log(&format!(
                "live capture helper missing ({}); the live view will poll screenshots",
                self.paths.capture.display()
            ));
        }
        if let Err(message) = self.spawn_backend(generation) {
            self.fail(generation, TITLE_START_FAILED, message);
        }
    }

    fn spawn_backend(self: &Arc<Self>, generation: u64) -> Result<(), String> {
        let paths = &self.paths;
        if let Some(folder) = std::env::var_os("HOME").and_then(|home| protected_folder(&paths.node, Path::new(&home)))
        {
            return Err(format!(
                "iPhone AI is running from your {folder} folder. macOS privacy protection makes its built-in \
                 server wait for permission to read files there, so it cannot start. Move \"iPhone AI.app\" to \
                 the Applications folder and open it from there."
            ));
        }
        if !paths.node.is_file() {
            return Err(format!("The bundled Node.js runtime is missing: {}", paths.node.display()));
        }
        if !paths.server_script.is_file() {
            return Err(format!("The backend bundle is missing: {}", paths.server_script.display()));
        }
        system::ensure_private_dir(&paths.data_dir)
            .map_err(|err| format!("Could not create the data folder {}: {err}", paths.data_dir.display()))?;
        let token = system::random_token().map_err(|err| format!("Could not generate the session token: {err}"))?;

        let mut child = Command::new(&paths.node)
            .arg("--disable-warning=ExperimentalWarning")
            .arg(&paths.server_script)
            .current_dir(&paths.data_dir)
            .env_clear()
            .envs(self.child_environment(&token))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|err| format!("Could not start {}: {err}", paths.node.display()))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stale = {
            let mut st = self.lock();
            if st.generation != generation || st.phase != Phase::Starting {
                // Superseded, or the app started quitting while we were spawning.
                drop(st);
                terminate(child);
                return Ok(());
            }
            st.child.replace(child)
        };
        if let Some(stale) = stale {
            terminate(stale);
        }
        self.shell_log(&format!("backend started (pid {pid})"));

        let mut readers = Vec::new();
        let spawned = (|| -> std::io::Result<()> {
            if let Some(stdout) = stdout {
                let me = Arc::clone(self);
                readers.push(
                    thread::Builder::new()
                        .name("backend-stdout".into())
                        .spawn(move || me.read_stdout(generation, stdout, token))?,
                );
            }
            if let Some(stderr) = stderr {
                let me = Arc::clone(self);
                readers.push(
                    thread::Builder::new()
                        .name("backend-stderr".into())
                        .spawn(move || read_lines(stderr, |line| me.record(generation, "stderr", line)))?,
                );
            }
            Ok(())
        })();
        let spawned = spawned.and_then(|()| {
            let me = Arc::clone(self);
            thread::Builder::new().name("backend-monitor".into()).spawn(move || me.monitor(generation, readers))
        });
        if let Err(err) = spawned {
            let child = {
                let mut st = self.lock();
                if st.generation == generation {
                    st.child.take()
                } else {
                    None
                }
            };
            if let Some(child) = child {
                terminate(child);
            }
            return Err(format!("Could not create the backend monitor threads: {err}"));
        }
        Ok(())
    }

    /// Explicit environment: nothing from the user's shell leaks into the backend.
    fn child_environment(&self, token: &str) -> Vec<(OsString, OsString)> {
        let inherited = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
        let passwd = system::passwd_entry();
        let home = inherited("HOME")
            .or_else(|| passwd.as_ref().map(|(_, home)| home.clone().into_os_string()))
            .unwrap_or_else(|| "/".into());
        let user = inherited("USER").or_else(|| passwd.as_ref().map(|(name, _)| name.clone())).unwrap_or_default();
        let logname = inherited("LOGNAME").unwrap_or_else(|| user.clone());
        let tmpdir = inherited("TMPDIR")
            .or_else(|| system::darwin_user_temp_dir().map(PathBuf::into_os_string))
            .unwrap_or_else(|| "/tmp/".into());
        let lang = inherited("LANG").unwrap_or_else(|| "en_US.UTF-8".into());
        let paths = &self.paths;

        let mut env: Vec<(OsString, OsString)> = vec![
            ("HOME".into(), home),
            ("USER".into(), user),
            ("LOGNAME".into(), logname),
            ("TMPDIR".into(), tmpdir),
            ("LANG".into(), lang),
            ("PATH".into(), CHILD_PATH.into()),
            ("IPHONE_AI_DESKTOP_TOKEN".into(), token.into()),
            ("IPHONE_AI_PORT".into(), "0".into()),
            ("IPHONE_AI_HOST".into(), "127.0.0.1".into()),
            ("IPHONE_AI_DATA_DIR".into(), paths.data_dir.clone().into_os_string()),
            ("IPHONE_AI_WEB_DIST".into(), paths.web_dir.clone().into_os_string()),
            ("IPHONE_AI_BUNDLE_ID".into(), self.bundle_id.clone().into()),
            ("IPHONE_AI_LOG_FILE".into(), paths.log_file.clone().into_os_string()),
        ];
        env.extend(bundled_tool_environment(paths));
        env
    }

    fn read_stdout(&self, generation: u64, stdout: impl Read, token: String) {
        read_lines(stdout, |line| {
            if let Some(port) = parse_listening(line) {
                if self.on_listening(generation, port, &token) {
                    return;
                }
            }
            self.record(generation, "stdout", line);
        });
    }

    fn on_listening(&self, generation: u64, port: u16, token: &str) -> bool {
        {
            let mut st = self.lock();
            if st.generation != generation || st.phase != Phase::Starting {
                return false;
            }
            st.phase = Phase::Running { port };
        }
        self.shell_log(&format!("backend is listening on 127.0.0.1:{port}"));
        match Url::parse(&format!("http://127.0.0.1:{port}/auth/desktop?token={token}")) {
            Ok(url) => {
                if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
                    if let Err(err) = window.navigate(url) {
                        self.shell_log(&format!("could not open the backend UI: {err}"));
                    }
                }
            }
            Err(err) => self.shell_log(&format!("invalid backend URL for port {port}: {err}")),
        }
        true
    }

    /// Copies backend output into the log file (unless the backend's own logger already
    /// wrote it there) and keeps the tail for the error page.
    fn record(&self, generation: u64, stream: &str, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        if cfg!(debug_assertions) {
            eprintln!("[backend {stream}] {line}");
        }
        let structured = structured_log_summary(line);
        if structured.is_none() {
            system::append_log_line(
                &self.paths.log_file,
                &format!("[{stream}] {}", system::truncate_chars(line, 4000)),
            );
        }
        let mut st = self.lock();
        if st.generation == generation {
            if st.recent.len() >= RECENT_LINES {
                st.recent.pop_front();
            }
            st.recent.push_back(system::truncate_chars(structured.as_deref().unwrap_or(line), 1000));
        }
    }

    /// Watches the child: early exit, startup timeout, or a crash while running.
    fn monitor(&self, generation: u64, readers: Vec<JoinHandle<()>>) {
        let started = Instant::now();
        loop {
            thread::sleep(POLL_INTERVAL);
            let mut st = self.lock();
            if st.generation != generation {
                return;
            }
            let Some(child) = st.child.as_mut() else { return };
            match child.try_wait() {
                Ok(Some(status)) => {
                    let pgid = child.id() as libc::pid_t;
                    st.child = None;
                    let phase = st.phase;
                    drop(st);
                    self.shell_log(&format!("backend exited: {}", describe_status(status)));
                    // Mirroir/osascript may outlive node inside its process group.
                    stop_group(pgid, None);
                    if phase == Phase::Stopping {
                        return;
                    }
                    wait_for(&readers, Duration::from_secs(1));
                    let (title, message) = match phase {
                        Phase::Running { .. } => (
                            TITLE_STOPPED,
                            format!("The iPhone AI backend stopped unexpectedly ({}).", describe_status(status)),
                        ),
                        _ => (
                            TITLE_START_FAILED,
                            format!("The iPhone AI backend exited during startup ({}).", describe_status(status)),
                        ),
                    };
                    self.fail(generation, title, message);
                    return;
                }
                Ok(None) => {
                    if st.phase == Phase::Starting && started.elapsed() >= STARTUP_TIMEOUT {
                        let child = st.child.take();
                        drop(st);
                        self.shell_log("backend did not report LISTENING in time; stopping it");
                        if let Some(child) = child {
                            terminate(child);
                        }
                        wait_for(&readers, Duration::from_secs(1));
                        self.fail(
                            generation,
                            TITLE_START_FAILED,
                            format!(
                                "The iPhone AI backend did not become ready within {} seconds.",
                                STARTUP_TIMEOUT.as_secs()
                            ),
                        );
                        return;
                    }
                }
                Err(err) => {
                    drop(st);
                    self.shell_log(&format!("could not poll the backend process: {err}"));
                }
            }
        }
    }

    fn fail(&self, generation: u64, title: &str, message: String) {
        let recent: Vec<String> = {
            let mut st = self.lock();
            if st.generation != generation || st.phase == Phase::Stopping {
                return;
            }
            st.phase = Phase::Failed;
            st.recent.iter().cloned().collect()
        };
        self.shell_log(&format!("backend failed: {message}"));
        pages::show_error(&self.app, title, &message, &self.paths.log_file, &recent);
    }

    fn shell_log(&self, message: &str) {
        if cfg!(debug_assertions) {
            eprintln!("[iphone-ai] {message}");
        }
        system::append_log_line(&self.paths.log_file, &format!("[shell] {message}"));
    }
}

/// Optional bundled tools, announced to the backend only when the file exists:
/// the Claude Code binary (Claude Agent SDK provider) and the ScreenCaptureKit
/// live-view helper (without it the backend keeps polling Mirroir screenshots).
fn bundled_tool_environment(paths: &ShellPaths) -> Vec<(OsString, OsString)> {
    [("IPHONE_AI_CLAUDE_CODE_BIN", &paths.claude_code), ("IPHONE_AI_CAPTURE_BIN", &paths.capture)]
        .into_iter()
        .filter(|(_, path)| path.is_file())
        .map(|(key, path)| (OsString::from(key), path.clone().into_os_string()))
        .collect()
}

/// Reads a pipe to EOF line by line (lossy UTF-8, overlong lines split), so the
/// backend can never block on a full pipe.
fn read_lines(stream: impl Read, mut on_line: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::with_capacity(1024);
    loop {
        buf.clear();
        match (&mut reader).take(MAX_LINE_BYTES).read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => on_line(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n'])),
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Folders macOS protects with a per-app privacy prompt ("Files and Folders").
/// A bundled helper reading its own files there blocks until someone answers.
pub(crate) fn protected_folder(executable: &Path, home: &Path) -> Option<&'static str> {
    const FOLDERS: [(&str, &str); 4] = [
        ("Documents", "Documents"),
        ("Desktop", "Desktop"),
        ("Downloads", "Downloads"),
        ("Library/Mobile Documents", "iCloud Drive"),
    ];
    FOLDERS.iter().find(|(dir, _)| executable.starts_with(home.join(dir))).map(|(_, name)| *name)
}

/// `LISTENING <port>` -> port.
fn parse_listening(line: &str) -> Option<u16> {
    let port = line.trim().strip_prefix("LISTENING ")?.trim();
    port.parse::<u16>().ok().filter(|port| *port != 0)
}

/// The backend logger (packages/server/src/core/logger.ts) writes JSON lines such as
/// `{"t":"…","level":"info","scope":"app","msg":"…"}` to IPHONE_AI_LOG_FILE and echoes
/// them to stderr. Returns a short `LEVEL scope: msg` form for those lines.
fn structured_log_summary(line: &str) -> Option<String> {
    if !line.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let level = object.get("level")?.as_str()?;
    let msg = object.get("msg")?.as_str()?;
    object.get("t")?.as_str()?;
    let scope = object.get("scope").and_then(serde_json::Value::as_str).unwrap_or("app");
    Some(format!("{} {scope}: {msg}", level.to_uppercase()))
}

fn describe_status(status: ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exit code {code}");
    }
    match status.signal() {
        Some(libc::SIGTRAP) => {
            "killed by SIGTRAP; the node runtime was probably signed without the JIT entitlements".into()
        }
        Some(libc::SIGKILL) => "killed by SIGKILL".into(),
        Some(libc::SIGSEGV) => "crashed with SIGSEGV".into(),
        Some(libc::SIGABRT) => "aborted (SIGABRT)".into(),
        Some(libc::SIGTERM) => "terminated by SIGTERM".into(),
        Some(signal) => format!("terminated by signal {signal}"),
        None => "unknown exit status".into(),
    }
}

fn redact_query(url: &Url) -> String {
    let mut clean = url.clone();
    clean.set_query(None);
    clean.to_string()
}

fn wait_for(handles: &[JoinHandle<()>], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline && handles.iter().any(|handle| !handle.is_finished()) {
        thread::sleep(Duration::from_millis(20));
    }
}

/// Stops a backend: close its stdin (its own "app closed" signal), then SIGTERM the
/// whole process group and SIGKILL whatever is left after the grace period.
fn terminate(mut child: Child) {
    let pgid = child.id() as libc::pid_t;
    drop(child.stdin.take());
    stop_group(pgid, Some(&mut child));
}

fn stop_group(pgid: libc::pid_t, mut leader: Option<&mut Child>) {
    signal_group(pgid, libc::SIGTERM);
    let deadline = Instant::now() + STOP_GRACE;
    let mut leader_done = leader.is_none();
    loop {
        if let Some(child) = leader.as_deref_mut() {
            if !leader_done {
                leader_done = !matches!(child.try_wait(), Ok(None));
            }
        }
        if leader_done && !group_alive(pgid) {
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    signal_group(pgid, libc::SIGKILL);
    if let Some(child) = leader {
        if !leader_done {
            let _ = child.wait();
        }
    }
}

fn signal_group(pgid: libc::pid_t, signal: libc::c_int) {
    if pgid > 1 {
        // SAFETY: plain syscall; pgid is the group this app created with process_group(0).
        unsafe {
            libc::killpg(pgid, signal);
        }
    }
}

/// True while any process we may signal is left in the group (signal 0 only checks).
fn group_alive(pgid: libc::pid_t) -> bool {
    // SAFETY: plain syscall without side effects for signal 0.
    pgid > 1 && unsafe { libc::killpg(pgid, 0) } == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_privacy_protected_install_locations() {
        let home = Path::new("/Users/me");
        let in_docs = Path::new("/Users/me/Documents/GitHub/iphone ai/release/iPhone AI.app/Contents/MacOS/node");
        assert_eq!(protected_folder(in_docs, home), Some("Documents"));
        assert_eq!(
            protected_folder(Path::new("/Users/me/Desktop/iPhone AI.app/Contents/MacOS/node"), home),
            Some("Desktop")
        );
        assert_eq!(protected_folder(Path::new("/Applications/iPhone AI.app/Contents/MacOS/node"), home), None);
        assert_eq!(protected_folder(Path::new("/Users/me/Applications/iPhone AI.app/Contents/MacOS/node"), home), None);
        assert_eq!(protected_folder(Path::new("/Users/me/DocumentsArchive/x/node"), home), None);
    }

    #[test]
    fn default_log_file_is_in_application_support() {
        assert_eq!(
            default_log_file(Path::new("/Users/me")),
            PathBuf::from("/Users/me/Library/Application Support/iPhone AI/logs/backend.log")
        );
    }

    #[test]
    fn parses_the_listening_line() {
        assert_eq!(parse_listening("LISTENING 52345"), Some(52345));
        assert_eq!(parse_listening("LISTENING 52345\r"), Some(52345));
        assert_eq!(parse_listening("  LISTENING 8080  "), Some(8080));
        assert_eq!(parse_listening("LISTENING 0"), None);
        assert_eq!(parse_listening("LISTENING 70000"), None);
        assert_eq!(parse_listening("LISTENING"), None);
        assert_eq!(parse_listening("listening 80"), None);
        assert_eq!(parse_listening("{\"msg\":\"LISTENING 80\"}"), None);
    }

    #[test]
    fn summarises_backend_logger_lines_only() {
        let line = r#"{"t":"2026-10-14T19:00:00.000Z","level":"warn","scope":"app.mcp","msg":"Mirroir restarted"}"#;
        assert_eq!(structured_log_summary(line).as_deref(), Some("WARN app.mcp: Mirroir restarted"));
        assert_eq!(structured_log_summary("Fatal: boom"), None);
        assert_eq!(structured_log_summary(r#"{"level":"info"}"#), None);
        assert_eq!(structured_log_summary("{not json"), None);
    }

    #[test]
    fn announces_only_bundled_tools_that_exist() {
        let dir = std::env::temp_dir().join(format!("iphone-ai-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = ShellPaths {
            node: dir.join("node"),
            capture: dir.join("iphone-ai-capture"),
            server_script: dir.join("server/server.mjs"),
            web_dir: dir.join("web"),
            claude_code: dir.join("claude-code/claude"),
            data_dir: dir.join("data"),
            log_file: dir.join("data/logs/backend.log"),
        };
        assert!(bundled_tool_environment(&paths).is_empty());

        std::fs::write(&paths.capture, b"").unwrap();
        let env = bundled_tool_environment(&paths);
        assert_eq!(env, vec![(OsString::from("IPHONE_AI_CAPTURE_BIN"), paths.capture.clone().into_os_string())]);

        std::fs::create_dir_all(dir.join("claude-code")).unwrap();
        std::fs::write(&paths.claude_code, b"").unwrap();
        let keys: Vec<OsString> = bundled_tool_environment(&paths).into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, vec![OsString::from("IPHONE_AI_CLAUDE_CODE_BIN"), OsString::from("IPHONE_AI_CAPTURE_BIN")]);

        // A directory with the helper's name is not the helper.
        std::fs::remove_file(&paths.capture).unwrap();
        std::fs::create_dir_all(&paths.capture).unwrap();
        assert!(!bundled_tool_environment(&paths).iter().any(|(key, _)| key == "IPHONE_AI_CAPTURE_BIN"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn describes_exit_statuses() {
        assert_eq!(describe_status(ExitStatus::from_raw(1 << 8)), "exit code 1");
        assert!(describe_status(ExitStatus::from_raw(libc::SIGTRAP)).contains("JIT"));
    }

    #[test]
    fn terminates_a_whole_process_group() {
        // A shell that ignores nothing and spawns a grandchild in the same group.
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 30 & wait")
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id() as libc::pid_t;
        thread::sleep(Duration::from_millis(200));
        assert!(group_alive(pgid));
        let started = Instant::now();
        terminate(child);
        assert!(!group_alive(pgid), "grandchild must be gone too");
        assert!(started.elapsed() < STOP_GRACE, "SIGTERM should have been enough");
    }

    #[test]
    fn escalates_to_sigkill_when_sigterm_is_ignored() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; while :; do sleep 1; done")
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = child.id() as libc::pid_t;
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        terminate(child);
        assert!(started.elapsed() >= STOP_GRACE);
        // SIGKILLed grandchildren are reaped by launchd shortly afterwards.
        let deadline = Instant::now() + Duration::from_secs(2);
        while group_alive(pgid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!group_alive(pgid));
    }
}
