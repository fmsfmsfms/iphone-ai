# iPhone AI — Architecture

```
┌──────────────────────── iPhone AI.app (Tauri 2 shell, Rust) ────────────────────────┐
│  • starts the bundled Node.js backend (sidecar) with a per-launch secret token        │
│  • opens the window at http://127.0.0.1:<port>/auth/desktop?token=…                    │
│  • kills the backend process group on quit                                            │
└───────────────┬─────────────────────────────────────────────────────────────────────┘
                │ spawn (stdin pipe = lifetime, stdout "LISTENING <port>")
┌───────────────▼──────────── Backend (Node 22, TypeScript, Fastify) ─────────────────┐
│ http/      REST + WebSocket, auth (desktop token / one-time browser code / remote    │
│            passcode sessions), Host + Origin + CSRF checks, static UI                │
│ device/    DeviceController — ONE serialized lane to the phone: priority queue,      │
│            control lease (manual vs AI vs workflow), emergency-stop latch, live      │
│            geometry checks; LiveCapture — ScreenCaptureKit screenshot frames (/ws/screen)│
│            ScreenStream — throttled screenshot polling when live frames stop          │
│ mcp/       MirroirManager — MCP client (official SDK) for the installed Mirroir      │
│            binary over stdio; parsers for Mirroir's text outputs; project-local      │
│            Mirroir workspace (permissions.json / settings.json)                       │
│ policy/    evaluatePolicy() (pure) + ApprovalBroker                                   │
│ ai/        providers (Anthropic API, Claude Agent SDK, OpenAI, OpenAI-compatible),    │
│            agent toolkit (observe → act → verify), task runner, conversations         │
│ automation/ workflows: storage, step engine, recorder, SKILL.md export                │
│ db/        node:sqlite (WAL) — settings, chats, tasks, approvals, workflows, activity │
│ security/  macOS Keychain secrets (via /usr/bin/security, never on argv)              │
└───────────────┬─────────────────────────────────────────────────────────────────────┘
                │ MCP stdio (JSON-RPC, one request at a time), cwd = app workspace
┌───────────────▼────────────┐        ┌───────────────────────────────┐
│ Mirroir MCP (installed,    │ CGEvent│ Apple iPhone Mirroring.app     │  ⇄  physical iPhone
│ unmodified) v0.40.1        ├───────►│ (window = the phone screen)    │
└────────────────────────────┘ SCK/AX └───────────────▲───────────────┘
 iphone-ai-capture (bundled Swift helper, capture only) ─┘ SCK screenshots → JPEG → backend → UI
 iphone-ai-input (bundled Swift helper) ── CGEvent scroll gesture ("glide") → Mirroring window, one per swipe
```

Swipes are the one input iPhone AI posts itself: Mirroir's `swipe` either crawls or ends with a
~1.4 s momentum tail it waits out, and iOS snaps a paging feed only on a slow lift. The
DeviceController runs `iphone-ai-input glide` (an eased gesture that slows to a stop before the
lift) for `swipe` actions after all its checks, and falls back to Mirroir's `swipe` when the
helper cannot start a gesture (see `device/input-helper.ts`, `shared/src/swipe.ts`).

## Facts about Mirroir that shape the design (verified in its source, v0.40.1)

1. **Strictly serial, no cancellation.** Mirroir reads one JSON-RPC line, runs the tool
   to completion, then reads the next. `notifications/cancelled` is ignored. The only
   way to interrupt an in-flight tool is a signal: SIGTERM/SIGINT/SIGHUP release held
   touches/keys and exit (143/130). SIGKILL would leave input held — never used first.
   → The emergency stop SIGTERMs Mirroir when an input call is executing, then respawns.
2. **Config is read once, from the process cwd first.** `<cwd>/.mirroir-mcp/permissions.json`
   and `settings.json` replace the global ones wholesale. iPhone AI launches Mirroir with
   `cwd = ~/Library/Application Support/iPhone AI/mirroir-workspace` and writes an explicit
   allow list there (empty in Observe-only mode with manual control off), plus a settings
   file that copies the user's global keys (e.g. `keyboardLayout`) and forces local OCR.
   The user's `~/.mirroir-mcp` is never written.
