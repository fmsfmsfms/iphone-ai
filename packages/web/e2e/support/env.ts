// Locations and run state shared by the Playwright config, the global setup /
// teardown and the tests. The global setup writes the run state to a JSON file
// whose path it publishes in E2E_STATE_FILE (workers inherit the variable).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const WEB_DIR = path.resolve(here, '../..');
export const REPO_ROOT = path.resolve(WEB_DIR, '../..');
export const SERVER_DIR = path.join(REPO_ROOT, 'packages', 'server');
export const WEB_DIST = path.join(WEB_DIR, 'dist');
export const MOCK_MIRROIR = path.join(SERVER_DIR, 'test', 'mock-mirroir', 'server.mjs');
export const FAKE_MODEL = path.join(WEB_DIR, 'e2e', 'fake-model.mjs');
export const TSX_BIN = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');

/** Per-launch secret the backend accepts at /auth/desktop (IPHONE_AI_DESKTOP_TOKEN). */
export const DESKTOP_TOKEN = 'e2e-token';

export interface RunState {
  /** Temp directory holding everything this run created. */
  runDir: string;
  /** IPHONE_AI_DATA_DIR of the backend. */
  dataDir: string;
  /** Mirroir workspace (the mock's cwd): mock-state.json, mock-calls.jsonl, mock-phone.json. */
  workspace: string;
  backendPort: number;
  baseURL: string;
  modelPort: number;
  modelURL: string;
  backendPid: number;
  modelPid: number;
  backendLog: string;
  modelLog: string;
}

export function runStateFile(): string {
  const file = process.env.E2E_STATE_FILE;
  if (!file) throw new Error('E2E_STATE_FILE is not set — run the tests through `playwright test` (globalSetup starts the backend).');
  return file;
}

export function readRunState(): RunState {
  return JSON.parse(readFileSync(runStateFile(), 'utf8')) as RunState;
}
