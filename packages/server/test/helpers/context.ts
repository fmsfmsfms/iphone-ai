// Builds the real backend core objects on throw-away temp directories, wired
// to the mock Mirroir MCP server (test/mock-mirroir/server.mjs) instead of the
// installed binary. Nothing here touches ~/Library, ~/.mirroir-mcp or a phone:
// HOME is pointed at the temp directory while a context is alive, so the
// Mirroir workspace generator never reads the user's global Mirroir settings.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MacPermissions, ServerEvent, SettingsPatch } from '@iphone-ai/shared';

import { ActivityLog } from '../../src/core/activity-log.js';
import { EventHub } from '../../src/core/events.js';
import { silentLogger } from '../../src/core/logger.js';
import { ensureAppDirectories, resolveAppPaths, type AppPaths } from '../../src/core/paths.js';
import { SettingsStore } from '../../src/core/settings-store.js';
import { Database } from '../../src/db/database.js';
import { DeviceController } from '../../src/device/device-controller.js';
import type { InputHelper } from '../../src/device/input-helper.js';
import { MirroirManager } from '../../src/mcp/mirroir-manager.js';

export const MOCK_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mock-mirroir/server.mjs');
export const MOCK_TOOLS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mock-mirroir/tools.json');

/** Permissions the DeviceController assumes for the mock (it has no `mirroir doctor`). */
export const MOCK_PERMISSIONS: Omit<MacPermissions, 'checkedAt'> = {
  screenRecording: 'granted',
  accessibility: 'granted',
  source: 'mock (assumed)',
};

/** Contents of <workspace>/mock-state.json (see test/mock-mirroir/README.md). */
export interface MockState {
  mirroring?: 'connected' | 'paused' | 'not_running' | 'no_window';
  window?: string;
  pos?: string;
  scale?: number;
  screen?: string;
  resetSeq?: number;
  crashOnCall?: string;
  slowMs?: Record<string, number>;
  screenRecording?: 'granted' | 'denied';
  ocrFailure?: boolean;
  resumeDelayMs?: number;
  timeScale?: number;
}

export interface MockCall {
  t: number;
  name: string;
  args: Record<string, unknown>;
}

export interface MockLogEntry {
  t: number;
  name?: string;
  args?: Record<string, unknown>;
  event?: string;
  signal?: string;
  pid?: number;
}

export interface CoreContext {
  dir: string;
  paths: AppPaths;
  db: Database;
  hub: EventHub;
  /** Every ServerEvent published on the hub, in order. */
  events: ServerEvent[];
  settings: SettingsStore;
  activity: ActivityLog;
  cleanup(): Promise<void>;
}

export interface DeviceContext extends CoreContext {
  mirroir: MirroirManager;
  device: DeviceController;
  /** Merges `patch` into <workspace>/mock-state.json (the mock re-reads it on every call). */
  writeMockState(patch: MockState): void;
  /** Every tools/call the mock received, in order. */
  readMockCalls(): MockCall[];
  /** Calls plus lifecycle lines ({event}, {signal}). */
  readMockLog(): MockLogEntry[];
  /** Tool names called so far. */
  calledTools(): string[];
}

export interface CoreOptions {
  settings?: SettingsPatch;
  /** Use a database file inside the temp dir instead of :memory:. */
  fileDatabase?: boolean;
}

export interface DeviceOptions extends CoreOptions {
  mockState?: MockState;
  /** MirroirManager auto-restart after crashes (default true). */
  autoRestart?: boolean;
  /** Pass MOCK_PERMISSIONS as the DeviceController's assumedPermissions (default true). */
  assumePermissions?: boolean;
  /** Start the mock server before returning (default true). */
  start?: boolean;
  /** iPhone AI's own swipe helper (a fake in tests); default none, so swipes go to the mock Mirroir. */
  input?: InputHelper | null;
}

export function makeTempDir(prefix = 'iphone-ai-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function createCoreContext(options: CoreOptions = {}): CoreContext {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  const paths = resolveAppPaths({ dataDir: path.join(dir, 'data'), webDistDir: null });
  ensureAppDirectories(paths);
  const db = new Database(options.fileDatabase ? paths.dbFile : ':memory:');
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const settings = new SettingsStore(db);
  if (options.settings) settings.update(options.settings);
  const activity = new ActivityLog(db, hub, 'test-session');

  let cleaned = false;
  return {
    dir,
    paths,
    db,
    hub,
    events,
    settings,
    activity,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        db.close();
      } catch {
        // already closed
      }
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function createDeviceContext(options: DeviceOptions = {}): Promise<DeviceContext> {
  const core = createCoreContext(options);
  const workspace = core.paths.mirroirWorkspace;
  const stateFile = path.join(workspace, 'mock-state.json');
  const callsFile = path.join(workspace, 'mock-calls.jsonl');
  let mockState: MockState = { timeScale: 0, ...options.mockState };
  writeFileSync(stateFile, JSON.stringify(mockState));

  const mirroir = new MirroirManager({
    paths: core.paths,
    settings: core.settings,
    log: silentLogger,
    activity: core.activity,
    command: { command: process.execPath, args: [MOCK_SERVER] },
    autoRestart: options.autoRestart ?? true,
  });
  const device = new DeviceController(
    mirroir,
    core.settings,
    core.hub,
    core.activity,
    silentLogger,
    options.assumePermissions === false ? null : MOCK_PERMISSIONS,
    options.input ?? null,
  );

  const readMockLog = (): MockLogEntry[] => {
    if (!existsSync(callsFile)) return [];
    return readFileSync(callsFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MockLogEntry);
  };
  const readMockCalls = (): MockCall[] =>
    readMockLog()
      .filter((e): e is MockLogEntry & { name: string } => typeof e.name === 'string')
      .map((e) => ({ t: e.t, name: e.name, args: e.args ?? {} }));

  if (options.start !== false) await mirroir.start();

  return {
    ...core,
    mirroir,
    device,
    writeMockState(patch: MockState) {
      mockState = { ...mockState, ...patch };
      writeFileSync(stateFile, JSON.stringify(mockState));
    },
    readMockCalls,
    readMockLog,
    calledTools: () => readMockCalls().map((c) => c.name),
    async cleanup() {
      device.stopMonitoring();
      try {
        await mirroir.stop();
      } catch {
        // already stopped
      }
      await core.cleanup();
    },
  };
}

/** Polls until `predicate` is true (or throws after `timeoutMs`). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(options.message ?? `Condition not met within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