3. **“Read-only” tools have side effects.** `screenshot`/`describe_screen` press the
   Resume button when the session is paused; `describe_screen(scroll:true)` performs real
   swipes; when ScreenCaptureKit fails (no Screen Recording grant) `screenshot` activates
   the Mirroring window (focus steal). → Live polling runs only after `mirroir doctor`
   confirms Screen Recording and the session is connected; paused sessions need a user click.
4. **Coordinates** are macOS points relative to the Mirroring window's top-left; screenshots
   are PNGs at the display backing scale (usually 2×). `status` reports `W×H` and position;
   window *size* is the geometry identity (`geometryId = "WxH"`).
5. **Focus.** Pointer and keyboard tools make iPhone Mirroring frontmost (AppleScript via
   System Events) and never restore focus. The UI shows this; the desktop app can re-focus
   itself after manual actions.
6. **`blockedApps` only guards `launch_app`.** Spotlight + typing, the app switcher and home
   screen taps are not gated by Mirroir — iPhone AI's policy engine enforces blocked apps on
   tap targets, typed text and launches.
7. `open_url` is always refused for the iPhone target; `press_back` always reports success;
   `type_text` falls back to the clipboard (Universal Clipboard) for unmappable characters
   (Arabic, emoji). Success texts mean "events posted", not "the phone reacted" — every AI
   action is followed by an observation.
8. `mirroir test`/`compile` bypass the permission policy and cannot run SKILL.md
   deterministically → workflows run through iPhone AI's own step engine over the MCP
   session; SKILL.md is exported for compatibility.

## Safety layers (defence in depth)

| Layer | What it enforces |
|---|---|
| Mirroir permission file | Fail-closed allow list; no input tools at all in Observe-only/no-manual mode; `set_network`, `reset_app`, `shake`, `generate_skill`, `hold_keys`, `measure`, `switch_target`, `open_url` always denied; `blockedApps` for `launch_app`. |
| Policy engine (`policy/engine.ts`) | Control mode; allowed AI tools; blocked apps on launches, tap targets and typed text; sensitive keyword rules → approval; credential/OTP screens → typing denied; commit-after-typing (send/submit) → approval; non-http URL schemes. |
| Approval broker | Human decision with timeout; cancelled by STOP; every decision audited. |
| DeviceController | Stop latch; control lease (manual vs AI/workflow); fresh geometry check before every coordinate action; bounds check; per-tool timeouts; Mirroir terminated on timeout. Glide swipes only while the Mirroir permission file allows `swipe`; STOP ends a running glide. |
| Agent toolkit | Max actions, max duration, loop detection (same action on unchanged screen), forced observation after every action, evidence-based verification on finish. |
| UI | Prominent STOP (⌘. and Esc-Esc), current mode always visible, focus-steal notices. |
| Physical | Closing iPhone Mirroring or locking the phone stops all input. |

## Control modes

- **Observe Only** (default): AI tools are `observe_screen`, `wait`, `finish_task`. Mirroir has no input tools unless manual control is enabled.
- **Assisted Control**: every AI action becomes an approval card.
- **AI Mode** (stored as `supervised`): AI acts within the task without approval cards — rules that would ask are waived (kept in the decision for the audit log); denials (blocked apps, deny rules, auth-screen typing, allowed actions, STOP) still apply.

Manual control (clicking the live viewer) is a separate switch, refused while an AI task or workflow holds the control lease (unless it is paused).

## AI loop

```
instruction → observe (describe_screen: OCR elements + gridded screenshot)
  → model chooses a tool (tap element / swipe / type / open app / …)
  → policy → (approval) → DeviceController → Mirroir
  → settle (screenshot settle_ms) → observe again → result + "screen changed?" to the model
  → … until finish_task(status, summary, evidence) → evidence matched against final OCR → verified?
```

Providers: Anthropic API (default Claude path), Claude Code login via the Claude Agent SDK
(opt-in, personal use only — it runs its own loop but calls the same toolkit), OpenAI, and
OpenAI-compatible local servers (LM Studio, vLLM, Ollama). Text-only models receive the OCR
element list instead of images.

## Persistence & privacy

SQLite (`node:sqlite`, WAL) in the app data directory (mode 0700/0600). Screenshots are kept
in memory only, unless “Store screenshots” is enabled (retention-limited). Typed text is
logged only as a character count unless explicitly enabled. API keys live in the macOS
Keychain. Diagnostics exports are redacted.
