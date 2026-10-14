// Fidelity of the mock Mirroir MCP server itself (it stands in for
// mirroir-mcp 0.40.1 in every device test). Drives it directly with the MCP
// SDK client, with hand-written permission files.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { pngDimensions } from '../../src/device/png.js';
import { classifyInputError, parseDescribeScreen, parseHealth, parseStatus, parseTargets } from '../../src/mcp/parsers.js';
import { makeTempDir, MOCK_SERVER, type MockState } from '../helpers/context.js';

interface Result {
  isError: boolean;
  text: string;
  images: { data: string; mimeType: string }[];
}

interface Mock {
  dir: string;
  call(name: string, args?: Record<string, unknown>): Promise<Result>;
  setState(patch: MockState): void;
  stderr(): string;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

const open: Mock[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** Spawns the mock in a fresh workspace. `permissions` is written verbatim (string) or as JSON; null = no file. */
async function spawnMock(permissions: unknown, state: MockState = {}): Promise<Mock> {
  const dir = makeTempDir('mock-mirroir-');
  mkdirSync(path.join(dir, '.mirroir-mcp'), { recursive: true });
  if (permissions !== null) {
    writeFileSync(
      path.join(dir, '.mirroir-mcp', 'permissions.json'),
      typeof permissions === 'string' ? permissions : JSON.stringify(permissions),
    );
  }
  let current: MockState = { timeScale: 0, ...state };
  writeFileSync(path.join(dir, 'mock-state.json'), JSON.stringify(current));
  const transport = new StdioClientTransport({ command: process.execPath, args: [MOCK_SERVER], cwd: dir, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  const client = new Client({ name: 'fidelity-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const mock: Mock = {
    dir,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
      };
      return {
        isError: r.isError === true,
        text: r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
        images: r.content.filter((c) => c.type === 'image').map((c) => ({ data: c.data ?? '', mimeType: c.mimeType ?? '' })),
      };
    },
    setState(patch) {
      current = { ...current, ...patch };
      writeFileSync(path.join(dir, 'mock-state.json'), JSON.stringify(current));
    },
    stderr: () => stderr,
    async listTools() {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    },
    async close() {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  open.push(mock);
  return mock;
}

const ALL = { allow: ['*'], deny: [], blockedApps: ['Wallet'] };

async function labels(mock: Mock): Promise<string[]> {
  return parseDescribeScreen((await mock.call('describe_screen', { omit_screenshot: true })).text).elements.map((e) => e.label);
}

describe('permissions (PermissionPolicy semantics)', () => {
  it('is fail-closed without a permission file', async () => {
    const mock = await spawnMock(null);
    expect(await mock.listTools()).toHaveLength(12);
    expect(mock.stderr()).toContain('Permission mode: fail-closed (readonly tools only)');
    expect((await mock.call('tap', { x: 1, y: 1 })).text).toBe(
      "Tool 'tap' requires explicit permission. Use --dangerously-skip-permissions or configure ~/.mirroir-mcp/permissions.json.",
    );
  });

  it('fails closed on a malformed file and says where it was', async () => {
    const mock = await spawnMock('{"allow": "tap"}');
    expect(await mock.listTools()).toHaveLength(12);
    // Like Mirroir, the warning names the real (resolved) path of the file it tried.
    expect(mock.stderr()).toContain(
      `Warning: Failed to parse permissions config at ${path.join(realpathSync(mock.dir), '.mirroir-mcp', 'permissions.json')}: The data couldn\u2019t be read because it isn\u2019t in the correct format.`,
    );
    expect((await mock.call('tap', { x: 1, y: 1 })).text).toMatch(/requires explicit permission/);
  });

  it('allows "*" except the deny list, and lists all 38 tools minus denied ones', async () => {
    const mock = await spawnMock({ allow: ['*'], deny: ['Open_URL', 'describe_screen'] });
    const tools = await mock.listTools();
    expect(tools).toHaveLength(37);
    expect(tools).not.toContain('open_url');
    // Read-only tools ignore the deny list.
    expect(tools).toContain('describe_screen');
    expect((await mock.call('open_url', { url: 'https://example.com' })).text).toBe(
      "Tool 'open_url' is blocked by deny list in permissions config. Remove it from the deny list in ~/.mirroir-mcp/permissions.json to allow it.",
    );
  });

  it('matches allow entries case-insensitively and rejects unknown (case-sensitive) tool names', async () => {
    const mock = await spawnMock({ allow: ['Swipe', 'LAUNCH_APP'] });
    expect(await mock.listTools()).toEqual(expect.arrayContaining(['launch_app', 'swipe']));
    expect((await mock.call('press_home')).text).toMatch(/^Tool 'press_home' is not in the allow list/);
    await expect(mock.call('SWIPE')).rejects.toThrow(/Unknown tool: SWIPE/);
  });
});

describe('device states', () => {
  it('reports each mirroring state like Mirroir', async () => {
    const mock = await spawnMock(ALL, { pos: '-1500,40' });
    expect((await mock.call('status')).text).toBe('Connected — mirroring active (window: 410x898, pos=(-1500,40), portrait)');
    expect(parseHealth((await mock.call('check_health')).text).ok).toBe(true);

    mock.setState({ mirroring: 'paused', window: '355x782' });
    expect((await mock.call('status')).text).toBe('Paused — connection paused, can resume');
    expect((await mock.call('get_orientation')).text).toBe('Orientation: portrait (window: 355x782)');
    expect(parseTargets((await mock.call('list_targets')).text)[0]).toMatchObject({ state: 'paused', widthPt: 355 });
    expect((await mock.call('check_health')).text).toContain("[WARN] 'iphone' is paused — click the window to resume");
    const pausedTap = await mock.call('tap', { x: 10, y: 10 });
    expect(pausedTap).toMatchObject({ isError: true, text: "Target 'iphone' is paused. Unlock iPhone or click Resume in the mirroring window." });
    expect(classifyInputError(pausedTap.text)).toBe('paused');
    // AX menu tools "succeed" while paused; screenshot shows the overlay after the resume wait.
    expect((await mock.call('press_home')).isError).toBe(false);
    mock.setState({ resumeDelayMs: 0 });
    expect(await labels(mock)).toEqual(['iPhone Mirroring Paused', 'Resume']);

    mock.setState({ mirroring: 'not_running' });
    expect(parseStatus((await mock.call('status')).text).state).toBe('not_running');
    expect(await mock.call('get_orientation')).toMatchObject({ isError: true, text: "Cannot determine orientation. Is target 'iphone' running?" });
    expect((await mock.call('list_targets')).text).toBe('- iphone (active): notRunning (no window) [appSwitcher, home, menuActions, spotlight]');
    expect((await mock.call('screenshot')).text).toBe("Target 'iphone' is not running");
    expect(classifyInputError((await mock.call('type_text', { text: 'x' })).text)).toBe('not_running');
    expect((await mock.call('press_home')).text).toBe("Failed to press Home. Is 'iphone' running?");

    mock.setState({ mirroring: 'no_window' });
    expect(parseStatus((await mock.call('status')).text).state).toBe('no_window');
    expect(classifyInputError((await mock.call('swipe', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 })).text)).toBe('no_window');
    expect((await mock.call('describe_screen')).text).toBe("Failed to capture/analyze screen. Is the 'iphone' window visible?");
  });

  it('rejects unknown targets', async () => {
    const mock = await spawnMock(ALL);
    expect(await mock.call('status', { target: 'android' })).toMatchObject({ isError: true, text: "Unknown target 'android'" });
    expect((await mock.call('switch_target', { target: 'iphone' })).text).toBe("Switched active target to 'iphone'");
  });
});

describe('screen output', () => {
  it('describes screens with the exact text format, icons, hints and variants', async () => {
    const mock = await spawnMock(ALL, { screen: 'wifi_password' });
    const pw = (await mock.call('describe_screen', { omit_screenshot: true })).text;
    expect(pw.split('\n')[0]).toBe('Screen elements (tap coordinates in points):');
    expect(pw).toContain('- "Enter the password for "Cafe Guest"" at (205, 130)');
    expect(pw).toMatch(/\n\n_meta: ocr_time_ms=\d+ recognition_level=accurate element_count=6$/);

    mock.setState({ screen: 'general' });
    const general = parseDescribeScreen((await mock.call('describe_screen', { omit_screenshot: true })).text);
    expect(general.hints).toEqual(['Back navigation: "<" detected — tap it to go back.']);
    const ys = general.elements.map((e) => e.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));

    mock.setState({ screen: 'app:Photos' });
    expect(parseDescribeScreen((await mock.call('describe_screen', { omit_screenshot: true })).text).hints).toEqual([
      'Tab bar: 4 items detected in the bottom band — tap one to switch sections.',
    ]);

    mock.setState({ screen: 'blank' });
    expect(parseDescribeScreen((await mock.call('describe_screen', { omit_screenshot: true })).text).noText).toBe(true);

    mock.setState({ screen: 'home', ocrFailure: true });
    const failed = parseDescribeScreen((await mock.call('describe_screen', { omit_screenshot: true })).text);
    expect(failed).toMatchObject({ ocrFailed: true, meta: { ocr_status: 'failed' } });
    expect(failed.icons).toHaveLength(4);
  });

  it('scales coordinates and screenshots to the window size', async () => {
    const mock = await spawnMock(ALL, { window: '355x782' });
    const home = parseDescribeScreen((await mock.call('describe_screen', { omit_screenshot: true })).text);
    expect(home.elements.find((e) => e.label === 'Settings')).toMatchObject({ x: Math.trunc((252 * 355) / 410), y: Math.trunc((412 * 782) / 898) });
    const shot = await mock.call('screenshot', { settle_ms: 0 });
    expect(shot.text).toBe('');
    expect(shot.images).toHaveLength(1);
    expect(pngDimensions(Buffer.from(shot.images[0]!.data, 'base64'))).toEqual({ width: 710, height: 1564 });
    // describe_screen returns the gridded image unless omitted.
    const withImage = await mock.call('describe_screen');
    expect(withImage.images[0]!.mimeType).toBe('image/png');
    expect(withImage.images[0]!.data).not.toBe(shot.images[0]!.data);
  });

  it('scrolls the phone for describe_screen(scroll:true), like Mirroir', async () => {
    const mock = await spawnMock(ALL, { screen: 'settings' });
    const page = parseDescribeScreen((await mock.call('describe_screen', { scroll: true, omit_screenshot: true })).text);
    expect(page.scrolled).toBe(true);
    expect(Number(page.meta.scroll_count)).toBeGreaterThan(0);
    expect(page.elements.map((e) => e.label)).toEqual(expect.arrayContaining(['Airplane Mode', 'Privacy & Security', 'Apps']));
    // The phone was left scrolled.
    expect(await labels(mock)).not.toContain('Airplane Mode');
  });
});

describe('input tools', () => {
  it('drives navigation, text fields and toggles', async () => {
    const mock = await spawnMock(ALL);
    expect((await mock.call('tap', { x: 252, y: 412 })).text).toBe('Tapped at (252, 412)');
    expect(await labels(mock)).toContain('Airplane Mode');
    expect((await mock.call('scroll_to', { label: 'Notifications' })).text).toBe("Found 'Notifications' after 1 scroll(s)");
    expect((await mock.call('scroll_to', { label: 'Notifications' })).text).toBe("'Notifications' is already visible on screen");
    expect((await mock.call('scroll_to', { label: 'Nowhere', max_scrolls: 3 })).text).toMatch(/^'Nowhere' not found — scroll exhausted after \d scroll\(s\)$|^'Nowhere' not found after 3 scroll\(s\)$/);

    expect((await mock.call('launch_app', { name: 'sett' })).text).toBe("Launched 'sett' via Spotlight");
    await mock.call('tap', { x: 110, y: 588 });
    expect(await labels(mock)).toEqual(expect.arrayContaining(['Battery Percentage', '87%']));
    await mock.call('tap', { x: 345, y: 170 });
    const after = await labels(mock);
    expect(after).toContain('87');
    expect((await mock.call('press_back')).text).toBe('Pressed back (OCR chevron or canonical fallback)');
    expect(await labels(mock)).toContain('Airplane Mode');

    await mock.call('spotlight');
    expect((await mock.call('type_text', { text: 'Safari\n' })).text).toBe('Typed 7 characters');
    await mock.call('tap', { x: 205, y: 790 });
    await mock.call('type_text', { text: 'example.com' });
    expect((await mock.call('press_key', { key: 'return' })).text).toBe('Pressed return');
    expect(await labels(mock)).toEqual(expect.arrayContaining(['Example Domain', 'example.com']));
  });

  it('reports Mirroir input errors and messages', async () => {
    const mock = await spawnMock(ALL);
    expect((await mock.call('tap', {})).text).toBe('Missing required parameters: x, y (numbers)');
    expect((await mock.call('tap', { x: 1, y: 1, cursor_mode: 'warp' })).text).toBe("Invalid cursor_mode 'warp'. Must be 'direct' or 'preserving'.");
    const bounds = await mock.call('tap', { x: 411.9, y: 5 });
    expect(bounds.text).toBe("Coordinates (411, 5) are outside the 'iphone' window (410x898). x must be 0-410, y must be 0-898.");
    expect(classifyInputError(bounds.text)).toBe('bounds');
    expect((await mock.call('swipe', { from_x: 205, from_y: 600, to_x: 205, to_y: 200 })).text).toBe('Swiped from (205,600) to (205,200)');
    expect((await mock.call('drag', { from_x: 1, from_y: 300, to_x: 1, to_y: 500 })).text).toBe('Dragged from (1,300) to (1,500) over 1000ms');
    expect((await mock.call('long_press', { x: 63.7, y: 112 })).text).toBe('Long pressed at (63, 112) for 500ms');
    expect((await mock.call('double_tap', { x: 5, y: 5 })).text).toBe('Double-tapped at (5, 5)');
    expect((await mock.call('press_key', { key: 'Return' })).text).toBe(
      "Unknown key 'Return'. Supported: delete, down, escape, left, return, right, space, tab, up, or a single character.",
    );
    expect((await mock.call('press_key', { key: 'l', modifiers: ['command', 'hyper'] })).text).toBe(
      "Unknown modifier 'hyper'. Supported: shift, command, option, control.",
    );
    expect((await mock.call('press_key', { key: 'l', modifiers: ['command'] })).text).toBe('Pressed command+l');
    expect((await mock.call('type_text', { text: 'مرحبا 👋' })).text).toMatch(
      /^Typed 7 characters\. Warning: 6 character\(s\) have no key mapping and were sent through the clipboard with Cmd\+V\./,
    );
    expect((await mock.call('launch_app', { name: 'WALLET' })).text).toBe(
      "App 'WALLET' is blocked by permissions config. Remove it from blockedApps in ~/.mirroir-mcp/permissions.json to allow launching it.",
    );
    expect((await mock.call('launch_app', { name: 'Zzz' })).text).toMatch(/^Spotlight is still open after searching 'Zzz', so no app launched\./);
    expect((await mock.call('open_url', { url: 'https://example.com' })).text).toMatch(/^open_url is not supported for iPhone Mirroring targets\./);
    expect((await mock.call('press_home')).text).toBe('Pressed Home — navigated to home screen');
    expect((await mock.call('press_app_switcher')).text).toBe('Opened App Switcher');
    expect((await mock.call('spotlight')).text).toBe('Opened Spotlight search');
    expect((await mock.call('classify_screen')).text).toBe('No component definitions found to classify against');
  });

  it('holds a touch across calls and refuses pointer tools meanwhile', async () => {
    const mock = await spawnMock(ALL);
    expect((await mock.call('touch', { action: 'end' })).text).toBe('No touch is held. Start one with touch(action:"begin").');
    expect((await mock.call('touch', { action: 'begin', x: 252, y: 412 })).text).toBe(
      'Touch began at (252, 412) and is held. End it with touch(action:"end").',
    );
    const refused = await mock.call('tap', { x: 1, y: 1 });
    expect(classifyInputError(refused.text)).toBe('held_touch');
    expect(refused.text).toContain('so tap is refused');
    expect((await mock.call('long_press', { x: 1, y: 1 })).text).toContain('so longPress is refused');
    // Keyboard tools are not refused while a touch is held.
    expect((await mock.call('type_text', { text: 'a' })).isError).toBe(false);
    expect((await mock.call('touch', { action: 'move', x: 252, y: 413, duration_ms: 0 })).text).toMatch(/duration_ms must be between 1 and 5000 \(got 0\)/);
    expect((await mock.call('touch', { action: 'move', x: 253, y: 413 })).text).toBe('Touch moved to (253, 413) and is held.');
    expect((await mock.call('touch', { action: 'end' })).text).toBe('Touch ended at (253, 413).');
    // A short touch is a tap: it opened Settings.
    expect(await labels(mock)).toContain('Airplane Mode');
    expect((await mock.call('touch', { action: 'cancel' })).text).toBe('Touch cancelled: no touch was held; the left button was released anyway.');
    expect((await mock.call('touch', { action: 'wiggle' })).text).toBe("Invalid action 'wiggle'. Must be one of: begin, move, end, cancel.");
  });
});

describe('skills', () => {
  it('lists and reads project-local skills', async () => {
    const mock = await spawnMock(null);
    expect((await mock.call('list_skills')).text).toMatch(/^No skills found\./);
    const skillDir = path.join(mock.dir, '.mirroir-mcp', 'skills', 'iphone-ai');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'check-battery.md'), '---\nname: Check battery\ndescription: Opens Battery settings.\n---\n\n## Steps\n1. Launch Settings\n');
    expect((await mock.call('list_skills')).text).toBe('- Check battery: Opens Battery settings.  [local]');
    const skill = await mock.call('get_skill', { name: 'iphone-ai/check-battery' });
    expect(skill.text).toContain('## Steps');
    expect(skill.text.endsWith('[Not compiled — use record_step after each step to compile]')).toBe(true);
    expect((await mock.call('get_skill', { name: 'nope' })).text).toBe("Skill 'nope' not found. Available skills:\n  - iphone-ai/check-battery");
  });
});

describe('process lifecycle', () => {
  async function rawSpawn() {
    const dir = makeTempDir('mock-mirroir-raw-');
    writeFileSync(path.join(dir, 'mock-state.json'), '{"timeScale":0}');
    const child = spawn(process.execPath, [MOCK_SERVER], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const firstLine = new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) resolve(buf.slice(0, nl));
      });
    });
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    const init = JSON.parse(await firstLine) as { result: { serverInfo: unknown; capabilities: unknown; protocolVersion: string } };
    return { dir, child, send, init };
  }

  it('answers initialize as mirroir-mcp 0.40.1 with only the tools capability', async () => {
    const { dir, child, init } = await rawSpawn();
    expect(init.result.serverInfo).toEqual({ name: 'mirroir-mcp', version: '0.40.1' });
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.protocolVersion).toBe('2025-11-25');
    child.stdin.end();
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 143 on SIGTERM and 130 on SIGINT', async () => {
    for (const [signal, expected] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ] as const) {
      const { dir, child } = await rawSpawn();
      child.kill(signal);
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).toBe(expected);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('crashes (exit 133) on a settle_ms that overflows UInt32 milliseconds', async () => {
    const { dir, child, send } = await rawSpawn();
    send({ id: 2, method: 'tools/call', params: { name: 'screenshot', arguments: { settle_ms: 5_000_000 } } });
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(133);
    rmSync(dir, { recursive: true, force: true });
  });
});
