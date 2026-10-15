// iPhone AI's own swipe helper (iphone-ai-input): how the backend finds it, how
// it reads the helper's results, and how the DeviceController uses it — glide
// first, Mirroir's swipe as the fallback, STOP ends a running glide. A fake
// helper script stands in for the Swift binary; nothing reaches a real phone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceAction, PolicyDecision } from '@iphone-ai/shared';

import { silentLogger } from '../../src/core/logger.js';
import { DeviceError, type ActionContext } from '../../src/device/device-controller.js';
import { GLIDE_DURATION_MS, InputHelper, resolveInputHelper } from '../../src/device/input-helper.js';
import { createDeviceContext, makeTempDir, waitFor, type DeviceContext } from '../helpers/context.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'input-helper', 'fake-input-helper.mjs');
const ALLOW: PolicyDecision = { verdict: 'allow', risk: 'low', reasons: [], rules: [] };
const GEOMETRY = '410x898';
const PAGE: DeviceAction = { kind: 'swipe', fromX: 205, fromY: 858, toX: 205, toY: 40, durationMs: 300, settle: true };
const user: ActionContext = { actor: 'user', geometryId: GEOMETRY, decision: ALLOW };

type Mode = 'ok' | 'not_trusted' | 'no_window' | 'crash' | 'slow';

/** A fake helper whose behaviour can be switched between runs. */
function fakeHelper(mode: Mode, now?: () => number) {
  const dir = makeTempDir('iphone-ai-input-');
  const config = path.join(dir, 'config.json');
  const log = path.join(dir, 'runs.jsonl');
  const setMode = (next: Mode) => writeFileSync(config, JSON.stringify({ mode: next, log }));
  setMode(mode);
  const input = new InputHelper({ command: process.execPath, args: [FAKE, config] }, silentLogger, now);
  const runs = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { input, setMode, runs };
}

let ctx: DeviceContext | null = null;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

describe('resolveInputHelper', () => {
  it('is never used in mock mode (it would swipe the real phone)', () => {
    expect(resolveInputHelper({ mock: true, env: { IPHONE_AI_INPUT_BIN: FAKE } })).toEqual({
      helper: null,
      reason: 'mock Mirroir mode (there is no real iPhone to swipe)',
    });
  });

  it('takes IPHONE_AI_INPUT_BIN, then the copy next to the node binary, then the repo build', () => {
    expect(resolveInputHelper({ env: { IPHONE_AI_INPUT_BIN: FAKE } }).helper).toEqual({ command: FAKE, args: [] });
    expect(resolveInputHelper({ env: { IPHONE_AI_INPUT_BIN: '/nowhere/iphone-ai-input' } })).toEqual({
      helper: null,
      reason: 'the input helper set in IPHONE_AI_INPUT_BIN was not found (/nowhere/iphone-ai-input)',
    });

    const bundle = makeTempDir('iphone-ai-bundle-');
    const macos = path.join(bundle, 'Contents', 'MacOS');
    mkdirSync(macos, { recursive: true });
    writeFileSync(path.join(macos, 'iphone-ai-input'), '');
    expect(resolveInputHelper({ env: {}, platform: 'darwin', execPath: path.join(macos, 'node'), repoRoot: null }).helper).toEqual({
      command: path.join(macos, 'iphone-ai-input'),
      args: [],
    });

    const repo = makeTempDir('iphone-ai-repo-');
    mkdirSync(path.join(repo, 'src-tauri', 'binaries'), { recursive: true });
    const built = path.join(repo, 'src-tauri', 'binaries', 'iphone-ai-input-aarch64-apple-darwin');
    writeFileSync(built, '');
    expect(resolveInputHelper({ env: {}, platform: 'darwin', arch: 'arm64', execPath: '/usr/bin/node', repoRoot: repo }).helper).toEqual({
      command: built,
      args: [],
    });
    expect(resolveInputHelper({ env: {}, platform: 'darwin', execPath: '/usr/bin/node', repoRoot: null })).toEqual({
      helper: null,
      reason: 'the iphone-ai-input helper is not installed',
    });
    expect(resolveInputHelper({ env: {}, platform: 'linux' }).helper).toBeNull();
  });
});

