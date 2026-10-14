// DeviceController regressions: revocation of queued AI/workflow input (task
// signal, lease pause), live paused checks before captures, fire-and-forget
// status refreshes, the monitoring timers and the Request timeout setting.
// Mock Mirroir only.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceAction, PolicyDecision } from '@iphone-ai/shared';

import { silentLogger } from '../../src/core/logger.js';
import { DeviceError, type ActionContext } from '../../src/device/device-controller.js';
import { ScreenStream } from '../../src/device/screen-stream.js';
import { createDeviceContext, sleep, waitFor, type DeviceContext, type DeviceOptions } from '../helpers/context.js';

const ALLOW: PolicyDecision = { verdict: 'allow', risk: 'low', reasons: [], rules: [] };
const GEOMETRY = '410x898';
const TAP_SETTINGS: DeviceAction = { kind: 'tap', x: 252, y: 412 };
const MANUAL_SUPERVISED: DeviceOptions = { settings: { permissions: { manualControlEnabled: true, controlMode: 'supervised' } } };
const MANUAL: DeviceOptions = { settings: { permissions: { manualControlEnabled: true } } };
const user = (patch: Partial<ActionContext> = {}): ActionContext => ({ actor: 'user', geometryId: GEOMETRY, decision: ALLOW, ...patch });

let ctx: DeviceContext | null = null;
let stream: ScreenStream | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  stream?.stop();
  stream = null;
  await ctx?.cleanup();
  ctx = null;
});

async function connected(options: DeviceOptions = {}): Promise<DeviceContext> {
  ctx = await createDeviceContext(options);
  await ctx.device.refreshPermissions();
  await ctx.device.refreshStatus();
  return ctx;
}

async function rejection(promise: Promise<unknown>): Promise<DeviceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(DeviceError);
    return err as DeviceError;
  }
  throw new Error('expected the promise to reject');
}

const count = (c: DeviceContext, tool: string) => c.calledTools().filter((t) => t === tool).length;

describe('task revocation reaches the device lane', () => {
  it('refuses an action whose task signal is already aborted, before anything is queued', async () => {
    const c = await connected(MANUAL_SUPERVISED);
    const lease = c.device.acquireLease('ai', 'Cancelled task');
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(
      c.device.perform(TAP_SETTINGS, { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW, signal: controller.signal }),
    );
    expect(err).toMatchObject({ code: 'aborted', message: 'The task was cancelled before this action ran.' });
    expect(c.calledTools()).not.toContain('tap');
    lease.release();
  });

  it('removes a queued AI action as soon as its task is cancelled, and never sends it', async () => {
    const c = await connected(MANUAL_SUPERVISED);
    c.writeMockState({ slowMs: { check_health: 1500 } });
    const lease = c.device.acquireLease('ai', 'Check battery');
    const controller = new AbortController();
    const health = c.device.checkHealth();
    await waitFor(() => c.calledTools().includes('check_health'), { message: 'check_health never started' });

    const tap = rejection(
      c.device.perform(TAP_SETTINGS, { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW, signal: controller.signal }),
    );
    expect(c.device.getStatus().queueDepth).toBe(1);
    const cancelledAt = Date.now();
    controller.abort();
    const err = await tap;
    // Rejected right away, not after the 1.5 s check_health ahead of it.
    expect(Date.now() - cancelledAt).toBeLessThan(500);
    expect(err).toMatchObject({ code: 'aborted', message: 'The task was cancelled before this action ran.' });
    expect(c.device.getStatus().queueDepth).toBe(0);

    await health;
    await sleep(200);
    expect(c.calledTools()).not.toContain('tap');
    lease.release();
  });

  it('refuses a workflow action cancelled during its pre-action status read', async () => {
    const c = await connected(MANUAL_SUPERVISED);
    const statusCalls = count(c, 'status');
    c.writeMockState({ slowMs: { status: 800 } });
    const lease = c.device.acquireLease('workflow', 'Morning routine');
    const controller = new AbortController();
    const home = rejection(
      c.device.perform({ kind: 'press_home' }, { actor: 'workflow', leaseId: lease.id, decision: ALLOW, signal: controller.signal }),
    );
    await waitFor(() => count(c, 'status') > statusCalls, { message: 'the in-job status read never started' });
    controller.abort();
    expect(await home).toMatchObject({ code: 'aborted' });
    await sleep(100);
    expect(c.calledTools()).not.toContain('press_home');
    lease.release();
  });

  it('still runs an action whose signal is not aborted, and detaches its listener', async () => {
    const c = await connected(MANUAL_SUPERVISED);
    const lease = c.device.acquireLease('ai', 'Task');
    const controller = new AbortController();
    const result = await c.device.perform(TAP_SETTINGS, {
      actor: 'ai',
      leaseId: lease.id,
      geometryId: GEOMETRY,
      decision: ALLOW,
      signal: controller.signal,
    });
    expect(result.ok).toBe(true);
    // Aborting after the action settled is harmless.
    controller.abort();
    expect(c.device.getStatus().queueDepth).toBe(0);
    lease.release();
  });
});

