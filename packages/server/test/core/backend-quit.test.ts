// The real backend (src/main.ts via tsx) quit the way the desktop app quits
// it: SIGTERM to the whole process group (src-tauri/src/backend.rs), which
// reaches the mock Mirroir at the same moment as the backend. The close must
// not be logged as a Mirroir crash. In the packaged app Mirroir's exit usually
// lands while shutdown() awaits the capture helper; mock mode has no helper,
// so the second test opens that window by signalling Mirroir first. Mock
// Mirroir only; HOME and the data directory are throw-away temp directories.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ActivityLog } from '../../src/core/activity-log.js';
import { EventHub } from '../../src/core/events.js';
import { resolveAppPaths } from '../../src/core/paths.js';
import { Database } from '../../src/db/database.js';
import { makeTempDir, MOCK_SERVER, sleep, waitFor, type MockLogEntry } from '../helpers/context.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Backend {
  child: ChildProcess;
  dataDir: string;
  workspace: string;
  logFile: string;
  stdout(): string;
}

let runDir: string | null = null;
let running: ChildProcess | null = null;

afterEach(() => {
  if (running?.pid && running.exitCode === null && running.signalCode === null) {
    try {
      process.kill(-running.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  running = null;
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  runDir = null;
});

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function startBackend(): Promise<Backend> {
  runDir = makeTempDir('iphone-ai-quit-');
  const home = path.join(runDir, 'home');
  const dataDir = path.join(runDir, 'data');
  const workspace = path.join(dataDir, 'mirroir-workspace');
  const logFile = path.join(runDir, 'iphone-ai.log');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(workspace, 'mock-state.json'), JSON.stringify({ timeScale: 0 }));

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    IPHONE_AI_MIRROIR_MOCK: MOCK_SERVER,
    IPHONE_AI_DATA_DIR: dataDir,
    IPHONE_AI_PORT: '0',
    IPHONE_AI_SECRETS: 'memory',
    IPHONE_AI_LOG_FILE: logFile,
  };
  // One Node process in its own process group, like the packaged app.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = child;
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr!.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const exited = () => child.exitCode !== null || child.signalCode !== null;

  await waitFor(() => /LISTENING \d+/.test(out) || exited(), { timeoutMs: 30000, message: 'backend never listened' });
  expect(exited(), out).toBe(false);
  await waitFor(() => readText(logFile).includes('Mirroir MCP server ready'), { timeoutMs: 20000, message: 'Mirroir never became ready' });
  return { child, dataDir, workspace, logFile, stdout: () => out };
}

function mockPid(backend: Backend): number {
  const entries = readText(path.join(backend.workspace, 'mock-calls.jsonl'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as MockLogEntry);
  const pid = entries.find((e) => e.event === 'start')?.pid;
  if (!pid) throw new Error('mock Mirroir pid not logged');
  return pid;
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

function activityTypes(dataDir: string): string[] {
  const db = new Database(resolveAppPaths({ dataDir, webDistDir: null }).dbFile);
  try {
    return new ActivityLog(db, new EventHub(), 'reader').query({ limit: 100 }).map((e) => e.type);
  } finally {
    db.close();
  }
}

describe('quitting the desktop app', () => {
  it('a process-group SIGTERM ends the session without a Mirroir crash row', async () => {
    const backend = await startBackend();
    process.kill(-backend.child.pid!, 'SIGTERM');
    expect(await waitForExit(backend.child), backend.stdout()).toBe(0);

    const types = activityTypes(backend.dataDir);
    expect(types).toContain('mcp.started');
    expect(types).toContain('session.ended');
    expect(types).not.toContain('mcp.exited');
  });

  it('Mirroir exiting a moment before the backend handles its SIGTERM is not a crash either', async () => {
    const backend = await startBackend();
    process.kill(mockPid(backend), 'SIGTERM'); // Mirroir handles the group SIGTERM first…
    await waitFor(() => readText(path.join(backend.workspace, 'mock-calls.jsonl')).includes('"signal":"SIGTERM"'));
    await sleep(150); // …and the backend sees the exit before its own signal.
    process.kill(-backend.child.pid!, 'SIGTERM');
    expect(await waitForExit(backend.child), backend.stdout()).toBe(0);

    const types = activityTypes(backend.dataDir);
    expect(types).toContain('session.ended');
    expect(types).not.toContain('mcp.exited');
    expect(readText(backend.logFile)).toContain('Mirroir MCP server exited as iPhone AI was closing');
  });
});
