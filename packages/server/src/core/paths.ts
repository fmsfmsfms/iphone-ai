// Filesystem locations used by the backend.
//
// Production: ~/Library/Application Support/iPhone AI
// Development: <repo>/.data (or IPHONE_AI_DATA_DIR)
//
// Mirroir is always launched with `cwd = mirroirWorkspace`, so the
// project-local `.mirroir-mcp/permissions.json` written there applies to it
// and the user's global ~/.mirroir-mcp configuration is never modified.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface AppPaths {
  dataDir: string;
  dbFile: string;
  logsDir: string;
  logFile: string;
  screenshotsDir: string;
  exportsDir: string;
  mirroirWorkspace: string;
  mirroirConfigDir: string;
  mirroirPermissionsFile: string;
  mirroirSettingsFile: string;
  mirroirSkillsDir: string;
  /** Directory containing the built web UI, if present. */
  webDistDir: string | null;
}

export function resolveAppPaths(options: { dataDir?: string; webDistDir?: string | null } = {}): AppPaths {
  const dataDir =
    options.dataDir ??
    process.env.IPHONE_AI_DATA_DIR ??
    path.join(homedir(), 'Library', 'Application Support', 'iPhone AI');
  const logsDir = path.join(dataDir, 'logs');
  const mirroirWorkspace = path.join(dataDir, 'mirroir-workspace');
  const mirroirConfigDir = path.join(mirroirWorkspace, '.mirroir-mcp');
  return {
    dataDir,
    dbFile: path.join(dataDir, 'iphone-ai.sqlite'),
    logsDir,
    logFile: path.join(logsDir, 'iphone-ai.log'),
    screenshotsDir: path.join(dataDir, 'screenshots'),
    exportsDir: path.join(dataDir, 'exports'),
    mirroirWorkspace,
    mirroirConfigDir,
    mirroirPermissionsFile: path.join(mirroirConfigDir, 'permissions.json'),
    mirroirSettingsFile: path.join(mirroirConfigDir, 'settings.json'),
    mirroirSkillsDir: path.join(mirroirConfigDir, 'skills', 'iphone-ai'),
    webDistDir: options.webDistDir ?? process.env.IPHONE_AI_WEB_DIST ?? null,
  };
}

/** Creates every directory with owner-only permissions (data may include screenshots). */
export function ensureAppDirectories(paths: AppPaths): void {
  for (const dir of [
    paths.dataDir,
    paths.logsDir,
    paths.screenshotsDir,
    paths.exportsDir,
    paths.mirroirWorkspace,
    paths.mirroirConfigDir,
    paths.mirroirSkillsDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
