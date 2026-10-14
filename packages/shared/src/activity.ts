// Activity history (audit log). Detail payloads are redacted before storage.

import type { Actor } from './control.js';

export type ActivityCategory =
  | 'session'
  | 'connection'
  | 'manual'
  | 'ai'
  | 'approval'
  | 'workflow'
  | 'policy'
  | 'security'
  | 'settings'
  | 'error';

export type ActivitySeverity = 'info' | 'warning' | 'error';

export interface ActivityEvent {
  id: string;
  at: number;
  /** App session (one per backend launch). */
  sessionId: string;
  category: ActivityCategory;
  /** Machine-readable event type, e.g. "tool.call", "task.completed", "approval.decided". */
  type: string;
  actor: Actor;
  severity: ActivitySeverity;
  /** One readable sentence for normal users. */
  summary: string;
  tool: string | null;
  success: boolean | null;
  durationMs: number | null;
  taskId: string | null;
  workflowRunId: string | null;
  /** Redacted structured detail. Never contains secrets, typed text (unless opted in) or images. */
  detail: Record<string, unknown> | null;
}

export interface ActivityQuery {
  categories?: ActivityCategory[];
  severity?: ActivitySeverity[];
  actor?: Actor[];
  search?: string;
  taskId?: string;
  since?: number;
  until?: number;
  limit?: number;
  before?: number;
}
