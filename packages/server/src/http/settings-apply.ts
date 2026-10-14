// Applying settings changes made through the API: audit them, and restart
// Mirroir when its project-local permission/settings files changed (Mirroir
// reads them once at startup). The restart waits until no device action is
// executing and — while input stays enabled — no AI task / workflow is
// actively holding control. It is never skipped while the running Mirroir
// still has the old configuration.

import { settingsPatchSchema, type Actor, type AppSettings, type ControlMode, type SettingsPatch } from '@iphone-ai/shared';

import type { AppContext } from '../core/services.js';
import { inputEnabled } from '../mcp/workspace.js';

/**
 * The shared settingsPatchSchema requires every top-level section to be
 * present; API patches may name any subset, so sections are made optional
 * here (still strict: unknown sections and keys are rejected).
 */
const partialSettingsPatchSchema = settingsPatchSchema.partial();

/** Validates a settings patch (throws ZodError → 400). */
export function parseSettingsPatch(body: unknown): SettingsPatch {
  return partialSettingsPatchSchema.parse(body ?? {}) as SettingsPatch;
}

/** Applies an already validated patch section by section (SettingsStore.mutate re-applies invariants). */
export function applySettingsPatch(ctx: AppContext, patch: SettingsPatch): AppSettings {
  return ctx.settings.mutate((draft) => {
    for (const [section, values] of Object.entries(patch)) {
      if (!values || typeof values !== 'object') continue;
      const target = draft[section as keyof Omit<AppSettings, 'version'>] as unknown as Record<string, unknown> | undefined;
      if (!target) continue;
      for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        if (value !== undefined) target[key] = structuredClone(value);
      }
    }
  });
}

const IDLE_WAIT_MS = 30_000;
const IN_FLIGHT_WAIT_MS = 15_000;
const POLL_MS = 500;

export const CONTROL_MODE_LABELS: Record<ControlMode, string> = {
  observe: 'Observe Only',
  assisted: 'Assisted Control',
  supervised: 'Supervised Automation',
};

const pendingRestarts = new WeakMap<object, Promise<void>>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function busy(ctx: AppContext, waitForLease = true): boolean {
  const status = ctx.device.getStatus();
  const lease = ctx.device.currentLease;
  const state = ctx.mirroir.info().state;
  return (
    status.actionInFlight || (waitForLease && lease !== null && !lease.paused) || state === 'starting' || state === 'restarting'
  );
}

/**
 * Restarts Mirroir (in the background) if the running server loaded an older
 * configuration. Concurrent calls coalesce into one restart. Never throws.
 */
export function applyMirroirConfig(ctx: AppContext, reason: string): Promise<void> {
  if (!ctx.mirroir.configChanged()) return Promise.resolve();
  const existing = pendingRestarts.get(ctx.mirroir);
  if (existing) return existing;
  const run = (async () => {
    for (let attempt = 0; attempt < 3 && ctx.mirroir.configChanged(); attempt += 1) {
      // When the new settings turn input off, policy already refuses every
      // further input, so a task holding control is not waited for: until the
      // restart, Mirroir still allows the old input tools.
      const waitForLease = inputEnabled(ctx.settings.get());
      const deadline = Date.now() + IDLE_WAIT_MS;
      while (busy(ctx, waitForLease) && Date.now() < deadline) await sleep(POLL_MS);
      const forced = busy(ctx);
      if (forced) {
        // Never cut an executing input call short, and never give up either:
        // wait for it to end. Mirroir's tool timeouts bound this (a timeout
        // restarts Mirroir, which loads the new configuration by itself).
        const warnAt = Date.now() + IN_FLIGHT_WAIT_MS;
        let warned = false;
        while (ctx.device.getStatus().actionInFlight && ctx.mirroir.configChanged()) {
          if (!warned && Date.now() >= warnAt) {
            warned = true;
            ctx.log.warn('Mirroir restart for new settings is waiting for an executing action to finish');
          }
          await sleep(POLL_MS);
        }
      }
      // Not running: the next start writes the new configuration anyway.
      if (!ctx.mirroir.isReady() || !ctx.mirroir.configChanged()) return;
      await ctx.mirroir.restart(reason);
      ctx.activity.record({
        category: 'connection',
        type: 'mirroir.config_restart',
        actor: 'system',
        severity: forced ? 'warning' : 'info',
        summary: forced
          ? 'Mirroir was restarted while a task held control so the new permissions take effect.'
          : 'Mirroir was restarted so the new permissions take effect.',
        detail: { reason },
      });
    }
  })()
    .catch((err: unknown) => {
      ctx.log.error('Mirroir restart after settings change failed', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      pendingRestarts.delete(ctx.mirroir);
    });
  pendingRestarts.set(ctx.mirroir, run);
  return run;
}

/** Dotted paths of the settings that differ between two snapshots, limited to the patched sections. */
export function changedSettingPaths(previous: AppSettings, next: AppSettings, sections?: readonly string[]): string[] {
  const out: string[] = [];
  const prev = previous as unknown as Record<string, Record<string, unknown>>;
  const curr = next as unknown as Record<string, Record<string, unknown>>;
  for (const section of sections ?? Object.keys(curr)) {
    if (section === 'version') continue;
    const a = prev[section] ?? {};
    const b = curr[section] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(`${section}.${key}`);
    }
  }
  return out;
}

