# Testing & Verification Report

Three kinds of evidence are kept strictly apart:

| Label | Meaning |
|---|---|
| **MOCK** | Against `packages/server/test/mock-mirroir/server.mjs`, a stand-in that reproduces mirroir-mcp 0.40.1's tool catalogue, permission rules and output formats with a simulated phone. No iPhone involved. |
| **REAL-MIRROIR** | Against the installed Mirroir binary (`/opt/homebrew/bin/mirroir` → `~/mirroir-mcp/.build/release/mirroir-mcp`), read-only, without input to a phone. |
| **REAL-DEVICE** | Against the physical iPhone through iPhone Mirroring. |

## Automated suites

Last full run: 2026-10-14, v0.2.0, with the official Node 22 toolchain (`source scripts/env.sh`).

| Suite | Command | Result |
|---|---|---|
| Backend unit + integration (MOCK) | `pnpm --filter @iphone-ai/server test` | 484 passed (37 files) |
| UI unit (jsdom) | `pnpm --filter @iphone-ai/web test` | 294 passed (32 files) |
| Browser E2E (Playwright, MOCK backend + scripted model) | `pnpm test:e2e` | 19 passed |
| Tauri shell (Rust) | `cd src-tauri && cargo test` | 15 passed; clippy clean |
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

**v0.2.0 changes made in response, not yet verified on the real iPhone:**

- ScreenCaptureKit live view (`iphone-ai-capture`). Verified only in packaging: the helper
  is signed into the bundle with the hardened runtime, answers `--help`, and reports a clean
  `permission` status when run without a Screen Recording grant. Real capture of the
  Mirroring window needs Screen Recording granted to the installed app.
- AI, workflow and viewer swipes are finger flicks (Mirroir `drag`, 160–240 ms) instead of
  scroll swipes; after-action settle shortened (450 ms default). Tested against the mock
  Mirroir only.
