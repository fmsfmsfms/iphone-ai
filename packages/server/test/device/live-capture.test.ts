// LiveCapture: the ScreenCaptureKit helper protocol parser and the helper
// lifecycle, driven by a FAKE helper (test/live-capture/fake-capture-helper.mjs)
// that speaks the exact framed protocol. No ScreenCaptureKit, no window, no phone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { LIVE_CONFLICT_ERROR, type DeviceStatus, type MirroringState, type PolicyDecision } from '@iphone-ai/shared';

import { EventHub } from '../../src/core/events.js';
import { silentLogger, type Logger } from '../../src/core/logger.js';
import {
  decodeLiveFrameMessage,
  HelperProtocolError,
  HelperStreamParser,
  LIVE_CONFLICT_REASON,
  LiveCapture,
  LiveFrame,
  MIRRORING_BUNDLE_ID,
  resolveCaptureHelper,
  type LiveCaptureTimings,
} from '../../src/device/live-capture.js';
import { makeGeometry } from '../../src/mcp/parsers.js';
import { createCoreContext, createDeviceContext, makeTempDir, sleep, waitFor, type CoreContext, type DeviceContext } from '../helpers/context.js';
import {
  encodeHelperFrame,
  encodeHelperStatus,
  FakeLiveDevice,
  fakeHelper,
  fakeJpeg,
  type FakeHelper,
  type FakeHelperLogEntry,
  type FakeScenario,
} from '../live-capture/helpers.js';

const SCRIPTED_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../live-capture/scripted-capture-helper.mjs');

/**
 * FakeLiveDevice whose status reads as freshly polled (`checkedAt` is now),
 * unless a test holds the last reading back (a status poll waiting behind a
 * slow Mirroir action).
 */
class PolledLiveDevice extends FakeLiveDevice {
  heldReadingAt: number | null = null;

  override getStatus(): DeviceStatus {
    const status = super.getStatus();
    return { ...status, mirroring: { ...status.mirroring, checkedAt: this.heldReadingAt ?? Date.now() } };
  }
}

interface ScriptStep {
  atMs: number;
  event: 'started' | 'window' | 'waiting';
  [field: string]: unknown;
}

/** A fake helper that also sends scripted STATUS events (test/live-capture/scripted-capture-helper.mjs). */
function scriptedHelper(dir: string, script: ScriptStep[]): FakeHelper {
  const scenarioFile = path.join(dir, `scripted-helper-${Math.random().toString(36).slice(2)}.json`);
  const logFile = `${scenarioFile}.log.jsonl`;
  writeFileSync(scenarioFile, JSON.stringify({ script }));
  const log = (): FakeHelperLogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as FakeHelperLogEntry)
      : [];
  return {
    command: { command: process.execPath, args: [SCRIPTED_HELPER, '--scenario', scenarioFile, '--log', logFile] },
    setScenario(next) {
      writeFileSync(scenarioFile, JSON.stringify(next));
    },
    log,
    starts: () => log().filter((e) => e.event === 'start'),
    stdinLines: () => log().filter((e) => e.event === 'stdin').map((e) => e.line ?? ''),
  };
}

describe('HelperStreamParser', () => {
  const status = encodeHelperStatus({ event: 'started', ptW: 410, ptH: 898, pxW: 730, pxH: 1600 });
  const frame1 = encodeHelperFrame({ seq: 1, ts: 1_700_000_000_000, ptW: 410, ptH: 898, pxW: 730, pxH: 1600 }, fakeJpeg(1, 40));
  const frame2 = encodeHelperFrame({ seq: 2, ts: 1_700_000_000_033, ptW: 410, ptH: 898, pxW: 730, pxH: 1600 }, fakeJpeg(2, 900));
  const stream = Buffer.concat([status, frame1, frame2]);

  it('decodes STATUS and FRAME messages', () => {
    const messages = new HelperStreamParser().push(stream);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ type: 'status', status: { event: 'started', ptW: 410, ptH: 898, pxW: 730, pxH: 1600 } });
    expect(messages[1]).toMatchObject({ type: 'frame', header: { seq: 1, ts: 1_700_000_000_000, ptW: 410, ptH: 898, pxW: 730, pxH: 1600 } });
    expect((messages[1] as { jpeg: Buffer }).jpeg.equals(fakeJpeg(1, 40))).toBe(true);
    expect((messages[2] as { jpeg: Buffer }).jpeg.equals(fakeJpeg(2, 900))).toBe(true);
  });

  it('handles messages split at every byte boundary and joined in one chunk', () => {
    const parser = new HelperStreamParser();
    const out = [];
    for (let i = 0; i < stream.length; i += 1) out.push(...parser.push(stream.subarray(i, i + 1)));
    expect(out.map((m) => m.type)).toEqual(['status', 'frame', 'frame']);
    expect(parser.pendingBytes).toBe(0);

    // Uneven chunks that straddle the length prefix and the frame header.
    const parser2 = new HelperStreamParser();
    const sizes = [3, 2, 7, 1, 50, 13, 400, 10_000];
    const out2 = [];
    let offset = 0;
    for (const size of sizes) {
      out2.push(...parser2.push(stream.subarray(offset, offset + size)));
      offset += size;
    }
    expect(out2.map((m) => m.type)).toEqual(['status', 'frame', 'frame']);
  });

  it('ignores unknown message types (forward compatible)', () => {
    const unknown = Buffer.from([0, 0, 0, 3, 0x7f, 1, 2]);
    expect(new HelperStreamParser().push(Buffer.concat([unknown, status]))).toEqual([
      { type: 'unknown', code: 0x7f },
      { type: 'status', status: { event: 'started', ptW: 410, ptH: 898, pxW: 730, pxH: 1600 } },
    ]);
  });

  it('rejects corrupt input', () => {
    const huge = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x02]);
    expect(() => new HelperStreamParser().push(huge)).toThrow(HelperProtocolError);
    expect(() => new HelperStreamParser().push(Buffer.from([0, 0, 0, 0]))).toThrow(HelperProtocolError);
    const badStatus = Buffer.concat([Buffer.from([0, 0, 0, 4, 0x01]), Buffer.from('{x}')]);
    expect(() => new HelperStreamParser().push(badStatus)).toThrow(HelperProtocolError);
    const noEvent = encodeHelperStatus({ event: 'nope' as 'started' });
    expect(() => new HelperStreamParser().push(noEvent)).toThrow(HelperProtocolError);
    const missingSize = encodeHelperFrame({ seq: 1, ts: 1, ptW: 0, ptH: 898, pxW: 730, pxH: 1600 }, fakeJpeg(1));
    expect(() => new HelperStreamParser().push(missingSize)).toThrow(HelperProtocolError);
    const emptyJpeg = encodeHelperFrame({ seq: 1, ts: 1, ptW: 410, ptH: 898, pxW: 730, pxH: 1600 }, Buffer.alloc(0));
    expect(() => new HelperStreamParser().push(emptyJpeg)).toThrow(HelperProtocolError);
  });

  it('round-trips the /ws/screen message format', () => {
    const header = {
      seq: 9,
      capturedAt: 1000,
      latencyMs: 12,
      widthPx: 730,
      heightPx: 1600,
      mimeType: 'image/jpeg' as const,
      pxPerPt: 1.7805,
      geometry: null,
      source: 'screencapturekit' as const,
      receivedAt: 1012,
    };
    const frame = new LiveFrame(header, fakeJpeg(9), { width: 410, height: 898 });
    const decoded = decodeLiveFrameMessage(frame.message());
    expect(decoded.header).toEqual(header);
    expect(decoded.jpeg.equals(fakeJpeg(9))).toBe(true);
    // Encoded once, shared by every viewer.
    expect(frame.message()).toBe(frame.message());
  });
});

