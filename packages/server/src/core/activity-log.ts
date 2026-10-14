// Audit trail: every session event, tool call, approval and outcome is
// recorded here (redacted) and pushed to connected UIs.

import type { ActivityEvent, ActivityQuery } from '@iphone-ai/shared';

import { fromJson, toJson, type Database, type SqlParam } from '../db/database.js';
import type { EventHub } from './events.js';
import { newId } from './ids.js';
import { redactValue } from './redact.js';

export type ActivityInput = Omit<ActivityEvent, 'id' | 'at' | 'sessionId' | 'tool' | 'success' | 'durationMs' | 'taskId' | 'workflowRunId' | 'detail' | 'severity'> &
  Partial<Pick<ActivityEvent, 'tool' | 'success' | 'durationMs' | 'taskId' | 'workflowRunId' | 'detail' | 'severity'>>;

interface ActivityRow {
  id: string;
  at: number;
  session_id: string;
  category: string;
  type: string;
  actor: string;
  severity: string;
  summary: string;
  tool: string | null;
  success: number | null;
  duration_ms: number | null;
  task_id: string | null;
  workflow_run_id: string | null;
  detail_json: string | null;
}

export class ActivityLog {
  constructor(
    private readonly db: Database,
    private readonly hub: EventHub,
    readonly sessionId: string,
  ) {}

  record(input: ActivityInput): ActivityEvent {
    const event: ActivityEvent = {
      id: newId('evt'),
      at: Date.now(),
      sessionId: this.sessionId,
      severity: input.severity ?? 'info',
      category: input.category,
      type: input.type,
      actor: input.actor,
      summary: input.summary,
      tool: input.tool ?? null,
      success: input.success ?? null,
      durationMs: input.durationMs ?? null,
      taskId: input.taskId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      detail: input.detail ? (redactValue(input.detail) as Record<string, unknown>) : null,
    };
    try {
      this.db.run(
        `INSERT INTO activity (id, at, session_id, category, type, actor, severity, summary, tool, success, duration_ms, task_id, workflow_run_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.at,
        event.sessionId,
        event.category,
        event.type,
        event.actor,
        event.severity,
        event.summary,
        event.tool,
        event.success === null ? null : event.success ? 1 : 0,
        event.durationMs,
        event.taskId,
        event.workflowRunId,
        event.detail ? toJson(event.detail) : null,
      );
    } catch {
      // The audit log must not take the app down; the event is still broadcast.
    }
    this.hub.publish({ type: 'activity', event });
    return event;
  }

  query(q: ActivityQuery = {}): ActivityEvent[] {
    const where: string[] = [];
    const params: SqlParam[] = [];
    const inList = (column: string, values: readonly string[] | undefined) => {
      if (!values || values.length === 0) return;
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    inList('category', q.categories);
    inList('severity', q.severity);
    inList('actor', q.actor);
    if (q.taskId) {
      where.push('task_id = ?');
      params.push(q.taskId);
    }
    if (q.since !== undefined) {
      where.push('at >= ?');
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('at <= ?');
      params.push(q.until);
    }
    if (q.before !== undefined) {
      where.push('at < ?');
      params.push(q.before);
    }
    if (q.search) {
      where.push("(summary LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\')");
      const like = `%${q.search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const sql = `SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ${limit}`;
    return this.db.all<ActivityRow>(sql, ...params).map(rowToEvent);
  }

  clear(): number {
    return this.db.run('DELETE FROM activity').changes;
  }

  pruneOlderThan(cutoff: number): number {
    return this.db.run('DELETE FROM activity WHERE at < ?', cutoff).changes;
  }
}

function rowToEvent(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    at: row.at,
    sessionId: row.session_id,
    category: row.category as ActivityEvent['category'],
    type: row.type,
    actor: row.actor as ActivityEvent['actor'],
    severity: row.severity as ActivityEvent['severity'],
    summary: row.summary,
    tool: row.tool,
    success: row.success === null ? null : row.success === 1,
    durationMs: row.duration_ms,
    taskId: row.task_id,
    workflowRunId: row.workflow_run_id,
    detail: row.detail_json ? fromJson<Record<string, unknown> | null>(row.detail_json, null) : null,
  };
}
