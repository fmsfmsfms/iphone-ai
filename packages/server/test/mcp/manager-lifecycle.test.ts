// MirroirManager lifecycle regressions: overlapping stop/restart calls,
// startup-failure backoff, a crash during tools/list and a workspace that
// cannot be written. Mock Mirroir and throw-away stub servers only.

import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { McpServerState } from '@iphone-ai/shared';

import { silentLogger } from '../../src/core/logger.js';
import { MirroirManager } from '../../src/mcp/mirroir-manager.js';
import { createDeviceContext, sleep, waitFor, type DeviceContext } from '../helpers/context.js';

let ctx: DeviceContext | null = null;
const extraManagers: MirroirManager[] = [];
const restoreModes: (() => void)[] = [];

afterEach(async () => {
  for (const restore of restoreModes.splice(0)) restore();
  for (const manager of extraManagers.splice(0)) await manager.stop().catch(() => undefined);
  await ctx?.cleanup();
  ctx = null;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startedPids(c: DeviceContext): number[] {
  return c.readMockLog().filter((e) => e.event === 'start' && typeof e.pid === 'number').map((e) => e.pid!);
}

function stubManager(c: DeviceContext, args: string[], autoRestart: boolean): MirroirManager {
  const manager = new MirroirManager({
    paths: c.paths,
    settings: c.settings,
    log: silentLogger,
    activity: c.activity,
    command: { command: process.execPath, args },
    autoRestart,
  });
  extraManagers.push(manager);
  return manager;
}

describe('overlapping lifecycle calls', () => {
  it('concurrent restarts while a tool is in flight leave exactly one running Mirroir', async () => {
    ctx = await createDeviceContext({ mockState: { slowMs: { describe_screen: 2000 } } });
    const c = ctx;
    const pending = c.mirroir.call('describe_screen', { omit_screenshot: true }).catch(() => undefined);
    await waitFor(() => c.calledTools().includes('describe_screen'));

    await Promise.all([c.mirroir.restart('first'), c.mirroir.restart('second')]);
    await pending;
    expect(c.mirroir.isReady()).toBe(true);
    const current = c.mirroir.info().pid!;
    expect(alive(current)).toBe(true);

    // Every other instance this test started must exit (no orphan with its stdin still open).
    await waitFor(() => startedPids(c).filter((pid) => pid !== current).every((pid) => !alive(pid)), {
      timeoutMs: 8000,
      message: `orphaned Mirroir process: ${startedPids(c).filter((pid) => pid !== current && alive(pid)).join(', ')}`,
    });
    expect(startedPids(c)).toHaveLength(2);
    expect(c.mirroir.info().restartCount).toBe(1);
  });

  it('a slow stop() does not detach an instance started while it waited', async () => {
    ctx = await createDeviceContext({ mockState: { slowMs: { describe_screen: 1500 } } });
    const c = ctx;
    const pending = c.mirroir.call('describe_screen', { omit_screenshot: true }).catch(() => undefined);
    await waitFor(() => c.calledTools().includes('describe_screen'));

    const slowStop = c.mirroir.stop(); // waits for the in-flight describe to finish
    await c.mirroir.stop(); // returns at once
    await c.mirroir.start();
    const newer = c.mirroir.info().pid;
    expect(c.mirroir.isReady()).toBe(true);

    await slowStop;
    await pending;
    expect(c.mirroir.isReady()).toBe(true);
    expect(c.mirroir.info()).toMatchObject({ state: 'ready', pid: newer });
    expect((await c.mirroir.call('status')).ok).toBe(true);
  });
});

describe('startup failures', () => {
  it('backs off when the binary dies during the MCP handshake', async () => {
    ctx = await createDeviceContext({ start: false });
    const manager = stubManager(ctx, ['-e', 'process.exit(1)'], true);
    const transitions: { state: McpServerState; at: number }[] = [];
    manager.on('state', (info: { state: McpServerState }) => transitions.push({ state: info.state, at: Date.now() }));

    await manager.start();
    expect(manager.info().state).toBe('crashed');
    await waitFor(() => transitions.filter((t) => t.state === 'crashed').length >= 3, { timeoutMs: 15000, message: 'did not retry twice' });
    await manager.stop();

    // Gap between each crash and the next restart attempt.
    const gaps: number[] = [];
    for (let i = 0; i < transitions.length; i += 1) {
      if (transitions[i]!.state !== 'crashed') continue;
      const next = transitions.slice(i + 1).find((t) => t.state === 'restarting');
      if (next) gaps.push(next.at - transitions[i]!.at);
    }
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps[0]!).toBeGreaterThanOrEqual(1800);
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.5);
  });

  it('a crash during tools/list stays crashed: never "ready" without a client, no mcp.started row', async () => {
    ctx = await createDeviceContext({ start: false });
    const script = path.join(ctx.dir, 'exit-on-tools-list.cjs');
    writeFileSync(
      script,
      `const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.0.0' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.exit(1);
  }
});
`,
    );
    const manager = stubManager(ctx, [script], false);
    const states: McpServerState[] = [];
    manager.on('state', (info: { state: McpServerState }) => states.push(info.state));

    await manager.start();
    await sleep(200);
    expect(states).toContain('crashed');
    expect(states).not.toContain('ready');
    expect(manager.info().state).toBe('crashed');
    expect(manager.isReady()).toBe(false);
    const types = ctx.activity.query({ categories: ['connection'] }).map((e) => e.type);
    expect(types).toContain('mcp.exited');
    expect(types).not.toContain('mcp.started');
  });

  it('reports a workspace that cannot be written as crashed instead of rejecting start()', async () => {
    ctx = await createDeviceContext({ start: false, autoRestart: false });
    const c = ctx;
    const configDir = path.dirname(c.paths.mirroirPermissionsFile);
    // Make sure the directory exists, then make it read-only.
    await c.mirroir.start();
    await c.mirroir.stop();
    chmodSync(configDir, 0o500);
    restoreModes.push(() => chmodSync(configDir, 0o700));

    await expect(c.mirroir.start()).resolves.toBeUndefined();
    expect(c.mirroir.info().state).toBe('crashed');
    expect(c.mirroir.info().lastError).toMatch(/^Could not write the Mirroir workspace: /);
    expect(c.mirroir.isReady()).toBe(false);
  });
});