describe('a paused lease hands control to the user', () => {
  it('refuses a queued AI action when its task is paused before it runs, so manual input does not interleave', async () => {
    const c = await connected(MANUAL_SUPERVISED);
    c.writeMockState({ slowMs: { check_health: 1000 } });
    const lease = c.device.acquireLease('ai', 'Check battery');
    const health = c.device.checkHealth();
    await waitFor(() => c.calledTools().includes('check_health'), { message: 'check_health never started' });

    const ai = rejection(c.device.perform(TAP_SETTINGS, { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW }));
    c.device.setLeasePaused(lease.id, true);
    const manual = c.device.perform({ kind: 'press_home' }, user());

    const err = await ai;
    expect(err).toMatchObject({
      code: 'lease_paused',
      status: 409,
      message: 'The task was paused before this action ran; it was not executed.',
    });
    expect((await manual).ok).toBe(true);
    await health;
    expect(c.calledTools()).toContain('press_home');
    expect(c.calledTools()).not.toContain('tap');

    // After resuming, the task's input runs again.
    c.device.setLeasePaused(lease.id, false);
    expect((await c.device.perform({ kind: 'press_home' }, { actor: 'ai', leaseId: lease.id, decision: ALLOW })).ok).toBe(true);
    lease.release();
  });

  it('refuses an AI action paused during its pre-action status read, and one sent while already paused', async () => {
    const c = await connected(MANUAL_SUPERVISED);
    const lease = c.device.acquireLease('ai', 'Task');
    const ai: ActionContext = { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW };
    const statusCalls = count(c, 'status');
    c.writeMockState({ slowMs: { status: 800 } });
    const tap = rejection(c.device.perform(TAP_SETTINGS, ai));
    await waitFor(() => count(c, 'status') > statusCalls, { message: 'the in-job status read never started' });
    c.device.setLeasePaused(lease.id, true);
    expect((await tap).code).toBe('lease_paused');
    expect(c.calledTools()).not.toContain('tap');

    // Already paused: refused immediately.
    expect((await rejection(c.device.perform({ kind: 'press_home' }, ai))).code).toBe('lease_paused');
    expect(c.calledTools()).not.toContain('press_home');
    lease.release();
  });
});

