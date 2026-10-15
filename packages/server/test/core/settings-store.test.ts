// SettingsStore: safe defaults, validated patches, invariants, persistence.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { ALWAYS_DENIED_TOOLS, createDefaultSettings, DEFAULT_AI_TOOLS, DEFAULT_LIVE_FPS, MAX_LIVE_FPS, type AppSettings } from '@iphone-ai/shared';

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

  // Changed with live capture: the screenshot policy gained liveCapture/liveFps.
  // It used to be replaced wholesale; it now merges, so a client that still
  // sends only the four polling fields does not silently reset the live keys.
  it('merges a patched screenshot policy over the current one (older clients omit the live keys)', () => {
    ctx.settings.update({ connection: { screenshot: { ...ctx.settings.get().connection.screenshot, liveCapture: false, liveFps: 12 } } });
    const next = ctx.settings.update({
      connection: { screenshot: { activeFps: 4, idleFps: 0.5, idleAfterMs: 10000, pauseWhenHidden: false } as never },
    });
    expect(next.connection.screenshot).toEqual({
      activeFps: 4,
      idleFps: 0.5,
      idleAfterMs: 10000,
      pauseWhenHidden: false,
      liveCapture: false,
      liveFps: 12,
    });
    expect(next.connection.target).toBe('iphone');
  });

  it('defaults to live capture at 10 fps, accepts 5–60 from older clients and stores at most 15 (single-screenshot capture)', () => {
    expect(DEFAULT_LIVE_FPS).toBe(10);
    expect(MAX_LIVE_FPS).toBe(15);
    expect(ctx.settings.get().connection.screenshot).toMatchObject({ liveCapture: true, liveFps: 10 });
    const screenshot = ctx.settings.get().connection.screenshot;
    expect(() => ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 61 } } })).toThrow(ZodError);
    expect(() => ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 4 } } })).toThrow(ZodError);
    expect(() => ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 12.5 } } })).toThrow(ZodError);
    expect(ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 60 } } }).connection.screenshot.liveFps).toBe(15);
    expect(ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 30 } } }).connection.screenshot.liveFps).toBe(15);
    expect(ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 12 } } }).connection.screenshot.liveFps).toBe(12);
    expect(ctx.settings.update({ connection: { screenshot: { ...screenshot, liveFps: 5 } } }).connection.screenshot.liveFps).toBe(5);
    expect(storedRow(ctx.db).connection.screenshot.liveFps).toBe(5);
  });

  it('uses the faster observation defaults (settle 450 ms, request timeout 30 s)', () => {
    expect(ctx.settings.get().ai.settleDelayMs).toBe(450);
    expect(ctx.settings.get().connection.requestTimeoutMs).toBe(30000);
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

  it('fills the live-capture keys into a screenshot policy stored by an older version', () => {
    const old = createDefaultSettings() as unknown as { connection: { screenshot: Record<string, unknown> } };
    old.connection.screenshot = { activeFps: 3, idleFps: 0.5, idleAfterMs: 20000, pauseWhenHidden: false };
    ctx.db.run("UPDATE settings SET value = ? WHERE key = 'app'", JSON.stringify(old));
    expect(new SettingsStore(ctx.db).get().connection.screenshot).toEqual({
      activeFps: 3,
      idleFps: 0.5,
      idleAfterMs: 20000,
      pauseWhenHidden: false,
      liveCapture: true,
      liveFps: 10,
    });
  });

  it('migrates the live frame rate once: the old 30 fps default → 10, anything above 15 → 15, custom values kept', () => {
    // A database written by 0.2.0: only the earlier migration was recorded.
    const storeLiveFps = (liveFps: number) => {
      const old = createDefaultSettings();
      old.connection.screenshot.liveFps = liveFps;
      ctx.db.run("UPDATE settings SET value = ? WHERE key = 'app'", JSON.stringify(old));
      ctx.db.run("UPDATE settings SET value = ? WHERE key = 'migrations'", JSON.stringify(['2026-10-faster-observation']));
    };

    storeLiveFps(30);
    expect(new SettingsStore(ctx.db).get().connection.screenshot.liveFps).toBe(10);
    // Persisted, not only applied in memory.
    expect(storedRow(ctx.db).connection.screenshot.liveFps).toBe(10);

    storeLiveFps(60);
    expect(new SettingsStore(ctx.db).get().connection.screenshot.liveFps).toBe(15);
    expect(storedRow(ctx.db).connection.screenshot.liveFps).toBe(15);

    storeLiveFps(20);
    expect(new SettingsStore(ctx.db).get().connection.screenshot.liveFps).toBe(15);

    storeLiveFps(12);
    expect(new SettingsStore(ctx.db).get().connection.screenshot.liveFps).toBe(12);

    // Recorded as done: a 30 stored afterwards is only clamped (15), not treated as the old default again.
    const migrated = JSON.parse(ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'migrations'")!.value) as string[];
    expect(migrated).toContain('2026-10-live-snapshot-fps');
    const later = createDefaultSettings();
    later.connection.screenshot.liveFps = 30;
    ctx.db.run("UPDATE settings SET value = ? WHERE key = 'app'", JSON.stringify(later));
    expect(new SettingsStore(ctx.db).get().connection.screenshot.liveFps).toBe(15);
  });

  it('migrates users still on the old defaults (settle 900 → 450 ms, timeout 60 → 30 s) once, keeping custom values', () => {
    const storeOld = (settleDelayMs: number, requestTimeoutMs: number) => {
      const old = createDefaultSettings();
      old.ai.settleDelayMs = settleDelayMs;
      old.connection.requestTimeoutMs = requestTimeoutMs;
      ctx.db.run("UPDATE settings SET value = ? WHERE key = 'app'", JSON.stringify(old));
      // A database written before the migration existed.
      ctx.db.run("DELETE FROM settings WHERE key = 'migrations'");
    };

    storeOld(900, 60000);
    const migrated = new SettingsStore(ctx.db).get();
    expect(migrated.ai.settleDelayMs).toBe(450);
    expect(migrated.connection.requestTimeoutMs).toBe(30000);
    // Persisted, not only applied in memory.
    expect(storedRow(ctx.db).ai.settleDelayMs).toBe(450);
    expect(storedRow(ctx.db).connection.requestTimeoutMs).toBe(30000);

    storeOld(1200, 90000);
    const custom = new SettingsStore(ctx.db).get();
    expect(custom.ai.settleDelayMs).toBe(1200);
    expect(custom.connection.requestTimeoutMs).toBe(90000);

    // Once migrated, choosing the old values again sticks across restarts.
    const store = new SettingsStore(ctx.db);
    store.update({ ai: { settleDelayMs: 900 }, connection: { requestTimeoutMs: 60000 } });
    const reloaded = new SettingsStore(ctx.db).get();
    expect(reloaded.ai.settleDelayMs).toBe(900);
    expect(reloaded.connection.requestTimeoutMs).toBe(60000);
  });

  it('adds the 0.5.0 payment keywords to the payment rule once, keeping the user\'s edits', () => {
    const NEW = ['pay', 'payment', 'order now', 'اطلب', 'أطلب', 'ادفع', 'الدفع'];
    const payment = (s: AppSettings) => s.permissions.sensitiveRules.find((r) => r.id === 'payment');
    /** Settings as 0.4.x stored them: the payment rule without the new keywords, before this migration. */
    const storeOld = (edit: (rules: AppSettings['permissions']['sensitiveRules']) => void) => {
      const old = createDefaultSettings();
      const rule = payment(old)!;
      rule.keywords = rule.keywords.filter((k) => !NEW.includes(k));
      edit(old.permissions.sensitiveRules);
      ctx.db.run("UPDATE settings SET value = ? WHERE key = 'app'", JSON.stringify(old));
      ctx.db.run("UPDATE settings SET value = ? WHERE key = 'migrations'", JSON.stringify(['2026-10-faster-observation', '2026-10-live-snapshot-fps']));
    };

    // Still on the old defaults: becomes exactly the new default rule.
    storeOld(() => undefined);
    const defaults = payment(createDefaultSettings())!;
    expect(payment(new SettingsStore(ctx.db).get())).toEqual(defaults);
    expect(payment(storedRow(ctx.db))).toEqual(defaults);

    // Customized: the user's keywords, effect and off switch are kept; only missing keywords are added.
    storeOld((rules) => {
      const rule = rules.find((r) => r.id === 'payment')!;
      rule.keywords = ['buy', 'mada', 'PAY'];
      rule.effect = 'deny';
      rule.enabled = false;
    });
    expect(payment(new SettingsStore(ctx.db).get())).toMatchObject({
      keywords: ['buy', 'mada', 'PAY', 'payment', 'order now', 'اطلب', 'أطلب', 'ادفع', 'الدفع'],
      effect: 'deny',
      enabled: false,
    });

    // The user deleted the payment rule: it is not brought back.
    storeOld((rules) => rules.splice(rules.findIndex((r) => r.id === 'payment'), 1));
    const loaded = new SettingsStore(ctx.db).get();
    expect(payment(loaded)).toBeUndefined();
    expect(loaded.permissions.sensitiveRules.map((r) => r.id)).toEqual(['auth', 'messaging', 'destructive', 'security']);

    // Runs once: a keyword the user removes afterwards stays removed.
    const store = new SettingsStore(ctx.db);
    const rules = createDefaultSettings().permissions.sensitiveRules.map((r) => (r.id === 'payment' ? { ...r, keywords: ['buy'] } : r));
    store.update({ permissions: { sensitiveRules: rules } });
    expect(payment(new SettingsStore(ctx.db).get())!.keywords).toEqual(['buy']);
  });

  it('never migrates a fresh install later (the old values chosen on purpose stick)', () => {
    ctx.settings.update({ ai: { settleDelayMs: 900 }, connection: { requestTimeoutMs: 60000 } });
    const reloaded = new SettingsStore(ctx.db).get();
    expect(reloaded.ai.settleDelayMs).toBe(900);
    expect(reloaded.connection.requestTimeoutMs).toBe(60000);
  });

  it('falls back to defaults when the stored row is not valid JSON', () => {
    ctx.db.run("UPDATE settings SET value = '{broken' WHERE key = 'app'");
    expect(new SettingsStore(ctx.db).get()).toEqual(createDefaultSettings());
  });
});
