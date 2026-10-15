// DeviceController (queue, lease, emergency stop, geometry checks, capture)
// against the mock Mirroir MCP server.

import { afterEach, describe, expect, it } from 'vitest';

import type { ActionResult, DeviceAction, PolicyDecision, ServerEvent } from '@iphone-ai/shared';

import type { Logger } from '../../src/core/logger.js';
import { DeviceController, DeviceError, type ActionContext } from '../../src/device/device-controller.js';
import { pngDimensions } from '../../src/device/png.js';
import { parseHealth } from '../../src/mcp/parsers.js';
import { createDeviceContext, MOCK_PERMISSIONS, waitFor, type DeviceContext, type DeviceOptions } from '../helpers/context.js';

const ALLOW: PolicyDecision = { verdict: 'allow', risk: 'low', reasons: [], rules: [] };
const NEEDS_APPROVAL: PolicyDecision = { verdict: 'require_approval', risk: 'high', reasons: ['"Send" matches "send"'], rules: ['sensitive.messaging'] };
const GEOMETRY = '410x898';
const TAP_SETTINGS: DeviceAction = { kind: 'tap', x: 252, y: 412 };
const MANUAL: DeviceOptions = { settings: { permissions: { manualControlEnabled: true } } };
const SUPERVISED: DeviceOptions = { settings: { permissions: { controlMode: 'supervised' } } };
const user = (patch: Partial<ActionContext> = {}): ActionContext => ({ actor: 'user', geometryId: GEOMETRY, decision: ALLOW, ...patch });

let ctx: DeviceContext | null = null;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

/** Context with permissions applied and the mirroring status read once. */
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

function labels(c: DeviceContext): Promise<string[]> {
  return c.device.describe({ includeImage: false }).then((d) => d.elements.map((e) => e.label));
}

describe('authorisation', () => {
  it('refuses a require_approval decision without an approval id, and runs it with one', async () => {
    const c = await connected(SUPERVISED);
    const lease = c.device.acquireLease('ai', 'Test task');
    const ai: ActionContext = { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: NEEDS_APPROVAL, taskId: 'task_1' };
    const err = await rejection(c.device.perform(TAP_SETTINGS, ai));
    expect(err).toMatchObject({ code: 'not_authorized', status: 403, message: 'This action needs approval first.' });
    expect(c.calledTools()).not.toContain('tap');

    const result = await c.device.perform(TAP_SETTINGS, { ...ai, approvalId: 'apr_1' });
    expect(result).toMatchObject({ ok: true, tool: 'tap', message: 'Tapped at (252, 412)', focusChanged: true });
    const event = c.activity.query({ categories: ['ai'] }).find((e) => e.type === 'tool.call');
    expect(event).toMatchObject({ actor: 'ai', tool: 'tap', success: true, taskId: 'task_1' });
    expect(event?.detail).toMatchObject({ approvalId: 'apr_1', policy: { verdict: 'require_approval', rules: ['sensitive.messaging'] } });
    lease.release();
  });

  it('refuses AI and workflow input in Observe Only mode even with an allow decision', async () => {
    const c = await connected(SUPERVISED);
    const lease = c.device.acquireLease('ai', 'Test task');
    c.settings.update({ permissions: { controlMode: 'observe' } });
    const err = await rejection(c.device.perform(TAP_SETTINGS, { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW }));
    expect(err).toMatchObject({ code: 'not_authorized', status: 403 });
    expect(c.calledTools()).not.toContain('tap');
    lease.release();
  });

  it('refuses denied decisions', async () => {
    const c = await connected(MANUAL);
    const err = await rejection(c.device.perform(TAP_SETTINGS, user({ decision: { verdict: 'deny', risk: 'high', reasons: ['No.'], rules: ['x'] } })));
    expect(err).toMatchObject({ code: 'not_authorized', message: 'No.' });
  });

  it('refuses manual actions while manual control is off', async () => {
    const c = await connected();
    const err = await rejection(c.device.perform(TAP_SETTINGS, user()));
    expect(err).toMatchObject({ code: 'not_authorized', status: 403, message: 'Manual control is turned off.' });
    expect(c.calledTools()).not.toContain('tap');
  });

  it('keeps remote sessions view-only and refuses the system actor', async () => {
    const c = await connected(MANUAL);
    expect(await rejection(c.device.perform(TAP_SETTINGS, user({ actor: 'remote-user' })))).toMatchObject({ code: 'not_authorized' });
    const remote = await c.device.perform(TAP_SETTINGS, user({ actor: 'remote-user', remoteControlAllowed: true }));
    expect(remote.ok).toBe(true);
    expect(await rejection(c.device.perform(TAP_SETTINGS, user({ actor: 'system' })))).toMatchObject({ code: 'not_authorized' });
  });

  it('requires AI and workflow actions to hold the current lease', async () => {
    const c = await connected(SUPERVISED);
    expect(await rejection(c.device.perform({ kind: 'press_home' }, { actor: 'ai', decision: ALLOW }))).toMatchObject({
      code: 'lease_conflict',
    });
    const lease = c.device.acquireLease('workflow', 'Morning routine');
    expect(await rejection(c.device.perform({ kind: 'press_home' }, { actor: 'workflow', leaseId: 'lease_other', decision: ALLOW }))).toMatchObject({
      code: 'lease_conflict',
    });
    const ok = await c.device.perform({ kind: 'press_home' }, { actor: 'workflow', leaseId: lease.id, decision: ALLOW });
    expect(ok).toMatchObject({ ok: true, focusChanged: false });
    lease.release();
    expect(c.device.getStatus().controlOwner).toBe('none');
  });
});

