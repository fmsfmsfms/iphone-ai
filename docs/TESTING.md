# Testing & Verification Report

Three kinds of evidence are kept strictly apart:

| Label | Meaning |
|---|---|
| **MOCK** | Against `packages/server/test/mock-mirroir/server.mjs`, a stand-in that reproduces mirroir-mcp 0.40.1's tool catalogue, permission rules and output formats with a simulated phone. No iPhone involved. |
| **REAL-MIRROIR** | Against the installed Mirroir binary (`/opt/homebrew/bin/mirroir` → `~/mirroir-mcp/.build/release/mirroir-mcp`), read-only, without input to a phone. |
| **REAL-DEVICE** | Against the physical iPhone through iPhone Mirroring. |

## Automated suites

Last full run: 2026-10-15, v0.6.0, with the official Node 22 toolchain (`source scripts/env.sh`).

| Suite | Command | Result |
|---|---|---|
| Backend unit + integration (MOCK) | `pnpm --filter @iphone-ai/server test` | 577 passed (43 files, incl. the real capture helper's --test-pattern against the backend parser, and approval re-checks replayed from recorded real-device screens) |
| UI unit (jsdom) | `pnpm --filter @iphone-ai/web test` | 329 passed (33 files) |
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

**v0.4.0 on the real iPhone (installed app, 2026-10-15):**

- **Swiping works.** Claude (Supervised) "open tiktok and scroll for 20 videos": completed and
  verified on screen, 21 swipes through the For You feed in 109 s (Mirroir swipe ≈2.4 s each,
  ≈3.9 s per video including the AI's checks). 12 manual viewer swipes were delivered
  (3.1–4.3 s each; they follow the speed of the user's drag).
- A real ordering flow in Jahez (search, approvals for Return and taps) and "Add big mac"
  (completed and verified). Live view 10 fps during video.
- Defect: the post-approval screen check treated OCR noise (status-bar clock "3:17 a", a text
  cursor "cheese|", fragments "29 ÷ ||", "jaû") as a screen change, so several approvals had
  to be given twice. Fixed in v0.5.0 (position-aware re-check; see below).
- Defect: Mirroir reports "paused" for a moment whenever the iPhone Mirroring window is active
  under the pointer (its own toolbar buttons). The live-view safety net took that for a capture
  conflict and switched the live view off for the session. Fixed in v0.5.0 (only a pause right
  after capture starts, while connected, is probed, and it must happen twice).

**v0.5.0 hardening (from v0.4.0's device session plus two adversarial reviews; mock-tested):**

- Approval re-check: noise is ignored only where the same text was already at the same spot
  (an OCR re-read, a blinking cursor, a counter tick) or in the status row anchored on the clock.
  New text elsewhere, decision words ("OK", "Pay", "نعم", "دفع"), sensitive keywords, blocked-app
  names and changed amounts ("SAR 49" → "SAR 149") always cancel the approval. Replaying the 81
  recorded consecutive observations: the 4 noise refusals pass, the genuine screen change still
  refuses. Every attack from the reviews (21 cases) is refused.
- Pre-existing gaps closed: taps on unlabeled icons now get the sensitive/blocked-app checks;
  a labelled target on a changed screen (same "Continue" on a payment step) is refused; "pay",
  "payment", "order now", "اطلب", "ادفع", "الدفع" are payment keywords (added to existing
  settings by a migration).
- Live-view safety net: probes only within 8 s of capture start, measured from the onset and
  never reopened by later reconnects; latches only on a second strike in a later helper session.

**v0.5.0 on the real iPhone (2026-10-15):** two TikTok runs, 20 swipes all delivered (2.4 s each
inside Mirroir; the AI paused 1.5 s between them, ≈3.9 s per video). The live view stayed on at
9–10 fps through a real pause (no false switch-off). That pause was genuine — iPhone Mirroring
logged "deviceUnlockedDuringSession" — and the AI stopped safely with the lock-and-Resume advice.
The user still found swiping laggy; earlier viewer swipes took 3.1–4.3 s because a drag was
replayed at the user's own pace (up to 1.5 s). v0.5.1: viewer swipes replay as 0.3 s flicks,
the AI's pause between repeated swipes is 0.3 s by default (0.8 s max), live view 15 fps.
The approval re-check of v0.5.0 has not run on the device yet.

**v0.5.1 on the real iPhone (2026-10-15):**

- TikTok "scroll 6 videos": completed and verified on screen, **2.72 s per video** (was 3.9 s);
  live view **15.0 fps** during video, nothing dropped.
- **Approvals asked once:** a Jahez search needed 3 approvals; each was asked once and its tap
  ran right after approval (the v0.4.0 double approvals are gone).
- Defect: a failed `scroll_to_text` returned an error with a screenshot, and the Claude API
  rejected the next request ("all content must be type `text` if `is_error` is true"), ending
  the task. Fixed in v0.5.2 (error results text-only; the screenshot follows the results).
- Defect (safety): after a refused re-check, the AI re-issued the same tap on a search-field icon
  that OCR now read as "a"; one glyph counted as a readable label, so the commit-after-typing
  approval was skipped. Fixed in v0.5.2: a label needs two letters or digits in a row, and a glyph
  at the tap point no longer hides sensitive text in its row (replayed in
  test/ai/glyph-labels.test.ts).
- Two runs ended early because the iPhone unlocked mid-session (Face ID when picked up or looked
  at): iPhone Mirroring logs "deviceUnlockedDuringSession". Resuming also asked for Mac
  authentication (Touch ID / password), which the user must do.

**v0.5.2 TikTok run and swipe experiment on the real iPhone (2026-10-15):**

- The user's run "open tiktok and scroll for 4 videos" took 57 s. Read from the OCR of each
  observation: 4 medium (312 pt) flicks did not move the feed at all; a long (430 pt) flick
  left it half-way between two videos; it finished snapping on its own seconds later. The AI
  doubted its swipes and spent extra turns.
- Swipe experiment (approved by the user; 12 swipes in TikTok's For You feed through a
  separate Mirroir allowed only `swipe`, watched with window screenshots; Mirroir duration
  measured around the call):

  | Swipe | Mirroir | Result |
  |---|---|---|
  | 430 pt flick, 300 ms (v0.5.2 AI "long") | 3.47 s (window in background) | paged |
  | 600 pt flick, 300 ms | 2.30 s | paged but **stuck at ~85% for 11 s+** until the next input |
  | 30 pt at 100 pt/s (no momentum) | 0.66 s | the stuck feed snapped onto the next video |
  | 400 pt at 488 pt/s (no momentum) | 1.24 s | snapped back (same video) |
  | 450 pt at 479 pt/s | 1.37 s | paged, settled when Mirroir returned |
  | 521 pt at 469 pt/s (×4) | 1.56–1.58 s | paged 3 of 4, settled; the 4th (0.3 s after the previous) snapped back while the next item was still black (not loaded) |
  | 600 pt at 461 pt/s (×2) | 1.80 s | paged once; snapped back once (on a photo ad) |
  | 521 pt down at 469 pt/s | 1.60 s | stayed on the same item (an ad) |

  v0.6.0 therefore paces every swipe at 460 pt/s (no momentum tail) and pages with 70% of the
  screen. Not yet run through the app itself (AI task, viewer, workflows) on the device.

**Not yet verified on the real iPhone:**

- The launch hand-off from a copy in `~/Documents`. (The conflict safety net did trigger on the
  real device on 2026-10-15 — falsely, on Mirroir's toolbar pauses; see above.)
