# iPhone AI — working rules

- **Version bump on every change.** Every edit, feature or fix to the app ships with a
  version bump: `pnpm version:bump patch` for fixes, `pnpm version:bump minor` for new
  features or behaviour changes (`major` / `x.y.z` also accepted). It updates every
  package.json, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
  `packages/shared/src/version.ts` (the runtime source of truth). Put the new version in the
  commit message. Never ship a rebuilt `iPhone AI.app` with an unchanged version.
- Work on `main` only; no branches or worktrees. Commit verified milestones.
- Never modify Mirroir (`~/mirroir-mcp`) or `~/.mirroir-mcp`; never use
  `--dangerously-skip-permissions` / `--yolo`. No real-iPhone input without the user's approval.
- The app bundles the official nodejs.org Node runtime (downloaded and SHA-256-verified by
  `pnpm package:mac`); never bundle or depend on Hermes Agent or `~/.hermes`.
- Package with `pnpm package:mac -- --install` and launch `/Applications/iPhone AI.app`
  (macOS privacy protection blocks the bundled server inside ~/Documents).
- Tests: `pnpm test` (mock Mirroir, no phone), `pnpm test:e2e` (Playwright), `pnpm test:device`
  (real device, read-only). Keep mock-based and real-device results clearly separated.
