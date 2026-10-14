# iPhone AI

Monitor and control your **physical iPhone** from your Mac — by hand, with AI agents
(Claude, OpenAI, or your own local models), or with reusable automations — through
Apple's **iPhone Mirroring** and your installed **[Mirroir MCP](https://mirroir.dev/)** server.

- **Live Control** — see the phone screen (polled screenshots, with honest FPS/latency),
  tap, swipe, long-press, type and navigate from a phone-shaped viewer.
- **AI Assistant** — "Open Settings", "Check my battery percentage", "Navigate to Wi-Fi
  settings"… The AI observes the real screen, acts one step at a time, re-checks the
  screen after every action, and verifies the final result against what is visible.
- **Safety first** — Observe Only by default, approvals for sensitive actions, blocked
  apps, no passwords/OTPs ever, a big **STOP AI CONTROL** button, and a full audit trail.
- **Automations** — save and re-run workflows (steps resolved by on-screen text, not
  hard-coded coordinates), with AI suggestions, manual recording and approval checkpoints.
- **Activity History**, **English/Arabic (RTL)**, and an optional **private remote
  dashboard** (e.g. over Tailscale) — the Mac always remains the control host.

```
iPhone AI.app (Tauri) ─► Node backend ─► Mirroir MCP (stdio) ─► iPhone Mirroring ─► iPhone
                          │  policy · approvals · AI loop · workflows · SQLite
                          └─► UI (React + HeroUI) in the app window or a browser
```

## Requirements

- macOS 15+ on Apple silicon, iPhone Mirroring set up with your iPhone (Apple's
  conditions apply: iPhone locked and nearby, same Apple Account, Wi-Fi/Bluetooth on).
- Mirroir installed at `/opt/homebrew/bin/mirroir` (iPhone AI never modifies it or
  `~/.mirroir-mcp`).
- macOS privacy permissions for **iPhone AI**: Screen Recording, Accessibility, and
  Automation → System Events (prompted on first input).
- For AI: an Anthropic or OpenAI API key, a signed-in Claude Code (personal use), or a
  local OpenAI-compatible server (LM Studio, Ollama, vLLM).

## Quick start

```bash
pnpm install
pnpm package:mac          # builds release/iPhone AI.app
open "release/iPhone AI.app"
```

Then follow **Dashboard → Setup checklist**. Full instructions: [docs/SETUP.md](docs/SETUP.md).

Development (backend with hot reload + Vite):

```bash
pnpm dev
```

## Documentation

- [Setup & usage](docs/SETUP.md)
- [Architecture](docs/ARCHITECTURE.md) — including the Mirroir behaviours that shaped the design
- [Security & privacy](docs/SECURITY.md)
- [Local API](docs/API.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Testing & verification report](docs/TESTING.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)

## Repository layout

| Path | Contents |
|---|---|
| `packages/shared` | Typed API contract, zod schemas, safe defaults |
| `packages/server` | Backend: MCP client, device control lane, policy, approvals, AI providers & agent loop, workflows, HTTP/WebSocket API, SQLite |
| `packages/web` | UI (React 19, Vite, Tailwind 4, HeroUI v3) |
| `src-tauri` | macOS app shell (Tauri 2) |
| `scripts` | Dev runner, packaging, icon generator |