describe('resolveCaptureHelper', () => {
  it('prefers IPHONE_AI_CAPTURE_BIN and reports a missing file honestly', () => {
    const dir = makeTempDir();
    const bin = path.join(dir, 'iphone-ai-capture');
    writeFileSync(bin, '');
    expect(resolveCaptureHelper({ env: { IPHONE_AI_CAPTURE_BIN: bin }, platform: 'darwin' })).toEqual({
      helper: { command: bin, args: [] },
      reason: null,
    });
    const missing = resolveCaptureHelper({ env: { IPHONE_AI_CAPTURE_BIN: path.join(dir, 'nope') }, platform: 'darwin' });
    expect(missing.helper).toBeNull();
    expect(missing.reason).toMatch(/IPHONE_AI_CAPTURE_BIN was not found/);
  });

  it('falls back to the Tauri sidecar build in development, never in mock mode or off macOS', () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, 'src-tauri', 'binaries'), { recursive: true });
    const sidecar = path.join(root, 'src-tauri', 'binaries', 'iphone-ai-capture-aarch64-apple-darwin');
    writeFileSync(sidecar, '');
    expect(resolveCaptureHelper({ env: {}, platform: 'darwin', arch: 'arm64', repoRoot: root }).helper).toEqual({ command: sidecar, args: [] });
    expect(resolveCaptureHelper({ env: {}, platform: 'darwin', arch: 'x64', repoRoot: root })).toEqual({
      helper: null,
      reason: 'the iphone-ai-capture helper is not installed',
    });
    expect(resolveCaptureHelper({ env: {}, platform: 'darwin', arch: 'arm64', repoRoot: root, mock: true }).reason).toMatch(/mock Mirroir mode/);
    expect(resolveCaptureHelper({ env: {}, platform: 'linux', arch: 'arm64', repoRoot: root }).reason).toMatch(/needs macOS/);
  });
});

// ───────────────────────────── lifecycle ─────────────────────────────

const FAST: Partial<LiveCaptureTimings> = {
  stopDelayMs: 300,
  liveWindowMs: 400,
  stallMs: 600,
  startupTimeoutMs: 2000,
  retryBaseMs: 100,
  retryMaxMs: 400,
  permissionRetryMs: 800,
  tickMs: 50,
  killGraceMs: 300,
};

let core: CoreContext | null = null;
let deviceCtx: DeviceContext | null = null;
let live: LiveCapture | null = null;

afterEach(async () => {
  await live?.shutdown();
  live = null;
  await core?.cleanup();
  core = null;
  await deviceCtx?.cleanup();
  deviceCtx = null;
});

