// Stops the backend (gracefully first: it SIGTERMs the mock Mirroir server
// itself) and the fake model server, then removes the run directory unless
// E2E_KEEP_DATA=1. Any mock Mirroir instance this run started that is still alive
// afterwards is stopped too (matched by pid and command line).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { killGroup } from './global-setup';
import { MOCK_MIRROIR, readRunState } from './support/env';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopGroup(pid: number, graceMs: number): Promise<void> {
  if (!pid || !groupAlive(pid)) return;
  // The group leader (tsx) forwards SIGTERM to the backend, which shuts Mirroir down cleanly.
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    killGroup(pid, 'SIGTERM');
  }
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pid)) {
    killGroup(pid, 'SIGTERM');
    await sleep(1000);
  }
  if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Mock Mirroir instances this run started (pids from their start lines) that are somehow still running. */
async function stopStrayMocks(workspace: string): Promise<void> {
  const callsFile = path.join(workspace, 'mock-calls.jsonl');
  if (!existsSync(callsFile)) return;
  const pids = readFileSync(callsFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"start"'))
    .map((line) => Number((JSON.parse(line) as { pid?: number }).pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const pid of pids) {
    if (!alive(pid)) continue;
    // Only ever signal the mock server itself (never a recycled pid).
    let command = '';
    try {
      command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (!command.includes(MOCK_MIRROIR)) continue;
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await sleep(100);
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
}

export default async function globalTeardown(): Promise<void> {
  if (!process.env.E2E_STATE_FILE || !existsSync(process.env.E2E_STATE_FILE)) return;
  const state = readRunState();
  await stopGroup(state.backendPid, 8000);
  await stopGroup(state.modelPid, 3000);
  await stopStrayMocks(state.workspace);
  if (process.env.E2E_KEEP_DATA === '1') {
    process.stdout.write(`E2E run data kept in ${state.runDir} (backend log: ${state.backendLog})\n`);
  } else {
    rmSync(state.runDir, { recursive: true, force: true });
  }
}
