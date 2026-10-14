// ApprovalBroker: human decisions, expiry, cancellation, persistence, audit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApprovalRequest, ServerEvent } from '@iphone-ai/shared';

import { ApprovalBroker, type ApprovalInput } from '../../src/policy/approvals.js';
import { createCoreContext, type CoreContext } from '../helpers/context.js';

let ctx: CoreContext;
let broker: ApprovalBroker;

const input = (patch: Partial<ApprovalInput> = {}): ApprovalInput => ({
  actor: 'ai',
  taskId: 'task_1',
  summary: 'Tap "Send" (e14) in Messages',
  action: { tool: 'tap', args: { x: 378, y: 800 } },
  risk: 'high',
  reasons: ['"Send" matches "send" (Sending messages, emails and posts)'],
  frameSeq: 7,
  timeoutSec: 60,
  ...patch,
});

function row(id: string): Record<string, unknown> | undefined {
  return ctx.db.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', id);
}

function resolvedEvents(): ApprovalRequest[] {
  return ctx.events
    .filter((e): e is Extract<ServerEvent, { type: 'approval_resolved' }> => e.type === 'approval_resolved')
    .map((e) => e.approval);
}

beforeEach(() => {
  ctx = createCoreContext();
  broker = new ApprovalBroker(ctx.db, ctx.hub, ctx.activity);
});

afterEach(async () => {
  broker.cancelAll('test cleanup');
  await ctx.cleanup();
});

describe('ApprovalBroker', () => {
  it('creates a pending request, publishes it and resolves on approval', async () => {
    const pending = broker.request(input());
    const [request] = broker.listPending();
    expect(request).toMatchObject({
      status: 'pending',
      actor: 'ai',
      taskId: 'task_1',
      workflowRunId: null,
      risk: 'high',
      frameSeq: 7,
      decidedAt: null,
    });
    expect(request!.id).toMatch(/^apr_/);
    expect(request!.expiresAt - request!.createdAt).toBe(60_000);
    expect(ctx.events.some((e) => e.type === 'approval_requested' && e.approval.id === request!.id)).toBe(true);
    expect(row(request!.id)).toMatchObject({ status: 'pending', summary: 'Tap "Send" (e14) in Messages' });

    const decided = broker.decide(request!.id, 'approved', 'user');
    expect(decided).toMatchObject({ id: request!.id, status: 'approved', decidedBy: 'user', note: null });
    await expect(pending).resolves.toBe('approved');

    expect(broker.listPending()).toEqual([]);
    expect(row(request!.id)).toMatchObject({ status: 'approved', decided_by: 'user', note: null });
    expect(resolvedEvents().map((a) => a.status)).toEqual(['approved']);
    const types = ctx.activity.query({ categories: ['approval'] }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['approval.requested', 'approval.approved']));
  });

  it('records a rejection with the user note', async () => {
    const pending = broker.request(input());
    const id = broker.listPending()[0]!.id;
    broker.decide(id, 'rejected', 'user', 'Not this conversation');
    await expect(pending).resolves.toBe('rejected');
    expect(row(id)).toMatchObject({ status: 'rejected', note: 'Not this conversation', decided_by: 'user' });
    const event = ctx.activity.query({ categories: ['approval'] }).find((e) => e.type === 'approval.rejected');
    expect(event).toMatchObject({ severity: 'warning', actor: 'user', tool: 'tap', taskId: 'task_1' });
    expect(event?.detail).toMatchObject({ approvalId: id, note: 'Not this conversation' });
  });

  it('expires when nobody decides in time', async () => {
    const pending = broker.request(input({ timeoutSec: 0.05 }));
    const id = broker.listPending()[0]!.id;
    await expect(pending).resolves.toBe('expired');
    expect(row(id)).toMatchObject({ status: 'expired', decided_by: 'system' });
    expect(broker.decide(id, 'approved', 'user')).toBeNull();
    expect(ctx.activity.query({}).some((e) => e.type === 'approval.expired')).toBe(true);
  });

  it('is cancelled when the task aborts its signal', async () => {
    const controller = new AbortController();
    const pending = broker.request(input(), controller.signal);
    const id = broker.listPending()[0]!.id;
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');
    expect(row(id)).toMatchObject({ status: 'cancelled', decided_by: 'system', note: 'Task stopped' });
    expect(broker.listPending()).toEqual([]);
  });

  // Regression: a request made with an already-aborted signal must still be
  // resolved through finish() (row updated, approval_resolved published).
  it('marks a request made with an already-aborted signal as cancelled (row + event)', async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = broker.request(input(), controller.signal);
    await expect(pending).resolves.toBe('cancelled');
    const id = broker.recent(1)[0]!.id;
    expect(row(id)).toMatchObject({ status: 'cancelled' });
    expect(resolvedEvents().map((a) => a.id)).toContain(id);
  });

  it('resolves a pre-aborted request as cancelled without leaving it pending in memory', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request(input(), controller.signal)).resolves.toBe('cancelled');
    expect(broker.listPending()).toEqual([]);
  });

  it('cancelAll cancels every pending request (emergency stop)', async () => {
    const a = broker.request(input({ summary: 'A' }));
    const b = broker.request(input({ summary: 'B', actor: 'workflow', taskId: null, workflowRunId: 'run_1' }));
    expect(broker.cancelAll('Emergency stop')).toBe(2);
    await expect(a).resolves.toBe('cancelled');
    await expect(b).resolves.toBe('cancelled');
    expect(broker.cancelAll('again')).toBe(0);
    expect(broker.recent().every((r) => r.status === 'cancelled' && r.note === 'Emergency stop')).toBe(true);
  });

  it('ignores decisions for unknown or already-decided requests', async () => {
    expect(broker.decide('apr_unknown', 'approved', 'user')).toBeNull();
    const pending = broker.request(input());
    const id = broker.listPending()[0]!.id;
    expect(broker.decide(id, 'approved', 'user')).not.toBeNull();
    expect(broker.decide(id, 'rejected', 'user')).toBeNull();
    await expect(pending).resolves.toBe('approved');
    expect(row(id)).toMatchObject({ status: 'approved' });
  });

  it('persists requests and reads them back newest first', async () => {
    const first = broker.request(input({ summary: 'first', action: { tool: 'launch_app', args: { name: 'Settings' } } }));
    const firstId = broker.listPending()[0]!.id;
    broker.decide(firstId, 'approved', 'user');
    await first;
    await new Promise((r) => setTimeout(r, 5));
    const second = broker.request(input({ summary: 'second', reasons: ['r1', 'r2'], frameSeq: null }));
    const recent = broker.recent();
    expect(recent.map((r) => r.summary)).toEqual(['second', 'first']);
    expect(recent[0]).toMatchObject({ status: 'pending', reasons: ['r1', 'r2'], frameSeq: null });
    expect(recent[1]).toMatchObject({ status: 'approved', action: { tool: 'launch_app', args: { name: 'Settings' } } });
    expect(broker.recent(1)).toHaveLength(1);
    broker.cancelAll('done');
    await second;
  });

  it('records requested approvals for high risk as warnings with redacted args', async () => {
    const pending = broker.request(input({ action: { tool: 'type_text', args: { text: 'secret', apiKey: 'sk-ant-abcdefghijklmnop' } } }));
    const event = ctx.activity.query({}).find((e) => e.type === 'approval.requested');
    expect(event).toMatchObject({ severity: 'warning', category: 'approval', tool: 'type_text' });
    expect(JSON.stringify(event?.detail)).not.toContain('sk-ant-abcdefghijklmnop');
    broker.cancelAll('done');
    await pending;
  });
});