function recordingLogger(): { log: Logger; lines: { level: string; msg: string; data?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const log: Logger = {
    debug: (msg, data) => lines.push({ level: 'debug', msg, data }),
    info: (msg, data) => lines.push({ level: 'info', msg, data }),
    warn: (msg, data) => lines.push({ level: 'warn', msg, data }),
    error: (msg, data) => lines.push({ level: 'error', msg, data }),
    child: () => log,
    setLevel: () => undefined,
  };
  return { log, lines };
}

interface Setup {
  c: CoreContext;
  device: PolledLiveDevice;
  helper: FakeHelper;
  live: LiveCapture;
  hub: EventHub;
  viewers: { count: number };
  frames: { seq: number; geometry: unknown }[];
}

function setup(
  scenario: FakeScenario = {},
  options: { timings?: Partial<LiveCaptureTimings>; liveFps?: number; log?: Logger; script?: ScriptStep[] } = {},
): Setup {
  core = createCoreContext();
  if (options.liveFps) {
    core.settings.update({ connection: { screenshot: { ...core.settings.get().connection.screenshot, liveFps: options.liveFps } } });
  }
  const device = new PolledLiveDevice();
  const helper = options.script ? scriptedHelper(core.dir, options.script) : fakeHelper(core.dir, scenario);
  const hub = core.hub;
  live = new LiveCapture({ device, settings: core.settings, hub, log: options.log ?? silentLogger, helper: helper.command, timings: { ...FAST, ...options.timings } });
  const viewers = { count: 0 };
  live.setViewerSource(() => viewers.count);
  const frames: Setup['frames'] = [];
  live.on('frame', (frame: LiveFrame) => frames.push({ seq: frame.meta.seq, geometry: frame.meta.geometry }));
  live.start();
  return { c: core, device, helper, live, hub, viewers, frames };
}

function show(s: Setup, count = 1): void {
  s.viewers.count = count;
  s.live.evaluate();
}

describe('LiveCapture lifecycle (fake helper)', () => {
  it('starts the helper only when a viewer is visible, with the documented CLI flags, and relays frames', async () => {
    // Asking for more than the 15 fps snapshot limit (an older client may still send up to 60) gets 15.
    const s = setup({}, { liveFps: 60 });
    await sleep(300);
    expect(s.helper.starts()).toHaveLength(0);
    expect(s.live.stats()).toMatchObject({ available: true, running: false, delivering: false, error: null });

    show(s);
    await waitFor(() => s.frames.length >= 12, { message: 'no live frames' });
    const argv = s.helper.starts()[0]!.argv!;
    expect(argv.slice(argv.indexOf('--bundle-id'))).toEqual([
      '--bundle-id',
      MIRRORING_BUNDLE_ID,
      '--fps',
      '15',
      '--max-long-edge',
      '1600',
      '--quality',
      '0.7',
    ]);

    const latest = s.live.latest()!;
    expect(latest.meta).toMatchObject({
      widthPx: 730,
      heightPx: 1600,
      mimeType: 'image/jpeg',
      source: 'screencapturekit',
      pxPerPt: 1.7805,
    });
    expect(latest.meta.receivedAt).toBeGreaterThanOrEqual(latest.meta.capturedAt);
    expect(latest.meta.latencyMs).toBe(latest.meta.receivedAt - latest.meta.capturedAt);
    expect(latest.windowPt).toEqual({ width: 410, height: 898 });
    // Sequence numbers come from the device's shared frame counter.
    expect(s.frames.map((f) => f.seq)).toEqual(s.frames.map((_, i) => i + 1));
    expect(s.live.isDelivering()).toBe(true);
    const stats = s.live.stats();
    expect(stats).toMatchObject({ available: true, running: true, delivering: true, phase: 'capturing', targetFps: 15, error: null });
    expect(stats.measuredFps).toBeGreaterThan(5);
  });

  it('attaches geometry only when the captured window size matches the Mirroir status geometry', async () => {
    const s = setup();
    show(s);
    await waitFor(() => s.frames.length >= 2);
    expect(s.live.latest()!.meta.geometry).toEqual(s.device.geometry);
    expect(s.live.latest()!.meta.geometry?.geometryId).toBe('410x898');

    s.device.geometry = makeGeometry(868, 440, 'landscape');
    const before = s.frames.length;
    await waitFor(() => s.frames.length >= before + 2);
    expect(s.frames.slice(before + 1).every((f) => f.geometry === null)).toBe(true);

    s.device.geometry = null;
    const before2 = s.frames.length;
    await waitFor(() => s.frames.length >= before2 + 2);
    expect(s.live.latest()!.meta.geometry).toBeNull();
  });

  it('runs while an AI task or workflow holds control even without a viewer', async () => {
    const s = setup();
    s.device.controlOwner = 'ai';
    s.live.evaluate();
    await waitFor(() => s.frames.length >= 2, { message: 'did not capture while the AI held control' });
  });

  it('runs while Mirroring is paused (ScreenCaptureKit has no side effects) but not without the window or permission', async () => {
    const s = setup();
    s.device.mirroringState = 'paused';
    show(s);
    await waitFor(() => s.frames.length >= 2, { message: 'did not capture while paused' });

    await s.live.shutdown();
    await s.c.cleanup();
    const t = setup();
    t.device.mirroringState = 'not_running';
    show(t);
    t.device.screenRecording = 'granted';
    await sleep(400);
    expect(t.helper.starts()).toHaveLength(0);
    t.device.mirroringState = 'connected';
    t.device.screenRecording = 'denied';
    t.live.evaluate();
    await sleep(400);
    expect(t.helper.starts()).toHaveLength(0);
    t.device.screenRecording = 'granted';
    t.live.evaluate();
    await waitFor(() => t.frames.length >= 1);
  });

  it('re-evaluates on device status events from the hub', async () => {
    const s = setup();
    s.viewers.count = 1;
    s.device.mirroringState = 'not_running';
    s.live.evaluate();
    await sleep(200);
    expect(s.helper.starts()).toHaveLength(0);
    s.device.mirroringState = 'connected';
    s.hub.publish({ type: 'status', status: s.device.getStatus() });
    await waitFor(() => s.frames.length >= 1, { message: 'a status event did not start capture' });
  });

  it('stops the helper (stop command + EOF) after the grace period once nobody needs it', async () => {
    const s = setup();
    show(s);
    await waitFor(() => s.frames.length >= 2);
    show(s, 0);
    await sleep(150);
    // Still inside the 300 ms grace period.
    expect(s.live.stats().running).toBe(true);
    await waitFor(() => !s.live.stats().running, { message: 'helper not stopped after the grace period' });
    expect(s.helper.stdinLines()).toContain('{"cmd":"stop"}');
    expect(s.helper.log().some((e) => e.event === 'exit' && e.code === 0)).toBe(true);
    expect(s.live.isDelivering()).toBe(false);

    // A viewer coming back inside the grace period keeps the same helper.
    show(s);
    await waitFor(() => s.helper.starts().length === 2);
    show(s, 0);
    await sleep(100);
    show(s);
    await sleep(500);
    expect(s.helper.starts()).toHaveLength(2);
    expect(s.live.stats().running).toBe(true);
  });

  it('stops immediately when live capture is turned off in Settings, and restarts when turned on', async () => {
    const s = setup();
    show(s);
    await waitFor(() => s.frames.length >= 2);
    const screenshot = s.c.settings.get().connection.screenshot;
    s.c.settings.update({ connection: { screenshot: { ...screenshot, liveCapture: false } } });
    await waitFor(() => !s.live.stats().running, { timeoutMs: 1000, message: 'not stopped when switched off' });
    expect(s.live.stats()).toMatchObject({ available: false, delivering: false, error: null });
    s.c.settings.update({ connection: { screenshot: { ...screenshot, liveCapture: true } } });
    await waitFor(() => s.helper.starts().length === 2);
  });

  it('sends a config command when the live frame rate changes', async () => {
    const s = setup();
    show(s);
    await waitFor(() => s.frames.length >= 1);
    const screenshot = s.c.settings.get().connection.screenshot;
    s.c.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 12 } } });
    await waitFor(() => s.helper.stdinLines().length > 0);
    expect(JSON.parse(s.helper.stdinLines()[0]!)).toEqual({ cmd: 'config', fps: 12, maxLongEdge: 1600, quality: 0.7 });
    expect(s.live.stats().targetFps).toBe(12);
  });

  it('restarts a crashed helper with backoff and reports the error while it is down', async () => {
    const s = setup({ crashAfterFrames: 3 });
    show(s);
    await waitFor(() => s.helper.log().some((e) => e.event === 'crash'));
    await waitFor(() => !s.live.stats().running);
    expect(s.live.isDelivering()).toBe(false);
    expect(s.live.stats().error).toMatch(/exited unexpectedly \(code 1\)/);
    s.helper.setScenario({});
    await waitFor(() => s.helper.starts().length >= 2, { message: 'not restarted' });
    await waitFor(() => s.live.isDelivering(), { message: 'no frames after the restart' });
    expect(s.live.stats().error).toBeNull();
  });

  it('backs off exponentially while the helper keeps crashing', async () => {
    const s = setup({ crashAfterFrames: 1 }, { timings: { retryBaseMs: 200, retryMaxMs: 5000 } });
    show(s);
    await waitFor(() => s.helper.starts().length >= 4, { timeoutMs: 10000 });
    const starts = s.helper.starts().map((e) => e.t);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    // 200, 400, 800 ms (+ process start-up) — each wait clearly longer than the one before it.
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! + 100);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! + 200);
  });

  it('reports missing Screen Recording permission (exit 2) and retries after the permission delay', async () => {
    const s = setup({ mode: 'permission' });
    show(s);
    await waitFor(() => s.helper.log().some((e) => e.event === 'exit' && e.code === 2));
    await waitFor(() => /Screen Recording permission was denied/.test(s.live.stats().error ?? ''));
    expect(s.live.stats()).toMatchObject({ available: true, delivering: false });
    await sleep(300);
    expect(s.helper.starts()).toHaveLength(1);
    s.helper.setScenario({});
    await waitFor(() => s.live.isDelivering(), { timeoutMs: 5000, message: 'not retried after the permission delay' });
  });

  it('restarts a helper that reports "started" but delivers no frame within the stall time', async () => {
    const s = setup({ mode: 'silent' });
    show(s);
    await waitFor(() => s.helper.starts().length >= 2, { timeoutMs: 5000, message: 'stalled helper not restarted' });
    // The first one was told to stop (stop command, EOF and SIGTERM at once) and exited.
    const firstPid = s.helper.starts()[0]!.pid;
    expect(s.helper.log().some((e) => e.pid === firstPid && e.event === 'exit')).toBe(true);
    expect(s.live.stats().error).toMatch(/no frame within/);
  });

  it('restarts a helper that sends malformed data', async () => {
    const s = setup({ mode: 'garbage' });
    show(s);
    await waitFor(() => s.helper.starts().length >= 2, { timeoutMs: 5000 });
    expect(s.live.stats().error).toMatch(/malformed data/);
  });

  it('keeps a silent but healthy helper on an unchanging screen, restarts it when polled screenshots show changes', async () => {
    const s = setup({ frames: 3 });
    show(s);
    await waitFor(() => s.frames.length === 3);
    await waitFor(() => !s.live.isDelivering(), { timeoutMs: 3000 });
    await sleep(700);
    // Unchanging screen: polled screenshots are identical → no restart.
    const now = Date.now();
    const png = Buffer.from('same pixels');
    s.live.notePolledFrame({ meta: { capturedAt: now - 10, latencyMs: 5 }, data: png });
    s.live.notePolledFrame({ meta: { capturedAt: now, latencyMs: 5 }, data: Buffer.from(png) });
    await sleep(300);
    expect(s.helper.starts()).toHaveLength(1);
    expect(s.live.stats().running).toBe(true);

    // The screen changes but the stream stays silent → stuck → restarted.
    s.live.notePolledFrame({ meta: { capturedAt: Date.now(), latencyMs: 5 }, data: Buffer.from('new pixels') });
    await waitFor(() => s.helper.starts().length === 2, { timeoutMs: 3000, message: 'stuck stream not restarted' });
  });

  it('does not treat a polled screenshot taken before the last live frame as a stuck stream', async () => {
    const s = setup({ frames: 2 });
    show(s);
    await waitFor(() => s.frames.length === 2);
    const lastLive = s.live.stats().lastFrameAt!;
    s.live.notePolledFrame({ meta: { capturedAt: lastLive - 50, latencyMs: 5 }, data: Buffer.from('a') });
    await sleep(700);
    s.live.notePolledFrame({ meta: { capturedAt: Date.now(), latencyMs: 5 }, data: Buffer.from('b') });
    await sleep(300);
    expect(s.helper.starts()).toHaveLength(1);
  });

  it('reports "waiting" from the helper without restarting it', async () => {
    const s = setup({ mode: 'waiting' });
    show(s);
    await waitFor(() => s.live.stats().phase === 'waiting');
    await sleep(800);
    expect(s.helper.starts()).toHaveLength(1);
    expect(s.live.stats().error).toMatch(/Waiting for the iPhone Mirroring window/);
  });

  it('is unavailable without a helper and never spawns anything', async () => {
    core = createCoreContext();
    const device = new FakeLiveDevice();
    live = new LiveCapture({ device, settings: core.settings, hub: core.hub, log: silentLogger, helper: null, unavailableReason: 'the iphone-ai-capture helper is not installed' });
    live.setViewerSource(() => 1);
    live.start();
    await sleep(100);
    expect(live.stats()).toMatchObject({
      available: false,
      running: false,
      delivering: false,
      error: 'Live capture unavailable: the iphone-ai-capture helper is not installed.',
    });
    expect(live.latest()).toBeNull();
  });

  it('logs the lines the backend log is checked for (started, periodic stats, unavailable)', async () => {
    const { log: recording, lines } = recordingLogger();
    core = createCoreContext();
    const device = new FakeLiveDevice();
    const helper = fakeHelper(core.dir, { crashAfterFrames: 15 });
    live = new LiveCapture({
      device,
      settings: core.settings,
      hub: core.hub,
      log: recording,
      helper: helper.command,
      timings: { ...FAST, statsIntervalMs: 400, retryBaseMs: 5000 },
    });
    live.setViewerSource(() => 1);
    live.start();
    await waitFor(() => lines.some((l) => l.msg.startsWith('Live capture stats:')), { message: 'no stats line' });
    const info = lines.filter((l) => l.level === 'info').map((l) => l.msg);
    expect(info).toContain('Live capture started (ScreenCaptureKit, 730x1600 px, 10 fps)');
    expect(info.find((m) => m.startsWith('Live capture stats:'))).toMatch(/^Live capture stats: fps=\d+(\.\d)?, avgLatencyMs=\d+, frames=\d+$/);
    await waitFor(() => helper.log().some((e) => e.event === 'crash'));
    await waitFor(() => lines.some((l) => l.level === 'info' && l.msg.startsWith('Live capture unavailable: the live capture helper exited unexpectedly (code 1)')));

    await live.shutdown();
    lines.length = 0;
    live = new LiveCapture({ device, settings: core.settings, hub: core.hub, log: recording, helper: null, unavailableReason: 'the iphone-ai-capture helper is not installed' });
    live.start();
    expect(lines).toContainEqual({ level: 'info', msg: 'Live capture unavailable: the iphone-ai-capture helper is not installed', data: undefined });
  });

  it('kills the helper on shutdown', async () => {
    const s = setup();
    show(s);
    await waitFor(() => s.frames.length >= 1);
    const pid = s.helper.starts()[0]!.pid;
    await s.live.shutdown();
    expect(s.live.stats().running).toBe(false);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { message: 'helper process still alive after shutdown' });
  });
});

