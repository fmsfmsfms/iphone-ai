// Persistent application settings with safe defaults and validated patches.

import { EventEmitter } from 'node:events';

import {
  ALWAYS_DENIED_TOOLS,
  createDefaultSettings,
  settingsPatchSchema,
  type AppSettings,
  type SettingsPatch,
} from '@iphone-ai/shared';

import type { Database } from '../db/database.js';

const SETTINGS_KEY = 'app';

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
        target[key] = structuredClone(value);
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
    return merged;
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

/** Fills in fields added in newer versions while keeping stored user values. */
function mergeDefaults(defaults: AppSettings, stored: Partial<AppSettings>): AppSettings {
  const out = structuredClone(defaults) as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(stored)) {
    if (section === 'version') continue;
    const base = out[section];
    if (base && typeof base === 'object' && !Array.isArray(base) && value && typeof value === 'object') {
      out[section] = { ...(base as Record<string, unknown>), ...(value as unknown as Record<string, unknown>) };
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
}
