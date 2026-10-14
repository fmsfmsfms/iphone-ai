# iphone-ai-capture — ScreenCaptureKit live view

`main.swift` is a small command-line helper that captures the iPhone Mirroring window as JPEG
frames. The backend (`packages/server`, LiveCapture service) spawns it while someone is watching the
screen or an AI task/workflow holds control, and relays the frames to the UI over `GET /ws/screen`.

Why it exists: polling Mirroir's `screenshot` tool sends a full PNG over MCP stdio (~2 fps), and every
in-flight screenshot delays the next input action in Mirroir's single serial lane. This helper
captures the same window with ScreenCaptureKit directly, so the live view runs at up to 15 fps and
Mirroir's lane is free for input.

**Capture only.** It never activates an app, moves the cursor or posts input, and (unlike Mirroir's
`screenshot`) never presses Resume on a paused session. It is safe to run while Mirroring is paused.

## Capture modes

- **`snapshot` (default, the only mode the app uses).** One
  `SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow:), …)` at
  a time — the same single-shot capture Mirroir's own `screenshot` tool makes — at most 15 per second,
  never overlapping.
- **`stream` (diagnostics only).** A continuous `SCStream` of the window, up to 60 fps. Do not use it
  while Mirroir controls the phone: every SCStream start makes iPhone Mirroring receive a
  ScreenSharingKit "window streaming started" notification and add overlay UI containing a native
  control to its window. Mirroir 0.40.1's accessibility-based pause detection (any button or labelled
  text under the window's first child) then reports the live session as "Paused — connection paused,
  can resume", and Mirroir refuses all input while it believes the session is paused. Single-shot
  screenshots do not trigger that overlay.

## Command line

```
iphone-ai-capture [--mode snapshot|stream] [--bundle-id com.apple.ScreenContinuity] [--fps 15]
                  [--max-long-edge 1600] [--quality 0.7]
iphone-ai-capture --help | --version | --test-pattern [--fps N] [--max-long-edge PX] [--quality Q]
```

| Option | Range | Default | Meaning |
|---|---|---|---|
| `--mode` | `snapshot`, `stream` | `snapshot` | capture mode, see above |
| `--bundle-id` | | `com.apple.ScreenContinuity` | app whose window is captured |
| `--fps` | snapshot 1–15, stream 1–60 | snapshot 15, stream 30 | maximum frame rate |
| `--max-long-edge` | 160–8192 | 1600 | downscale so the longer side is at most this many pixels |
| `--quality` | 0.1–1 | 0.7 | JPEG quality |
| `--test-pattern` | | | diagnostics only, see below (not combinable with `--mode stream`) |

Out-of-range numbers are clamped (with a note on stderr, for example
`--fps 30 is out of range 1-15 in snapshot mode; using 15`); malformed arguments exit 64.

## stdin (JSON lines)

```json
{"cmd":"config","fps":10,"maxLongEdge":800,"quality":0.5}   // any subset of the three fields
{"cmd":"stop"}
```

`config` changes apply to the running capture (snapshot mode: from the next screenshot; stream
mode: `SCStream.updateConfiguration`); `fps` is clamped to the mode's range. stdin EOF, `stop`,
SIGTERM, SIGINT and SIGHUP stop the capture, emit `stopped` and exit 0. Malformed lines and unknown
commands are logged to stderr and ignored.

## stdout (binary, length-prefixed)

Every message is `[uint32 BE N = length of the rest][1 byte type][N-1 bytes payload]`, written whole
from one serial queue.

**`0x01` STATUS** — UTF-8 JSON:

| `event` | When | Extra fields |
|---|---|---|
| `waiting` | no window of the app (Mirroring not open / window closed), or (snapshot mode) a screenshot failed while the window is not on screen (hidden, minimized or on another Space); retried every 1 s | `code: "no_window"` / `"window_hidden"`, `message` |
| `started` | the capture is running (snapshot mode: written right before the first frame; stream mode: once the stream started) | `ptW`, `ptH`, `pxW`, `pxH` (`message` for the test pattern) |
| `window` | window resized / moved to a display with another scale, or `config` changed the output size | `ptW`, `ptH`, `pxW`, `pxH` |
| `error` | `code: "permission"` (then exit 2) or `code: "stream_failed"` (a screenshot or the stream failed; the helper retries; exit 3 after 5 failures in a row) | `code`, `message` |
| `stopped` | clean stop (then exit 0) | `message` (the reason) |

**`0x02` FRAME** — `[uint32 BE H][H bytes UTF-8 JSON header][JPEG bytes]`, header:

