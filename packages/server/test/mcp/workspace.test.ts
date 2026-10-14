// Project-local Mirroir configuration generated for the app's workspace.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALWAYS_DENIED_TOOLS, createDefaultSettings, type AppSettings } from '@iphone-ai/shared';

import { ensureAppDirectories, resolveAppPaths } from '../../src/core/paths.js';
import {
  buildMirroirSettings,
  buildPermissionFile,
  inputEnabled,
  isMutatingTool,
  MANUAL_TOOLS,
  MUTATING_TOOLS,
  READONLY_TOOLS,
  workspaceFingerprint,
  writeMirroirWorkspace,
} from '../../src/mcp/workspace.js';
import { makeTempDir, MOCK_TOOLS_FILE } from '../helpers/context.js';

function settingsWith(mutate: (s: AppSettings) => void): AppSettings {
  const s = createDefaultSettings();
  mutate(s);
  return s;
}

let dir: string;
let globalFile: string;

beforeEach(() => {
  dir = makeTempDir();
  globalFile = path.join(dir, 'global-settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tool classification', () => {
  it('matches Mirroir: 12 read-only + 26 mutating = the 38 tools of the real catalogue', () => {
    expect(READONLY_TOOLS).toHaveLength(12);
    expect(MUTATING_TOOLS).toHaveLength(26);
    const catalogue = (JSON.parse(readFileSync(MOCK_TOOLS_FILE, 'utf8')) as { name: string }[]).map((t) => t.name).sort();
    expect([...READONLY_TOOLS, ...MUTATING_TOOLS].sort()).toEqual(catalogue);
    expect(READONLY_TOOLS.some((t) => MUTATING_TOOLS.includes(t))).toBe(false);
  });

  it('classifies mutating tools', () => {
    expect(isMutatingTool('tap')).toBe(true);
    expect(isMutatingTool('touch')).toBe(true);
    expect(isMutatingTool('screenshot')).toBe(false);
    expect(isMutatingTool('describe_screen')).toBe(false);
    expect(isMutatingTool('finish_task')).toBe(false);
  });
});

describe('buildPermissionFile', () => {
  it('allows nothing in Observe Only with manual control off (fail-closed)', () => {
    const settings = createDefaultSettings();
    expect(inputEnabled(settings)).toBe(false);
    const file = buildPermissionFile(settings);
    expect(file.allow).toEqual([]);
    expect(file.deny).toEqual([...new Set([...ALWAYS_DENIED_TOOLS, 'open_url'])].sort());
  });

  it('allows the manual tools plus touch when manual control is on', () => {
    const settings = settingsWith((s) => {
      s.permissions.manualControlEnabled = true;
    });
    expect(inputEnabled(settings)).toBe(true);
    expect(buildPermissionFile(settings).allow).toEqual([...MANUAL_TOOLS, 'touch'].sort());
  });

  it('enables input for AI control modes even with manual control off', () => {
    for (const mode of ['assisted', 'supervised'] as const) {
      const settings = settingsWith((s) => {
        s.permissions.controlMode = mode;
      });
      expect(inputEnabled(settings)).toBe(true);
      expect(buildPermissionFile(settings).allow).toEqual([...MANUAL_TOOLS, 'touch'].sort());
    }
  });

  it('never allows always-denied tools, open_url or non-mutating names, whatever the AI list says', () => {
    const settings = settingsWith((s) => {
      s.permissions.controlMode = 'supervised';
      s.permissions.aiAllowedTools = [...ALWAYS_DENIED_TOOLS, 'open_url', 'pinch', 'screenshot', 'finish_task', 'tap'];
    });
    const file = buildPermissionFile(settings);
    for (const tool of [...ALWAYS_DENIED_TOOLS, 'open_url', 'screenshot', 'finish_task']) {
      expect(file.allow).not.toContain(tool);
    }
    expect(file.allow).toContain('pinch');
    expect(file.allow).toContain('tap');
    for (const tool of [...ALWAYS_DENIED_TOOLS, 'open_url']) expect(file.deny).toContain(tool);
    expect(file.allow).toEqual([...file.allow].sort());
  });

  it('sorts blockedApps and keeps only ASCII skip keywords from enabled rules', () => {
    const settings = settingsWith((s) => {
      s.permissions.blockedApps = ['Wallet', 'alrajhi', 'Bank', 'PayPal'];
      s.permissions.sensitiveRules = [
        { id: 'a', label: 'A', keywords: ['send', 'إرسال', 'delete'], effect: 'require_approval', enabled: true },
        { id: 'b', label: 'B', keywords: ['buy'], effect: 'deny', enabled: false },
      ];
    });
    const file = buildPermissionFile(settings);
    expect(file.blockedApps).toEqual(['alrajhi', 'Bank', 'PayPal', 'Wallet']);
    expect(file.skipElements).toEqual(['delete', 'send']);
  });
});

describe('buildMirroirSettings', () => {
  it('carries global keys over (read only) and forces local OCR', () => {
    writeFileSync(
      globalFile,
      JSON.stringify({
        keyboardLayout: 'French',
        ocrLanguages: ['en-US', 'ar-SA'],
        screenDescriberMode: 'vision',
        componentDetection: 'llm_every_screen',
        agent: 'embacle',
        describeScreenOmitScreenshot: true,
      }),
    );
    const before = readFileSync(globalFile, 'utf8');
    const settings = buildMirroirSettings(globalFile);
    expect(settings).toEqual({
      keyboardLayout: 'French',
      ocrLanguages: ['en-US', 'ar-SA'],
      screenDescriberMode: 'ocr',
      componentDetection: 'heuristic',
      agent: '',
      describeScreenOmitScreenshot: false,
    });
    expect(readFileSync(globalFile, 'utf8')).toBe(before);
  });

  it('keeps an empty keyboardLayout (the common global value)', () => {
    writeFileSync(globalFile, '{"keyboardLayout": ""}');
    expect(buildMirroirSettings(globalFile).keyboardLayout).toBe('');
  });

  it('falls back to overrides only when the global file is missing, invalid or not an object', () => {
    const overrides = { screenDescriberMode: 'ocr', componentDetection: 'heuristic', agent: '', describeScreenOmitScreenshot: false };
    expect(buildMirroirSettings(path.join(dir, 'missing.json'))).toEqual(overrides);
    writeFileSync(globalFile, '{not json');
    expect(buildMirroirSettings(globalFile)).toEqual(overrides);
    writeFileSync(globalFile, '["keyboardLayout"]');
    expect(buildMirroirSettings(globalFile)).toEqual(overrides);
  });
});

describe('writeMirroirWorkspace / workspaceFingerprint', () => {
  it('writes both files (owner-only) into <workspace>/.mirroir-mcp and returns the fingerprint', () => {
    const paths = resolveAppPaths({ dataDir: path.join(dir, 'data'), webDistDir: null });
    ensureAppDirectories(paths);
    writeFileSync(globalFile, '{"keyboardLayout":"German"}');
    const settings = createDefaultSettings();
    const fp = writeMirroirWorkspace(paths, settings, globalFile);
    expect(fp).toBe(workspaceFingerprint(settings, globalFile));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);

    expect(paths.mirroirPermissionsFile).toBe(path.join(paths.mirroirWorkspace, '.mirroir-mcp', 'permissions.json'));
    const permissions = JSON.parse(readFileSync(paths.mirroirPermissionsFile, 'utf8')) as { allow: string[] };
    expect(permissions.allow).toEqual([]);
    const mirroirSettings = JSON.parse(readFileSync(paths.mirroirSettingsFile, 'utf8')) as Record<string, unknown>;
    expect(mirroirSettings).toMatchObject({ keyboardLayout: 'German', screenDescriberMode: 'ocr' });
    expect(statSync(paths.mirroirPermissionsFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.mirroirSettingsFile).mode & 0o777).toBe(0o600);
  });

  it('changes when the control mode, manual switch, blocked apps or global keys change', () => {
    writeFileSync(globalFile, '{"keyboardLayout":""}');
    const base = createDefaultSettings();
    const fp = workspaceFingerprint(base, globalFile);
    expect(workspaceFingerprint(createDefaultSettings(), globalFile)).toBe(fp);

    expect(workspaceFingerprint(settingsWith((s) => (s.permissions.controlMode = 'supervised')), globalFile)).not.toBe(fp);
    expect(workspaceFingerprint(settingsWith((s) => (s.permissions.manualControlEnabled = true)), globalFile)).not.toBe(fp);
    expect(workspaceFingerprint(settingsWith((s) => s.permissions.blockedApps.push('Notes')), globalFile)).not.toBe(fp);
    writeFileSync(globalFile, '{"keyboardLayout":"French"}');
    expect(workspaceFingerprint(base, globalFile)).not.toBe(fp);
  });

  it('does not change for settings Mirroir does not see', () => {
    const fp = workspaceFingerprint(createDefaultSettings(), globalFile);
    expect(workspaceFingerprint(settingsWith((s) => (s.general.theme = 'light')), globalFile)).toBe(fp);
    expect(workspaceFingerprint(settingsWith((s) => (s.ai.maxActionsPerTask = 3)), globalFile)).toBe(fp);
  });

  it('is the same for assisted and supervised (same allow list)', () => {
    expect(workspaceFingerprint(settingsWith((s) => (s.permissions.controlMode = 'assisted')), globalFile)).toBe(
      workspaceFingerprint(settingsWith((s) => (s.permissions.controlMode = 'supervised')), globalFile),
    );
  });
});