describe('control lease', () => {
  it('blocks manual input while an AI task holds control, unless the task is paused', async () => {
    const c = await connected({ settings: { permissions: { manualControlEnabled: true, controlMode: 'supervised' } } });
    const lease = c.device.acquireLease('ai', 'Check battery');
    expect(c.device.getStatus().controlOwner).toBe('ai');
    expect(() => c.device.acquireLease('workflow', 'Other')).toThrow(DeviceError);

    const err = await rejection(c.device.perform(TAP_SETTINGS, user()));
    expect(err.code).toBe('lease_conflict');
    expect(err.message).toContain('Check battery');

    c.device.setLeasePaused(lease.id, true);
    const result = await c.device.perform(TAP_SETTINGS, user());
    expect(result.ok).toBe(true);
    expect(c.readMockCalls().find((call) => call.name === 'tap')?.args).toEqual({ x: 252, y: 412, cursor_mode: 'preserving' });

    c.device.setLeasePaused(lease.id, false);
    expect((await rejection(c.device.perform(TAP_SETTINGS, user()))).code).toBe('lease_conflict');
    lease.release();
    expect((await c.device.perform({ kind: 'press_home' }, user())).ok).toBe(true);
  });
});

describe('geometry and state checks', () => {
  it('refuses coordinates computed for a different window size', async () => {
    const c = await connected(MANUAL);
    c.writeMockState({ window: '355x782' });
    const err = await rejection(c.device.perform(TAP_SETTINGS, user()));
    expect(err.code).toBe('geometry_changed');
    expect(err.message).toContain('410x898 → 355x782');
    expect(c.device.geometry?.geometryId).toBe('355x782');
    expect(c.device.currentGeometryId()).toBe('355x782');
    expect(c.calledTools()).not.toContain('tap');

    const ok = await c.device.perform({ kind: 'tap', x: 100, y: 100 }, user({ geometryId: '355x782' }));
    expect(ok.ok).toBe(true);
  });

  it('refuses pointer actions without a geometry id', async () => {
    const c = await connected(MANUAL);
    expect((await rejection(c.device.perform(TAP_SETTINGS, user({ geometryId: null })))).code).toBe('geometry_unknown');
    // Non-pointer actions do not need one.
    expect((await c.device.perform({ kind: 'press_home' }, user({ geometryId: null }))).ok).toBe(true);
  });

  it('refuses out-of-bounds points (taps and both swipe ends)', async () => {
    const c = await connected(MANUAL);
    const err = await rejection(c.device.perform({ kind: 'tap', x: 500, y: 20 }, user()));
    expect(err).toMatchObject({ code: 'out_of_bounds', status: 400 });
    expect(err.message).toContain('410×898');
    const swipe: DeviceAction = { kind: 'swipe', fromX: 205, fromY: 600, toX: 205, toY: 950 };
    expect((await rejection(c.device.perform(swipe, user()))).code).toBe('out_of_bounds');
    expect(c.calledTools().filter((t) => t === 'tap' || t === 'swipe')).toEqual([]);
  });

  it('refuses input while iPhone Mirroring is paused or not connected', async () => {
    const c = await connected(MANUAL);
    c.writeMockState({ mirroring: 'paused' });
    const paused = await rejection(c.device.perform(TAP_SETTINGS, user()));
    expect(paused.code).toBe('paused');
    // iPhone Mirroring needs the iPhone locked: never tell the user to unlock it.
    expect(paused.message).toBe('iPhone Mirroring is paused. Lock your iPhone and keep it nearby, then click Resume and try again.');
    expect((await rejection(c.device.perform({ kind: 'press_home' }, user()))).code).toBe('paused');
    expect(c.device.getStatus().mirroring.state).toBe('paused');

    c.writeMockState({ mirroring: 'not_running' });
    const notRunning = await rejection(c.device.perform({ kind: 'press_home' }, user()));
    expect(notRunning.code).toBe('not_connected');
    expect(notRunning.message).toContain("Not running — 'iphone' is not open");
    expect(c.calledTools().filter((t) => t !== 'status')).toEqual([]);
  });

  it('refuses everything with mcp_unavailable when the server is down', async () => {
    const c = await connected(MANUAL);
    await c.mirroir.stop();
    expect(await rejection(c.device.perform({ kind: 'press_home' }, user()))).toMatchObject({ code: 'mcp_unavailable', status: 503 });
    await expect(c.device.captureFrame()).rejects.toMatchObject({ code: 'mcp_unavailable' });
  });
});

