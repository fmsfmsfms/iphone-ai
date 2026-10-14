// Pure helpers for the Activity History page: filters, live merging, day
// grouping, pagination cursors and readable rendering of redacted details.

import type { ActivityCategory, ActivityEvent, ActivityQuery, ActivitySeverity, Actor } from '@iphone-ai/shared';

export const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = [
  'manual',
  'ai',
  'approval',
  'workflow',
  'policy',
  'security',
  'connection',
  'session',
  'settings',
  'error',
];

export const ACTIVITY_SEVERITIES: readonly ActivitySeverity[] = ['info', 'warning', 'error'];

export const ACTIVITY_ACTORS: readonly Actor[] = ['user', 'ai', 'workflow', 'system', 'remote-user'];

/** Events requested per page (the API allows up to 1000). */
export const PAGE_SIZE = 100;

export interface ActivityFilters {
  categories: ActivityCategory[];
  severity: ActivitySeverity[];
  actor: Actor[];
  search: string;
  taskId: string | null;
}

export const EMPTY_FILTERS: ActivityFilters = { categories: [], severity: [], actor: [], search: '', taskId: null };

export function hasActiveFilters(filters: ActivityFilters): boolean {
  return (
    filters.categories.length > 0 ||
    filters.severity.length > 0 ||
    filters.actor.length > 0 ||
    filters.search.trim().length > 0 ||
    filters.taskId !== null
  );
}

/** Number of filter groups in use (for the "Filters (n)" badge). */
export function activeFilterCount(filters: ActivityFilters): number {
  return [
    filters.categories.length > 0,
    filters.severity.length > 0,
    filters.actor.length > 0,
    filters.search.trim().length > 0,
    filters.taskId !== null,
  ].filter(Boolean).length;
}

/** Converts UI filters to the API query (lists stay in a stable order). */
export function filtersToQuery(filters: ActivityFilters, extra: Pick<ActivityQuery, 'limit' | 'before'> = {}): ActivityQuery {
  const query: ActivityQuery = {};
  if (filters.categories.length) query.categories = ACTIVITY_CATEGORIES.filter((c) => filters.categories.includes(c));
  if (filters.severity.length) query.severity = ACTIVITY_SEVERITIES.filter((s) => filters.severity.includes(s));
  if (filters.actor.length) query.actor = ACTIVITY_ACTORS.filter((a) => filters.actor.includes(a));
  const search = filters.search.trim();
  if (search) query.search = search.slice(0, 200);
  if (filters.taskId) query.taskId = filters.taskId;
  if (extra.limit !== undefined) query.limit = extra.limit;
  if (extra.before !== undefined) query.before = extra.before;
  return query;
}

/** Client-side mirror of the server's filter semantics (used for live events). */
export function matchesFilters(event: ActivityEvent, filters: ActivityFilters): boolean {
  if (filters.categories.length && !filters.categories.includes(event.category)) return false;
  if (filters.severity.length && !filters.severity.includes(event.severity)) return false;
  if (filters.actor.length && !filters.actor.includes(event.actor)) return false;
  if (filters.taskId && event.taskId !== filters.taskId) return false;
  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = [event.summary, event.type, event.tool ?? ''].map((s) => s.toLowerCase());
    if (!haystack.some((s) => s.includes(search))) return false;
  }
  return true;
}

/** Newest first; ties broken by id so the order is stable. */
export function compareEvents(a: ActivityEvent, b: ActivityEvent): number {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Merges two lists by id (first occurrence wins) and sorts newest first. */
export function mergeEvents(...lists: readonly (readonly ActivityEvent[])[]): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const list of lists) for (const event of list) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()].sort(compareEvents);
}

/**
 * Live events that arrived over the WebSocket after the current list was
 * fetched (ids already present when the fetch started are excluded, because
 * the fetch result covers them) and that match the active filters.
 */
export function freshLiveEvents(live: readonly ActivityEvent[], baselineIds: ReadonlySet<string>, filters: ActivityFilters): ActivityEvent[] {
  return live.filter((event) => !baselineIds.has(event.id) && matchesFilters(event, filters));
}

/**
 * Cursor for the next page. The API filters with `at < before`, so the
 * cursor sits one millisecond past the oldest event: events sharing that
 * millisecond are fetched again and de-duplicated instead of being skipped.
 * `strict` steps past the oldest millisecond (used when a full page made no
 * progress because every event in it had the same timestamp).
 */
export function nextPageCursor(events: readonly ActivityEvent[], strict = false): number | null {
  if (events.length === 0) return null;
  let oldest = events[0]!.at;
  for (const event of events) if (event.at < oldest) oldest = event.at;
  return strict ? oldest : oldest + 1;
}

// ---------------------------------------------------------------------------
// Day grouping
// ---------------------------------------------------------------------------

export type DayKind = 'today' | 'yesterday' | 'date';