describe('fire-and-forget status refresh', () => {
  it('does not leak an unhandled rejection when the refresh after a paused input error fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = await connected(MANUAL);
      const statusCalls = count(c, 'status');
      c.writeMockState({ slowMs: { status: 500 } });
      const tap = c.device.perform(TAP_SETTINGS, user());
      // While the pre-action status read runs (it already saw "connected"),
      // Mirroring pauses and the next status call crashes Mirroir.
      await waitFor(() => count(c, 'status') > statusCalls, { message: 'the in-job status read never started' });
      c.writeMockState({ mirroring: 'paused', crashOnCall: 'status', slowMs: {} });
      const result = await tap;
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/is paused/);
      await waitFor(() => c.readMockLog().some((e) => e.event === 'crash'), { message: 'status never crashed the mock' });
      await sleep(300);
      expect(unhandled).toEqual([]);
      expect(c.device.getStatus().server.state).not.toBe('ready');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('captures check the live mirroring status', () => {
  it('refuses screenshot and describe without sending them when Mirroring paused since the last poll', async () => {
    const c = await connected({ mockState: { resumeDelayMs: 0 } });
    expect(c.device.getStatus().mirroring.state).toBe('connected');
    c.writeMockState({ mirroring: 'paused' }); // no refreshStatus: the cache still says connected
    const before = c.calledTools().length;

    expect(await rejection(c.device.captureFrame({ reason: 'live-viewer' }))).toMatchObject({ code: 'paused' });
    // The cache now knows; force the next check through the queued job by resetting it.
    c.writeMockState({ mirroring: 'connected' });
    await c.device.refreshStatus();
    c.writeMockState({ mirroring: 'paused' });
    expect(await rejection(c.device.describe({ includeImage: false }))).toMatchObject({ code: 'paused' });
    c.writeMockState({ mirroring: 'connected' });
    await c.device.refreshStatus();
    c.writeMockState({ mirroring: 'paused' });
    expect(await rejection(c.device.describe({ includeImage: false, settleFirst: true }))).toMatchObject({ code: 'paused' });

    const sent = c.calledTools().slice(before);
    expect(sent.filter((t) => t === 'screenshot' || t === 'describe_screen')).toEqual([]);
    expect(c.device.getStatus().mirroring.state).toBe('paused');
  });

  it('still lets a user-initiated capture resume Mirroring', async () => {
    const c = await connected({ mockState: { resumeDelayMs: 0 } });
    c.writeMockState({ mirroring: 'paused' });
    const frame = await c.device.captureFrame({ allowResume: true });
    expect(frame.meta.widthPx).toBe(820);
    const described = await c.device.describe({ includeImage: false, allowResume: true });
    expect(described.rawText.length).toBeGreaterThan(0);
  });

  it('the live viewer sends no screenshot after Mirroring pauses (Observe Only, manual off)', async () => {
    const c = await connected({ mockState: { resumeDelayMs: 0 } });
    stream = new ScreenStream(c.device, c.settings, c.hub, silentLogger);
    stream.start();
    stream.setViewer('v1', { visible: true, interactive: false });
    await waitFor(() => count(c, 'screenshot') >= 1, { timeoutMs: 5000, message: 'the viewer never captured' });
    // Let the viewer go idle, then pause Mirroring without a status poll.
    stream.setViewer('v1', null);
    await sleep(800);
    const screenshots = count(c, 'screenshot');
    c.writeMockState({ mirroring: 'paused' });
    expect(c.device.getStatus().mirroring.state).toBe('connected');
    stream.setViewer('v1', { visible: true, interactive: false });
    await sleep(1500);
    expect(count(c, 'screenshot')).toBe(screenshots);
    expect(c.device.getStatus().mirroring.state).toBe('paused');
  });
});

describe('monitoring timers', () => {
  it('stopMonitoring() during an in-flight doctor run does not re-arm the doctor timer', async () => {
    const c = await connected();
    const runDoctor = vi.spyOn(c.mirroir, 'runDoctor').mockImplementation(() => sleep(200).then(() => null));
    c.device.start();
    await sleep(50);
    c.device.stopMonitoring();
    await sleep(400);
    const internals = c.device as unknown as { doctorTimer: NodeJS.Timeout | null; statusTimer: NodeJS.Timeout | null };
    expect(internals.doctorTimer).toBeNull();
    expect(internals.statusTimer).toBeNull();
    expect(runDoctor).toHaveBeenCalledTimes(1);
  });

  it('start() twice does not start a second monitoring loop', async () => {
    const c = await connected();
    const runDoctor = vi.spyOn(c.mirroir, 'runDoctor').mockResolvedValue(null);
    c.device.start();
    c.device.start();
    await sleep(100);
    expect(runDoctor).toHaveBeenCalledTimes(1);
    c.device.stopMonitoring();
  });
});

describe('Request timeout setting', () => {
  function recordTimeouts(c: DeviceContext): Map<string, number[]> {
    const seen = new Map<string, number[]>();
    const original = c.mirroir.call.bind(c.mirroir);
    vi.spyOn(c.mirroir, 'call').mockImplementation((name, args, options) => {
      seen.set(name, [...(seen.get(name) ?? []), options?.timeoutMs ?? -1]);
      return original(name, args, options);
    });
    return seen;
  }

  it('raises read-only call timeouts to the setting but leaves input and status probes alone', async () => {
    const c = await connected({ settings: { permissions: { manualControlEnabled: true }, connection: { requestTimeoutMs: 120000 } } });
    const seen = recordTimeouts(c);
    await c.device.describe({ includeImage: false, settleFirst: true });
    await c.device.captureFrame();
    await c.device.checkHealth();
    await c.device.readOnlyCall('list_targets');
    await c.device.perform(TAP_SETTINGS, user());

    for (const tool of ['describe_screen', 'screenshot', 'check_health', 'list_targets']) {
      expect(Math.min(...(seen.get(tool) ?? [0])), tool).toBeGreaterThanOrEqual(120000);
    }
    expect(seen.get('tap')).toEqual([12000]);
    expect(Math.max(...(seen.get('status') ?? [0]))).toBe(10000);
  });

  it('never shortens a built-in timeout that is longer than the setting', async () => {
    const c = await connected({ settings: { connection: { requestTimeoutMs: 5000 } } });
    const seen = recordTimeouts(c);
    await c.device.describe({ includeImage: false });
    await c.device.describe({ includeImage: false });
    await c.device.checkHealth();
    await c.device.captureFrame();
    expect(seen.get('describe_screen')).toEqual([90000, 30000]);
    expect(seen.get('check_health')).toEqual([90000]);
    expect(seen.get('screenshot')).toEqual([20000]);
  });
});
