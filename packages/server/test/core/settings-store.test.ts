// SettingsStore: safe defaults, validated patches, invariants, persistence.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { ALWAYS_DENIED_TOOLS, createDefaultSettings, DEFAULT_AI_TOOLS, type AppSettings } from '@iphone-ai/shared';

import { SettingsStore } from '../../src/core/settings-store.js';
import { Database } from '../../src/db/database.js';
import { createCoreContext, type CoreContext } from '../helpers/context.js';

let ctx: CoreContext;

beforeEach(() => {
  ctx = createCoreContext({ fileDatabase: true });
});

afterEach(async () => {
  await ctx.cleanup();
});

function storedRow(db: Database): AppSettings {
  return JSON.parse(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'")!.value) as AppSettings;
}

describe('defaults', () => {
  it('starts observe-only with manual control off, blocked apps and no unattended runs', () => {
    const s = ctx.settings.get();
    expect(s).toEqual(createDefaultSettings());
    expect(s.permissions.controlMode).toBe('observe');
    expect(s.permissions.manualControlEnabled).toBe(false);
    expect(s.permissions.blockedApps).toContain('Wallet');
    expect(s.permissions.aiAllowedTools).toEqual([...DEFAULT_AI_TOOLS]);
    expect(s.automation.unattendedRunsEnabled).toBe(false);
    expect(s.remote.enabled).toBe(false);
    expect(s.privacy.storeScreenshots).toBe(false);
    expect(s.privacy.logTypedText).toBe(false);
  });

  it('persists the defaults on first load', () => {
    expect(storedRow(ctx.db)).toEqual(createDefaultSettings());
  });

  it('hands out copies', () => {
    const a = ctx.settings.get();
    a.permissions.controlMode = 'supervised';
    expect(ctx.settings.get().permissions.controlMode).toBe('observe');
  });
});

describe('update', () => {
  it('applies a partial patch and notifies listeners with next and previous', () => {
    const seen: [AppSettings, AppSettings][] = [];
    const off = ctx.settings.onChange((next, previous) => seen.push([next, previous]));
    const next = ctx.settings.update({ permissions: { controlMode: 'supervised' }, general: { theme: 'light' } });
    expect(next.permissions.controlMode).toBe('supervised');
    expect(next.permissions.blockedApps).toContain('Wallet');
    expect(next.general.language).toBe('en');
    expect(seen).toHaveLength(1);
    expect(seen[0]![0].general.theme).toBe('light');
    expect(seen[0]![1].general.theme).toBe('dark');
    off();
    ctx.settings.update({ general: { theme: 'system' } });
    expect(seen).toHaveLength(1);
  });

  it('replaces nested objects such as the screenshot policy wholesale', () => {
    const next = ctx.settings.update({
      connection: { screenshot: { activeFps: 4, idleFps: 0.5, idleAfterMs: 10000, pauseWhenHidden: false } },
    });
    expect(next.connection.screenshot).toEqual({ activeFps: 4, idleFps: 0.5, idleAfterMs: 10000, pauseWhenHidden: false });
    expect(next.connection.target).toBe('iphone');
  });

  it('rejects invalid values, unknown sections and protected fields', () => {
    const before = ctx.settings.get();
    expect(() => ctx.settings.update({ permissions: { controlMode: 'yolo' } })).toThrow(ZodError);
    expect(() => ctx.settings.update({ connection: { requestTimeoutMs: 10 } })).toThrow(ZodError);
    expect(() => ctx.settings.update({ hacks: { enabled: true } })).toThrow(ZodError);
    expect(() => ctx.settings.update({ automation: { unattendedRunsEnabled: true } })).not.toThrow();
    expect(ctx.settings.get().automation.unattendedRunsEnabled).toBe(false);
    expect(() => ctx.settings.update({ remote: { passcodeSet: true } })).not.toThrow();
    expect(ctx.settings.get().remote.passcodeSet).toBe(false);
    expect(() => ctx.settings.update('nope')).toThrow(ZodError);
    expect({ ...ctx.settings.get(), automation: before.automation, remote: before.remote }).toEqual(before);
  });
});

describe('invariants', () => {
  it('strips always-denied tools from the AI tool list (case-insensitive) and dedupes', () => {
    const next = ctx.settings.update({
      permissions: { aiAllowedTools: ['tap', 'Set_Network', 'reset_app', 'tap', 'swipe', ...ALWAYS_DENIED_TOOLS] },
    });
    expect(next.permissions.aiAllowedTools).toEqual(['tap', 'swipe']);
  });

  it('trims and dedupes blocked apps', () => {
    const next = ctx.settings.update({ permissions: { blockedApps: [' Wallet ', 'Wallet', 'Bank'] } });
    expect(next.permissions.blockedApps).toEqual(['Wallet', 'Bank']);
  });

  it('keeps unattended runs disabled even through internal mutation', () => {
    const next = ctx.settings.mutate((draft) => {
      (draft.automation as { unattendedRunsEnabled: boolean }).unattendedRunsEnabled = true;
    });
    expect(next.automation.unattendedRunsEnabled).toBe(false);
  });

  it('keeps remote access disabled until a passcode is set', () => {
    expect(ctx.settings.update({ remote: { enabled: true } }).remote.enabled).toBe(false);
    ctx.settings.mutate((d) => {
      d.remote.passcodeSet = true;
    });
    expect(ctx.settings.update({ remote: { enabled: true } }).remote.enabled).toBe(true);
    ctx.settings.mutate((d) => {
      d.remote.passcodeSet = false;
    });
    expect(ctx.settings.get().remote.enabled).toBe(false);
  });

  it('repairs dangling provider references', () => {
    const next = ctx.settings.update({ ai: { activeProviderId: 'missing', visionProviderId: 'also-missing' } });
    expect(next.ai.activeProviderId).toBe('claude-api');
    expect(next.ai.visionProviderId).toBeNull();
  });
});

describe('persistence', () => {
  it('survives a restart (new Database + SettingsStore on the same file)', () => {
    ctx.settings.update({ permissions: { controlMode: 'assisted', manualControlEnabled: true }, privacy: { logTypedText: true } });
    ctx.db.close();
    const db = new Database(ctx.paths.dbFile);
    try {
      const reloaded = new SettingsStore(db).get();
      expect(reloaded.permissions.controlMode).toBe('assisted');
      expect(reloaded.permissions.manualControlEnabled).toBe(true);
      expect(reloaded.privacy.logTypedText).toBe(true);
    } finally {
      db.close();
    }
  });

  it('sanitises tampered rows and fills in fields missing from older versions', () => {
    const tampered = createDefaultSettings() as unknown as Record<string, Record<string, unknown>>;
    tampered.automation!.unattendedRunsEnabled = true;
    (tampered.permissions as { aiAllowedTools: string[] }).aiAllowedTools = ['tap', 'reset_app', 'hold_keys'];
    tampered.remote!.enabled = true;
    delete tampered.privacy!.cloudDisclosureAcknowledged;
    delete (tampered as Record<string, unknown>).advanced;
    ctx.db.run("UPDATE settings SET value = ? WHERE key = 'app'", JSON.stringify(tampered));

    const loaded = new SettingsStore(ctx.db).get();
    expect(loaded.automation.unattendedRunsEnabled).toBe(false);
    expect(loaded.permissions.aiAllowedTools).toEqual(['tap']);
    expect(loaded.remote.enabled).toBe(false);
    expect(loaded.privacy.cloudDisclosureAcknowledged).toBe(false);
    expect(loaded.advanced).toEqual({ debugLogging: false, mcpTrace: false });
  });

  it('falls back to defaults when the stored row is not valid JSON', () => {
    ctx.db.run("UPDATE settings SET value = '{broken' WHERE key = 'app'");
    expect(new SettingsStore(ctx.db).get()).toEqual(createDefaultSettings());
  });
});