export interface DayGroup {
  /** Local calendar day, e.g. "2026-10-14". */
  key: string;
  kind: DayKind;
  /** Local midnight of the day (ms). */
  dayStart: number;
  events: ActivityEvent[];
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar-day key for a timestamp. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Groups events (any order) into local days, newest day first; events keep newest-first order. */
export function groupByDay(events: readonly ActivityEvent[], now: number): DayGroup[] {
  const today = dayKey(now);
  const todayStart = startOfLocalDay(now);
  // Local midnight of the previous day (DST-safe: step into the previous day, then normalise).
  const yesterday = dayKey(startOfLocalDay(todayStart - 12 * 3600 * 1000));
  const groups = new Map<string, DayGroup>();
  for (const event of [...events].sort(compareEvents)) {
    const key = dayKey(event.at);
    let group = groups.get(key);
    if (!group) {
      const kind: DayKind = key === today ? 'today' : key === yesterday ? 'yesterday' : 'date';
      group = { key, kind, dayStart: startOfLocalDay(event.at), events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return [...groups.values()].sort((a, b) => b.dayStart - a.dayStart);
}

// ---------------------------------------------------------------------------
// Event presentation
// ---------------------------------------------------------------------------

export type EventOutcome = 'success' | 'failure' | 'warning' | 'neutral';

export function eventOutcome(event: ActivityEvent): EventOutcome {
  if (event.success === false || event.severity === 'error') return 'failure';
  if (event.severity === 'warning') return 'warning';
  if (event.success === true) return 'success';
  return 'neutral';
}

/** "taskId" → "Task id", "fix_hint" → "Fix hint", "deviceName" → "Device name". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type DetailValueKind = 'text' | 'number' | 'boolean' | 'null' | 'list' | 'json';

export interface DetailEntry {
  /** Dotted path into the detail object ("args.x"). */
  path: string;
  /** Readable label ("Args › X"). */
  label: string;
  kind: DetailValueKind;
  /** Display string (lists joined with ", "). */
  value: string;
  /** Individual items for `list` values. */
  items?: string[];
}

const MAX_DEPTH = 3;
const MAX_ENTRIES = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Flattens a (redacted) detail object into readable rows. Nested objects are
 * expanded up to three levels; arrays of scalars become lists; anything deeper
 * or mixed is shown as compact JSON.
 */
export function detailEntries(detail: Record<string, unknown> | null | undefined): DetailEntry[] {
  const out: DetailEntry[] = [];
  if (!detail) return out;
  const walk = (value: unknown, path: string[], depth: number) => {
    if (out.length >= MAX_ENTRIES) return;
    const key = path.join('.');
    const label = path.map(humanizeKey).join(' › ');
    if (value === null || value === undefined) {
      out.push({ path: key, label, kind: 'null', value: '' });
    } else if (typeof value === 'boolean') {
      out.push({ path: key, label, kind: 'boolean', value: String(value) });
    } else if (typeof value === 'number') {
      out.push({ path: key, label, kind: 'number', value: String(value) });
    } else if (typeof value === 'string') {
      out.push({ path: key, label, kind: 'text', value });
    } else if (Array.isArray(value)) {
      if (value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
        const items = value.map((v) => (v === null ? '' : scalarText(v)));
        out.push({ path: key, label, kind: 'list', value: items.join(', '), items });
      } else if (depth < MAX_DEPTH && value.length <= 20) {
        value.forEach((item, index) => walk(item, [...path, String(index + 1)], depth + 1));
      } else {
        out.push({ path: key, label, kind: 'json', value: scalarText(value) });
      }
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        out.push({ path: key, label, kind: 'json', value: '{}' });
      } else if (depth < MAX_DEPTH) {
        for (const k of keys) walk(value[k], [...path, k], depth + 1);
      } else {
        out.push({ path: key, label, kind: 'json', value: scalarText(value) });
      }
    } else {
      out.push({ path: key, label, kind: 'text', value: scalarText(value) });
    }
  };
  for (const [k, v] of Object.entries(detail)) walk(v, [k], 1);
  return out;
}

/** Pretty JSON for the "Show raw" view. */
export function rawDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail) return '';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

// ---------------------------------------------------------------------------
// Hash parameters (#/activity?taskId=…)
// ---------------------------------------------------------------------------

/** Reads optional filters passed in the hash, e.g. links from a task: `#/activity?taskId=task_1`. */
export function parseActivityHashParams(hash: string): { taskId: string | null } {
  const index = hash.indexOf('?');
  if (index === -1) return { taskId: null };
  const params = new URLSearchParams(hash.slice(index + 1));
  const taskId = params.get('taskId')?.trim() ?? '';
  return { taskId: taskId && taskId.length <= 100 ? taskId : null };
}

/** Hash that links to the activity history filtered by one task. */
export function activityHashForTask(taskId: string): string {
  return `#/activity?taskId=${encodeURIComponent(taskId)}`;
}

/** Filename from a Content-Disposition header (falls back when absent). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  const name = plain?.[1]?.trim();
  return name && !/[\\/]/.test(name) ? name : fallback;
}
