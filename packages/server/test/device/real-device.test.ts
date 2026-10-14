// REAL DEVICE acceptance tests — read-only.
//
// Skipped (and excluded by vitest.config.ts) unless IPHONE_AI_DEVICE_TESTS=1:
//   IPHONE_AI_DEVICE_TESTS=1 pnpm --filter @iphone-ai/server test:device
//
// Uses the installed Mirroir binary (realpath of /opt/homebrew/bin/mirroir) in
// a temporary workspace whose project-local permissions.json is fail-closed
// (allow: []), exactly as iPhone AI launches it in Observe Only mode. It only
// READS: status, get_orientation, list_targets and `mirroir doctor --json`;
// screenshot and describe_screen run only when doctor confirms Screen
// Recording AND status says Connected (otherwise they could press Resume or
// activate the Mirroring window). No input tool is ever called.
//
// Note: the real Mirroir writes its own log to ~/.mirroir-mcp/debug.log on
// startup (Mirroir behaviour that cannot be redirected); nothing else under
// ~/.mirroir-mcp is read or written by this test.

import { existsSync, readFileSync, realpathSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_MIRROIR_BINARY } from '@iphone-ai/shared';

import { silentLogger } from '../../src/core/logger.js';
import { pngDimensions } from '../../src/device/png.js';
import { MirroirManager } from '../../src/mcp/mirroir-manager.js';
import {
  parseDescribeScreen,
  parseOrientation,
  parseStatus,
  parseTargets,
  type DoctorCheck,
  type ParsedStatus,
} from '../../src/mcp/parsers.js';
import { READONLY_TOOLS } from '../../src/mcp/workspace.js';
import { createCoreContext, type CoreContext } from '../helpers/context.js';

const ENABLED = process.env.IPHONE_AI_DEVICE_TESTS === '1';
const READ_TOOLS = new Set(['status', 'get_orientation', 'list_targets', 'screenshot', 'describe_screen']);

function report(line: string): void {
  console.log(`[real-device] ${line}`);
}

describe.skipIf(!ENABLED)('real Mirroir + iPhone (read-only)', () => {
  let core: CoreContext;
  let mirroir: MirroirManager;
  let status: ParsedStatus | null = null;
  let doctor: DoctorCheck[] | null = null;
  const called: string[] = [];

  async function read(tool: string, args: Record<string, unknown> = {}) {
    // Guard rail: this suite must never send input to the phone.
    if (!READ_TOOLS.has(tool)) throw new Error(`refusing to call non-read tool ${tool}`);
    called.push(tool);
    return mirroir.call(tool, args, { timeoutMs: 120000 });
  }

  beforeAll(async () => {
    if (!existsSync(DEFAULT_MIRROIR_BINARY)) {
      throw new Error(`Mirroir is not installed at ${DEFAULT_MIRROIR_BINARY}`);
    }
    core = createCoreContext();
    // Defaults: Observe Only, manual control off → fail-closed permission file.
    mirroir = new MirroirManager({
      paths: core.paths,
      settings: core.settings,
      log: silentLogger,
      activity: core.activity,
      autoRestart: false,
    });
    await mirroir.start();
  });

  afterAll(async () => {
    await mirroir?.stop();
    await core?.cleanup();
    report(`tools called: ${called.join(', ') || '(none)'}`);
  });

  it('launches the real binary (symlink resolved) with a fail-closed workspace', () => {
    expect(mirroir.resolveBinary()).toBe(realpathSync(DEFAULT_MIRROIR_BINARY));
    const permissions = JSON.parse(readFileSync(core.paths.mirroirPermissionsFile, 'utf8')) as { allow: string[] };
    expect(permissions.allow).toEqual([]);
    const info = mirroir.info();
    expect(info.state).toBe('ready');
    report(`binary ${mirroir.resolveBinary()} (mirroir-mcp ${info.version ?? '?'}, pid ${info.pid})`);
  });

  it('lists only the read-only tools', () => {
    const tools = mirroir.info().tools;
    expect(tools.map((t) => t.name)).toEqual([...READONLY_TOOLS].sort());
    expect(tools.some((t) => t.mutating)).toBe(false);
    report(`tools/list: ${tools.length} read-only tools, no input tools exposed`);
  });

  it('reads status, orientation and targets', async () => {
    const statusOut = await read('status');
    expect(statusOut.ok).toBe(true);
    status = parseStatus(statusOut.text);
    expect(['connected', 'paused', 'not_running', 'no_window']).toContain(status.state);
    report(`status: ${status.raw}`);

    const orientationOut = await read('get_orientation');
    if (status.state === 'connected' || status.state === 'paused') {
      const orientation = parseOrientation(orientationOut.text);
      expect(orientation).not.toBeNull();
      if (status.geometry && orientation) {
        expect(orientation.widthPt).toBe(status.geometry.widthPt);
        expect(orientation.heightPt).toBe(status.geometry.heightPt);
      }
    }
    report(`get_orientation: ${orientationOut.text}`);

    const targetsOut = await read('list_targets');
    const targets = parseTargets(targetsOut.text);
    expect(targets.some((t) => t.name === 'iphone')).toBe(true);
    report(`list_targets: ${targetsOut.text.replace(/\n/g, ' | ')}`);
  });

  it('runs mirroir doctor --json', async () => {
    doctor = await mirroir.runDoctor();
    expect(doctor).not.toBeNull();
    const names = doctor!.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Screen capture', 'Accessibility']));
    for (const check of doctor!) report(`doctor: ${check.name} = ${check.status} (${check.detail})`);
  }, 30000);

  it('captures a screenshot and describes the screen when allowed', async (context) => {
    const screenRecording = doctor?.find((c) => c.name === 'Screen capture')?.status === 'passed';
    if (!screenRecording || status?.state !== 'connected') {
      report(
        `screenshot/describe_screen skipped: Screen Recording ${screenRecording ? 'granted' : 'not granted'}, mirroring ${status?.state ?? 'unknown'}`,
      );
      context.skip();
      return;
    }
    const shot = await read('screenshot', { settle_ms: 0 });
    expect(shot.ok).toBe(true);
    const image = shot.images[0];
    expect(image?.mimeType).toBe('image/png');
    const dims = pngDimensions(Buffer.from(image!.data, 'base64'));
    expect(dims).not.toBeNull();
    const pxPerPt = status.geometry ? dims!.width / status.geometry.widthPt : null;
    report(`screenshot: ${dims!.width}x${dims!.height} px (${pxPerPt ?? '?'} px/pt)`);

    const described = await read('describe_screen', { omit_screenshot: true });
    expect(described.ok).toBe(true);
    const parsed = parseDescribeScreen(described.text);
    expect(parsed.ocrFailed).toBe(false);
    report(`describe_screen: ${parsed.elements.length} elements (${parsed.icons.length} icons), meta ${JSON.stringify(parsed.meta)}`);
  }, 180000);
});
