// Privacy deletion and the diagnostics export.

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, localHeaders, loginDesktop, type Harness } from './harness.js';

describe('privacy and diagnostics', () => {
  let h: Harness;
  let cookie: string;

  beforeEach(async () => {
    h = await createHarness();
    cookie = await loginDesktop(h);
  });

  afterEach(async () => {
    await h.close();
  });

  it('deletes the selected local data and records it', async () => {
    const db = h.ctx.db;
    const now = Date.now();
    db.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', 'conv_1', 'Hi', now, now);
    db.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', 'conv_workflow_ai_steps', 'wf', now, now);
    db.run('INSERT INTO chat_messages (id, conversation_id, role, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'msg_1', 'conv_1', 'user', 'hello', null, now);
    db.run('INSERT INTO chat_messages (id, conversation_id, role, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'msg_2', 'conv_workflow_ai_steps', 'user', 'step', null, now);
    h.fakes.agents.listConversations.mockReturnValue([{ id: 'conv_1', title: 'Hi', createdAt: now, updatedAt: now }] as never);
    h.fakes.agents.deleteConversation.mockImplementation((id: string) => {
      db.run('DELETE FROM conversations WHERE id = ?', id);
    });
    const approval = h.ctx.approvals.request({ actor: 'ai', summary: 'x', action: { tool: 'tap', args: {} }, risk: 'low', reasons: [], timeoutSec: 60 });
    h.ctx.approvals.cancelAll('test');
    await approval;
    h.ctx.activity.record({ category: 'manual', type: 'tool.call', actor: 'user', summary: 'old event' });

    const res = await h.local.app.inject({
      method: 'POST',
      url: '/api/privacy/delete',
      headers: localHeaders(cookie),
      payload: { activity: true, conversations: true, approvals: true, screenshots: true },
    });
    expect(res.statusCode).toBe(200);
    const { deleted } = res.json<{ deleted: Record<string, number> }>();
    expect(deleted.conversations).toBe(1);
    expect(deleted.approvals).toBe(1);
    expect(deleted.screenshots).toBe(0);
    expect(deleted.activity).toBeGreaterThan(0);
    expect(db.all('SELECT id FROM chat_messages')).toHaveLength(0);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(db.all('SELECT id FROM conversations')).toEqual([{ id: 'conv_workflow_ai_steps' }]);
    const events = h.ctx.activity.query({});
    expect(events.some((e) => e.summary === 'old event')).toBe(false);
    expect(events[0]?.type).toBe('privacy.deleted');

    const unknown = await h.local.app.inject({ method: 'POST', url: '/api/privacy/delete', headers: localHeaders(cookie), payload: { everything: true } });
    expect(unknown.statusCode).toBe(400);
  });

  it('exports redacted diagnostics as an attachment', async () => {
    appendFileSync(
      h.ctx.paths.logFile,
      `${JSON.stringify({ msg: `key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV in ${homedir()}/Library` })}\n`,
    );
    const res = await h.local.app.inject({ method: 'GET', url: '/api/diagnostics/export', headers: localHeaders(cookie) });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="iphone-ai-diagnostics-.*\.json"$/);
    expect(res.body).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV');
    expect(res.body).not.toContain(homedir());
    const body = res.json<{ versions: { app: string }; appLog: string[]; mirroirStderr: string[]; activity: unknown[]; settings: unknown }>();
    expect(body.versions.app).toBe('0.1.0-test');
    expect(body.appLog.join('\n')).toContain('[redacted]');
    expect(body.mirroirStderr).toEqual(['mirroir started']);
    expect(Array.isArray(body.activity)).toBe(true);
  });
});