describe('actions', () => {
  it('returns Mirroir failures as ok:false results and audits them', async () => {
    const c = await connected(MANUAL);
    const result: ActionResult = await c.device.perform({ kind: 'launch_app', name: 'Imaginary App' }, user());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Spotlight is still open after searching 'Imaginary App'/);
    const event = c.activity.query({ categories: ['manual'] })[0];
    expect(event).toMatchObject({ type: 'tool.call', tool: 'launch_app', success: false, severity: 'warning' });
    expect(event?.summary).toMatch(/^Open Imaginary App — failed: Spotlight is still open/);
  });

  it('redacts typed text in the audit log unless the user opted in', async () => {
    const c = await connected(MANUAL);
    await c.device.perform({ kind: 'spotlight' }, user());
    const typed = await c.device.perform({ kind: 'type_text', text: 'Settings' }, user());
    expect(typed).toMatchObject({ ok: true, message: 'Typed 8 characters' });
    const event = c.activity.query({ search: 'Type' }).find((e) => e.tool === 'type_text');
    expect(event?.summary).toBe('Type 8 characters — done');
    expect(event?.detail).toMatchObject({ args: { text: '«8 characters»' } });
    expect(JSON.stringify(event)).not.toContain('"Settings"');

    c.settings.update({ privacy: { logTypedText: true } });
    await c.device.perform({ kind: 'type_text', text: 'x' }, user());
    const visible = c.activity.query({}).find((e) => e.tool === 'type_text' && e.summary.startsWith('Type "x"'));
    expect(visible?.detail).toMatchObject({ args: { text: 'x' } });
  });

  it('skips manual auditing when auditManualActions is off', async () => {
    const c = await connected({ settings: { permissions: { manualControlEnabled: true, auditManualActions: false } } });
    await c.device.perform({ kind: 'press_home' }, user());
    expect(c.activity.query({ categories: ['manual'] })).toEqual([]);
  });

  it('marks focus-stealing tools and drives the simulated phone', async () => {
    const c = await connected(MANUAL);
    const focusEvents: unknown[] = [];
    c.device.on('focus_steal', (e) => focusEvents.push(e));
    const tap = await c.device.perform(TAP_SETTINGS, user());
    expect(tap.focusChanged).toBe(true);
    expect(c.device.getStatus().lastFocusSteal).not.toBeNull();
    expect(focusEvents).toHaveLength(1);
    expect(await labels(c)).toEqual(expect.arrayContaining(['Airplane Mode', 'Wi-Fi', 'Bluetooth']));

    const home = await c.device.perform({ kind: 'press_home' }, user());
    expect(home.focusChanged).toBe(false);
    expect(await labels(c)).toContain('Weather');
  });

  it('passes long-press durations and lowercases keys for Mirroir', async () => {
    const c = await connected(MANUAL);
    await c.device.perform({ kind: 'long_press', x: 63, y: 112, durationMs: 700 }, user());
    await c.device.perform({ kind: 'press_key', key: 'Return', modifiers: ['shift'] }, user());
    const calls = c.readMockCalls();
    expect(calls.find((x) => x.name === 'long_press')?.args).toEqual({ x: 63, y: 112, duration_ms: 700, cursor_mode: 'preserving' });
    expect(calls.find((x) => x.name === 'press_key')?.args).toEqual({ key: 'return', modifiers: ['shift'] });
  });

  it('follows a page flick (settle) with the slow settle nudge in the same job; plain swipes get none', async () => {
    const c = await connected(MANUAL);
    const flick: DeviceAction = { kind: 'swipe', fromX: 205, fromY: 858, toX: 205, toY: 40, durationMs: 300, settle: true };
    const result = await c.device.perform(flick, user());
    expect(result).toMatchObject({ ok: true, tool: 'swipe' });
    const swipes = c.readMockCalls().filter((x) => x.name === 'swipe');
    expect(swipes.map((x) => x.args)).toEqual([
      { from_x: 205, from_y: 858, to_x: 205, to_y: 40, duration_ms: 300, cursor_mode: 'preserving' },
      { from_x: 205, from_y: 459, to_x: 205, to_y: 439, duration_ms: 200, cursor_mode: 'preserving' },
    ]);
    // One action in the audit log, without the settle flag leaking into Mirroir's arguments.
    expect(c.activity.query({ categories: ['manual'] }).filter((e) => e.type === 'tool.call')).toHaveLength(1);

    await c.device.perform({ kind: 'swipe', fromX: 205, fromY: 651, toX: 205, toY: 247, durationMs: 879 }, user());
    expect(c.readMockCalls().filter((x) => x.name === 'swipe')).toHaveLength(3);
  });

  it('skips the settle nudge when the task is cancelled during the flick', async () => {
    const c = await connected({ ...SUPERVISED, mockState: { slowMs: { swipe: 600 } } });
    const lease = c.device.acquireLease('ai', 'Paging task');
    const abort = new AbortController();
    const flick: DeviceAction = { kind: 'swipe', fromX: 205, fromY: 858, toX: 205, toY: 40, durationMs: 300, settle: true };
    const running = c.device.perform(flick, { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW, signal: abort.signal });
    await waitFor(() => c.calledTools().includes('swipe'), { message: 'the flick never reached the mock' });
    abort.abort();
    expect(await running).toMatchObject({ ok: true });
    expect(c.calledTools().filter((name) => name === 'swipe')).toHaveLength(1);
    lease.release();
  });

  it('serialises actions and observations through one lane', async () => {
    const c = await connected({ ...MANUAL, mockState: { slowMs: { tap: 400 } } });
    const order: string[] = [];
    const tap = c.device.perform(TAP_SETTINGS, user()).then(() => order.push('tap'));
    const describe = c.device.describe({ includeImage: false }).then(() => order.push('describe'));
    await Promise.all([tap, describe]);
    expect(order).toEqual(['tap', 'describe']);
    // The status re-read happens inside each job, right before the tap and
    // right before the capture.
    const names = c.calledTools();
    expect(names.slice(names.indexOf('tap') - 1, names.indexOf('tap') + 3)).toEqual(['status', 'tap', 'status', 'describe_screen']);
  });
});

