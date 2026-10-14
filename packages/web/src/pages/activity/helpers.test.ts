import type { ActivityEvent } from '@iphone-ai/shared';
import { describe, expect, it } from 'vitest';

import {
  activeFilterCount,
  detailEntries,
  EMPTY_FILTERS,
  eventOutcome,
  filenameFromDisposition,
  filtersToQuery,
  freshLiveEvents,
  groupByDay,
  hasActiveFilters,
  humanizeKey,
  matchesFilters,
  mergeEvents,
  nextPageCursor,
  parseActivityHashParams,
  rawDetail,
  type ActivityFilters,
} from './helpers';

function ev(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'evt_1',
    at: new Date(2026, 9, 14, 12, 0, 0).getTime(),
    sessionId: 'sess',
    category: 'manual',
    type: 'tool.call',
    actor: 'user',
    severity: 'info',
    summary: 'Tapped “Settings”',
    tool: 'tap',
    success: true,
    durationMs: 120,
    taskId: null,
    workflowRunId: null,
    detail: null,
    ...overrides,
  };
}

const filters = (overrides: Partial<ActivityFilters> = {}): ActivityFilters => ({ ...EMPTY_FILTERS, ...overrides });

describe('filters', () => {
  it('builds an API query with stable list order and trimmed search', () => {
    const query = filtersToQuery(filters({ categories: ['error', 'ai'], severity: ['error', 'info'], actor: ['ai'], search: '  send  ', taskId: 'task_9' }), {
      limit: 100,
      before: 55,
    });
    expect(query).toEqual({
      categories: ['ai', 'error'],
      severity: ['info', 'error'],
      actor: ['ai'],
      search: 'send',
      taskId: 'task_9',
      limit: 100,
      before: 55,
    });
    expect(filtersToQuery(EMPTY_FILTERS)).toEqual({});
  });

  it('counts active filter groups', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(filters({ search: '   ' }))).toBe(false);
    expect(activeFilterCount(filters({ categories: ['ai', 'manual'], taskId: 't' }))).toBe(2);
  });

  it('matches live events like the server does', () => {
    const e = ev({ category: 'ai', actor: 'ai', severity: 'warning', summary: 'AI tapped Send', tool: 'tap', taskId: 'task_1' });
    expect(matchesFilters(e, EMPTY_FILTERS)).toBe(true);
    expect(matchesFilters(e, filters({ categories: ['manual'] }))).toBe(false);
    expect(matchesFilters(e, filters({ severity: ['warning'] }))).toBe(true);
    expect(matchesFilters(e, filters({ actor: ['user'] }))).toBe(false);
    expect(matchesFilters(e, filters({ taskId: 'task_2' }))).toBe(false);
    expect(matchesFilters(e, filters({ search: 'SEND' }))).toBe(true);
    expect(matchesFilters(e, filters({ search: 'tool.call' }))).toBe(true);
    expect(matchesFilters(e, filters({ search: 'swipe' }))).toBe(false);
  });
});

