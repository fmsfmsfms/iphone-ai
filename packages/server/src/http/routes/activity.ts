// Activity history: query, export (JSON / CSV) and clearing.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  activityQuerySchema,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityQuery,
  type ActivitySeverity,
  type Actor,
} from '@iphone-ai/shared';

import type { AppContext } from '../../core/services.js';
import { HttpError } from '../errors.js';
import { actorFor, requireLocal, type RouteDeps } from '../guards.js';

const CATEGORIES: readonly ActivityCategory[] = [
  'session',
  'connection',
  'manual',
  'ai',
  'approval',
  'workflow',
  'policy',
  'security',
  'settings',
  'error',
];
const SEVERITIES: readonly ActivitySeverity[] = ['info', 'warning', 'error'];
const ACTORS: readonly Actor[] = ['user', 'ai', 'workflow', 'system', 'remote-user'];

const EXPORT_PAGE = 1000;
const EXPORT_MAX = 20_000;

const exportFormatSchema = z.object({ format: z.enum(['json', 'csv']).default('json') });

function splitList<T extends string>(raw: string | undefined, allowed: readonly T[], field: string): T[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  const invalid = values.filter((v) => !(allowed as readonly string[]).includes(v));
  if (invalid.length > 0) {
    throw new HttpError(400, 'validation_error', `${field}: unknown value${invalid.length > 1 ? 's' : ''} ${invalid.join(', ')}`);
  }
  return values as T[];
}

export function parseActivityQuery(raw: unknown): ActivityQuery {
  const q = activityQuerySchema.parse(raw ?? {});
  const out: ActivityQuery = {};
  const categories = splitList(q.categories, CATEGORIES, 'categories');
  const severity = splitList(q.severity, SEVERITIES, 'severity');
  const actor = splitList(q.actor, ACTORS, 'actor');
  if (categories) out.categories = categories;
  if (severity) out.severity = severity;
  if (actor) out.actor = actor;
  if (q.search?.trim()) out.search = q.search.trim();
  if (q.taskId) out.taskId = q.taskId;
  if (q.since !== undefined) out.since = q.since;
  if (q.until !== undefined) out.until = q.until;
  if (q.before !== undefined) out.before = q.before;
  if (q.limit !== undefined) out.limit = q.limit;
  return out;
}

/** Pages through the history newest-first without losing events that share a millisecond. */
function collectForExport(ctx: AppContext, query: ActivityQuery): ActivityEvent[] {
  const max = Math.min(query.limit ?? EXPORT_MAX, EXPORT_MAX);
  const out: ActivityEvent[] = [];
  const seen = new Set<string>();
  let until = query.until;
  while (out.length < max) {
    const page = ctx.activity.query({ ...query, limit: EXPORT_PAGE, ...(until !== undefined ? { until } : {}) });
    let added = 0;
    for (const event of page) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      out.push(event);
      added += 1;
      if (out.length >= max) break;
    }
    if (page.length < EXPORT_PAGE) break;
    const oldest = page[page.length - 1]!.at;
    if (added > 0) {
      until = oldest;
    } else if (until === oldest) {
      // A whole page shares one timestamp: step past it to guarantee progress.
      until = oldest - 1;
    } else {
      break;
    }
  }
  return out;
}

/** CSV cell with quoting and spreadsheet formula neutralisation. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function activityToCsv(events: readonly ActivityEvent[]): string {
  const header = ['time', 'category', 'type', 'actor', 'severity', 'summary', 'tool', 'success', 'durationMs', 'taskId', 'workflowRunId', 'detail'];
  const rows = events.map((e) =>
    [
      new Date(e.at).toISOString(),
      e.category,
      e.type,
      e.actor,
      e.severity,
      e.summary,
      e.tool,
      e.success,
      e.durationMs,
      e.taskId,
      e.workflowRunId,
      e.detail,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[header.join(','), ...rows].join('\r\n')}\r\n`;
}

export function registerActivityRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx } = deps;

  app.get('/api/activity', async (request) => ctx.activity.query(parseActivityQuery(request.query)));

  app.get('/api/activity/export', async (request, reply) => {
    const { format } = exportFormatSchema.parse(request.query ?? {});
    // Details were redacted when the events were recorded.
    const events = collectForExport(ctx, parseActivityQuery(request.query));
    const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\..+$/, '').replace('T', '-');
    void reply.header('content-disposition', `attachment; filename="iphone-ai-activity-${stamp}.${format}"`);
    if (format === 'csv') {
      return reply.header('content-type', 'text/csv; charset=utf-8').send(activityToCsv(events));
    }
    return reply.header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(events, null, 2));
  });

  app.delete('/api/activity', async (request) => {
    const session = requireLocal(request);
    const deleted = ctx.activity.clear();
    ctx.activity.record({
      category: 'security',
      type: 'activity.cleared',
      actor: actorFor(session),
      summary: `Activity history cleared (${deleted} event${deleted === 1 ? '' : 's'}).`,
    });
    return { deleted };
  });
}