describe('emergency stop', () => {
  it('rejects queued actions, aborts the lease and SIGTERMs Mirroir during an in-flight input call', async () => {
    const c = await connected({ ...SUPERVISED, mockState: { slowMs: { tap: 5000 } } });
    const events: ServerEvent[] = c.events;
    const lease = c.device.acquireLease('ai', 'Runaway task');
    const ai: ActionContext = { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW };
    const inFlight = rejection(c.device.perform(TAP_SETTINGS, ai));
    const queued = rejection(c.device.perform({ kind: 'press_home' }, ai));
    await waitFor(() => c.calledTools().includes('tap'), { message: 'tap never reached the mock' });
    expect(c.device.getStatus()).toMatchObject({ actionInFlight: true, queueDepth: 1, controlOwner: 'ai' });
    const pid = c.mirroir.info().pid;

    const started = Date.now();
    await c.device.emergencyStop('User pressed STOP', 'user');
    expect(Date.now() - started).toBeLessThan(4000);

    expect(lease.signal.aborted).toBe(true);
    expect((await queued).code).toBe('stop_latched');
    expect(['mcp_unavailable', 'tool_failed']).toContain((await inFlight).code);
    await waitFor(() => c.readMockLog().some((e) => e.signal === 'SIGTERM'), { message: 'mock never saw SIGTERM' });
    expect(c.calledTools()).not.toContain('press_home');

    expect(c.device.getStatus()).toMatchObject({ stopLatched: true, stopReason: 'User pressed STOP', controlOwner: 'none' });
    expect(events.some((e) => e.type === 'stop_engaged' && e.reason === 'User pressed STOP')).toBe(true);
    const audit = c.activity.query({ categories: ['security'] }).find((e) => e.type === 'stop.engaged');
    expect(audit?.detail).toMatchObject({ cancelledQueuedActions: 1, interruptedInFlight: 'ai:tap' });

    // Mirroir is restarted, and the tap never landed on the phone (still home).
    await waitFor(() => c.mirroir.isReady(), { timeoutMs: 15000, message: 'Mirroir was not restarted' });
    expect(c.mirroir.info().pid).not.toBe(pid);
    expect(await labels(c)).toContain('Weather');

    // Everything stays refused until re-armed.
    expect((await rejection(c.device.perform({ kind: 'press_home' }, ai))).code).toBe('stop_latched');
    expect(() => c.device.acquireLease('ai', 'Another task')).toThrow(/Emergency stop is engaged/);
  });

  it('latches without terminating Mirroir when no input is executing, and re-arms', async () => {
    const c = await connected(MANUAL);
    const pid = c.mirroir.info().pid;
    await c.device.emergencyStop('Pause everything', 'user');
    expect(c.device.isStopLatched).toBe(true);
    expect(c.mirroir.info().pid).toBe(pid);
    expect(c.readMockLog().some((e) => e.signal)).toBe(false);
    expect((await rejection(c.device.perform({ kind: 'press_home' }, user()))).code).toBe('stop_latched');

    c.device.rearm('user');
    expect(c.device.getStatus()).toMatchObject({ stopLatched: false, stopReason: null });
    expect(c.events.some((e) => e.type === 'stop_released')).toBe(true);
    expect(c.activity.query({}).some((e) => e.type === 'stop.released')).toBe(true);
    expect((await c.device.perform({ kind: 'press_home' }, user())).ok).toBe(true);
    // Re-arming twice is a no-op.
    c.device.rearm('user');
    expect(c.activity.query({}).filter((e) => e.type === 'stop.released')).toHaveLength(1);
  });
});

