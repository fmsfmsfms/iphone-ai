# iphone-ai-input — iPhone AI's swipe ("glide")

`main.swift` is a small command-line helper that posts one trackpad-style scroll gesture to the
iPhone Mirroring window. The backend (`packages/server`, `device/input-helper.ts`) runs it once
per `swipe` action, after the DeviceController's checks (control mode, approvals, control lease,
STOP latch, paused/geometry checks, and only while Mirroir's permission file allows `swipe`).

Why it exists: iOS snaps a paging feed (TikTok, Reels, Shorts) to the nearest item only when a
scroll ends with a slow lift. Mirroir's `swipe` either crawls (below 500 pt/s) or flicks with a
~1.4 s momentum tail that it waits out and that can leave the feed half-way between two items.
The glide moves fast and eases to a stop before the lift: ~0.35 s per gesture, and the feed has
snapped when it returns (6 of 6 pages on the real iPhone, 2026-10-15; docs/TESTING.md).

**Scroll gestures only.** It never taps, clicks, types or presses keys. It brings iPhone
Mirroring to the front when needed (`open -b`, then 300 ms to settle, as Mirroir does), warps
the pointer to the middle of the window, posts the gesture and puts the pointer back.

## Command line

```
iphone-ai-input glide --dx <pt> --dy <pt> [--duration-ms 250] [--bundle-id com.apple.ScreenContinuity] [--dry-run]
iphone-ai-input --help | --version
```

- `--dx`/`--dy`: finger travel in window points (negative `dy`: finger up, next item); 1–4000 pt.
  The gesture sends 3 wheel units per point (Mirroir's scroll amplification), so the content
  moves about as far as the finger.
- `--duration-ms`: 80–1000 (clamped), default 250. Frames every 8 ms with an ease-out (cubic)
  velocity, then 40 ms of zero-delta frames, then the lift (scroll phase Ended). No momentum
  phase.
- `--dry-run`: prints the planned frames; posts nothing, needs no permission.

Prints one JSON line on stdout:

| Exit | JSON | Meaning |
|---|---|---|
| 0 | `{"ok":true,"ms":…,"activated":…,"frames":…,"wheel":[x,y],"window":[x,y,w,h]}` | gesture posted |
| 2 | `{"ok":false,"error":"not_trusted" \| "no_window" \| "activation_failed",…}` | nothing posted; the backend uses Mirroir's swipe |
| 3 | `{"ok":false,"error":"interrupted",…}` | SIGTERM/SIGINT/SIGHUP (the emergency stop): the gesture was ended with a lift |
| 64 | `{"ok":false,"error":"bad_args",…}` | malformed arguments |

The binary embeds `Info.plist` (LSBackgroundOnly) like the capture helper. Accessibility is
attributed to the responsible process (iPhone AI). Built by `scripts/build-input.mjs` (run by
`pnpm package:mac`); bundled as `Contents/MacOS/iphone-ai-input`.