function describeValue(value: unknown): unknown {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object') return '[changed]';
  return value;
}

/** One readable sentence for the activity log. */
export function describeSettingsChange(previous: AppSettings, next: AppSettings, paths: readonly string[]): string {
  const sentences: string[] = [];
  const rest: string[] = [];
  for (const path of paths) {
    if (path === 'permissions.controlMode') {
      sentences.push(`Control mode changed to ${CONTROL_MODE_LABELS[next.permissions.controlMode]}`);
    } else if (path === 'permissions.manualControlEnabled') {
      sentences.push(`Manual control turned ${next.permissions.manualControlEnabled ? 'on' : 'off'}`);
    } else if (path === 'remote.enabled') {
      sentences.push(`Remote access turned ${next.remote.enabled ? 'on' : 'off'}`);
    } else if (path === 'remote.allowRemoteControl') {
      sentences.push(`Remote control ${next.remote.allowRemoteControl ? 'allowed' : 'not allowed'}`);
    } else {
      rest.push(path);
    }
  }
  if (rest.length) sentences.push(`Settings changed: ${rest.join(', ')}`);
  void previous;
  return sentences.length ? `${sentences.join('. ')}.` : 'Settings saved (no changes).';
}

const MODE_RANK: Record<ControlMode, number> = { observe: 0, assisted: 1, supervised: 2 };

/** True when the change gives the AI, manual input or remote devices more power. */
export function isEscalation(previous: AppSettings, next: AppSettings): boolean {
  return (
    MODE_RANK[next.permissions.controlMode] > MODE_RANK[previous.permissions.controlMode] ||
    (next.permissions.manualControlEnabled && !previous.permissions.manualControlEnabled) ||
    (next.remote.enabled && !previous.remote.enabled) ||
    (next.remote.allowRemoteControl && !previous.remote.allowRemoteControl) ||
    next.permissions.aiAllowedTools.some((t) => !previous.permissions.aiAllowedTools.includes(t)) ||
    previous.permissions.blockedApps.some((a) => !next.permissions.blockedApps.includes(a))
  );
}

/** Records the change, then schedules a Mirroir restart if its configuration is affected. */
export function recordSettingsChange(ctx: AppContext, previous: AppSettings, next: AppSettings, actor: Actor, sections?: readonly string[]): void {
  const paths = changedSettingPaths(previous, next, sections);
  if (paths.length === 0) return;
  const prev = previous as unknown as Record<string, Record<string, unknown>>;
  const curr = next as unknown as Record<string, Record<string, unknown>>;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const path of paths) {
    const [section, key] = path.split('.') as [string, string];
    changes[path] = { from: describeValue(prev[section]?.[key]), to: describeValue(curr[section]?.[key]) };
  }
  ctx.activity.record({
    category: 'settings',
    type: 'settings.changed',
    actor,
    severity: isEscalation(previous, next) ? 'warning' : 'info',
    summary: describeSettingsChange(previous, next, paths),
    detail: { changes },
  });
  void applyMirroirConfig(ctx, `Settings changed: ${paths.join(', ')}`);
}