describe('screen capture', () => {
  it('refuses screenshots until Screen Recording is confirmed', async () => {
    const c = await connected({ assumePermissions: false });
    expect(c.device.getStatus().permissions.screenRecording).toBe('unknown');
    expect(c.device.canCaptureScreen()).toBe(false);
    let err: unknown = null;
    try {
      await c.device.captureFrame();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeviceError);
    expect(err).toMatchObject({ code: 'screen_capture_unavailable', status: 412 });
    await expect(c.device.describe()).rejects.toThrow(/Screen Recording permission is not confirmed/);
    expect(c.calledTools()).not.toContain('screenshot');
  });

  it('captures 2x PNG frames with geometry and detects changes', async () => {
    const c = await connected(MANUAL);
    expect(c.device.getStatus().permissions).toMatchObject({ screenRecording: 'granted', source: 'mock (assumed)' });
    expect(c.device.canCaptureScreen()).toBe(true);

    const first = await c.device.captureFrame({ reason: 'test' });
    expect(first.meta).toMatchObject({ seq: 1, widthPx: 820, heightPx: 1796, mimeType: 'image/png', pxPerPt: 2, source: 'mirroir-screenshot' });
    expect(first.meta.geometry?.geometryId).toBe(GEOMETRY);
    expect(pngDimensions(first.data)).toEqual({ width: 820, height: 1796 });
    expect(c.device.getLatestFrame()).toBe(first);
    expect(c.events.some((e) => e.type === 'frame' && e.meta.seq === 1)).toBe(true);
    expect(c.readMockCalls().find((x) => x.name === 'screenshot')?.args).toEqual({ settle_ms: 0 });

    const same = await c.device.captureFrame({ settleMs: 300 });
    expect(same.meta.seq).toBe(2);
    // Live capture frames take numbers from the same sequence (a higher seq is always newer).
    expect(c.device.nextFrameSeq()).toBe(3);
    const after = await c.device.captureFrame();
    expect(after.meta.seq).toBe(4);
    expect(same.data.equals(first.data)).toBe(true);

    await c.device.perform(TAP_SETTINGS, user());
    const changed = await c.device.captureFrame();
    expect(changed.data.equals(first.data)).toBe(false);
  });

  it('reports pxPerPt for other window sizes', async () => {
    const c = await connected({ mockState: { window: '355x782' } });
    const frame = await c.device.captureFrame();
    expect(frame.meta).toMatchObject({ widthPx: 710, heightPx: 1564, pxPerPt: 2 });
  });

  it('coalesces concurrent live-frame requests into one screenshot call', async () => {
    const c = await connected({ mockState: { slowMs: { screenshot: 150 } } });
    const [a, b] = await Promise.all([c.device.captureFrame(), c.device.captureFrame()]);
    expect(a).toBe(b);
    expect(c.calledTools().filter((t) => t === 'screenshot')).toHaveLength(1);
  });

  it('refuses captures while paused unless the user allows Mirroir to press Resume', async () => {
    const c = await connected({ mockState: { resumeDelayMs: 0 } });
    c.writeMockState({ mirroring: 'paused' });
    await c.device.refreshStatus();
    await expect(c.device.captureFrame()).rejects.toMatchObject({ code: 'paused' });
    const frame = await c.device.captureFrame({ allowResume: true });
    expect(frame.meta.widthPx).toBe(820);
  });

  it('describes the screen with element ids, coordinates, image and fingerprint', async () => {
    const c = await connected();
    const d = await c.device.describe();
    expect(d.rawText.startsWith('Screen elements (tap coordinates in points):')).toBe(true);
    expect(d.elements[0]?.id).toBe('e1');
    expect(d.elements.map((e) => e.id)).toEqual(d.elements.map((_, i) => `e${i + 1}`));
    expect(d.elements.find((e) => e.label === 'Settings')).toMatchObject({ x: 252, y: 412, kind: 'text' });
    expect(d.elements.filter((e) => e.kind?.startsWith('icon'))).toHaveLength(4);
    expect(d.imageMimeType).toBe('image/png');
    expect(pngDimensions(Buffer.from(d.imageBase64 ?? '', 'base64'))).toEqual({ width: 820, height: 1796 });
    expect(d.geometry?.geometryId).toBe(GEOMETRY);
    expect(d.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const again = await c.device.describe({ includeImage: false });
    expect(again.imageBase64).toBeNull();
    expect(again.fingerprint).toBe(d.fingerprint);
    expect(c.readMockCalls().filter((x) => x.name === 'describe_screen').map((x) => x.args)).toEqual([
      { omit_screenshot: false },
      { omit_screenshot: true },
    ]);

    c.writeMockState({ screen: 'battery' });
    const battery = await c.device.describe({ includeImage: false, settleFirst: true });
    expect(battery.elements.map((e) => e.label)).toEqual(expect.arrayContaining(['Battery Percentage', '87%']));
    expect(battery.fingerprint).not.toBe(d.fingerprint);
    expect(c.calledTools().slice(-4)).toEqual(['status', 'screenshot', 'status', 'describe_screen']);
    // The settle wait before an AI observation is capped at 700 ms (it was 1500 ms, which never
    // settles on moving video and was added to every AI step).
    expect(c.readMockCalls().filter((x) => x.name === 'screenshot').at(-1)?.args).toEqual({ settle_ms: 700 });
  });

  it('surfaces describe_screen failures as tool_failed', async () => {
    const c = await connected({ mockState: { screenRecording: 'denied' } });
    const err = await rejection(c.device.describe());
    expect(err).toMatchObject({ code: 'tool_failed', message: "Failed to capture/analyze screen. Is the 'iphone' window visible?" });
  });
});

describe('status monitoring and diagnostics', () => {
  it('follows mirroring state changes written to the mock state file', async () => {
    ctx = await createDeviceContext();
    const c = ctx;
    c.device.start();
    await waitFor(() => c.device.getStatus().mirroring.state === 'connected', { message: 'never connected' });
    expect(c.device.getStatus().permissions.screenRecording).toBe('granted');
    expect(c.device.geometry).toMatchObject({ widthPt: 410, heightPt: 898, orientation: 'portrait' });

    c.writeMockState({ mirroring: 'paused' });
    await waitFor(() => c.device.getStatus().mirroring.state === 'paused', { timeoutMs: 8000, message: 'never saw paused' });
    expect(c.device.getStatus().mirroring.rawStatus).toBe('Paused — connection paused, can resume');
    expect(c.device.geometry).toBeNull();

    c.writeMockState({ mirroring: 'connected', window: '898x410' });
    await waitFor(() => c.device.getStatus().mirroring.state === 'connected', { timeoutMs: 8000 });
    expect(c.device.geometry).toMatchObject({ geometryId: '898x410', orientation: 'landscape' });

    const types = c.activity.query({ categories: ['connection'] }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['mirroring.connected', 'mirroring.paused', 'permissions.checked']));
    await waitFor(() => c.events.some((e) => e.type === 'status' && e.status.mirroring.state === 'paused'));
  });

  it('logs every mirroring state transition to the backend log (activity rows unchanged)', async () => {
    ctx = await createDeviceContext();
    const c = ctx;
    const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
    const log: Logger = {
      debug: (msg, data) => lines.push({ level: 'debug', msg, data }),
      info: (msg, data) => lines.push({ level: 'info', msg, data }),
      warn: (msg, data) => lines.push({ level: 'warn', msg, data }),
      error: (msg, data) => lines.push({ level: 'error', msg, data }),
      child: () => log,
      setLevel: () => undefined,
    };
    const device = new DeviceController(c.mirroir, c.settings, c.hub, c.activity, log, MOCK_PERMISSIONS);
    await device.refreshStatus();
    c.writeMockState({ mirroring: 'paused' });
    await device.refreshStatus();
    await device.refreshStatus();
    c.writeMockState({ mirroring: 'connected' });
    await device.refreshStatus();

    expect(lines.filter((l) => l.msg === 'Mirroring state changed')).toEqual([
      { level: 'info', msg: 'Mirroring state changed', data: { from: 'unknown', to: 'connected' } },
      { level: 'info', msg: 'Mirroring state changed', data: { from: 'connected', to: 'paused' } },
      { level: 'info', msg: 'Mirroring state changed', data: { from: 'paused', to: 'connected' } },
    ]);
    const types = c.activity.query({ categories: ['connection'] }).map((e) => e.type);
    expect(types.filter((t) => t.startsWith('mirroring.')).sort()).toEqual(['mirroring.connected', 'mirroring.connected', 'mirroring.paused']);
    // iPhone Mirroring needs the iPhone locked: the guidance never says to unlock it.
    const paused = c.activity.query({ categories: ['connection'] }).find((e) => e.type === 'mirroring.paused');
    expect(paused?.summary).toBe('iPhone Mirroring is paused — lock the iPhone, keep it nearby and click Resume.');
  });

  it('resets the mirroring state to unknown when Mirroir crashes', async () => {
    const c = await connected({ mockState: { crashOnCall: 'get_orientation' } });
    expect(c.device.getStatus().mirroring.state).toBe('connected');
    await expect(c.device.readOnlyCall('get_orientation')).rejects.toThrow();
    await waitFor(() => c.device.getStatus().mirroring.state === 'unknown');
    expect(c.device.getStatus().server.state).toBe('crashed');
    c.writeMockState({ crashOnCall: undefined });
    await waitFor(() => c.mirroir.isReady(), { timeoutMs: 15000 });
    expect((await c.device.refreshStatus()).state).toBe('connected');
  });

  it('runs read-only diagnostics and check_health', async () => {
    const c = await connected();
    expect((await c.device.readOnlyCall('list_targets')).text).toBe(
      '- iphone (active): connected (410x898) [appSwitcher, home, menuActions, spotlight]',
    );
    expect((await c.device.readOnlyCall('get_orientation')).text).toBe('Orientation: portrait (window: 410x898)');
    await expect(c.device.readOnlyCall('tap', { x: 1, y: 1 })).rejects.toMatchObject({ code: 'not_authorized' });
    const health = parseHealth((await c.device.checkHealth()).text);
    expect(health.ok).toBe(true);
    expect(health.items).toHaveLength(4);
  });
});
