# Security & Privacy

iPhone AI can operate your real iPhone. It is built so that nothing happens on the
phone that you did not allow, and so that you can always stop it.

## Defaults

- **Observe Only** mode: the AI can look and describe; it cannot tap, type or navigate.
- **Manual control off**: clicking the live viewer does nothing until you enable it.
- In this state Mirroir itself is started with an **empty allow list**, so even a bug in
  iPhone AI could not send taps or typing through it. iPhone AI's own swipe helper (scroll
  gestures only) is used only while that list allows swipes.
- **Sensitive apps blocked**: Wallet, Passwords, password managers, authenticator apps,
  national-ID apps (Nafath, Absher) and common banking/payment apps. Edit the list in
  Settings → Permissions.
- **No screenshots stored**; typed text is logged only as a character count.
- **Local only**: the backend listens on `127.0.0.1`; remote access is off.

## Layers of protection

1. **Mirroir's fail-closed permission file** — written by iPhone AI into its own
   workspace (`~/Library/Application Support/iPhone AI/mirroir-workspace/.mirroir-mcp/`).
   Your global `~/.mirroir-mcp` is never modified. `set_network`, `reset_app`, `shake`,
   `hold_keys`, `measure`, `switch_target`, `generate_skill` and `open_url` are always denied.
   iPhone AI never uses `--dangerously-skip-permissions` / `--yolo`.
2. **Policy engine** (backend) — checks every AI and workflow action:
   control mode, allowed actions, blocked apps (launches, taps on app labels, typed app
   names — Mirroir only guards launches), sensitive keywords (send, delete, buy, transfer,
   sign out, allow, …) → approval, password/OTP/passcode screens → typing refused,
   "submit after typing" → approval, non-web URL schemes → approval. In **AI Mode** every
   approval is waived (the action runs; the flagged rules are still recorded); denials apply
   in every mode.
3. **Approvals** (Assisted Control) — a card with what will happen and why it needs
   approval. Timeouts count as "no". Every decision is recorded.
4. **Control lease** — only one controller (you, an AI task, or a workflow) at a time.
   Manual input is refused while a task is in control unless you pause it.
5. **Geometry checks** — touches are refused if the iPhone Mirroring window changed size
   since the screenshot the coordinates came from.
6. **Limits** — max actions and max duration per task; repeated actions on an unchanged
   screen are refused and the task is stopped if it keeps looping.
7. **Never automated**: passwords, passcodes, verification codes, Face ID / Touch ID,
   sign-in prompts. The AI is told to hand control back to you, and typing on such
   screens is blocked.
8. **Swipes from iPhone AI's input helper** — swipes are normally sent by the bundled
   `iphone-ai-input` helper rather than Mirroir (a faster gesture that iOS snaps to the next
   video). It can only post scroll-wheel gestures at the middle of the iPhone Mirroring window
   (no taps, clicks or keys), runs only after all the checks above, and only while Mirroir's
   permission file would allow `swipe`. This is enforced inside iPhone AI, not by Mirroir. If
   the helper cannot start a gesture, Mirroir's `swipe` is used instead.

## STOP AI CONTROL

The red button (shortcut **⌘.** or **Esc Esc**) works from every screen, including
view-only remote sessions. It:

1. latches a stop: every device action is refused until you click **Re-arm**;
2. cancels the active AI task and workflow run and all pending approvals;
3. rejects queued actions;
4. if an input action is executing, terminates Mirroir with `SIGTERM` — Mirroir's
   handler interrupts gestures and lifts held touches/keys before exiting — and then
   restarts it; a swipe from iPhone AI's input helper is ended instead (the helper lifts the
   gesture and exits).

Input that macOS has already delivered to the phone cannot be undone. Closing the
iPhone Mirroring window (or locking the phone) is an additional physical kill switch:
neither Mirroir nor the input helper can deliver any input without it.

## Data

| Data | Where | Default |
|---|---|---|
| Settings, conversations, tasks, approvals, workflows, activity | SQLite in the app data folder (owner-only permissions) | kept; activity retention 90 days |
| Screenshots of AI steps / workflow runs | memory only | opt-in to store on disk (7-day retention) |
| Typed text | activity history | length only; opt-in to log text |
| API keys, remote passcode hash | macOS Keychain (service "iPhone AI") | — |

Cloud AI providers (Anthropic, OpenAI) receive the on-screen text and — for vision
models — screenshots of your phone while a task runs. The app asks you to acknowledge
this before the first cloud task. Local models (LM Studio, Ollama, vLLM) keep everything
on your network.

Delete history any time: Settings → Privacy → Delete local history.

## Local API protection

- Binds to `127.0.0.1`; requests whose `Host` is not the local address are rejected
  (DNS-rebinding defence).
- Session cookie (HttpOnly, SameSite=Strict) obtained only through the desktop app's
  per-launch secret or a one-time link.
- State-changing requests need a custom header (CSRF defence) and a matching `Origin`.
- WebSocket connections are authenticated the same way.

## Remote access (optional, off by default)

- Must be explicitly enabled and requires a passcode (stored as a scrypt hash).
- Binds only to an address you choose — intended for a private network such as
  Tailscale (traffic is WireGuard-encrypted). Never expose it to the public internet.
- Remote sessions are view-only unless you allow remote control; sessions expire and
  can be revoked individually or all at once. STOP works from remote sessions.
- The Mac always remains the control host; remote browsers never run Mirroir.

## Claude Code login provider

"Claude (Claude Code login)" runs Anthropic's Claude Agent SDK with your own local
Claude Code authentication. Anthropic's terms do not allow third-party products to offer
claude.ai login; use this only for your own personal use on your own Mac. For anything
shared, use the "Claude (Anthropic API)" provider with an API key. iPhone AI never reads,
stores or proxies Claude Code OAuth tokens; built-in Claude Code tools (shell, files) are
disabled — only the iPhone tools exist.
