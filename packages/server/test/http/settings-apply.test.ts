// Mirroir restarts after settings changes: never skipped while the running
// server still has the old configuration, and not deferred for a task holding
// control when the change turns input off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, type AppSettings } from '@iphone-ai/shared';

import type { AppContext } from '../../src/core/services.js';
import { applyMirroirConfig } from '../../src/http/settings-apply.js';

function fakeCtx(settings: AppSettings) {
  const state = { actionInFlight: false, leaseHeld: true, changed: true };
  const restart = vi.fn(async () => {
    state.changed = false;
  });
  const warn = vi.fn();
  const record = vi.fn();
  const ctx = {
    settings: { get: () => settings },
    device: {
      getStatus: () => ({ actionInFlight: state.actionInFlight }),
      get currentLease() {
        return state.leaseHeld ? { paused: false } : null;
      },
    },
    mirroir: {
      configChanged: () => state.changed,
      info: () => ({ state: 'ready' }),
      isReady: () => true,
      restart,
    },
    log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    activity: { record },
  } as unknown as AppContext;
  return { ctx, state, restart, warn, record };
}

/** Tracks completion without awaiting (a regression must fail, not hang under fake timers). */
function track(promise: Promise<void>): { finished: boolean } {
  const status = { finished: false };
  void promise.then(() => {
    status.finished = true;
  });
  return status;
}

function settingsWith(mode: AppSettings['permissions']['controlMode'], manual: boolean): AppSettings {
  const settings = createDefaultSettings();
  settings.permissions.controlMode = mode;
  settings.permissions.manualControlEnabled = manual;
  return settings;
}

describe('applyMirroirConfig', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a long in-flight action instead of skipping the restart', async () => {
    const { ctx, state, restart, record } = fakeCtx(settingsWith('supervised', false));
    state.actionInFlight = true; // e.g. a long scroll_to
    const done = track(applyMirroirConfig(ctx, 'test'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restart).not.toHaveBeenCalled();
    expect(ctx.mirroir.configChanged()).toBe(true);

    state.actionInFlight = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done.finished).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(ctx.mirroir.configChanged()).toBe(false);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: 'mirroir.config_restart', severity: 'warning' }));
  });

  it('does not wait for a task holding control when the change turns input off', async () => {
    const { ctx, restart } = fakeCtx(settingsWith('observe', false));
    const done = track(applyMirroirConfig(ctx, 'Control mode changed to Observe Only'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done.finished).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('turning input off still lets an executing action finish, then restarts', async () => {
    const { ctx, state, restart } = fakeCtx(settingsWith('observe', false));
    state.actionInFlight = true;
    const done = track(applyMirroirConfig(ctx, 'test'));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(restart).not.toHaveBeenCalled();
    state.actionInFlight = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done.finished).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('still defers to an active task while input stays enabled', async () => {
    const { ctx, state, restart } = fakeCtx(settingsWith('assisted', false));
    const done = track(applyMirroirConfig(ctx, 'test'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).not.toHaveBeenCalled();
    state.leaseHeld = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done.finished).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('stops waiting once Mirroir picked up the configuration by itself', async () => {
    const { ctx, state, restart } = fakeCtx(settingsWith('supervised', false));
    state.actionInFlight = true;
    const done = track(applyMirroirConfig(ctx, 'test'));
    await vi.advanceTimersByTimeAsync(40_000);
    state.changed = false; // e.g. a tool timeout restarted Mirroir
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done.finished).toBe(true);
    expect(restart).not.toHaveBeenCalled();
  });
});
