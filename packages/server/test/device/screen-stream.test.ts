// ScreenStream: throttled screenshot polling for the live viewer (not video).

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerEvent } from '@iphone-ai/shared';

import { silentLogger } from '../../src/core/logger.js';
import { LiveCapture, type LiveCaptureTimings } from '../../src/device/live-capture.js';
import { ScreenStream } from '../../src/device/screen-stream.js';
import { createDeviceContext, sleep, waitFor, type DeviceContext, type DeviceOptions } from '../helpers/context.js';
import { fakeHelper, type FakeHelper, type FakeScenario } from '../live-capture/helpers.js';

let ctx: DeviceContext | null = null;
let stream: ScreenStream | null = null;
let live: LiveCapture | null = null;

afterEach(async () => {
  stream?.stop();
  stream = null;
  await live?.shutdown();
  live = null;
  await ctx?.cleanup();
  ctx = null;
});

async function setup(options: DeviceOptions = {}): Promise<{ c: DeviceContext; s: ScreenStream; frames: number[] }> {
  ctx = await createDeviceContext(options);
  await ctx.device.refreshPermissions();
  await ctx.device.refreshStatus();
  stream = new ScreenStream(ctx.device, ctx.settings, ctx.hub, silentLogger);
  const frames: number[] = [];
  ctx.device.on('frame', () => frames.push(Date.now()));
  stream.start();
  return { c: ctx, s: stream, frames };
}

const screenshots = (c: DeviceContext) => c.calledTools().filter((t) => t === 'screenshot').length;

describe('ScreenStream', () => {
  it('does not poll when no viewer is visible', async () => {
    const { c, s } = await setup();
    s.setViewer('hidden-tab', { visible: false, interactive: false });
    await sleep(1500);
    expect(screenshots(c)).toBe(0);
    expect(s.stats()).toMatchObject({
      mode: 'polling-screenshots',
      running: false,
      targetFps: 0,
      measuredFps: 0,
      pausedReason: 'No visible viewer',
      viewers: 0,
      lastFrameAt: null,
    });
  });

  it('does not poll without a confirmed Screen Recording permission', async () => {
    const { c, s } = await setup({ assumePermissions: false });
    s.setViewer('v1', { visible: true, interactive: true });
    await sleep(1500);
    expect(screenshots(c)).toBe(0);
    expect(s.stats()).toMatchObject({ running: false, pausedReason: 'Screen Recording permission not confirmed', viewers: 1 });
  });

  it('does not poll while iPhone Mirroring is paused', async () => {
    const { c, s } = await setup({ mockState: { mirroring: 'paused' } });
    s.setViewer('v1', { visible: true, interactive: true });
    await sleep(1200);
    expect(screenshots(c)).toBe(0);
    expect(s.stats().pausedReason).toBe('iPhone Mirroring is paused');
  });

  it('polls at the active rate with a visible viewer and reports the measured fps honestly', async () => {
    const { c, s, frames } = await setup();
    const started = Date.now();
    s.setViewer('v1', { visible: true, interactive: true });
    await sleep(3200);
    const stats = s.stats();
    const now = Date.now();

    // 2 fps target → about 6 frames in ~3 s (scheduling jitter allowed).
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames.length).toBeLessThanOrEqual(8);
    expect(screenshots(c)).toBe(frames.length);
    expect(stats).toMatchObject({ running: true, targetFps: 2, pausedReason: null, viewers: 1, consecutiveErrors: 0, lastError: null });
    expect(stats.lastFrameAt).toBeGreaterThanOrEqual(started);

    // The reported rate is what was actually delivered, not the target.
    const independent = (frames.length - 1) / Math.max((now - frames[0]!) / 1000, 1);
    expect(Math.abs(stats.measuredFps - independent)).toBeLessThan(0.2);
    expect(stats.measuredFps).toBeLessThanOrEqual(2.2);
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);

    await waitFor(() => c.events.some((e: ServerEvent) => e.type === 'stream_stats' && e.stats.running), { timeoutMs: 5000 });
  });

  it('reports a measured fps below the target when screenshots are slow', async () => {
    const { s, frames } = await setup({ mockState: { slowMs: { screenshot: 700 } } });
    s.setViewer('v1', { visible: true, interactive: true });
    await sleep(4000);
    const stats = s.stats();
    expect(stats.targetFps).toBe(2);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(stats.measuredFps).toBeGreaterThan(0.5);
    expect(stats.measuredFps).toBeLessThan(1.6);
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(650);
  });

  it('drops to the idle rate after inactivity and back to active on activity', async () => {
    const { c, s } = await setup();
    c.settings.mutate((d) => {
      d.connection.screenshot.idleAfterMs = 300;
    });
    s.setViewer('v1', { visible: true, interactive: false });
    expect(s.stats().targetFps).toBe(2);
    await sleep(600);
    expect(s.stats().targetFps).toBe(0.2);
    s.markActivity();
    expect(s.stats().targetFps).toBe(2);
    s.markActivity(4000);
    expect(s.stats().targetFps).toBe(4);
  });

  it('stops polling when the last viewer leaves', async () => {
    const { c, s, frames } = await setup();
    s.setViewer('v1', { visible: true, interactive: true });
    await waitFor(() => frames.length >= 2, { timeoutMs: 5000 });
    s.setViewer('v1', null);
    await sleep(700);
    const count = screenshots(c);
    await sleep(1500);
    expect(screenshots(c)).toBe(count);
    expect(s.stats()).toMatchObject({ running: false, viewers: 0 });
    await waitFor(() => s.stats().pausedReason === 'No visible viewer', { timeoutMs: 3000 });
  });

  it('keeps polling without a viewer while an AI task holds control', async () => {
    const { c, frames } = await setup({ settings: { permissions: { controlMode: 'supervised' } } });
    const lease = c.device.acquireLease('ai', 'Task');
    stream!.markActivity();
    await waitFor(() => frames.length >= 2, { timeoutMs: 5000, message: 'no frames while the AI held control' });
    lease.release();
  });

  it('counts errors and backs off when screenshots fail', async () => {
    const { s } = await setup({ mockState: { screenRecording: 'denied' } });
    s.setViewer('v1', { visible: true, interactive: true });
    await waitFor(() => s.stats().consecutiveErrors >= 1, { timeoutMs: 5000 });
    expect(s.stats().lastError).toBe("Failed to capture screenshot. Is the 'iphone' window visible?");
    expect(s.stats().measuredFps).toBe(0);
  });
});