// ───────────────────────────── capture conflict latch ─────────────────────────────

describe('LiveCapture conflict safety latch (fake helper, fake Mirroir status)', () => {
  const PROBE: Partial<LiveCaptureTimings> = { conflictProbeMs: 1200 };
  /** A short conflict window, so a test can get past it quickly. */
  const WINDOW_MS = 400;
  const WINDOW: Partial<LiveCaptureTimings> = { ...PROBE, conflictWindowMs: WINDOW_MS };

  /** A status poll result, delivered the way DeviceController publishes it. */
  function setMirroring(s: Setup, state: MirroringState): void {
    s.device.mirroringState = state;
    s.hub.publish({ type: 'status', status: s.device.getStatus() });
  }

  async function capturing(s: Setup): Promise<void> {
    show(s);
    await waitFor(() => s.live.isDelivering(), { message: 'no live frames' });
  }

  /** The current helper must be capturing (frames from the previous one can still count as delivering). */
  async function helperCapturing(s: Setup): Promise<void> {
    await waitFor(() => s.live.stats().phase === 'capturing', { message: 'helper not capturing' });
  }

  /** connected → paused while the current helper captures → helper stopped → connected again right after. */
  async function strike(s: Setup): Promise<void> {
    await helperCapturing(s);
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'helper not stopped for the conflict probe' });
    setMirroring(s, 'connected');
  }

  /** A first strike: capture is only a suspect, nothing is latched and the helper is restarted at once. */
  async function firstStrike(s: Setup): Promise<void> {
    await helperCapturing(s);
    const starts = s.helper.starts().length;
    await strike(s);
    await waitFor(() => s.helper.starts().length === starts + 1 && s.live.stats().phase === 'capturing', {
      message: 'helper not restarted to confirm the conflict',
    });
    expect(s.live.conflictLatched).toBe(false);
  }

  /** A first strike, then the same in the restarted helper session: latched off. */
  async function latch(s: Setup): Promise<void> {
    await firstStrike(s);
    const starts = s.helper.starts().length;
    await strike(s);
    await waitFor(() => s.live.conflictLatched, { message: 'conflict not latched' });
    expect(s.helper.starts()).toHaveLength(starts);
  }

  it('stops the helper on a pause right after capture started, restarts it once when Mirroir reports connected right after, and latches it off when that repeats', async () => {
    const { log, lines } = recordingLogger();
    const s = setup({}, { timings: PROBE, log });
    await capturing(s);

    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { timeoutMs: 2000, message: 'helper not stopped for the conflict probe' });
    // Stopped with the stop command + EOF, and not restarted while the probe runs
    // (longer than stopDelayMs and retryMaxMs).
    expect(s.helper.stdinLines()).toContain('{"cmd":"stop"}');
    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', msg: 'Live capture stopped', data: expect.objectContaining({ reason: 'conflict-probe' }) }));
    await sleep(500);
    expect(s.helper.starts()).toHaveLength(1);
    expect(s.live.conflictLatched).toBe(false);
    expect(s.device.activity).toEqual([]);

    // First strike: a pause under the pointer (iPhone Mirroring's toolbar) can end
    // the same way, so capture is only a suspect and runs again at once.
    setMirroring(s, 'connected');
    await waitFor(() => s.helper.starts().length === 2 && s.live.stats().phase === 'capturing', { message: 'helper not restarted to confirm the conflict' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.live.stats()).toMatchObject({ available: true, running: true });
    expect(s.device.activity).toEqual([]);
    expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', msg: expect.stringContaining('restarting live capture once to confirm') }));

    // The same in the restarted helper session: capture caused it.
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'restarted helper not stopped for the conflict probe' });
    setMirroring(s, 'connected');
    await waitFor(() => s.live.conflictLatched, { message: 'conflict not latched' });
    expect(s.live.stats()).toMatchObject({ available: false, running: false, delivering: false, error: LIVE_CONFLICT_ERROR });
    expect(s.device.activity).toEqual([expect.objectContaining({ type: 'live.conflict', severity: 'warning' })]);
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.msg)).toEqual([
      `Live capture turned off for this session: ${LIVE_CONFLICT_REASON} (polling screenshots instead)`,
    ]);
    expect(s.helper.starts()).toHaveLength(2);

    // Stays off for the session: an AI task, status events and later pauses do not restart it.
    s.device.controlOwner = 'ai';
    setMirroring(s, 'paused');
    setMirroring(s, 'connected');
    s.live.evaluate();
    await sleep(PROBE.conflictProbeMs! + 300);
    expect(s.helper.starts()).toHaveLength(2);
    expect(s.device.activity).toHaveLength(1);
    expect(s.live.stats().error).toBe(LIVE_CONFLICT_ERROR);
  });

  it('latches a pause that comes back every time capture starts after one confirming restart (simulated capture-induced overlay)', async () => {
    const s = setup({}, { timings: PROBE });
    // iPhone Mirroring adds its overlay ~150 ms into every capture while connected
    // (Mirroir reads it as paused) and drops it once capture stops.
    let capturingAt: number | null = null;
    const overlay = setInterval(() => {
      const stats = s.live.stats();
      const capturingNow = stats.running && stats.phase === 'capturing';
      if (capturingNow && s.device.mirroringState === 'connected') {
        capturingAt ??= Date.now();
        if (Date.now() - capturingAt >= 150) setMirroring(s, 'paused');
      } else if (!stats.running && s.device.mirroringState === 'paused') {
        capturingAt = null;
        setMirroring(s, 'connected');
      } else if (!capturingNow) capturingAt = null;
    }, 20);
    try {
      show(s);
      await waitFor(() => s.live.conflictLatched, { message: 'a reproducible conflict was not latched' });
      expect(s.helper.starts()).toHaveLength(2);
      expect(s.device.activity).toEqual([expect.objectContaining({ type: 'live.conflict' })]);
    } finally {
      clearInterval(overlay);
    }
  });

  it('treats a pause that outlives the probe window as genuine: no latch, the helper runs again', async () => {
    const s = setup({}, { timings: { conflictProbeMs: 400 } });
    await capturing(s);
    setMirroring(s, 'paused');
    await waitFor(() => s.helper.starts().length === 2, { timeoutMs: 5000, message: 'helper not restarted after a genuine pause' });
    // It waited for the probe window after the first helper exited.
    const firstPid = s.helper.starts()[0]!.pid;
    const exited = s.helper.log().find((e) => e.pid === firstPid && e.event === 'exit')!;
    expect(s.helper.starts()[1]!.t - exited.t).toBeGreaterThanOrEqual(350);
    await waitFor(() => s.live.isDelivering(), { message: 'no frames while genuinely paused' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.live.stats()).toMatchObject({ available: true, error: null });
    expect(s.device.activity).toEqual([]);

    // Resuming afterwards (paused → connected) is not a conflict either.
    setMirroring(s, 'connected');
    await sleep(300);
    expect(s.live.conflictLatched).toBe(false);
    expect(s.helper.starts()).toHaveLength(2);
  });

  it('does not latch when the user resumed iPhone Mirroring during the probe', async () => {
    const { log, lines } = recordingLogger();
    const s = setup({}, { timings: PROBE, log });
    await capturing(s);
    s.device.lastUserResumeAt = Date.now() - 60_000; // an earlier resume does not count
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'helper not stopped for the conflict probe' });
    // The viewer's Resume button: a capture with resume allowed made Mirroir press Resume.
    s.device.lastUserResumeAt = Date.now();
    setMirroring(s, 'connected');
    await waitFor(() => s.helper.starts().length === 2, { message: 'not restarted after the user resumed' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.device.activity).toEqual([]);
    expect(lines.filter((l) => l.level === 'warn')).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ level: 'info', msg: expect.stringContaining('resumed by the user') }));

    // Later pauses that clear without a user Resume still latch.
    await waitFor(() => s.live.isDelivering());
    await latch(s);
  });

  it('ends the probe without latching when iPhone Mirroring stops running', async () => {
    const s = setup({}, { timings: { conflictProbeMs: 5000 } });
    await capturing(s);
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running);
    setMirroring(s, 'not_running');
    setMirroring(s, 'connected');
    await waitFor(() => s.helper.starts().length === 2, { message: 'not restarted once Mirroring connected again' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.device.activity).toEqual([]);
  });

  it('does not probe a pause that starts well after capture started (iPhone Mirroring active under the pointer)', async () => {
    const s = setup({}, { timings: WINDOW });
    await capturing(s);
    await sleep(WINDOW_MS + 200);
    setMirroring(s, 'paused');
    await sleep(300);
    setMirroring(s, 'connected');
    await sleep(300);
    expect(s.helper.starts()).toHaveLength(1);
    expect(s.live.stats()).toMatchObject({ running: true, phase: 'capturing' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.device.activity).toEqual([]);
  });

  it('probes a pause about 100 ms after the first frame with the same short window', async () => {
    const s = setup({}, { timings: WINDOW });
    await capturing(s);
    await sleep(100);
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'a pause inside the window was not probed' });
    expect(s.live.conflictLatched).toBe(false);
  });

  it('probes a pause right after iPhone Mirroring was resumed, however long capture ran while it was paused', async () => {
    const s = setup({}, { timings: WINDOW });
    setMirroring(s, 'paused');
    await capturing(s);
    // The whole window passes while paused, when no connected → paused change can happen.
    await sleep(WINDOW_MS + 200);
    setMirroring(s, 'connected');
    await sleep(100);
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'a pause right after the resume was not probed' });
    // A toolbar pause right after the user clicked Resume ends the same way: only a first strike.
    setMirroring(s, 'connected');
    await waitFor(() => s.helper.starts().length === 2 && s.live.stats().phase === 'capturing', { message: 'helper not restarted to confirm the conflict' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.device.activity).toEqual([]);
  });

  it('measures the window up to the last reading that said connected, not to when a delayed status poll noticed the pause', async () => {
    const s = setup({}, { timings: WINDOW });
    await capturing(s);
    // The next status poll waits behind a slow Mirroir action (a swipe takes 2–4 s);
    // the pause began after this reading.
    s.device.heldReadingAt = Date.now();
    await sleep(WINDOW_MS + 200);
    s.device.heldReadingAt = null;
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'a pause that began inside the window was not probed' });
  });

  it('does not reopen the window on a resize ("window") later in the helper session', async () => {
    const { log, lines } = recordingLogger();
    const s = setup({}, { timings: WINDOW, log, script: [{ atMs: WINDOW_MS + 300, event: 'window', ptW: 410, ptH: 900, pxW: 730, pxH: 1604 }] });
    await capturing(s);
    await waitFor(() => lines.some((l) => l.msg === 'Live capture window is 410x900 pt'), { message: 'resize not reported' });
    setMirroring(s, 'paused');
    await sleep(300);
    expect(s.live.stats()).toMatchObject({ running: true, phase: 'capturing' });
    expect(s.helper.starts()).toHaveLength(1);
  });

  it('reopens the window when the helper restarts its capture (a new "started" without "waiting")', async () => {
    const { log, lines } = recordingLogger();
    const s = setup({}, { timings: WINDOW, log, script: [{ atMs: WINDOW_MS + 300, event: 'started', ptW: 410, ptH: 898, pxW: 730, pxH: 1600 }] });
    await capturing(s);
    await waitFor(() => lines.some((l) => l.msg === 'The live capture helper restarted its capture'), { message: 'capture restart not reported' });
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'a pause right after the helper restarted its capture was not probed' });
  });

  it('opens a new window for a helper restarted after a stall', async () => {
    const s = setup({ mode: 'silent' }, { timings: WINDOW });
    show(s);
    await waitFor(() => s.helper.starts().length === 1);
    s.helper.setScenario({});
    // The silent helper is restarted after stallMs, which is longer than the window.
    await waitFor(() => s.helper.starts().length === 2 && s.live.stats().phase === 'capturing', { timeoutMs: 5000, message: 'stalled helper not restarted' });
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'a pause right after the restart was not probed' });
  });

  it('treats a short pause right after a restart for a genuine pause as a first strike only (iPhone Mirroring toolbar)', async () => {
    const s = setup({}, { timings: { conflictProbeMs: 400, conflictWindowMs: WINDOW_MS } });
    await capturing(s);
    // The pointer rests on iPhone Mirroring right after the viewer opened: paused for longer than the probe.
    setMirroring(s, 'paused');
    await waitFor(() => s.helper.starts().length === 2 && s.live.stats().phase === 'capturing', { timeoutMs: 5000, message: 'not restarted after a genuine pause' });
    setMirroring(s, 'connected');
    await sleep(100);
    // Its toolbar again for a moment, inside the restarted helper's window.
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'the pause after the restart was not probed' });
    setMirroring(s, 'connected');
    await waitFor(() => s.helper.starts().length === 3 && s.live.stats().phase === 'capturing', { message: 'helper not restarted to confirm the conflict' });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.device.activity).toEqual([]);
  });

  it('forgets a first strike once a later helper session captured past its window with Mirroring connected', async () => {
    const { log, lines } = recordingLogger();
    // The restart must open its window within the window of the first strike: room for a slow process start.
    const s = setup({}, { timings: { ...PROBE, conflictWindowMs: 1500 }, log });
    await capturing(s);
    await firstStrike(s);
    await waitFor(() => lines.some((l) => l.msg.includes('the earlier pause was not caused by capture')), { message: 'first strike not forgotten' });

    // A new helper session (the viewer closed and opened again): one short pause
    // inside its window is a first strike again, not a latch.
    show(s, 0);
    await waitFor(() => !s.live.stats().running, { message: 'helper not stopped once nobody needed it' });
    show(s);
    await waitFor(() => s.helper.starts().length === 3 && s.live.stats().phase === 'capturing', { message: 'helper not started for the viewer' });
    await firstStrike(s);
    expect(s.helper.starts()).toHaveLength(4);
    expect(s.device.activity).toEqual([]);
  });

  it('forgets a first strike that no restarted helper session confirmed in time (the viewer closed during the check)', async () => {
    const { log, lines } = recordingLogger();
    const s = setup({}, { timings: WINDOW, log });
    await capturing(s);
    setMirroring(s, 'paused');
    await waitFor(() => !s.live.stats().running, { message: 'helper not stopped for the conflict probe' });
    // Nobody needs capture any more when Mirroir reports connected again: a first strike, but no restart.
    show(s, 0);
    setMirroring(s, 'connected');
    await waitFor(() => lines.some((l) => l.msg.includes('restarting live capture once to confirm')), { message: 'no first strike' });
    await waitFor(() => lines.some((l) => l.msg.includes('capture is no longer a suspect')), { message: 'unconfirmable first strike kept' });
    expect(s.helper.starts()).toHaveLength(1);

    // The viewer opens again later: one short pause inside the new window is a first strike again, not a latch.
    show(s);
    await waitFor(() => s.helper.starts().length === 2 && s.live.stats().phase === 'capturing', { message: 'helper not started for the viewer' });
    await firstStrike(s);
    expect(s.helper.starts()).toHaveLength(3);
    expect(s.device.activity).toEqual([]);
  });

  it('does not reopen the window when Mirroring connects again later in the capture run (repeated toolbar pauses, a Mirroir restart)', async () => {
    const { log, lines } = recordingLogger();
    const s = setup({}, { timings: WINDOW, log });
    await capturing(s);
    await sleep(WINDOW_MS + 200);
    // Mirroir restarts (status unknown for a moment), then the pointer moves over iPhone
    // Mirroring's toolbar: every pause begins right after Mirroring connected again.
    setMirroring(s, 'unknown');
    await sleep(100);
    for (const pausedMs of [150, 300, 200]) {
      setMirroring(s, 'connected');
      await sleep(100);
      setMirroring(s, 'paused');
      await sleep(pausedMs);
    }
    setMirroring(s, 'connected');
    await sleep(300);
    expect(lines.filter((l) => l.msg.startsWith('Mirroir reported iPhone Mirroring as paused while live capture was running'))).toEqual([]);
    expect(s.helper.starts()).toHaveLength(1);
    expect(s.live.stats()).toMatchObject({ running: true, phase: 'capturing' });
    expect(s.live.conflictLatched).toBe(false);
  });

  it('does not probe on a pause while the helper is not capturing', async () => {
    const s = setup({ mode: 'waiting' }, { timings: PROBE });
    show(s);
    await waitFor(() => s.live.stats().phase === 'waiting');
    setMirroring(s, 'paused');
    await sleep(300);
    expect(s.live.stats()).toMatchObject({ running: true, phase: 'waiting' });
    expect(s.helper.starts()).toHaveLength(1);
  });

  it('clears the latch, or a first strike, when live capture is switched off and on, or its frame rate changes', async () => {
    const s = setup({}, { timings: PROBE });
    await capturing(s);
    await latch(s);
    const starts = s.helper.starts().length;

    const screenshot = s.c.settings.get().connection.screenshot;
    s.c.settings.update({ connection: { screenshot: { ...screenshot, liveCapture: false } } });
    expect(s.live.conflictLatched).toBe(false);
    expect(s.live.stats()).toMatchObject({ available: false, error: null });
    s.c.settings.update({ connection: { screenshot: { ...screenshot, liveCapture: true } } });
    await waitFor(() => s.helper.starts().length === starts + 1, { message: 'not restarted after switching live capture back on' });
    await waitFor(() => s.live.isDelivering());
    expect(s.live.stats()).toMatchObject({ available: true, error: null });

    await latch(s);
    s.c.settings.update({ connection: { screenshot: { ...s.c.settings.get().connection.screenshot, liveFps: 12 } } });
    expect(s.live.conflictLatched).toBe(false);
    await waitFor(() => s.helper.starts().length === starts + 3, { message: 'not restarted after a frame rate change' });
    expect(s.helper.starts()[starts + 2]!.argv).toContain('12');

    // A first strike is forgotten too: after a frame rate change, the next one is a first strike again.
    await firstStrike(s);
    s.c.settings.update({ connection: { screenshot: { ...s.c.settings.get().connection.screenshot, liveFps: 8 } } });
    await firstStrike(s);
    expect(s.device.activity).toHaveLength(2);
  });

  it('latches from real DeviceController status polls, records a connection activity row and leaves input gates on Mirroir state', async () => {
    const d = await createDeviceContext({ settings: { permissions: { manualControlEnabled: true } } });
    deviceCtx = d;
    await d.device.refreshPermissions();
    await d.device.refreshStatus();
    const helper = fakeHelper(d.dir);
    const capture = new LiveCapture({ device: d.device, settings: d.settings, hub: d.hub, log: silentLogger, helper: helper.command, timings: { ...FAST, conflictProbeMs: 3000 } });
    live = capture;
    capture.setViewerSource(() => 1);
    capture.start();
    await waitFor(() => capture.isDelivering(), { message: 'no live frames' });

    // A first strike restarts the helper; the same in the restarted session latches.
    for (const helperStarts of [1, 2]) {
      await waitFor(() => helper.starts().length === helperStarts && capture.stats().phase === 'capturing', { message: 'helper not capturing' });
      expect(capture.conflictLatched).toBe(false);
      d.writeMockState({ mirroring: 'paused' });
      await d.device.refreshStatus();
      await waitFor(() => !capture.stats().running, { message: 'helper not stopped for the conflict probe' });
      d.writeMockState({ mirroring: 'connected' });
      await d.device.refreshStatus();
    }
    await waitFor(() => capture.conflictLatched, { message: 'conflict not latched' });

    const row = d.activity.query({ categories: ['connection'] }).find((e) => e.type === 'live.conflict');
    expect(row).toMatchObject({ category: 'connection', actor: 'system', severity: 'warning' });
    expect(capture.stats().error).toBe(LIVE_CONFLICT_ERROR);

    // The latch only stops capture: input is still refused while Mirroir reports paused.
    d.writeMockState({ mirroring: 'paused' });
    const allow: PolicyDecision = { verdict: 'allow', risk: 'low', reasons: [], rules: [] };
    await expect(d.device.perform({ kind: 'press_home' }, { actor: 'user', decision: allow })).rejects.toMatchObject({ code: 'paused' });
    expect(helper.starts()).toHaveLength(2);
  });

  it('does not latch when the user resumes through a capture with resume allowed (real DeviceController)', async () => {
    const d = await createDeviceContext({ mockState: { resumeDelayMs: 0 } });
    deviceCtx = d;
    await d.device.refreshPermissions();
    await d.device.refreshStatus();
    const helper = fakeHelper(d.dir);
    const capture = new LiveCapture({ device: d.device, settings: d.settings, hub: d.hub, log: silentLogger, helper: helper.command, timings: { ...FAST, conflictProbeMs: 3000 } });
    live = capture;
    capture.setViewerSource(() => 1);
    capture.start();
    await waitFor(() => capture.isDelivering(), { message: 'no live frames' });

    d.writeMockState({ mirroring: 'paused' });
    await d.device.refreshStatus();
    await waitFor(() => !capture.stats().running, { message: 'helper not stopped for the conflict probe' });
    expect(d.device.lastUserResumeAt).toBeNull();
    // The viewer's Resume button (POST /api/screen/capture {resume:true}).
    await d.device.captureFrame({ allowResume: true, reason: 'user-capture' });
    expect(d.device.lastUserResumeAt).not.toBeNull();
    d.writeMockState({ mirroring: 'connected' });
    await d.device.refreshStatus();
    await waitFor(() => helper.starts().length === 2, { message: 'not restarted after the user resumed' });
    expect(capture.conflictLatched).toBe(false);
    expect(d.activity.query({ categories: ['connection'] }).filter((e) => e.type === 'live.conflict')).toEqual([]);
  });
});
