// MirroirManager against the mock Mirroir MCP server (real child process,
// real MCP SDK client, real project-local permission file).

import { afterEach, describe, expect, it } from 'vitest';

import type { McpServerState } from '@iphone-ai/shared';

import { McpTimeoutError, McpUnavailableError } from '../../src/mcp/mirroir-manager.js';
import { isPermissionDenial, parseDescribeScreen, parseStatus } from '../../src/mcp/parsers.js';
import { MANUAL_TOOLS, READONLY_TOOLS } from '../../src/mcp/workspace.js';
import { base64PngDimensions } from '../../src/device/png.js';
import { createDeviceContext, waitFor, type DeviceContext } from '../helpers/context.js';

let ctx: DeviceContext | null = null;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

function recordStates(c: DeviceContext): McpServerState[] {
  const states: McpServerState[] = [];
  c.mirroir.on('state', (info: { state: McpServerState }) => states.push(info.state));
  return states;
}

describe('MirroirManager with the mock server', () => {
  it('starts ready with only the 12 read-only tools under the fail-closed configuration', async () => {
    ctx = await createDeviceContext();
    const info = ctx.mirroir.info();
    expect(info.state).toBe('ready');
    expect(ctx.mirroir.isReady()).toBe(true);
    expect(info.version).toBe('0.40.1');
    expect(info.pid).toBeGreaterThan(0);
    expect(info.tools.map((t) => t.name)).toEqual([...READONLY_TOOLS].sort());
    expect(info.tools.every((t) => !t.mutating)).toBe(true);
    expect(info.tools.find((t) => t.name === 'screenshot')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { settle_ms: { type: 'integer' } },
    });
    expect(ctx.mirroir.hasTool('tap')).toBe(false);
    expect(ctx.mirroir.configChanged()).toBe(false);

    const started = ctx.activity.query({ categories: ['connection'] }).find((e) => e.type === 'mcp.started');
    expect(started?.summary).toContain('12 tools (0 input tools allowed)');
    expect(ctx.mirroir.recentStderr().some((l) => l.includes('Permission mode: config-based'))).toBe(true);
  });

  it('exposes the manual tools plus touch when manual control is enabled', async () => {
    ctx = await createDeviceContext({ settings: { permissions: { manualControlEnabled: true } } });
    const tools = ctx.mirroir.info().tools;
    const mutating = tools.filter((t) => t.mutating).map((t) => t.name);
    expect(mutating).toEqual([...MANUAL_TOOLS, 'touch'].sort());
    expect(tools).toHaveLength(READONLY_TOOLS.length + MANUAL_TOOLS.length + 1);
    expect(ctx.mirroir.hasTool('open_url')).toBe(false);
    expect(ctx.mirroir.hasTool('set_network')).toBe(false);
  });

  it('reports configChanged() after a permission-relevant settings change', async () => {
    ctx = await createDeviceContext();
    expect(ctx.mirroir.configChanged()).toBe(false);
    ctx.settings.update({ general: { theme: 'light' } });
    expect(ctx.mirroir.configChanged()).toBe(false);
    ctx.settings.update({ permissions: { manualControlEnabled: true } });
    expect(ctx.mirroir.configChanged()).toBe(true);
    await ctx.mirroir.restart('permissions changed');
    expect(ctx.mirroir.configChanged()).toBe(false);
    expect(ctx.mirroir.hasTool('tap')).toBe(true);
    expect(ctx.mirroir.info().restartCount).toBe(1);
  });

  it('calls status and describe_screen', async () => {
    ctx = await createDeviceContext();
    const status = await ctx.mirroir.call('status');
    expect(status.ok).toBe(true);
    expect(status.text).toBe('Connected — mirroring active (window: 410x898, pos=(1200,80), portrait)');
    expect(parseStatus(status.text).geometry).toMatchObject({ widthPt: 410, heightPt: 898 });
    expect(status.images).toEqual([]);

    const described = await ctx.mirroir.call('describe_screen', {});
    expect(described.ok).toBe(true);
    const parsed = parseDescribeScreen(described.text);
    expect(parsed.elements.map((e) => e.label)).toEqual(expect.arrayContaining(['Settings', 'Safari', 'Messages', 'Photos', 'Wallet']));
    expect(described.images).toHaveLength(1);
    expect(described.images[0]!.mimeType).toBe('image/png');
    expect(base64PngDimensions(described.images[0]!.data)).toEqual({ width: 820, height: 1796 });

    const textOnly = await ctx.mirroir.call('describe_screen', { omit_screenshot: true });
    expect(textOnly.images).toEqual([]);
    expect(ctx.calledTools()).toEqual(['status', 'describe_screen', 'describe_screen']);
  });

  it('gets input refused by the mock permission layer when the tool is not allowed', async () => {
    ctx = await createDeviceContext();
    const tap = await ctx.mirroir.call('tap', { x: 252, y: 412 });
    expect(tap.ok).toBe(false);
    expect(tap.text).toBe(
      "Tool 'tap' is not in the allow list. Add it to the allow list in ~/.mirroir-mcp/permissions.json or use --dangerously-skip-permissions.",
    );
    expect(isPermissionDenial(tap.text)).toBe(true);

    const openUrl = await ctx.mirroir.call('open_url', { url: 'https://example.com' });
    expect(openUrl.ok).toBe(false);
    expect(openUrl.text).toMatch(/^Tool 'open_url' is blocked by deny list/);

    // The phone did not move: still on the home screen.
    const screen = parseDescribeScreen((await ctx.mirroir.call('describe_screen', { omit_screenshot: true })).text);
    expect(screen.elements.some((e) => e.label === 'Weather')).toBe(true);
  });

  it('enforces blockedApps on launch_app (exact, case-insensitive)', async () => {
    ctx = await createDeviceContext({ settings: { permissions: { manualControlEnabled: true } } });
    const blocked = await ctx.mirroir.call('launch_app', { name: 'wallet' });
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toBe(
      "App 'wallet' is blocked by permissions config. Remove it from blockedApps in ~/.mirroir-mcp/permissions.json to allow launching it.",
    );
    const launched = await ctx.mirroir.call('launch_app', { name: 'Settings' });
    expect(launched).toMatchObject({ ok: true, text: "Launched 'Settings' via Spotlight" });
  });

  it('rejects unknown tool names with a JSON-RPC error', async () => {
    ctx = await createDeviceContext();
    await expect(ctx.mirroir.call('TAP')).rejects.toThrow(/Unknown tool: TAP/);
    expect(ctx.mirroir.isReady()).toBe(true);
  });

  it('marks a crash, then restarts automatically to ready', async () => {
    ctx = await createDeviceContext({ mockState: { crashOnCall: 'get_orientation' } });
    const states = recordStates(ctx);
    const firstPid = ctx.mirroir.info().pid;

    await expect(ctx.mirroir.call('get_orientation')).rejects.toBeInstanceOf(McpUnavailableError);
    await waitFor(() => states.includes('crashed'), { message: 'never reported crashed' });
    expect(ctx.mirroir.info().lastError).toMatch(/exited unexpectedly/);
    await expect(ctx.mirroir.call('status')).rejects.toBeInstanceOf(McpUnavailableError);

    ctx.writeMockState({ crashOnCall: undefined });
    await waitFor(() => ctx!.mirroir.isReady(), { timeoutMs: 15000, message: 'never restarted' });
    expect(states).toEqual(expect.arrayContaining(['crashed', 'restarting', 'ready']));
    expect(ctx.mirroir.info().restartCount).toBe(1);
    expect(ctx.mirroir.info().pid).not.toBe(firstPid);
    expect(ctx.activity.query({}).some((e) => e.type === 'mcp.exited')).toBe(true);
    expect(ctx.readMockLog().some((e) => e.event === 'crash')).toBe(true);
    expect((await ctx.mirroir.call('get_orientation')).text).toBe('Orientation: portrait (window: 410x898)');
  });

  it('terminate() sends SIGTERM (Mirroir releases held input) and stops', async () => {
    ctx = await createDeviceContext();
    await ctx.mirroir.terminate('test stop');
    expect(ctx.mirroir.info()).toMatchObject({ state: 'stopped', lastError: 'test stop', pid: null, tools: [] });
    await waitFor(() => ctx!.readMockLog().some((e) => e.signal === 'SIGTERM'), { message: 'mock never saw SIGTERM' });
    await expect(ctx.mirroir.call('status')).rejects.toBeInstanceOf(McpUnavailableError);

    await ctx.mirroir.start();
    expect(ctx.mirroir.isReady()).toBe(true);
  });

  it('stop() closes stdin gracefully (no signal)', async () => {
    ctx = await createDeviceContext();
    await ctx.mirroir.stop();
    expect(ctx.mirroir.info().state).toBe('stopped');
    await waitFor(() => ctx!.readMockLog().some((e) => e.event === 'exit'));
    expect(ctx.readMockLog().some((e) => e.signal)).toBe(false);
  });

  it('times out a wedged call, terminates Mirroir and restarts it', async () => {
    ctx = await createDeviceContext({ mockState: { slowMs: { status: 5000 } } });
    const states = recordStates(ctx);
    const started = Date.now();
    await expect(ctx.mirroir.call('status', {}, { timeoutMs: 300 })).rejects.toBeInstanceOf(McpTimeoutError);
    expect(Date.now() - started).toBeLessThan(4000);
    await waitFor(() => ctx!.readMockLog().some((e) => e.signal === 'SIGTERM'), { message: 'no SIGTERM after timeout' });

    ctx.writeMockState({ slowMs: {} });
    await waitFor(() => ctx!.mirroir.isReady(), { timeoutMs: 15000 });
    expect(states).toContain('stopped');
    expect(states[states.length - 1]).toBe('ready');
    expect(ctx.mirroir.info().restartCount).toBe(1);
    expect((await ctx.mirroir.call('status')).ok).toBe(true);
  });

  it('serialises calls like Mirroir: a slow call delays the next one', async () => {
    ctx = await createDeviceContext({ mockState: { slowMs: { get_orientation: 600 } } });
    const started = Date.now();
    const [slow, fast] = await Promise.all([ctx.mirroir.call('get_orientation'), ctx.mirroir.call('status')]);
    expect(slow.ok && fast.ok).toBe(true);
    expect(fast.durationMs).toBeGreaterThanOrEqual(500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });

  it('reports binary_missing for a missing Mirroir binary without spawning anything', async () => {
    ctx = await createDeviceContext({ start: false });
    const { MirroirManager } = await import('../../src/mcp/mirroir-manager.js');
    const { silentLogger } = await import('../../src/core/logger.js');
    ctx.settings.update({ connection: { mirroirBinaryPath: '/nonexistent/iphone-ai-test/mirroir' } });
    const manager = new MirroirManager({ paths: ctx.paths, settings: ctx.settings, log: silentLogger, activity: ctx.activity });
    expect(manager.resolveBinary()).toBeNull();
    await manager.start();
    expect(manager.info().state).toBe('binary_missing');
    expect(manager.info().lastError).toContain('/nonexistent/iphone-ai-test/mirroir');
    await expect(manager.call('status')).rejects.toThrow(/not found/);
    expect(await manager.runDoctor()).toBeNull();
  });
});
