// Manual control, emergency stop, control mode and settings validation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, localHeaders, loginDesktop, type Harness } from './harness.js';

function enableManualControl(harness: Harness): void {
  harness.ctx.settings.mutate((draft) => {
    draft.permissions.manualControlEnabled = true;
  });
}

const TAP = { action: { kind: 'tap', x: 100, y: 200 }, geometryId: '410x898', frameSeq: 7 };

describe('manual control and safety routes', () => {
  let h: Harness;
  let cookie: string;

  beforeEach(async () => {
    h = await createHarness();
    cookie = await loginDesktop(h);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await h.close();
  });

  it('denies a manual action while manual control is off (403 with the policy reason)', async () => {
    expect(h.ctx.settings.get().permissions.manualControlEnabled).toBe(false);
    const res = await h.local.app.inject({ method: 'POST', url: '/api/control/action', headers: localHeaders(cookie), payload: TAP });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; message: string; reasons: string[]; rules: string[] } }>();
    expect(body.error.code).toBe('policy_denied');
    expect(body.error.rules).toContain('manual.disabled');
    expect(body.error.message).toMatch(/Manual control is turned off/);
    expect(h.fakes.device.perform).not.toHaveBeenCalled();
  });

  it('performs a manual action when manual control is on, passing the policy decision', async () => {
    enableManualControl(h);
    const res = await h.local.app.inject({ method: 'POST', url: '/api/control/action', headers: localHeaders(cookie), payload: TAP });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tool: 'tap', focusChanged: false });
    expect(h.fakes.device.perform).toHaveBeenCalledTimes(1);
    const [action, actionCtx] = h.fakes.device.perform.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(action).toEqual({ kind: 'tap', x: 100, y: 200 });
    expect(actionCtx).toMatchObject({ actor: 'user', geometryId: '410x898', decision: { verdict: 'allow' } });
  });

  it('refocuses the desktop app after a focus-stealing manual action', async () => {
    enableManualControl(h);
    h.fakes.device.perform.mockResolvedValueOnce({ ok: true, tool: 'tap', durationMs: 5, message: 'ok', focusChanged: true });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const res = await h.local.app.inject({ method: 'POST', url: '/api/control/action', headers: localHeaders(cookie), payload: TAP });
    expect(res.statusCode).toBe(200);
    expect(h.fakes.device.refocusApp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(h.fakes.device.refocusApp).toHaveBeenCalledTimes(1);
  });

  it('validates manual actions with the shared schema', async () => {
    enableManualControl(h);
    const res = await h.local.app.inject({
      method: 'POST',
      url: '/api/control/action',
      headers: localHeaders(cookie),
      payload: { action: { kind: 'tap', x: -5, y: 'a' }, geometryId: null, frameSeq: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(h.fakes.device.perform).not.toHaveBeenCalled();
  });

  it('emergency stop latches the device, cancels approvals, the AI task and the workflow run', async () => {
    const pending = h.ctx.approvals.request({
      actor: 'ai',
      summary: 'Tap "Send"',
      action: { tool: 'tap', args: {} },
      risk: 'high',
      reasons: ['test'],
      timeoutSec: 60,
    });
    h.fakes.agents.activeTask.mockReturnValue({ id: 'task_1' } as never);
    h.fakes.workflows.activeRun.mockReturnValue({ id: 'run_1' } as never);
    const res = await h.local.app.inject({
      method: 'POST',
      url: '/api/control/stop',
      headers: localHeaders(cookie),
      payload: { reason: 'Panic button' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopLatched: true });
    expect(h.fakes.device.emergencyStop).toHaveBeenCalledWith('Panic button', 'user');
    expect(await pending).toBe('cancelled');
    expect(h.fakes.agents.cancelTask).toHaveBeenCalledWith('task_1', 'Panic button');
    expect(h.fakes.workflows.stop).toHaveBeenCalledWith('run_1', 'Panic button');
  });

  it('changes the control mode, audits it and restarts Mirroir when its config changed', async () => {
    h.fakes.mirroir.configChanged.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const res = await h.local.app.inject({
      method: 'PUT',
      url: '/api/control/mode',
      headers: localHeaders(cookie),
      payload: { mode: 'supervised' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ permissions: { controlMode: 'supervised' } });
    const events = h.ctx.activity.query({ categories: ['settings'] });
    expect(events[0]?.summary).toBe('Control mode changed to Supervised Automation.');
    await vi.waitFor(() => expect(h.fakes.mirroir.restart).toHaveBeenCalledTimes(1));
  });

  it('rejects invalid settings patches with 400', async () => {
    const bad = await h.local.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: localHeaders(cookie),
      payload: { permissions: { controlMode: 'yolo' } },
    });
    expect(bad.statusCode).toBe(400);
    const body = bad.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('permissions.controlMode');

    const unknown = await h.local.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: localHeaders(cookie),
      payload: { secrets: { anything: true } },
    });
    expect(unknown.statusCode).toBe(400);

    const everywhere = await h.local.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: localHeaders(cookie),
      payload: { remote: { bindAddress: '0.0.0.0' } },
    });
    expect(everywhere.statusCode).toBe(400);
    expect(h.ctx.settings.get().permissions.controlMode).toBe('observe');
  });

  it('applies valid settings patches and records them', async () => {
    const res = await h.local.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: localHeaders(cookie),
      payload: { general: { theme: 'light' }, privacy: { historyRetentionDays: 30 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ general: { theme: 'light' }, privacy: { historyRetentionDays: 30 } });
    const event = h.ctx.activity.query({ categories: ['settings'] })[0];
    expect(event?.summary).toContain('general.theme');
    expect(event?.summary).toContain('privacy.historyRetentionDays');
  });

  it('exports activity as sanitized CSV', async () => {
    h.ctx.activity.record({ category: 'manual', type: 'tool.call', actor: 'user', summary: '=HYPERLINK("x") "quoted", text' });
    const res = await h.local.app.inject({ method: 'GET', url: '/api/activity/export?format=csv&categories=manual', headers: localHeaders(cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="iphone-ai-activity-.*\.csv"$/);
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('time,category,type,actor,severity,summary,tool,success,durationMs,taskId,workflowRunId,detail');
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"") ""quoted"", text"`);

    const invalid = await h.local.app.inject({ method: 'GET', url: '/api/activity?categories=nope', headers: localHeaders(cookie) });
    expect(invalid.statusCode).toBe(400);
  });
});
