# Testing & Verification Report

Three kinds of evidence are kept strictly apart:

| Label | Meaning |
|---|---|
| **MOCK** | Against `packages/server/test/mock-mirroir/server.mjs`, a stand-in that reproduces mirroir-mcp 0.40.1's tool catalogue, permission rules and output formats with a simulated phone. No iPhone involved. |
| **REAL-MIRROIR** | Against the installed Mirroir binary (`/opt/homebrew/bin/mirroir` → `~/mirroir-mcp/.build/release/mirroir-mcp`), read-only, without input to a phone. |
| **REAL-DEVICE** | Against the physical iPhone through iPhone Mirroring. |

## Automated suites

Last full run: 2026-10-15, v0.4.0, with the official Node 22 toolchain (`source scripts/env.sh`).

| Suite | Command | Result |
|---|---|---|
| Backend unit + integration (MOCK) | `pnpm --filter @iphone-ai/server test` | 496 passed (38 files, incl. the real capture helper's --test-pattern against the backend parser) |
| UI unit (jsdom) | `pnpm --filter @iphone-ai/web test` | 322 passed (33 files) |
| Browser E2E (Playwright, MOCK backend + scripted model) | `pnpm test:e2e` | 24 passed (incl. the Live Control assistant panel: one scroller, approvals in view) |
| Tauri shell (Rust) | `cd src-tauri && cargo test` | 21 passed; clippy and rustfmt clean |
| Real-device read-only | `pnpm test:device` (needs a connected iPhone) | not run; see device section |

Backend suites cover: Mirroir text parsers (all output variants), the project-local
permission workspace, the MCP manager (startup, tool discovery, crash → auto-restart,
SIGTERM termination, timeouts), the policy engine (modes, blocked apps, sensitive rules,
credential screens, commit-after-typing, URL schemes), approvals (approve/reject/expire/
abort), the device controller (leases, geometry, bounds, paused, STOP during an
in-flight action), screen streaming, settings invariants, the activity log, both
streaming AI adapters against protocol emulators, the HTTP layer (auth, CSRF, Host,
Origin, remote sessions, rate limiting), workflows, and the AI task loop end-to-end.

## AI providers

| Provider | Evidence | Result |
|---|---|---|
| Local, vision — Gemma 4 12B (LM Studio, OpenAI-compatible) | Live model × real agent loop × MOCK phone: "Navigate to Wi-Fi settings." | **Completed and verified on screen** in 19 s (2 actions: open Settings → tap "Wi-Fi" by element id); screenshots sent; reasoning captured |
| Local, text — Llama 3.2 3B (Ollama) | Same | Integration works (provider test OK; opened Settings and tapped Wi-Fi), but the small model then wandered and finished "needs user" — model capability, not integration |
| Claude — Claude Code login (Agent SDK) | Bundled engine × MOCK phone | Engine starts, iPhone tools register; without a sign-in it fails in ~1 s with "Not logged in · Please run /login" and the task ends cleanly. **Live model run pending a sign-in or API key** |
| Claude — Anthropic API | Protocol emulator (streaming, thinking, tool use, refusal, error mapping) | Passing. **Live run pending an API key** |
| OpenAI | Protocol emulator (streaming tool-call deltas, images, error mapping) | Passing. **Live run pending an API key** |

## Real Mirroir (no input)

- MCP handshake 201 ms, protocol 2025-11-25, server 0.40.1; 12 read-only tools under the
  fail-closed workspace; `tap` refused by Mirroir itself with the project-local permission file.
- `mirroir doctor` parsed: Accessibility granted, Screen Recording not granted (in the
  development shell), iPhone Mirroring observed "Paused" (355×782 pt) then "Not running".

## Real device

**v0.1.0, run by the user in the installed app (Supervised mode), 2026-10-14.** Read
afterwards from the app's activity log:

- Screen display, AI taps, typing (9 characters + Return), Back, and AI swipes in TikTok
  all reached the phone and reported done.
- Taps took 60–70 ms when iPhone Mirroring was already frontmost (~0.7 s when it had to
  be brought forward). Each AI swipe took ~2.3 s inside Mirroir: its `swipe` is a
  trackpad scroll with a momentum tail. The user found the viewer (≈2 fps polling) laggy
  and feed swiping slow.

**v0.2.0 on the real iPhone (installed app, 2026-10-14), read from the backend log, the
activity log and macOS's unified log:**

- The SCStream live view captured the real Mirroring window at **29.4 fps** (882 frames in
  30 s, 3 ms average JPEG encode, 0 dropped), with geometry matching Mirroir's.
- Defect: each stream start made iPhone Mirroring add a "window streaming" overlay that
  Mirroir 0.40.1 reports as **Paused** while the session was live, blocking control.
  Fixed in v0.3.0 by capturing screenshots instead of a stream.
- Defect: the helper appeared as a second "iPhone AI" in the Dock; quitting that icon
  stopped the live view. Fixed in v0.3.0 (background-only helper).
- Defect: after installing, Spotlight launched a build copy from `~/Documents`, which
  refused to start. Fixed in v0.3.0 (build copies deleted; stray copies hand off).
- Two genuine pauses came from the iPhone being unlocked during the session; the app's old
  "Unlock your iPhone" advice was wrong and is corrected in v0.3.0.

**v0.3.0 on the real iPhone (installed app, 2026-10-15), read from the backend, activity
and unified logs:**

- Mirroir stayed **Connected** with the live view on (snapshot capture): no paused flips and
  no "window streaming" events in iPhone Mirroring's log. The helper ran as a background-only
  process (one Dock icon). Live view measured 9.8–10 fps during video, 3 ms encode,
  13–35 ms latency.
- First live Claude run (Anthropic API, `claude-opus-5-5`, Supervised): "open tiktok and scroll
  for 20 videos". TikTok opened (4.0 s) and a tap worked (64 ms), but **13 swipes did not move
  the feed**: v0.2.0/0.3.0 sent swipes as Mirroir `drag` (~250 ms each), which iOS treats as a
  pointer click-drag. The task failed honestly ("the For You feed wouldn't move"). Fixed in
  v0.4.0 by going back to Mirroir `swipe` (the gesture that paged TikTok in v0.1.0).

**Not yet verified on the real iPhone:**

- v0.4.0's swipes (Mirroir `swipe`, 300 ms, repeated with `times`) for the AI, workflows and the
  viewer, and the viewer's speed-matched drags.
- The launch hand-off from a copy in `~/Documents`, and the conflict safety net (it has not
  been triggered on this Mac).