```json
{"seq": 42, "ts": 1792006958234, "ptW": 342, "ptH": 744, "pxW": 684, "pxH": 1488}
```

- `seq` increases by one per frame message.
- `ts` is the capture time in epoch ms (snapshot mode: when the screenshot was requested; stream mode:
  the sample's host-clock presentation time).
- `ptW` × `ptH` is the window size in points, truncated to integers — the same geometry as Mirroir's
  `status` and its tap coordinates (points from the window's top-left). `pxW` × `pxH` is the JPEG size.
- Only frames with new content are encoded. Snapshot mode hashes each screenshot's pixels and skips
  one identical to the last frame sent; stream mode encodes `SCFrameStatus.complete` frames (plus the
  stream's first `.started` frame). While the content stays unchanged (identical screenshots, or
  `.idle` stream reports) the last JPEG is re-sent about once per second with a new `seq` and
  `ts` = now, so a consumer can tell a static screen from a stalled capture (normally at least one
  frame every 1.25 s). Without fresh evidence that the content is unchanged nothing is re-sent.
- At most one frame is in flight (encoding or being written). Snapshot mode takes the next screenshot
  only after the previous frame was written (a slow reader slows the captures down); stream mode drops
  frames that arrive meanwhile, never queues them. Either way a slow reader gets the freshest frame,
  not a backlog.

**stderr** carries human-readable log lines only (`iphone-ai-capture: …`): window found/lost, the
first frame of each capture, and every 30 s while frames flow a line such as
`last 30 s: 412 frames (13.7 fps), 3 idle repeats, 0 dropped while busy, encode avg 7.9 ms`
(frames counts new frames only; snapshot mode never drops).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | stopped (stdin EOF, `stop`, SIGTERM/SIGINT/SIGHUP) or stdout closed by the reader |
| 1 | internal error (stdout write failed for another reason than a closed pipe) |
| 2 | Screen Recording not granted (checked with `CGPreflightScreenCaptureAccess` before ScreenCaptureKit is touched, so it never triggers a permission prompt) |
| 3 | the capture failed 5 times in a row without a frame in between |
| 64 | bad command-line arguments |

A stop that cannot finish (for example because nobody reads stdout any more) is forced after 5 s.

## Capture details

- Window: `SCShareableContent` windows whose `owningApplication.bundleIdentifier` is the bundle id,
  `windowLayer == 0`, at least 50 × 50 pt; on-screen windows first, then the largest area. Looked up
  again every second (resize → new filter and size + `window`; new window id → restart; gone →
  `waiting`). In snapshot mode a failed screenshot of a window that is not on screen is `waiting`
  (`window_hidden`), not an error: it is retried every second without counting towards exit 3.
- Filter: `SCContentFilter(desktopIndependentWindow:)` — the same kind of capture Mirroir's own
  screenshot uses, so pixels and point geometry match its tap coordinates.
- Configuration: `width`/`height` = window points × `filter.pointPixelScale`, downscaled
  proportionally to `--max-long-edge`; BGRA, sRGB, `showsCursor = false`,
  `ignoreShadowsSingleWindow = true`, no audio (stream mode adds `minimumFrameInterval = 1/fps` and
  `queueDepth = 4`).
- Snapshot pacing: each screenshot is due 1/fps after the previous one was due (a fixed timeline, so
  timer lateness does not lower the rate); it starts only once the previous screenshot was compared and
  written. A screenshot that has not answered within 10 s counts as a failed capture.
- Unchanged-content check: a `Hasher` over the screenshot's pixel rows (row padding excluded),
  about 2 ms for a 740 × 1600 px picture.
- Encoding: one reused `CIContext` (`jpegRepresentation`, sRGB).

## Background-only process

`Info.plist` next to `main.swift` is linked into the binary's `__TEXT,__info_plist` section. It sets
`CFBundleIdentifier` `me.alsaud.iphoneai.capture` and `LSBackgroundOnly`, and at startup (after
`--help` / `--version` are handled, so those never connect to the window server) the helper creates
`NSApplication` on the main thread, which checks it in with LaunchServices as **BackgroundOnly**.
Without this, ScreenCaptureKit (ReplayKit) created `NSApplication` lazily on a background queue, which
checked the process in with the main bundle's Info.plist — inside the app that is `iPhone AI.app`, a
regular app — and the helper appeared as a second "iPhone AI" in the Dock that could become frontmost.

CoreFoundation uses the embedded plist only while the executable's name does **not** end with the
enclosing app's `CFBundleExecutable` (`iphone-ai`): `iphone-ai-capture` is fine; a name like
`capture-iphone-ai` would make `Bundle.main` the app again. When `LSBackgroundOnly` is not in effect
the helper prints `warning: the embedded Info.plist is not in effect …` on stderr and falls back to
`setActivationPolicy(.prohibited)`. Screen Recording is unaffected: TCC attributes the helper to its
responsible process (iPhone AI).

Check a running helper with `lsappinfo info <pid>`: it must show `type="BackgroundOnly"`.

A windowless background-only app is a candidate for App Nap, which would throttle the timers that
pace the screenshots and repeat idle frames. While capturing, the helper holds a
`ProcessInfo.beginActivity([.userInitiatedAllowingIdleSystemSleep, .latencyCritical])` activity
(it does not keep the Mac awake).

## Building and packaging

```
node scripts/build-capture.mjs [--force] [--target aarch64-apple-darwin|x86_64-apple-darwin]
```

compiles with `xcrun swiftc -O -swift-version 5 -target <arch>-apple-macos15.0 -parse-as-library`
(ScreenCaptureKit, CoreImage, CoreMedia, AppKit; `-Xlinker -sectcreate -Xlinker __TEXT -Xlinker
__info_plist -Xlinker <Info.plist>`) into `src-tauri/binaries/iphone-ai-capture-<triple>`, ad-hoc
signs it (identifier `me.alsaud.iphoneai.capture`, hardened runtime) so it runs from the repo, and
checks that `--help` works and that `launchctl plist __TEXT,__info_plist <binary>` shows
`"LSBackgroundOnly" = true;`. It skips the compile while the source, `Info.plist`, flags and compiler
are unchanged. `pnpm package:mac` runs it as step 5 (also with `--stage-only`); `src-tauri/build.rs`
refuses to build the shell without it.

`tauri.conf.json` lists `binaries/iphone-ai-capture` in `bundle.externalBin`, so the bundle contains
`Contents/MacOS/iphone-ai-capture`, signed by `tauri build` with the app identity and
`Entitlements.plist`. After the build, `package-mac.mjs` verifies that the bundled helper exists, is
signed like the app with the hardened runtime, runs `--help`, carries the embedded plist, exits
cleanly with valid framing when started with stdin already closed, and — in a GUI session — that a
`--test-pattern` run checks in with LaunchServices as `type="BackgroundOnly"` without the warning
above and exits 0 when its stdin closes. The shell passes its path to the backend as
`IPHONE_AI_CAPTURE_BIN` (only when the file exists). In development the backend falls back to
`src-tauri/binaries/iphone-ai-capture-<arch>-apple-darwin`.

## Permissions

ScreenCaptureKit needs **Screen Recording**. macOS attributes the helper to the app that launched
the process chain: inside the packaged app that is *iPhone AI* (the same grant Mirroir's screenshots
already use); in development it is your terminal. Without the grant the helper reports
`error`/`permission` and exits 2, and the backend keeps polling Mirroir screenshots.

## Testing without Screen Recording

`--test-pattern` replaces the window screenshots with a synthetic 390 × 844 pt (@2x) picture and runs
it through the real snapshot loop: pacing (and the 15 fps cap), the unchanged-picture check, idle
repeats, encoder, framing, stdin commands and signal handling, without touching ScreenCaptureKit. A bar
moves down for 2 s, then stands still for 3 s, in every 5 s: at `--fps 15` that is about 30 new frames,
then one frame and two idle repeats (one per second) per cycle. It also creates `NSApplication` like a
real run, so it shows how the helper checks in with LaunchServices. It is a diagnostics mode for
protocol tests; the backend never starts it for the live view.

## Verifying real frames in the packaged app

1. Grant Screen Recording to iPhone AI, open iPhone Mirroring, launch `/Applications/iPhone AI.app`
   and open the live view.
2. `pgrep -fl 'iPhone AI.app/Contents/MacOS/iphone-ai-capture'` shows the running helper (it exits
   about 10 s after the last viewer leaves); `lsappinfo info <pid>` shows `type="BackgroundOnly"`
   and the Dock shows no second iPhone AI.
3. The helper's stderr lines (`starting snapshots of window …`, `first frame: …`, `last 30 s: … fps …`)
   show whether frames flow; where they end up (for example
   `~/Library/Application Support/iPhone AI/logs/backend.log`) depends on how the backend's
   LiveCapture service forwards helper stderr.
4. `GET /api/screen/stream` (`StreamStats`) reports `mode: "live-screencapturekit"` and the UI badge
   reads "Live · ScreenCaptureKit" only while frames arrive; `/ws/screen` frame headers carry
   `source: "screencapturekit"`.
5. Mirroir's `status` keeps reporting the session as connected (not "Paused") while the live view runs.
