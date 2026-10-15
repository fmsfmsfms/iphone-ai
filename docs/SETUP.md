# Setup & Usage

## 1. Prerequisites

| Requirement | How to check |
|---|---|
| macOS 15+ (Apple silicon) | Apple menu → About This Mac |
| iPhone Mirroring paired with your iPhone | Open **iPhone Mirroring** — you should see your phone |
| Mirroir installed | `mirroir doctor` in Terminal (binary at `/opt/homebrew/bin/mirroir`) |
| Node.js 22.13+ and pnpm 10 (to build) | `node -v`, `pnpm -v` |
| Rust toolchain + Xcode command line tools (to package) | `cargo --version`, `xcode-select -p` |

iPhone AI does not install or modify Mirroir. It launches the installed binary with its own
project-local configuration (see [Security](SECURITY.md)).

## 2. Build the app

```bash
pnpm install
pnpm package:mac -- --install
```

This builds the UI and backend, bundles the official Node.js runtime and (optionally) the
Claude Code engine, and produces **`release/iPhone AI.app`** (removed again by `--install`
once the copy in /Applications is verified). Pass `-- --no-claude-code`
to skip the ~240 MB Claude Code engine if you will not use the "Claude Code login"
provider.

Signing: the script uses `APPLE_SIGNING_IDENTITY` or auto-detects a "Developer ID
Application" / "Apple Development" identity in your keychain. A stable identity matters:
macOS privacy permissions are tied to the signature, so ad-hoc builds lose their grants
after every rebuild. If macOS asks whether `codesign` may use your key, choose **Always Allow**.

`--install` copies it to **`/Applications/iPhone AI.app`** (quit iPhone AI first when
rebuilding) and deletes the build copies, so Spotlight and the Dock offer only one
iPhone AI. Always launch that copy: macOS privacy protection blocks an app inside
`~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive from reading its own bundled
server until a prompt is answered. A copy started from there opens
/Applications/iPhone AI.app instead when that one is the same version or newer; otherwise it
asks you to install it.
The packaging script downloads the official Node.js runtime from nodejs.org and verifies its
SHA-256 against nodejs.org's published checksums before bundling it.

## 3. First launch

1. Open **iPhone AI**. It starts its backend and Mirroir automatically.
2. Follow **Dashboard → Setup checklist**:
   - **iPhone Mirroring** — click *Open iPhone Mirroring* and approve on the iPhone if asked,
     then **lock the iPhone** and keep it nearby (iPhone Mirroring only runs while it is locked).
   - **Screen Recording** — *Open settings*, enable **iPhone AI**, then **quit and reopen** iPhone AI.
   - **Accessibility** — *Open settings*, enable **iPhone AI**.
   - **Automation** — the first time input is sent, macOS asks whether iPhone AI may
     control **System Events**; allow it (Mirroir uses it to bring the Mirroring window forward).
   - **AI provider** — Settings → AI Providers (see below).
3. Keep iPhone AI and iPhone Mirroring in the **same macOS Space**. Input actions bring the
   iPhone Mirroring window to the front (macOS delivers input only to the frontmost app);
   iPhone AI can bring itself back afterwards (Settings → General).

## 4. Live Control

- The center viewer shows the phone screen **live** (ScreenCaptureKit screenshots, 10 fps
  by default, up to 15) once iPhone AI has Screen Recording permission. Without it, it falls back to
  polled screenshots (≈2 fps). The panel shows the source and the measured FPS/latency.
- Turn on **Manual control** (left panel or `M`) to interact: click = tap, drag = swipe (sent
  when you release; a flick — released while still moving — pages feeds like TikTok to the
  next item in about 3 s, a drag you stop before releasing scrolls exactly that far),
  arrow keys page (↑ = next item), a drag in Long press mode = click-drag for sliders,
  and Long-press / Double-tap modes. Home, Back, App Switcher,
  Spotlight, Open app, and a text field for typing are in the left panel.
- Touches are refused if the iPhone Mirroring window changed size since the frame you
  clicked on — refresh and try again.

## 5. AI providers

| Provider | Setup |
|---|---|
| Claude (Anthropic API) — default | Add an API key from console.anthropic.com. Default model `claude-opus-5-5`. |
| Claude (Claude Code login) | Personal use only. Sign in to Claude Code on this Mac (`claude` → login) or store an API key; *Test connection* shows the status. |
| OpenAI | Add an API key from platform.openai.com (a ChatGPT subscription does not include API access). Pick a vision + tool-calling model. |
| LM Studio / Ollama / vLLM | Start the server, set the base URL, *Fetch models*, choose a model that supports tool calling. Turn **vision** on only for vision models. |

Keys are stored in the macOS Keychain. Switch the active provider any time from the top
bar or the Assistant page — no restart needed. Text-only models can use a separate
"screen understanding" vision provider.

## 6. Control modes

| Mode | What the AI can do |
|---|---|
| **Observe Only** (default) | Look and describe. No input. |
| **Assisted Control** | Proposes each action; you approve or reject every one. |
| **Supervised Automation** | Acts within the task; sensitive actions still need approval; blocked actions never run. |

**STOP AI CONTROL** (red button, `⌘.`, or `Esc Esc`) stops everything immediately. See
[Security](SECURITY.md) for exactly what it does.

## 7. Automations

Automations → *New workflow* or *Suggest with AI* or *Record*:
- Steps refer to **visible text** ("Tap “Wi-Fi”"), resolved live on screen.
- *Record* captures what you do in Live Control and converts taps on labelled elements
  into text-based steps.
- Add **checkpoints** to require your approval mid-run; AI steps can handle variable screens.
- Runs need Assisted or Supervised mode. Pause, resume, stop, and retry (from the failed
  step) are available; every run is kept in the history with per-step results.
- *Export SKILL.md* writes the workflow in Mirroir's skill format into iPhone AI's Mirroir
  workspace.

Unattended or scheduled runs are intentionally disabled.

## 8. Remote dashboard (optional)

Settings → Remote Access: set a passcode, choose your Tailscale address, enable. Open the
shown URL from another computer on your tailnet and sign in with the passcode. Remote
sessions are view-only unless you allow control; revoke them any time. The Mac always does
the phone control; the remote page shows whether iPhone Mirroring is actually connected.

## 9. Development

```bash
pnpm dev                 # backend (tsx watch, port 47823) + Vite UI (5173)
pnpm test                # unit/integration tests (mock Mirroir; no phone needed)
pnpm test:e2e            # browser end-to-end tests against the mock backend
pnpm test:device         # REAL-device read-only checks (needs a connected iPhone)
pnpm typecheck
```

In development the data directory is `./.data` and macOS permissions apply to the
terminal app that runs `pnpm dev`.
