// ActivityLog: redacted audit records, broadcast, query filters.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityEvent } from '@iphone-ai/shared';

import type { ActivityInput } from '../../src/core/activity-log.js';
import { createCoreContext, type CoreContext } from '../helpers/context.js';

let ctx: CoreContext;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

beforeEach(() => {
  ctx = createCoreContext();
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await ctx.cleanup();
});

function recordAt(offsetMs: number, input: Partial<ActivityInput> & Pick<ActivityInput, 'summary'>): ActivityEvent {
  vi.setSystemTime(T0 + offsetMs);
  return ctx.activity.record({ category: 'manual', type: 'tool.call', actor: 'user', ...input });
}

describe('record', () => {
  it('fills defaults, broadcasts and persists the event', () => {
    const event = recordAt(0, { summary: 'Tap at (1, 2) — done', tool: 'tap', success: true, durationMs: 42 });
    expect(event).toMatchObject({
      at: T0,
      sessionId: 'test-session',
      severity: 'info',
      tool: 'tap',
      success: true,
      durationMs: 42,
      taskId: null,
      workflowRunId: null,
      detail: null,
    });
    expect(event.id).toMatch(/^evt_/);
    expect(ctx.events).toEqual([{ type: 'activity', event }]);
    expect(ctx.activity.query()).toEqual([event]);
  });

  it('redacts secrets in detail before storing it', () => {
    const event = recordAt(0, {
      summary: 'Provider saved',
      category: 'settings',
      detail: { apiKey: 'sk-ant-abcdefghijklmnopqrst', note: 'Bearer abcdefghijklmnopqrs', nested: { password: 'x' } },
    });
    expect(event.detail).toEqual({ apiKey: '[redacted]', note: '[redacted]', nested: { password: '[redacted]' } });
    expect(ctx.activity.query()[0]!.detail).toEqual(event.detail);
    expect(JSON.stringify(ctx.db.all('SELECT detail_json FROM activity'))).not.toContain('sk-ant-');
  });

  it('keeps broadcasting even if the database write fails', () => {
    ctx.db.close();
    const event = ctx.activity.record({ category: 'error', type: 'x', actor: 'system', summary: 'still announced' });
    expect(ctx.events.at(-1)).toEqual({ type: 'activity', event });
  });
});

describe('query', () => {
  beforeEach(() => {
    recordAt(1000, { summary: 'Tap at (10, 20) — done', tool: 'tap', success: true });
    recordAt(2000, { summary: 'AI opened Settings', category: 'ai', actor: 'ai', tool: 'launch_app', taskId: 'task_a' });
    recordAt(3000, { summary: 'Battery at 100% after charging', category: 'ai', actor: 'ai', taskId: 'task_b' });
    recordAt(4000, { summary: 'Battery 1000 mAh', category: 'connection', actor: 'system', severity: 'warning' });
    recordAt(5000, { summary: 'Used snake_case name', category: 'workflow', actor: 'workflow', severity: 'error', type: 'run.failed' });
    recordAt(6000, { summary: 'Used snakeXcase name', category: 'workflow', actor: 'workflow' });
  });

  it('returns newest first with a default limit', () => {
    const all = ctx.activity.query();
    expect(all.map((e) => e.at - T0)).toEqual([6000, 5000, 4000, 3000, 2000, 1000]);
  });

  it('filters by categories, severity, actor and task', () => {
    expect(ctx.activity.query({ categories: ['ai'] }).map((e) => e.taskId)).toEqual(['task_b', 'task_a']);
    expect(ctx.activity.query({ categories: ['ai', 'connection'] })).toHaveLength(3);
    expect(ctx.activity.query({ severity: ['warning', 'error'] }).map((e) => e.severity)).toEqual(['error', 'warning']);
    expect(ctx.activity.query({ actor: ['workflow'] })).toHaveLength(2);
    expect(ctx.activity.query({ taskId: 'task_a' }).map((e) => e.summary)).toEqual(['AI opened Settings']);
    expect(ctx.activity.query({ categories: [] })).toHaveLength(6);
  });

  it('filters by time range and paginates with before/limit', () => {
    expect(ctx.activity.query({ since: T0 + 2000, until: T0 + 4000 }).map((e) => e.at - T0)).toEqual([4000, 3000, 2000]);
    expect(ctx.activity.query({ before: T0 + 3000 }).map((e) => e.at - T0)).toEqual([2000, 1000]);
    expect(ctx.activity.query({ limit: 2 }).map((e) => e.at - T0)).toEqual([6000, 5000]);
    expect(ctx.activity.query({ limit: 0 })).toHaveLength(1);
    expect(ctx.activity.query({ limit: 999999 })).toHaveLength(6);
  });

  it('searches summary, type and tool, treating % and _ literally', () => {
    expect(ctx.activity.query({ search: '100%' }).map((e) => e.summary)).toEqual(['Battery at 100% after charging']);
    expect(ctx.activity.query({ search: 'snake_case' }).map((e) => e.summary)).toEqual(['Used snake_case name']);
    expect(ctx.activity.query({ search: 'launch_app' }).map((e) => e.tool)).toEqual(['launch_app']);
    expect(ctx.activity.query({ search: 'run.failed' })).toHaveLength(1);
    expect(ctx.activity.query({ search: "'; DROP TABLE activity; --" })).toEqual([]);
    expect(ctx.activity.query()).toHaveLength(6);
  });

  it('combines filters', () => {
    expect(ctx.activity.query({ categories: ['ai'], search: 'battery', since: T0 }).map((e) => e.taskId)).toEqual(['task_b']);
  });
});

describe('maintenance', () => {
  it('prunes old events and clears everything', () => {
    recordAt(0, { summary: 'old' });
    recordAt(10_000, { summary: 'new' });
    expect(ctx.activity.pruneOlderThan(T0 + 5000)).toBe(1);
    expect(ctx.activity.query().map((e) => e.summary)).toEqual(['new']);
    expect(ctx.activity.clear()).toBe(1);
    expect(ctx.activity.query()).toEqual([]);
  });
});
