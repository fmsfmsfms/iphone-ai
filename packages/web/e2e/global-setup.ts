// Starts everything the browser tests talk to, on throw-away directories:
//  1. a fake OpenAI-compatible model server (e2e/fake-model.mjs) whose replies
//     each test scripts;
//  2. the real iPhone AI backend (packages/server/src/main.ts via tsx) wired to
//     the MOCK Mirroir MCP server (packages/server/test/mock-mirroir) — no
//     iPhone, no iPhone Mirroring, no macOS permissions are used — serving the
//     built UI (packages/web/dist).
// HOME points into the temp directory so the backend never reads the user's
// ~/.mirroir-mcp, and secrets stay in memory (mock mode). Both processes run
// in their own process groups; global-teardown.ts stops them.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DESKTOP_TOKEN, FAKE_MODEL, MOCK_MIRROIR, SERVER_DIR, WEB_DIST, type RunState } from './support/env';

const STARTUP_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal environment for child processes (nothing from the runner such as NODE_OPTIONS leaks in). */
function baseEnv(home: string): NodeJS.ProcessEnv {
  const keep = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = { HOME: home };
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function tail(file: string, lines = 40): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Waits until `pattern` appears in the log file (the process writes its stdout there). */
async function waitForLog(child: ChildProcess, logFile: string, pattern: RegExp, what: string): Promise<RegExpExecArray> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    const match = pattern.exec(existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
    if (match) return match;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${what} exited during startup (code ${child.exitCode ?? child.signalCode}).\n${tail(logFile)}`);
    }
    if (Date.now() > deadline) throw new Error(`${what} did not start within ${STARTUP_TIMEOUT_MS / 1000}s.\n${tail(logFile)}`);
    await sleep(100);
  }
}

function startProcess(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): ChildProcess {
  const fd = openSync(options.logFile, 'a');
  try {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      // Own process group: teardown signals the whole group (tsx's child, the mock Mirroir).
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(path.join(WEB_DIST, 'index.html'))) {
    throw new Error(`The web UI is not built (${WEB_DIST}). Run: pnpm --filter @iphone-ai/web build`);
  }
  const backendPort = Number(process.env.E2E_BACKEND_PORT);
  const modelPort = Number(process.env.E2E_MODEL_PORT);
  if (!backendPort || !modelPort) throw new Error('E2E_BACKEND_PORT / E2E_MODEL_PORT are not set (playwright.config.ts picks them).');

  const runDir = mkdtempSync(path.join(os.tmpdir(), 'iphone-ai-e2e-'));
  const home = path.join(runDir, 'home');
  const dataDir = path.join(runDir, 'data');
  const workspace = path.join(dataDir, 'mirroir-workspace');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  // Instant mock input timings; connected phone on the Home Screen.
  writeFileSync(path.join(workspace, 'mock-state.json'), JSON.stringify({ timeScale: 0, mirroring: 'connected', screen: 'home', resetSeq: 0 }));

  const modelLog = path.join(runDir, 'fake-model.log');
  const backendLog = path.join(runDir, 'backend.log');
  const started: ChildProcess[] = [];
  try {
    const model = startProcess([FAKE_MODEL], {
      cwd: runDir,
      env: { ...baseEnv(home), FAKE_MODEL_PORT: String(modelPort) },
      logFile: modelLog,
    });
    started.push(model);
    await waitForLog(model, modelLog, /FAKE_MODEL_LISTENING (\d+)/, 'The fake model server');

    const tsxCli = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const backend = startProcess([tsxCli, 'src/main.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...baseEnv(home),
        NODE_ENV: 'production',
        IPHONE_AI_MIRROIR_MOCK: MOCK_MIRROIR,
        IPHONE_AI_DATA_DIR: dataDir,
        IPHONE_AI_PORT: String(backendPort),
        IPHONE_AI_DESKTOP_TOKEN: DESKTOP_TOKEN,
        IPHONE_AI_WEB_DIST: WEB_DIST,
        IPHONE_AI_SECRETS: 'memory',
        IPHONE_AI_LOG_FILE: path.join(runDir, 'iphone-ai.log'),
      },
      logFile: backendLog,
    });
    started.push(backend);
    const listening = await waitForLog(backend, backendLog, /LISTENING (\d+)/, 'The iPhone AI backend');
    if (Number(listening[1]) !== backendPort) throw new Error(`Backend listens on ${listening[1]}, expected ${backendPort}.`);

    // The mock Mirroir server logs a start line once MirroirManager has spawned it.
    const callsFile = path.join(workspace, 'mock-calls.jsonl');
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (!(existsSync(callsFile) && readFileSync(callsFile, 'utf8').includes('"event":"start"'))) {
      if (Date.now() > deadline) throw new Error(`The mock Mirroir server never started.\n${tail(backendLog)}`);
      await sleep(100);
    }

    const state: RunState = {
      runDir,
      dataDir,
      workspace,
      backendPort,
      baseURL: `http://127.0.0.1:${backendPort}`,
      modelPort,
      modelURL: `http://127.0.0.1:${modelPort}`,
      backendPid: backend.pid ?? 0,
      modelPid: model.pid ?? 0,
      backendLog,
      modelLog,
    };
    const stateFile = path.join(runDir, 'state.json');
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    process.env.E2E_STATE_FILE = stateFile;
  } catch (err) {
    for (const child of started) if (child.pid) killGroup(child.pid, 'SIGKILL');
    if (process.env.E2E_KEEP_DATA !== '1') rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
}