// Live capture handover: the REAL DeviceController on the mock Mirroir server,
// plus LiveCapture driven by the FAKE capture helper (no ScreenCaptureKit, no phone).
describe('ScreenStream with live capture', () => {
  async function setupLive(
    scenario: FakeScenario,
    timings: Partial<LiveCaptureTimings> = {},
  ): Promise<{ c: DeviceContext; s: ScreenStream; l: LiveCapture; helper: FakeHelper }> {
    ctx = await createDeviceContext();
    await ctx.device.refreshPermissions();
    await ctx.device.refreshStatus();
    const helper = fakeHelper(ctx.dir, scenario);
    live = new LiveCapture({
      device: ctx.device,
      settings: ctx.settings,
      hub: ctx.hub,
      log: silentLogger,
      helper: helper.command,
      timings: { tickMs: 50, ...timings },
    });
    stream = new ScreenStream(ctx.device, ctx.settings, ctx.hub, silentLogger, live);
    live.start();
    stream.start();
    return { c: ctx, s: stream, l: live, helper };
  }

  it('reports live capture as unavailable and keeps polling when there is no helper', async () => {
    ctx = await createDeviceContext();
    await ctx.device.refreshPermissions();
    await ctx.device.refreshStatus();
    live = new LiveCapture({ device: ctx.device, settings: ctx.settings, hub: ctx.hub, log: silentLogger, helper: null, unavailableReason: 'the iphone-ai-capture helper is not installed' });
    stream = new ScreenStream(ctx.device, ctx.settings, ctx.hub, silentLogger, live);
    live.start();
    stream.start();
    stream.setViewer('v1', { visible: true, interactive: true });
    await waitFor(() => screenshots(ctx!) >= 2, { timeoutMs: 5000 });
    expect(stream.stats()).toMatchObject({
      mode: 'polling-screenshots',
      running: true,
      liveAvailable: false,
      liveError: 'Live capture unavailable: the iphone-ai-capture helper is not installed.',
    });
  });

  it('pauses polling while live frames arrive, resumes it when the helper dies, and goes live again after the retry', async () => {
    // 10 fps default (single-screenshot capture): the crash comes ~2.5 s in, after the checks below.
    const { c, s, l, helper } = await setupLive({ crashAfterFrames: 25 }, { retryBaseMs: 2500 });
    s.setViewer('v1', { visible: true, interactive: true });
    await waitFor(() => l.isDelivering(), { timeoutMs: 5000, message: 'live frames never arrived' });
    // Give an in-flight screenshot (started before the handover) time to finish.
    await sleep(400);
    const before = screenshots(c);
    await sleep(800);
    expect(screenshots(c)).toBe(before);
    expect(s.stats()).toMatchObject({
      mode: 'live-screencapturekit',
      running: true,
      targetFps: 15,
      pausedReason: 'Live capture active',
      liveAvailable: true,
      liveError: null,
      viewers: 1,
    });
    expect(s.stats().measuredFps).toBeGreaterThan(5);
    await waitFor(
      () => c.events.some((e: ServerEvent) => e.type === 'stream_stats' && e.stats.mode === 'live-screencapturekit'),
      { timeoutMs: 3000, message: 'no live stream_stats event' },
    );
    // Live frames share the frame sequence with polled screenshots.
    const polledSeq = c.device.getLatestFrame()?.meta.seq ?? 0;
    expect(l.latest()!.meta.seq).toBeGreaterThan(polledSeq);
    // The mock's window is 410x898 like the fake helper's, so touch geometry is attached.
    expect(l.latest()!.meta.geometry?.geometryId).toBe('410x898');

    // The helper crashes: polling takes over at once, the error is reported.
    await waitFor(() => helper.log().some((e) => e.event === 'crash'), { timeoutMs: 5000 });
    const atCrash = screenshots(c);
    await waitFor(() => screenshots(c) >= atCrash + 2, { timeoutMs: 4000, message: 'polling did not resume' });
    expect(s.stats()).toMatchObject({ mode: 'polling-screenshots', running: true, liveAvailable: true });
    expect(s.stats().liveError).toMatch(/exited unexpectedly/);
    expect(s.stats().pausedReason).toBeNull();

    // Retried with backoff: live again, polling paused again.
    helper.setScenario({});
    await waitFor(() => helper.starts().length === 2 && l.isDelivering(), { timeoutMs: 6000, message: 'helper not retried' });
    await waitFor(() => s.stats().mode === 'live-screencapturekit', { timeoutMs: 2000 });
    expect(s.stats().liveError).toBeNull();
  });

  it('resumes polling within the 2 s live window when frames stop arriving (nothing changes on screen)', async () => {
    const { c, s, l } = await setupLive({ frames: 10 });
    s.setViewer('v1', { visible: true, interactive: true });
    await waitFor(() => l.isDelivering(), { timeoutMs: 5000 });
    const lastLive = () => l.stats().lastFrameAt ?? 0;
    await waitFor(() => !l.isDelivering(), { timeoutMs: 4000 });
    // Not delivering means no frame within the last 2 s.
    expect(Date.now() - lastLive()).toBeGreaterThanOrEqual(2000);
    const n = screenshots(c);
    await waitFor(() => screenshots(c) >= n + 1, { timeoutMs: 3000, message: 'polling did not resume after live frames stopped' });
    expect(s.stats().mode).toBe('polling-screenshots');
  });

  it('starts live capture for an AI task without a viewer and keeps Mirroir free of polling', async () => {
    const { c, s, l } = await setupLive({}, {});
    c.settings.update({ permissions: { controlMode: 'supervised' } });
    const lease = c.device.acquireLease('ai', 'Task');
    s.markActivity();
    await waitFor(() => l.isDelivering(), { timeoutMs: 5000, message: 'no live capture while the AI held control' });
    await sleep(400);
    const n = screenshots(c);
    await sleep(800);
    expect(screenshots(c)).toBe(n);
    lease.release();
  });
});
