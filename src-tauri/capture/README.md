# iphone-ai-capture — ScreenCaptureKit live view

`main.swift` is a small command-line helper that streams the iPhone Mirroring window as JPEG
frames. The backend (`packages/server`, LiveCapture service) spawns it while someone is watching the
screen or an AI task/workflow holds control, and relays the frames to the UI over `GET /ws/screen`.

Why it exists: polling Mirroir's `screenshot` tool sends a full PNG over MCP stdio (~2 fps), and every
in-flight screenshot delays the next input action in Mirroir's single serial lane. This helper
captures the same window with ScreenCaptureKit directly, so the live view runs at up to 30–60 fps and
Mirroir's lane is free for input.

**Capture only.** It never activates an app, moves the cursor or posts input, and (unlike Mirroir's
`screenshot`) never presses Resume on a paused session. It is safe to run while Mirroring is paused.

## Command line

```
iphone-ai-capture [--bundle-id com.apple.ScreenContinuity] [--fps 30] [--max-long-edge 1600] [--quality 0.7]
iphone-ai-capture --help | --version | --test-pattern
```

| Option | Range | Default | Meaning |
|---|---|---|---|
| `--bundle-id` | | `com.apple.ScreenContinuity` | app whose window is captured |
| `--fps` | 1–60 | 30 | maximum frame rate (`minimumFrameInterval = 1/fps`) |
| `--max-long-edge` | 160–8192 | 1600 | downscale so the longer side is at most this many pixels |
| `--quality` | 0.1–1 | 0.7 | JPEG quality |
| `--test-pattern` | | | diagnostics only, see below |

Out-of-range numbers are clamped (with a note on stderr); malformed arguments exit 64.

## stdin (JSON lines)

```json
{"cmd":"config","fps":10,"maxLongEdge":800,"quality":0.5}   // any subset of the three fields
{"cmd":"stop"}
```

`config` changes apply to the running stream (`SCStream.updateConfiguration`). stdin EOF, `stop`,
SIGTERM, SIGINT and SIGHUP stop the capture, emit `stopped` and exit 0. Malformed lines and unknown
commands are logged to stderr and ignored.

## stdout (binary, length-prefixed)

Every message is `[uint32 BE N = length of the rest][1 byte type][N-1 bytes payload]`, written whole
from one serial queue.

**`0x01` STATUS** — UTF-8 JSON:

| `event` | When | Extra fields |
|---|---|---|
| `waiting` | no window of the app (Mirroring not open / window closed); retried every 1 s | `code: "no_window"`, `message` |
| `started` | the stream is running | `ptW`, `ptH`, `pxW`, `pxH` |
| `window` | window resized / moved to a display with another scale, or `config` changed the output size | `ptW`, `ptH`, `pxW`, `pxH` |
| `error` | `code: "permission"` (then exit 2) or `code: "stream_failed"` (the helper retries; exit 3 after 5 failures in a row) | `code`, `message` |
| `stopped` | clean stop (then exit 0) | `message` (the reason) |

**`0x02` FRAME** — `[uint32 BE H][H bytes UTF-8 JSON header][JPEG bytes]`, header:

```json
{"seq": 42, "ts": 1792006958234, "ptW": 342, "ptH": 744, "pxW": 684, "pxH": 1488}
```

