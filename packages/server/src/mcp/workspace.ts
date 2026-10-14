// Generates the project-local Mirroir configuration that iPhone AI launches
// Mirroir with. Mirroir reads <cwd>/.mirroir-mcp/{permissions,settings}.json
// once at startup and uses them INSTEAD of ~/.mirroir-mcp (no merge), so the
// user's global configuration is never modified.
//
// The permission file is an explicit allow list (never "*"): in Observe Only
// mode with manual control off it allows nothing, so Mirroir itself refuses
// every input tool (fail-closed at both layers).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { ALWAYS_DENIED_TOOLS, type AppSettings } from '@iphone-ai/shared';

import type { AppPaths } from '../core/paths.js';

/** Mirroir tools that read state only. Always available; never need permission. */
export const READONLY_TOOLS: readonly string[] = [
  'screenshot',
  'describe_screen',
  'start_recording',
  'stop_recording',
  'get_orientation',
  'status',
  'check_health',
  'list_targets',
  'list_skills',
  'get_skill',
  'calibrate_component',
  'classify_screen',
];

/** Mutating tools as classified by Mirroir's PermissionPolicy.swift. */
export const MUTATING_TOOLS: readonly string[] = [
  'tap',
  'swipe',
  'drag',
  'type_text',
  'press_key',
  'long_press',
  'double_tap',
  'touch',
  'pinch',
  'rotate',
  'hold_keys',
  'shake',
  'launch_app',
  'open_url',
  'press_home',
  'press_app_switcher',
  'press_back',
  'spotlight',
  'scroll_to',
  'reset_app',
  'measure',
  'set_network',
  'switch_target',
  'record_step',
  'save_compiled',
  'generate_skill',
];

/** Tools the manual controls in the Live viewer use. */
export const MANUAL_TOOLS: readonly string[] = [
  'tap',
  'double_tap',
  'long_press',
  'swipe',
  'drag',
  'type_text',
  'press_key',
  'press_home',
  'press_back',
  'press_app_switcher',
  'spotlight',
  'launch_app',
  'scroll_to',
];

/** `touch` is allowed whenever input is allowed so STOP can always send touch(cancel). */
const SAFETY_TOOLS: readonly string[] = ['touch'];

/** Unsupported on the iPhone target (Mirroir always refuses it) — never exposed. */
const UNSUPPORTED_TOOLS: readonly string[] = ['open_url'];

export interface MirroirPermissionFile {
  allow: string[];
  deny: string[];
  blockedApps: string[];
  skipElements: string[];
}

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.includes(name);
}

/** Input is possible only when the user enabled manual control or chose an AI control mode. */
export function inputEnabled(settings: AppSettings): boolean {
  return settings.permissions.manualControlEnabled || settings.permissions.controlMode !== 'observe';
}

export function buildPermissionFile(settings: AppSettings): MirroirPermissionFile {
  const deny = [...new Set([...ALWAYS_DENIED_TOOLS, ...UNSUPPORTED_TOOLS])].sort();
  const allow = inputEnabled(settings)
    ? [...new Set([...MANUAL_TOOLS, ...settings.permissions.aiAllowedTools, ...SAFETY_TOOLS])]
        .filter((t) => MUTATING_TOOLS.includes(t) && !deny.includes(t))
        .sort()
    : [];
  return {
    allow,
    deny,
    blockedApps: [...settings.permissions.blockedApps].sort((a, b) => a.localeCompare(b)),
    skipElements: settings.permissions.sensitiveRules
      .filter((r) => r.enabled)
      .flatMap((r) => r.keywords)
      .filter((k) => /^[\x20-\x7e]+$/.test(k))
      .sort(),
  };
}

/**
 * Project-local settings.json. Mirroir uses this file wholesale instead of the
 * global one, so user keys from ~/.mirroir-mcp/settings.json (read only) are
 * carried over, then iPhone AI's required overrides are applied.
 */
export function buildMirroirSettings(globalSettingsFile = path.join(homedir(), '.mirroir-mcp', 'settings.json')): Record<string, unknown> {
  let global: Record<string, unknown> = {};
  try {
    if (existsSync(globalSettingsFile)) {
      const parsed = JSON.parse(readFileSync(globalSettingsFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) global = parsed as Record<string, unknown>;
    }
  } catch {
    global = {};
  }
  return {
    ...global,
    // Local OCR only: screen contents never leave the Mac through Mirroir.
    screenDescriberMode: 'ocr',
    componentDetection: 'heuristic',
    agent: '',
    describeScreenOmitScreenshot: false,
  };
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Writes the workspace configuration and returns a fingerprint. When the
 * fingerprint changes, Mirroir must be restarted (it reads config once).
 */
export function writeMirroirWorkspace(paths: AppPaths, settings: AppSettings, globalSettingsFile?: string): string {
  const permissions = buildPermissionFile(settings);
  const mirroirSettings = buildMirroirSettings(globalSettingsFile);
  writeJsonAtomic(paths.mirroirPermissionsFile, permissions);
  writeJsonAtomic(paths.mirroirSettingsFile, mirroirSettings);
  return fingerprint(permissions, mirroirSettings);
}

/** Fingerprint of the configuration that would be written, without touching disk. */
export function workspaceFingerprint(settings: AppSettings, globalSettingsFile?: string): string {
  return fingerprint(buildPermissionFile(settings), buildMirroirSettings(globalSettingsFile));
}

function fingerprint(permissions: MirroirPermissionFile, mirroirSettings: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(permissions))
    .update(JSON.stringify(mirroirSettings))
    .digest('hex')
    .slice(0, 16);
}
