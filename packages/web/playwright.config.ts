// Browser end-to-end tests: the built UI served by the real backend, wired to
// the MOCK Mirroir server and a scripted fake model (see e2e/global-setup.ts).
// No iPhone, no iPhone Mirroring and no real AI provider are involved.
//
//   pnpm --filter @iphone-ai/web build && cd packages/web && npx playwright test
//
// E2E_KEEP_DATA=1 keeps the temp data directory and backend log after the run.

import { execFileSync } from 'node:child_process';

import { defineConfig } from '@playwright/test';

/** A free loopback port (picked synchronously so every process sees the same value). */
function freePort(): number {
  const script =
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
}

// Workers inherit these, so the config evaluates to the same ports everywhere.
if (!process.env.E2E_BACKEND_PORT) process.env.E2E_BACKEND_PORT = String(freePort());
if (!process.env.E2E_MODEL_PORT) {
  let port = freePort();
  while (String(port) === process.env.E2E_BACKEND_PORT) port = freePort();
  process.env.E2E_MODEL_PORT = String(port);
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // One backend and one simulated phone are shared: tests run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_BACKEND_PORT}`,
    trace: 'retain-on-failure',
    browserName: 'chromium',
    headless: true,
    // Wide enough for the full status-bar labels ("MCP ready", "Mirroring connected").
    viewport: { width: 1600, height: 1000 },
    locale: 'en-US',
    colorScheme: 'dark',
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