- `seq` increases by one per frame message.
- `ts` is the capture time in epoch ms (the sample's host-clock presentation time).
- `ptW` × `ptH` is the window size in points, truncated to integers — the same geometry as Mirroir's
  `status` and its tap coordinates (points from the window's top-left). `pxW` × `pxH` is the JPEG size.
- Only frames with new content are encoded (`SCFrameStatus.complete`, plus the stream's first
  `.started` frame). While ScreenCaptureKit keeps reporting the content as unchanged (`.idle`), the last
  JPEG is re-sent about once per second with a new `seq` and `ts` = now, so a consumer can tell a
  static screen from a stalled stream. Without fresh idle reports nothing is re-sent.
- At most one frame is in flight (encoding or being written). Frames that arrive meanwhile are
  dropped, never queued: a slow reader gets the freshest frame, not a backlog.

**stderr** carries human-readable log lines only (`iphone-ai-capture: …`): window found/lost, the
first frame of each stream, and every 30 s while frames flow a line such as
`last 30 s: 812 frames (27.1 fps), 3 idle repeats, 41 dropped while busy, encode avg 7.9 ms`.

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
  again every second (resize → `updateConfiguration` + `window`; new window id → restart; gone →
  `waiting`).
- Filter: `SCContentFilter(desktopIndependentWindow:)` — the same kind of capture Mirroir's own
  screenshot uses, so pixels and point geometry match its tap coordinates.
- Configuration: `width`/`height` = window points × `filter.pointPixelScale`, downscaled
  proportionally to `--max-long-edge`; BGRA, sRGB, `showsCursor = false`,
  `ignoreShadowsSingleWindow = true`, `queueDepth = 4`, no audio.
- Encoding: one reused `CIContext` (`jpegRepresentation`, sRGB).

## Building and packaging

```
node scripts/build-capture.mjs [--force] [--target aarch64-apple-darwin|x86_64-apple-darwin]
```

compiles with `xcrun swiftc -O -swift-version 5 -target <arch>-apple-macos15.0 -parse-as-library`
(ScreenCaptureKit, CoreImage, CoreMedia, AppKit) into `src-tauri/binaries/iphone-ai-capture-<triple>`,
ad-hoc signs it (identifier `me.alsaud.iphoneai.capture`, hardened runtime) so it runs from the repo,
and checks that `--help` works. It skips the compile while the source, flags and compiler are
unchanged. `pnpm package:mac` runs it as step 5 (also with `--stage-only`); `src-tauri/build.rs`
refuses to build the shell without it.

`tauri.conf.json` lists `binaries/iphone-ai-capture` in `bundle.externalBin`, so the bundle contains
`Contents/MacOS/iphone-ai-capture`, signed by `tauri build` with the app identity and
`Entitlements.plist`. After the build, `package-mac.mjs` verifies that the bundled helper exists, is
signed like the app with the hardened runtime, runs `--help`, and exits cleanly with valid framing when
started with stdin already closed. The shell passes its path to the backend as
`IPHONE_AI_CAPTURE_BIN` (only when the file exists). In development the backend falls back to
`src-tauri/binaries/iphone-ai-capture-<arch>-apple-darwin`.

## Permissions

ScreenCaptureKit needs **Screen Recording**. macOS attributes the helper to the app that launched
the process chain: inside the packaged app that is *iPhone AI* (the same grant Mirroir's screenshots
already use); in development it is your terminal. Without the grant the helper reports
`error`/`permission` and exits 2, and the backend keeps polling Mirroir screenshots.

## Testing without Screen Recording

`--test-pattern` streams a synthetic 390 × 844 pt (@2x) moving bar through the same encoder, idle
repeats, framing, stdin commands and signal handling, without touching ScreenCaptureKit (2 s of
motion, then 3 s of "unchanged content" in every 5 s). It is a diagnostics mode for protocol tests;
the backend never starts it for the live view.

## Verifying real frames in the packaged app

1. Grant Screen Recording to iPhone AI, open iPhone Mirroring, launch `/Applications/iPhone AI.app`
   and open the live view.
2. `pgrep -fl 'iPhone AI.app/Contents/MacOS/iphone-ai-capture'` shows the running helper (it exits
   about 10 s after the last viewer leaves).
3. The helper's stderr lines (`starting capture of window …`, `first frame: …`, `last 30 s: … fps …`)
   show whether frames flow; where they end up (for example
   `~/Library/Application Support/iPhone AI/logs/backend.log`) depends on how the backend's
   LiveCapture service forwards helper stderr.
4. `GET /api/screen/stream` (`StreamStats`) reports `mode: "live-screencapturekit"` and the UI badge
   reads "Live · ScreenCaptureKit" only while frames arrive; `/ws/screen` frame headers carry
   `source: "screencapturekit"`.
5. macOS shows its screen-recording indicator in the menu bar while the helper captures.
