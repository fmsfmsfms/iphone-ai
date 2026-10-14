// Persistent application settings with safe defaults and validated patches.

import { EventEmitter } from 'node:events';

import {
  ALWAYS_DENIED_TOOLS,
  createDefaultSettings,
  DEFAULT_LIVE_FPS,
  MAX_LIVE_FPS,
  MIN_LIVE_FPS,
  settingsPatchSchema,
  type AppSettings,
  type SettingsPatch,
} from '@iphone-ai/shared';

import type { Database } from '../db/database.js';

const SETTINGS_KEY = 'app';
/** Row holding the ids of one-time settings migrations already applied. */
const MIGRATIONS_KEY = 'migrations';

/**
 * One-time migrations of values that were defaults in older versions. A user
 * still on the old default gets the new one; any other (customized) value is
 * kept. Each runs once per database, so choosing the old value again later
 * sticks.
 */
const MIGRATIONS: readonly { id: string; apply(settings: AppSettings): void }[] = [
  {
    // 0.1.x: faster AI observation (settle 900 → 450 ms) and a shorter request timeout (60 → 30 s).
    id: '2026-10-faster-observation',
    apply(settings) {
      if (settings.ai.settleDelayMs === 900) settings.ai.settleDelayMs = 450;
      if (settings.connection.requestTimeoutMs === 60000) settings.connection.requestTimeoutMs = 30000;
    },
  },
];

type SettingsListener = (next: AppSettings, previous: AppSettings) => void;

export class SettingsStore {
  private current: AppSettings;
  private readonly emitter = new EventEmitter();

  constructor(private readonly db: Database) {
    this.current = this.load();
  }

  get(): AppSettings {
    return structuredClone(this.current);
  }

  /** Validates and applies a partial update. Throws a ZodError on invalid input. */
  update(patch: SettingsPatch | unknown): AppSettings {
    const parsed = settingsPatchSchema.parse(patch);
    const previous = this.current;
    const next = structuredClone(previous);
    for (const [section, values] of Object.entries(parsed)) {
      if (!values) continue;
      const target = next[section as keyof Omit<AppSettings, 'version'>] as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(values)) {
        target[key] = mergeNested(target[key], value);
      }
    }
    sanitize(next);
    this.current = next;
    this.save();
    this.emitter.emit('change', this.get(), previous);
    return this.get();
  }

  /** Internal updates (e.g. hasApiKey flags) that bypass the public patch schema. */
  mutate(fn: (draft: AppSettings) => void): AppSettings {
    const previous = this.current;
    const next = structuredClone(previous);
    fn(next);
    sanitize(next);
    this.current = next;
    this.save();
    this.emitter.emit('change', this.get(), previous);
    return this.get();
  }

  onChange(listener: SettingsListener): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings();
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY);
    if (!row) {
      this.persist(defaults);
      // Fresh install: already on the current defaults.
      this.recordMigrations(MIGRATIONS.map((m) => m.id));
      return defaults;
    }
    let stored: Partial<AppSettings>;
    try {
      stored = JSON.parse(row.value) as Partial<AppSettings>;
    } catch {
      return defaults;
    }
    const merged = mergeDefaults(defaults, stored);
    sanitize(merged);
    const done = this.appliedMigrations();
    const pending = MIGRATIONS.filter((m) => !done.has(m.id));
    if (pending.length > 0) {
      for (const migration of pending) migration.apply(merged);
      sanitize(merged);
      this.persist(merged);
      this.recordMigrations([...done, ...pending.map((m) => m.id)]);
    }
    return merged;
  }

  private appliedMigrations(): Set<string> {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', MIGRATIONS_KEY);
    if (!row) return new Set();
    try {
      const ids = JSON.parse(row.value) as unknown;
      return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private recordMigrations(ids: readonly string[]): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      MIGRATIONS_KEY,
      JSON.stringify([...new Set(ids)]),
      Date.now(),
    );
  }

  private save(): void {
    this.persist(this.current);
  }

  private persist(settings: AppSettings): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      SETTINGS_KEY,
      JSON.stringify(settings),
      Date.now(),
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A patched value: nested plain objects (connection.screenshot) are merged
 * over the current value so keys an older client omits are kept; arrays and
 * scalars replace it.
 */
export function mergeNested(current: unknown, value: unknown): unknown {
  if (isPlainObject(current) && isPlainObject(value)) {
    const out: Record<string, unknown> = { ...current };
    for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = structuredClone(v);
    return out;
  }
  return structuredClone(value);
}

/** Fills in fields added in newer versions while keeping stored user values. */
function mergeDefaults(defaults: AppSettings, stored: Partial<AppSettings>): AppSettings {
  const out = structuredClone(defaults) as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(stored) as [string, unknown][]) {
    if (section === 'version') continue;
    const base = out[section];
    if (isPlainObject(base) && isPlainObject(value)) {
      const merged: Record<string, unknown> = { ...base, ...value };
      // One level deeper for nested objects (connection.screenshot gained live-capture keys).
      for (const [key, nested] of Object.entries(base)) {
        const storedNested = value[key];
        if (isPlainObject(nested) && isPlainObject(storedNested)) merged[key] = { ...nested, ...storedNested };
      }
      out[section] = merged;
    }
  }
  return out as unknown as AppSettings;
}

/** Enforces invariants no matter what was stored or patched. */
function sanitize(settings: AppSettings): void {
  settings.version = 1;
  settings.automation.unattendedRunsEnabled = false;
  const denied = new Set(ALWAYS_DENIED_TOOLS.map((t) => t.toLowerCase()));
  settings.permissions.aiAllowedTools = [
    ...new Set(settings.permissions.aiAllowedTools.filter((t) => !denied.has(t.toLowerCase()))),
  ];
  settings.permissions.blockedApps = [...new Set(settings.permissions.blockedApps.map((a) => a.trim()).filter(Boolean))];
  if (!settings.ai.providers.some((p) => p.id === settings.ai.activeProviderId) && settings.ai.providers[0]) {
    settings.ai.activeProviderId = settings.ai.providers[0].id;
  }
  if (settings.ai.visionProviderId && !settings.ai.providers.some((p) => p.id === settings.ai.visionProviderId)) {
    settings.ai.visionProviderId = null;
  }
  if (!settings.remote.passcodeSet) settings.remote.enabled = false;
  const screenshot = settings.connection.screenshot;
  if (typeof screenshot.liveCapture !== 'boolean') screenshot.liveCapture = true;
  screenshot.liveFps = Number.isFinite(screenshot.liveFps)
    ? Math.min(MAX_LIVE_FPS, Math.max(MIN_LIVE_FPS, Math.round(screenshot.liveFps)))
    : DEFAULT_LIVE_FPS;
}