describe('merging and paging', () => {
  it('merges by id, newest first', () => {
    const a = ev({ id: 'a', at: 3 });
    const b = ev({ id: 'b', at: 1 });
    const c = ev({ id: 'c', at: 2 });
    expect(mergeEvents([a, b], [c, { ...a, summary: 'dup' }]).map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect(mergeEvents([a, b], [c, { ...a, summary: 'dup' }])[0]!.summary).toBe('Tapped “Settings”');
  });

  it('keeps only live events that arrived after the fetch and match the filters', () => {
    const old = ev({ id: 'old', category: 'ai' });
    const fresh = ev({ id: 'fresh', category: 'ai' });
    const other = ev({ id: 'other', category: 'manual' });
    const result = freshLiveEvents([fresh, other, old], new Set(['old']), filters({ categories: ['ai'] }));
    expect(result.map((e) => e.id)).toEqual(['fresh']);
  });

  it('pages one millisecond past the oldest event so ties are not skipped', () => {
    expect(nextPageCursor([])).toBeNull();
    const events = [ev({ id: 'a', at: 500 }), ev({ id: 'b', at: 300 }), ev({ id: 'c', at: 400 })];
    expect(nextPageCursor(events)).toBe(301);
    expect(nextPageCursor(events, true)).toBe(300);
  });
});

describe('groupByDay', () => {
  it('groups into Today, Yesterday and dates in local time', () => {
    const now = new Date(2026, 9, 14, 9, 30).getTime();
    const events = [
      ev({ id: 'today-early', at: new Date(2026, 9, 14, 0, 5).getTime() }),
      ev({ id: 'yesterday-late', at: new Date(2026, 9, 13, 23, 55).getTime() }),
      ev({ id: 'today-late', at: new Date(2026, 9, 14, 9, 0).getTime() }),
      ev({ id: 'older', at: new Date(2026, 9, 1, 12, 0).getTime() }),
    ];
    const groups = groupByDay(events, now);
    expect(groups.map((g) => [g.kind, g.key])).toEqual([
      ['today', '2026-10-14'],
      ['yesterday', '2026-10-13'],
      ['date', '2026-10-01'],
    ]);
    expect(groups[0]!.events.map((e) => e.id)).toEqual(['today-late', 'today-early']);
    expect(groups[2]!.dayStart).toBe(new Date(2026, 9, 1).getTime());
  });

  it('handles the first day of a month and the new year', () => {
    const now = new Date(2027, 0, 1, 8).getTime();
    const groups = groupByDay([ev({ id: 'nye', at: new Date(2026, 11, 31, 22).getTime() })], now);
    expect(groups[0]!.kind).toBe('yesterday');
    expect(groups[0]!.key).toBe('2026-12-31');
  });
});

describe('presentation', () => {
  it('derives the outcome', () => {
    expect(eventOutcome(ev({ success: false }))).toBe('failure');
    expect(eventOutcome(ev({ success: null, severity: 'error' }))).toBe('failure');
    expect(eventOutcome(ev({ success: null, severity: 'warning' }))).toBe('warning');
    expect(eventOutcome(ev({ success: true }))).toBe('success');
    expect(eventOutcome(ev({ success: null }))).toBe('neutral');
  });

  it('humanizes keys', () => {
    expect(humanizeKey('taskId')).toBe('Task id');
    expect(humanizeKey('fix_hint')).toBe('Fix hint');
    expect(humanizeKey('deviceName')).toBe('Device name');
    expect(humanizeKey('URLPath')).toBe('Url path');
  });

  it('flattens redacted details into readable rows', () => {
    const entries = detailEntries({
      reasons: ['Sending messages requires approval'],
      args: { x: 10, y: 20, text: null },
      risk: 'high',
      ok: false,
      steps: [{ id: 's1', status: 'ok' }],
      empty: {},
      deep: { a: { b: { c: { d: 1 } } } },
    });
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath['reasons']).toMatchObject({ kind: 'list', items: ['Sending messages requires approval'], label: 'Reasons' });
    expect(byPath['args.x']).toMatchObject({ kind: 'number', value: '10', label: 'Args › X' });
    expect(byPath['args.text']).toMatchObject({ kind: 'null' });
    expect(byPath['ok']).toMatchObject({ kind: 'boolean', value: 'false' });
    expect(byPath['steps.1.status']).toMatchObject({ kind: 'text', value: 'ok' });
    expect(byPath['empty']).toMatchObject({ kind: 'json', value: '{}' });
    expect(byPath['deep.a.b']).toMatchObject({ kind: 'json', value: '{"c":{"d":1}}' });
    expect(detailEntries(null)).toEqual([]);
    expect(rawDetail({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('reads the task filter from the hash', () => {
    expect(parseActivityHashParams('#/activity')).toEqual({ taskId: null });
    expect(parseActivityHashParams('#/activity?taskId=task_42')).toEqual({ taskId: 'task_42' });
    expect(parseActivityHashParams('#/activity?taskId=%20')).toEqual({ taskId: null });
  });

  it('reads download file names', () => {
    expect(filenameFromDisposition('attachment; filename="iphone-ai-activity-2026.csv"', 'x')).toBe('iphone-ai-activity-2026.csv');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''report%20one.json", 'x')).toBe('report one.json');
    expect(filenameFromDisposition(null, 'fallback.json')).toBe('fallback.json');
    expect(filenameFromDisposition('attachment; filename="../evil"', 'safe.json')).toBe('safe.json');
  });
});
