# Troubleshooting

Start with **Dashboard → Setup checklist** and **Settings → iPhone Connection → Run
diagnostics**. They show exactly what Mirroir reports.

## The viewer says "Screen Recording permission not confirmed"

iPhone AI only takes screenshots after macOS confirms Screen Recording. Without it,
Mirroir falls back to bringing the iPhone Mirroring window to the front for every
screenshot, which would constantly steal focus — so polling stays off.

1. System Settings → Privacy & Security → **Screen & System Audio Recording**.
2. Enable **iPhone AI** (add it with **+** from `/Applications` or the `release/` folder if missing).
3. **Quit and reopen iPhone AI** — macOS applies the grant on relaunch.

When running from a terminal in development (`pnpm dev`), the grant belongs to the
terminal app instead.

## "No window" / taps do nothing

- **Accessibility** must be enabled for iPhone AI (System Settings → Privacy & Security →
  Accessibility). Without it Mirroir cannot find the Mirroring window ("No window").
- **Automation → System Events**: macOS may ask whether iPhone AI may control System
  Events the first time input is sent. Allow it — Mirroir uses it to bring the iPhone
  Mirroring window to the front before delivering input.
- Keep iPhone AI and iPhone Mirroring in the **same macOS Space** (Mirroir cannot deliver
  input across Spaces).

## iPhone Mirroring is "Paused"

Unlock your iPhone and click **Resume** in the iPhone Mirroring window, or press
**Resume** in iPhone AI's viewer (Mirroir clicks the button for you). The phone must be
locked and nearby for iPhone Mirroring to work (Apple's requirement).

## After rebuilding the app, permissions stop working

macOS ties privacy grants to the app's code signature. Builds signed with a stable
identity (Developer ID / Apple Development) keep their grants; ad-hoc builds do not. If
grants look enabled but don't work, remove iPhone AI from the list, add it again, and
relaunch. Resetting: `tccutil reset ScreenCapture me.alsaud.iphoneai` (and
`Accessibility`, `AppleEvents`).

## Mirroir MCP keeps restarting

- Check **Settings → Advanced → Mirroir log** (stderr tail).
- Verify the binary: `mirroir doctor` in Terminal.
- Only one Mirroir instance should drive the Mac at a time — quit other MCP clients
  (Claude Desktop / Claude Code configured with Mirroir) while using iPhone AI.

## Typed text arrives wrong or not at all

- Non-US keyboard layouts need `keyboardLayout` in `~/.mirroir-mcp/settings.json`
  (iPhone AI copies your global Mirroir settings into its workspace).
- Arabic, emoji and other characters without a key mapping are sent through the clipboard
  (Cmd+V) and require **Universal Clipboard** (Handoff on both devices, same Apple
  Account, Wi-Fi + Bluetooth on). The result shows a warning when this path is used.
- iOS autocorrect may change words.

## The AI says it cannot see the screen

- Mirroring must be connected and Screen Recording confirmed (see above).
- A provider must be configured: Settings → AI Providers → Test connection.
- Text-only local models receive OCR text only. For screenshots, enable **vision** on a
  vision-capable model or set a separate "screen understanding" provider.

## Local models (LM Studio / Ollama / vLLM)

- Start the server (LM Studio: Developer → Start Server; Ollama: `ollama serve`).
- Pick a model that supports **tool calling**; small models often fail at multi-step
  control. vLLM needs `--enable-auto-tool-choice --tool-call-parser <parser>`.
- Use **Fetch models** in the provider card to see what the server offers.

## Diagnostics export

Settings → Advanced → **Export diagnostics** produces a redacted JSON file (versions,
status, settings without secrets, recent activity, Mirroir log tail) safe to share.
