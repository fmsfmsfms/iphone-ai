// Human approval checkpoints. An approval request blocks the requesting task
// until the user decides, the request expires, or the emergency stop fires.
// Every decision is persisted and written to the activity history.

import type { Actor, ApprovalRequest, ApprovalStatus, RiskLevel } from '@iphone-ai/shared';

import type { ActivityLog } from '../core/activity-log.js';
import type { EventHub } from '../core/events.js';
import { newId } from '../core/ids.js';
import { fromJson, toJson, type Database } from '../db/database.js';

export interface ApprovalInput {
  actor: Actor;
  taskId?: string | null;
  workflowRunId?: string | null;
  summary: string;
  action: { tool: string; args: Record<string, unknown> };
  risk: RiskLevel;
  reasons: string[];
  frameSeq?: number | null;
  timeoutSec: number;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (status: ApprovalStatus) => void;
  timer: NodeJS.Timeout;
}

interface ApprovalRow {
  id: string;
  created_at: number;
  expires_at: number;
  status: string;
  actor: string;
  task_id: string | null;
  workflow_run_id: string | null;
  summary: string;
  action_json: string;
  risk: string;
  reasons_json: string;
  frame_seq: number | null;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly db: Database,
    private readonly hub: EventHub,
    private readonly activity: ActivityLog,
  ) {}

  /** Resolves with the final status. Never throws; aborting the signal cancels the request. */
  request(input: ApprovalInput, signal?: AbortSignal): Promise<ApprovalStatus> {
    const now = Date.now();
    const request: ApprovalRequest = {
      id: newId('apr'),
      createdAt: now,
      expiresAt: now + input.timeoutSec * 1000,
      status: 'pending',
      actor: input.actor,
      taskId: input.taskId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      summary: input.summary,
      action: input.action,
      risk: input.risk,
      reasons: input.reasons,
      frameSeq: input.frameSeq ?? null,
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    this.insert(request);
    this.hub.publish({ type: 'approval_requested', approval: request });
    this.activity.record({
      category: 'approval',
      type: 'approval.requested',
      actor: input.actor,
      severity: input.risk === 'high' ? 'warning' : 'info',
      summary: `Approval requested: ${input.summary}`,
      taskId: request.taskId,
      workflowRunId: request.workflowRunId,
      tool: input.action.tool,
      detail: { approvalId: request.id, risk: input.risk, reasons: input.reasons, args: input.action.args },
    });

    return new Promise<ApprovalStatus>((resolve) => {
      if (signal?.aborted) {
        this.finish(request.id, 'cancelled', 'system', 'Task stopped before approval');
        resolve('cancelled');
        return;
      }
      const timer = setTimeout(() => {
        this.finish(request.id, 'expired', 'system', null);
      }, input.timeoutSec * 1000);
      timer.unref();
      this.pending.set(request.id, { request, resolve, timer });
      signal?.addEventListener(
        'abort',
        () => {
          this.finish(request.id, 'cancelled', 'system', 'Task stopped');
        },
        { once: true },
      );
    });
  }

  decide(id: string, decision: 'approved' | 'rejected', decidedBy: string, note?: string | null): ApprovalRequest | null {
    if (!this.pending.has(id)) return null;
    return this.finish(id, decision, decidedBy, note ?? null);
  }

  cancelAll(reason: string): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.finish(id, 'cancelled', 'system', reason);
    return ids.length;
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  recent(limit = 100): ApprovalRequest[] {
    return this.db
      .all<ApprovalRow>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?', Math.min(limit, 500))
      .map(rowToApproval);
  }

  private finish(id: string, status: ApprovalStatus, decidedBy: string, note: string | null): ApprovalRequest | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const request: ApprovalRequest = { ...entry.request, status, decidedAt: Date.now(), decidedBy, note };
    this.db.run(
      'UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?',
      status,
      request.decidedAt,
      decidedBy,
      note,
      id,
    );
    this.hub.publish({ type: 'approval_resolved', approval: request });
    const verb: Record<ApprovalStatus, string> = {
      approved: 'Approved',
      rejected: 'Rejected',
      expired: 'Expired (no decision)',
      cancelled: 'Cancelled',
      pending: 'Pending',
    };
    this.activity.record({
      category: 'approval',
      type: `approval.${status}`,
      actor: decidedBy === 'system' ? 'system' : 'user',
      severity: status === 'approved' ? 'info' : 'warning',
      summary: `${verb[status]}: ${request.summary}`,
      taskId: request.taskId,
      workflowRunId: request.workflowRunId,
      tool: request.action.tool,
      detail: { approvalId: id, decidedBy, note },
    });
    entry.resolve(status);
    return request;
  }

  private insert(r: ApprovalRequest): void {
    this.db.run(
      `INSERT INTO approvals (id, created_at, expires_at, status, actor, task_id, workflow_run_id, summary, action_json, risk, reasons_json, frame_seq, decided_at, decided_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.createdAt,
      r.expiresAt,
      r.status,
      r.actor,
      r.taskId,
      r.workflowRunId,
      r.summary,
      toJson(r.action),
      r.risk,
      toJson(r.reasons),
      r.frameSeq,
      null,
      null,
      null,
    );
  }
}

function rowToApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as ApprovalStatus,
    actor: row.actor as Actor,
    taskId: row.task_id,
    workflowRunId: row.workflow_run_id,
    summary: row.summary,
    action: fromJson(row.action_json, { tool: '', args: {} }),
    risk: row.risk as RiskLevel,
    reasons: fromJson<string[]>(row.reasons_json, []),
    frameSeq: row.frame_seq,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note,
  };
}
