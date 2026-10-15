#!/usr/bin/env node
// Fake iphone-ai-input for tests. Posts nothing. Behaviour comes from the JSON
// config file given as the first argument (re-read on every run):
//   { "mode": "ok" | "not_trusted" | "no_window" | "crash" | "slow", "log": "<file>" }
// Each run appends its remaining arguments (the glide command line) to `log`.
import { appendFileSync, readFileSync } from 'node:fs';

const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
appendFileSync(config.log, `${JSON.stringify(args)}\n`);
const out = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

switch (config.mode) {
  case 'ok':
    out({ ok: true, ms: 320, activated: false, frames: 31, wheel: [0, -2136] });
    process.exit(0);
    break;
  case 'not_trusted':
    out({ ok: false, error: 'not_trusted', message: 'iPhone AI does not have Accessibility permission' });
    process.exit(2);
    break;
  case 'no_window':
    out({ ok: false, error: 'no_window', message: 'no on-screen com.apple.ScreenContinuity window' });
    process.exit(2);
    break;
  case 'crash':
    process.stderr.write('fatal error: boom\n');
    process.exit(1);
    break;
  case 'slow':
    process.on('SIGTERM', () => {
      out({ ok: false, error: 'interrupted', message: 'stopped after 3 of 31 frames', ms: 40 });
      process.exit(3);
    });
    setTimeout(() => {
      out({ ok: true, ms: 3000, activated: false });
      process.exit(0);
    }, 3000);
    break;
  default:
    process.exit(70);
}
