// LiveCapture: the ScreenCaptureKit helper protocol parser and the helper
// lifecycle, driven by a FAKE helper (test/live-capture/fake-capture-helper.mjs)
// that speaks the exact framed protocol. No ScreenCaptureKit, no window, no phone.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EventHub } from '../../src/core/events.js';
import { silentLogger } from '../../src/core/logger.js';
import {
  decodeLiveFrameMessage,
  HelperProtocolError,
  HelperStreamParser,
  LiveCapture,
  LiveFrame,
  MIRRORING_BUNDLE_ID,
  resolveCaptureHelper,
  type LiveCaptureTimings,
} from '../../src/device/live-capture.js';
import { makeGeometry } from '../../src/mcp/parsers.js';
import { createCoreContext, makeTempDir, sleep, waitFor, type CoreContext } from '../helpers/context.js';
import {
  encodeHelperFrame,
  encodeHelperStatus,
  FakeLiveDevice,
  fakeHelper,
  fakeJpeg,
  type FakeHelper,
  type FakeScenario,
} from '../live-capture/helpers.js';

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
let live: LiveCapture | null = null;

afterEach(async () => {
  await live?.shutdown();
  live = null;
  await core?.cleanup();
  core = null;
});

interface Setup {
  c: CoreContext;
  device: FakeLiveDevice;
  helper: FakeHelper;
  live: LiveCapture;
  hub: EventHub;
  viewers: { count: number };
  frames: { seq: number; geometry: unknown }[];
}

function setup(scenario: FakeScenario = {}, options: { timings?: Partial<LiveCaptureTimings>; liveFps?: number } = {}): Setup {
  core = createCoreContext();
  if (options.liveFps) {
    core.settings.update({ connection: { screenshot: { ...core.settings.get().connection.screenshot, liveFps: options.liveFps } } });
  }
  const device = new FakeLiveDevice();
  const helper = fakeHelper(core.dir, scenario);
  const hub = core.hub;
  live = new LiveCapture({ device, settings: core.settings, hub, log: silentLogger, helper: helper.command, timings: { ...FAST, ...options.timings } });
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
    const s = setup({}, { liveFps: 20 });
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
      '20',
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
    expect(stats).toMatchObject({ available: true, running: true, delivering: true, phase: 'capturing', targetFps: 20, error: null });
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
    const lines: { level: string; msg: string }[] = [];
    const recording = {
      debug: (msg: string) => lines.push({ level: 'debug', msg }),
      info: (msg: string) => lines.push({ level: 'info', msg }),
      warn: (msg: string) => lines.push({ level: 'warn', msg }),
      error: (msg: string) => lines.push({ level: 'error', msg }),
      child: () => recording,
      setLevel: () => undefined,
    };
    core = createCoreContext();
    const device = new FakeLiveDevice();
    const helper = fakeHelper(core.dir, { crashAfterFrames: 40 });
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
    expect(info).toContain('Live capture started (ScreenCaptureKit, 730x1600 px, 30 fps)');
    expect(info.find((m) => m.startsWith('Live capture stats:'))).toMatch(/^Live capture stats: fps=\d+(\.\d)?, avgLatencyMs=\d+, frames=\d+$/);
    await waitFor(() => helper.log().some((e) => e.event === 'crash'));
    await waitFor(() => lines.some((l) => l.level === 'info' && l.msg.startsWith('Live capture unavailable: the live capture helper exited unexpectedly (code 1)')));

    await live.shutdown();
    lines.length = 0;
    live = new LiveCapture({ device, settings: core.settings, hub: core.hub, log: recording, helper: null, unavailableReason: 'the iphone-ai-capture helper is not installed' });
    live.start();
    expect(lines).toContainEqual({ level: 'info', msg: 'Live capture unavailable: the iphone-ai-capture helper is not installed' });
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
