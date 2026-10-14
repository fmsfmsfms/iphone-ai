// Test harness for the HTTP layer: a real database, settings, event hub,
// activity log, approvals, secrets and screenshot store, with FAKE Mirroir,
// device, stream, agent and workflow services (only what the routes call).

import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, type ActionResult, type DeviceStatus, type StreamStats } from '@iphone-ai/shared';

import { ScreenshotStore } from '../../src/ai/screenshots.js';
import { ActivityLog } from '../../src/core/activity-log.js';
import { EventHub } from '../../src/core/events.js';
import { silentLogger } from '../../src/core/logger.js';
import { ensureAppDirectories, resolveAppPaths } from '../../src/core/paths.js';
import type { AgentServiceApi, AppContext, WorkflowServiceApi } from '../../src/core/services.js';
import { SettingsStore } from '../../src/core/settings-store.js';
import { Database } from '../../src/db/database.js';
import type { DeviceController } from '../../src/device/device-controller.js';
import { LiveCapture } from '../../src/device/live-capture.js';
import type { ScreenStream } from '../../src/device/screen-stream.js';
import { AuthService } from '../../src/http/auth.js';
import { createHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import type { MirroirManager } from '../../src/mcp/mirroir-manager.js';
import { ApprovalBroker } from '../../src/policy/approvals.js';
import { hashPasscode, REMOTE_PASSCODE_ACCOUNT } from '../../src/remote/passcode.js';
import { MemorySecretStore } from '../../src/security/secrets.js';

export const LOCAL_PORT = 47823;
export const LOCAL_HOST = `127.0.0.1:${LOCAL_PORT}`;
export const LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
export const REMOTE_ADDRESS = '100.101.102.103';
export const REMOTE_PORT = 47824;
export const REMOTE_HOST = `${REMOTE_ADDRESS}:${REMOTE_PORT}`;
export const DESKTOP_TOKEN = 'desktop-token-for-tests-0123456789abcdef';
export const PASSCODE = 'correct horse battery';

function fakeStatus(stopLatched: boolean): DeviceStatus {
  return {
    server: {
      state: 'ready',
      binaryPath: '/opt/homebrew/bin/mirroir',
      pid: 1234,
      version: '0.40.1',
      protocolVersion: '2025-06-18',
      startedAt: 1,
      restartCount: 0,
      lastError: null,
      tools: [],
      permissionFile: null,
    },
    mirroring: { state: 'connected', rawStatus: 'Connected', target: 'iphone', geometry: null, checkedAt: 1 },
    permissions: { screenRecording: 'granted', accessibility: 'granted', source: 'test', checkedAt: 1 },
    controlOwner: 'none',
    stopLatched,
    stopReason: stopLatched ? 'test' : null,
    queueDepth: 0,
    actionInFlight: false,
    lastFocusSteal: null,
  };
}

export function createFakes() {
  let stopLatched = false;
  let frameSeq = 0;
  const actionResult: ActionResult = { ok: true, tool: 'tap', durationMs: 12, message: 'Tapped', focusChanged: false };
  const device = {
    perform: vi.fn(async () => actionResult),
    emergencyStop: vi.fn(async () => {
      stopLatched = true;
    }),
    rearm: vi.fn(() => {
      stopLatched = false;
    }),
    refocusApp: vi.fn(),
    checkHealth: vi.fn(async () => ({ ok: true, text: 'All checks passed' })),
    getStatus: vi.fn(() => fakeStatus(stopLatched)),
    getLatestFrame: vi.fn((): { meta: { seq: number; mimeType: string; source?: string }; data: Buffer } | null => null),
    nextFrameSeq: vi.fn(() => {
      frameSeq += 1;
      return frameSeq;
    }),
    geometry: null,
    get isStopLatched() {
      return stopLatched;
    },
    currentLease: null,
  };
  const mirroir = {
    configChanged: vi.fn(() => false),
    restart: vi.fn(async () => undefined),
    isReady: vi.fn(() => true),
    info: vi.fn(() => fakeStatus(false).server),
    recentStderr: vi.fn(() => ['mirroir started']),
    resolveBinary: vi.fn(() => '/opt/homebrew/bin/mirroir'),
    runDoctor: vi.fn(async () => []),
  };
  const streamStats: StreamStats = {
    mode: 'polling-screenshots',
    running: false,
    targetFps: 0,
    measuredFps: 0,
    avgLatencyMs: 0,
    lastFrameAt: null,
    pausedReason: 'No visible viewer',
    viewers: 0,
    consecutiveErrors: 0,
    lastError: null,
    liveAvailable: false,
    liveError: null,
  };
  const stream = {
    setViewer: vi.fn(),
    markActivity: vi.fn(),
    stats: vi.fn(() => streamStats),
  };
  const agents = {
    activeTask: vi.fn(() => null),
    cancelTask: vi.fn(),
    listConversations: vi.fn(() => []),
    deleteConversation: vi.fn(),
    claudeCodeStatus: vi.fn(async () => ({ available: false, binaryPath: null, loggedIn: false, authMethod: 'none', detail: 'test' })),
  };
  const workflows = {
    activeRun: vi.fn(() => null),
    stop: vi.fn(),
  };
  return { device, mirroir, stream, agents, workflows };
}

export type Fakes = ReturnType<typeof createFakes>;

export interface Harness {
  ctx: AppContext;
  fakes: Fakes;
  auth: AuthService;
  secrets: MemorySecretStore;
  local: HttpServerHandle;
  dataDir: string;
  /** Builds a remote listener sharing this harness' AuthService. */
  remoteServer(): HttpServerHandle;
  /** Stores a passcode hash and marks it set (what PUT /api/remote/passcode does). */
  setPasscode(passcode?: string): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  webDistDir?: string | null;
  /**
   * Builds ctx.live (default: a LiveCapture without a helper, i.e. unavailable).
   * Tests pass one backed by the FAKE capture helper.
   */
  live?: (deps: { device: Fakes['device']; settings: SettingsStore; hub: EventHub }) => LiveCapture;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'iphone-ai-http-'));
  const paths = resolveAppPaths({ dataDir, webDistDir: options.webDistDir ?? null });
  ensureAppDirectories(paths);
  const db = new Database(':memory:');
  const settings = new SettingsStore(db);
  const hub = new EventHub();
  const activity = new ActivityLog(db, hub, 'app_session_test');
  const approvals = new ApprovalBroker(db, hub, activity);
  const secrets = new MemorySecretStore();
  const screenshots = new ScreenshotStore(db, paths, settings);
  const fakes = createFakes();
  const live = options.live
    ? options.live({ device: fakes.device, settings, hub })
    : new LiveCapture({ device: fakes.device, settings, hub, log: silentLogger, helper: null, unavailableReason: 'test harness' });
  const ctx: AppContext = {
    version: '0.1.0-test',
    sessionId: 'app_session_test',
    paths,
    log: silentLogger,
    db,
    hub,
    settings,
    secrets,
    activity,
    mirroir: fakes.mirroir as unknown as MirroirManager,
    device: fakes.device as unknown as DeviceController,
    stream: fakes.stream as unknown as ScreenStream,
    live,
    approvals,
    screenshots,
    agents: fakes.agents as unknown as AgentServiceApi,
    workflows: fakes.workflows as unknown as WorkflowServiceApi,
  };
  const auth = new AuthService(ctx);
  auth.startup();
  const local = createHttpServer(ctx, {
    host: '127.0.0.1',
    port: LOCAL_PORT,
    desktopToken: DESKTOP_TOKEN,
    listener: 'local',
    auth,
  });
  const extra: HttpServerHandle[] = [];
  return {
    ctx,
    fakes,
    auth,
    secrets,
    local,
    dataDir,
    remoteServer() {
      const server = createHttpServer(ctx, {
        host: REMOTE_ADDRESS,
        port: REMOTE_PORT,
        desktopToken: null,
        listener: 'remote',
        auth,
      });
      extra.push(server);
      return server;
    },
    async setPasscode(passcode = PASSCODE) {
      await secrets.set(REMOTE_PASSCODE_ACCOUNT, await hashPasscode(passcode));
      settings.mutate((draft) => {
        draft.remote.passcodeSet = true;
      });
    },
    async close() {
      await live.shutdown();
      for (const server of extra) await server.close();
      await local.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Extracts "iai_session=<token>" from a Set-Cookie header. */
export function sessionCookieFrom(setCookie: string | string[] | undefined): string | null {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const first = value.split(';')[0] ?? '';
    if (first.startsWith(`${SESSION_COOKIE}=`) && first.length > SESSION_COOKIE.length + 1) return first;
  }
  return null;
}

/** Headers a same-origin browser request on the local listener carries. */
export function localHeaders(cookie: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: LOCAL_HOST,
    origin: LOCAL_ORIGIN,
    [CSRF_HEADER]: '1',
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

export function remoteHeaders(cookie: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: REMOTE_HOST,
    origin: `http://${REMOTE_HOST}`,
    [CSRF_HEADER]: '1',
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

/**
 * Sends one raw HTTP/1.1 request over a real socket and resolves with the
 * status code. inject() normalises request targets, so absolute-form targets
 * ("GET http://host/path HTTP/1.1") can only be tested this way.
 */
export function rawHttpStatus(port: number, requestTarget: string, host: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match) {
        resolve(Number(match[1]));
        socket.destroy();
      }
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error(`no HTTP response: ${JSON.stringify(data.slice(0, 200))}`)));
    const extra = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);
  });
}

export async function loginDesktop(h: Harness): Promise<string> {
  const res = await h.local.app.inject({
    method: 'GET',
    url: `/auth/desktop?token=${encodeURIComponent(DESKTOP_TOKEN)}`,
    headers: { host: LOCAL_HOST },
  });
  const cookie = sessionCookieFrom(res.headers['set-cookie']);
  if (res.statusCode !== 302 || !cookie) throw new Error(`desktop login failed: ${res.statusCode} ${res.body}`);
  return cookie;
}

export async function loginRemote(h: Harness, remote: HttpServerHandle, passcode = PASSCODE, deviceName = 'Test iPad'): Promise<string> {
  const res = await remote.app.inject({
    method: 'POST',
    url: '/api/auth/remote-login',
    headers: remoteHeaders(null),
    payload: { passcode, deviceName },
  });
  const cookie = sessionCookieFrom(res.headers['set-cookie']);
  if (res.statusCode !== 200 || !cookie) throw new Error(`remote login failed: ${res.statusCode} ${res.body}`);
  return cookie;
}