describe('InputHelper', () => {
  it('runs one glide with the finger travel and the fixed gesture length', async () => {
    const { input, runs } = fakeHelper('ok');
    expect(input.available).toBe(true);
    await expect(input.glide(0, -818)).resolves.toEqual({ ok: true, ms: 320, activated: false });
    expect(runs()).toEqual([['glide', '--dx', '0', '--dy', '-818', '--duration-ms', String(GLIDE_DURATION_MS)]]);
    expect(input.running).toBe(false);
  });

  it('lets Mirroir take over only when the helper posted nothing', async () => {
    const { input, setMode } = fakeHelper('no_window');
    await expect(input.glide(0, -100)).resolves.toMatchObject({ ok: false, fallback: true, code: 'no_window' });
    // A helper that dies without its JSON line may have posted part of the gesture: no second swipe.
    setMode('crash');
    await expect(input.glide(0, -100)).resolves.toMatchObject({ ok: false, fallback: false, code: 'crashed', message: expect.stringContaining('boom') });
    const missing = new InputHelper({ command: '/nowhere/iphone-ai-input', args: [] }, silentLogger);
    await expect(missing.glide(0, -100)).resolves.toMatchObject({ ok: false, fallback: true, code: 'spawn_failed' });
  });

  it('pauses itself for a minute after a missing Accessibility permission', async () => {
    let now = 1_000_000;
    const { input, setMode } = fakeHelper('not_trusted', () => now);
    await expect(input.glide(0, -100)).resolves.toMatchObject({ ok: false, fallback: true, code: 'not_trusted' });
    expect(input.available).toBe(false);
    now += 59_000;
    expect(input.available).toBe(false);
    now += 2_000;
    expect(input.available).toBe(true);
    setMode('ok');
    await expect(input.glide(0, -100)).resolves.toMatchObject({ ok: true });
  });

  it('kill() ends a running glide and reports it as stopped', async () => {
    const { input } = fakeHelper('slow');
    const running = input.glide(0, -818);
    await waitFor(() => input.running, { message: 'the glide never started' });
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the fake install its SIGTERM handler
    input.kill();
    await expect(running).resolves.toMatchObject({ ok: false, fallback: false, code: 'stopped' });
  });
});

describe('DeviceController swipes with the input helper', () => {
  const manual = { settings: { permissions: { manualControlEnabled: true } } };

  it('glides instead of calling Mirroir’s swipe (and sends no settle nudge)', async () => {
    const fake = fakeHelper('ok');
    ctx = await createDeviceContext({ ...manual, input: fake.input });
    await ctx.device.refreshStatus();
    const result = await ctx.device.perform(PAGE, user);
    expect(result).toMatchObject({ ok: true, tool: 'swipe', message: 'Swiped from (205,858) to (205,40) (iPhone AI glide)', focusChanged: true });
    expect(ctx.calledTools()).not.toContain('swipe');
    expect(fake.runs()).toEqual([['glide', '--dx', '0', '--dy', '-818', '--duration-ms', '250']]);
    const audit = ctx.activity.query({ categories: ['manual'] }).find((e) => e.type === 'tool.call');
    expect(audit).toMatchObject({ tool: 'swipe', success: true });
    expect(audit?.detail).toMatchObject({ result: 'Swiped from (205,858) to (205,40) (iPhone AI glide)' });
  });

  it('falls back to Mirroir’s flick and settle nudge when the helper cannot start a gesture', async () => {
    const fake = fakeHelper('no_window');
    ctx = await createDeviceContext({ ...manual, input: fake.input });
    await ctx.device.refreshStatus();
    const result = await ctx.device.perform(PAGE, user);
    expect(result).toMatchObject({ ok: true, message: 'Swiped from (205,858) to (205,40)' });
    expect(ctx.readMockCalls().filter((call) => call.name === 'swipe')).toHaveLength(2);
    expect(fake.runs()).toHaveLength(1);
  });

  it('reports a helper that stopped part-way as a failed swipe, without swiping again through Mirroir', async () => {
    const fake = fakeHelper('crash');
    ctx = await createDeviceContext({ ...manual, input: fake.input });
    await ctx.device.refreshStatus();
    const result = await ctx.device.perform(PAGE, user);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Swipe failed: the input helper exited with 1/);
    expect(ctx.calledTools()).not.toContain('swipe');
  });

  it('leaves taps and other input to Mirroir', async () => {
    const fake = fakeHelper('ok');
    ctx = await createDeviceContext({ ...manual, input: fake.input });
    await ctx.device.refreshStatus();
    await ctx.device.perform({ kind: 'tap', x: 252, y: 412 }, user);
    await ctx.device.perform({ kind: 'drag', fromX: 100, fromY: 400, toX: 250, toY: 400, durationMs: 400 }, user);
    expect(fake.runs()).toHaveLength(0);
    expect(ctx.calledTools()).toEqual(expect.arrayContaining(['tap', 'drag']));
  });

  it('STOP ends a running glide without restarting Mirroir, and the swipe is reported as stopped', async () => {
    const fake = fakeHelper('slow');
    ctx = await createDeviceContext({ settings: { permissions: { controlMode: 'supervised' } }, input: fake.input });
    await ctx.device.refreshStatus();
    const lease = ctx.device.acquireLease('ai', 'Paging task');
    const running = ctx.device.perform(PAGE, { actor: 'ai', leaseId: lease.id, geometryId: GEOMETRY, decision: ALLOW }).then(
      () => null,
      (err: unknown) => err,
    );
    await waitFor(() => fake.input.running, { message: 'the glide never started' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pid = ctx.mirroir.info().pid;
    await ctx.device.emergencyStop('User pressed STOP', 'user');
    const err = await running;
    expect(err).toBeInstanceOf(DeviceError);
    expect((err as DeviceError).code).toBe('stop_latched');
    expect(ctx.mirroir.info().pid).toBe(pid);
    expect(ctx.readMockLog().some((entry) => entry.signal === 'SIGTERM')).toBe(false);
    const audit = ctx.activity.query({ categories: ['security'] }).find((e) => e.type === 'stop.engaged');
    expect(audit?.detail).toMatchObject({ interruptedInFlight: 'ai:swipe', note: expect.stringContaining('input helper was ended') });
  });
});
