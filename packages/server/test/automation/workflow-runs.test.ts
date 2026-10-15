import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowInput } from '@iphone-ai/shared';

import { autoDecide, createHarness, waitUntil, type Harness } from './fakes.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

function workflow(steps: WorkflowInput['steps'], name = 'Check iOS version'): string {
  return h.service.create({ name, description: '', steps, source: 'manual' }).id;
}

async function runToEnd(id: string) {
  const started = await h.service.run(id, 'user');
  return h.service.waitForRun(started.id);
}

describe('workflow runs', () => {
  it('runs every step end to end and records the outcome', async () => {
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'wait_for_text', label: 'General', timeoutMs: 1000 },
      { id: 'c', type: 'tap_text', label: 'general' },
      { id: 'd', type: 'tap_text', label: 'About', exact: true },
      { id: 'e', type: 'assert_text', label: 'Name', present: true },
      { id: 'f', type: 'assert_text', label: 'Wallet', present: false },
      { id: 'g', type: 'screenshot', label: 'about page' },
      { id: 'h', type: 'read_screen', saveAs: 'model' },
      { id: 'i', type: 'wait', ms: 100 },
    ]);
    const run = await runToEnd(id);

    expect(run.status).toBe('succeeded');
    expect(run.error).toBeNull();
    expect(run.endedAt).not.toBeNull();
    expect(run.steps.map((s) => s.status)).toEqual(Array(9).fill('succeeded'));
    expect(run.steps[2]!.message).toContain('Tapped “General”');
    expect(run.steps[6]!.screenshotId).toMatch(/^shot_/);
    expect(run.steps[7]!.output).toContain('iPhone 17');

    expect(h.device.performed.map((p) => p.action)).toEqual([
      { kind: 'launch_app', name: 'Settings' },
      { kind: 'tap', x: 205, y: 340 },
      { kind: 'tap', x: 205, y: 300 },
    ]);
    for (const p of h.device.performed) {
      expect(p.ctx.actor).toBe('workflow');
      expect(p.ctx.workflowRunId).toBe(run.id);
      expect(p.ctx.decision.verdict).toBe('allow');
    }
    expect(h.device.performed[1]!.ctx.geometryId).toBe('410x898');
    expect(h.device.currentLease).toBeNull();
    expect(h.service.activeRun()).toBeNull();

    const saved = h.service.get(id)!;
    expect(saved.lastRunStatus).toBe('succeeded');
    expect(saved.lastSuccessAt).not.toBeNull();
    expect(h.service.runs(id)[0]!.id).toBe(run.id);
    expect(h.service.getRun(run.id)!.status).toBe('succeeded');
    expect(h.runEvents.some((r) => r.id === run.id && r.status === 'running')).toBe(true);
    expect(h.runEvents.at(-1)!.status).toBe('succeeded');

    const types = h.activity.query({ categories: ['workflow'] }).map((e) => e.type);
    expect(types).toContain('workflow.run.started');
    expect(types).toContain('workflow.run.succeeded');
    expect(types.filter((t) => t === 'workflow.step.succeeded')).toHaveLength(9);
  });

  it('fails when an element is not found and skips the remaining steps', async () => {
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'tap_text', label: 'Bluetooth' },
      { id: 'c', type: 'tap_text', label: 'General' },
    ]);
    const run = await runToEnd(id);

    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'skipped']);
    expect(run.steps[1]!.message).toBe("Couldn't find “Bluetooth” on screen");
    expect(run.steps[2]!.message).toBe('Skipped due to previous failure');
    expect(run.error).toBe("Couldn't find “Bluetooth” on screen");
    // One initial describe plus three retries for the missing label.
    expect(h.device.performed).toHaveLength(1);
    expect(h.service.get(id)!.lastRunStatus).toBe('failed');
    expect(h.activity.query({ categories: ['workflow'] }).some((e) => e.type === 'workflow.run.failed')).toBe(true);
  });

  it('stops a run in the middle of a step', async () => {
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'wait', ms: 5000 },
      { id: 'c', type: 'tap_text', label: 'General' },
    ]);
    const started = await h.service.run(id, 'user');
    await waitUntil(() => h.service.getRun(started.id)!.steps[1]!.status === 'running');

    await expect(h.service.run(id, 'user')).rejects.toThrow(/already running/);

    const stopping = h.service.stop(started.id, 'Stopped by the user.');
    expect(stopping.status).toBe('stopped');
    const run = await h.service.waitForRun(started.id);

    expect(run.status).toBe('stopped');
    expect(run.error).toBe('Stopped by the user.');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'skipped']);
    expect(run.steps[2]!.message).toBe('Skipped (run stopped)');
    expect(h.device.performed).toHaveLength(1);
    expect(h.device.currentLease).toBeNull();
    expect(h.service.get(id)!.lastRunStatus).toBe('stopped');
  });

  it('ends as stopped when the emergency stop aborts the lease', async () => {
    const id = workflow([
      { id: 'a', type: 'wait', ms: 5000 },
      { id: 'b', type: 'press_home' },
    ]);
    const started = await h.service.run(id, 'user');
    await waitUntil(() => h.service.getRun(started.id)!.steps[0]!.status === 'running');
    h.device.emergencyStop();
    const run = await h.service.waitForRun(started.id);
    expect(run.status).toBe('stopped');
    expect(run.error).toBe('Stopped by the emergency stop.');
    expect(h.device.performed).toHaveLength(0);
  });

  it('pauses between steps (lease paused for manual use) and resumes', async () => {
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'wait', ms: 200 },
      { id: 'c', type: 'tap_text', label: 'General' },
      { id: 'd', type: 'tap_text', label: 'About' },
    ]);
    const started = await h.service.run(id, 'user');
    await waitUntil(() => h.service.getRun(started.id)!.steps[1]!.status === 'running');

    const paused = h.service.pause(started.id);
    expect(paused.status).toBe('paused');
    expect(h.device.currentLease!.paused).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.service.getRun(started.id)!.status).toBe('paused');
    expect(h.service.getRun(started.id)!.steps[1]!.status).toBe('succeeded');
    expect(h.device.performed).toHaveLength(1);

    const resumed = h.service.resume(started.id);
    expect(resumed.status).toBe('running');
    const run = await h.service.waitForRun(started.id);

    expect(run.status).toBe('succeeded');
    expect(h.device.performed).toHaveLength(3);
    expect(h.device.leasePausedHistory).toEqual([true, false]);
    expect(() => h.service.pause(run.id)).toThrow(/already finished/);
  });

  it('continues after an approved checkpoint', async () => {
    const decisions = autoDecide(h, () => 'approved');
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'checkpoint', message: 'Ready to open General?' },
      { id: 'c', type: 'tap_text', label: 'General' },
    ]);
    const run = await runToEnd(id);
    decisions.unsubscribe();

    expect(run.status).toBe('succeeded');
    expect(decisions.requests).toHaveLength(1);
    expect(decisions.requests[0]!.risk).toBe('low');
    expect(decisions.requests[0]!.workflowRunId).toBe(run.id);
    expect(decisions.requests[0]!.summary).toBe('Checkpoint: Ready to open General?');
    expect(h.device.performed).toHaveLength(2);
  });

  it('stops at a rejected checkpoint', async () => {
    const decisions = autoDecide(h, () => 'rejected');
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'checkpoint', message: 'Ready?' },
      { id: 'c', type: 'tap_text', label: 'General' },
    ]);
    const run = await runToEnd(id);
    decisions.unsubscribe();

    expect(run.status).toBe('stopped');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'skipped']);
    expect(run.steps[1]!.message).toBe('You stopped the workflow at this checkpoint.');
    expect(h.device.performed).toHaveLength(1);
  });

  it('denies launching a blocked app', async () => {
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Wallet' },
      { id: 'b', type: 'press_home' },
    ]);
    const run = await runToEnd(id);

    expect(run.status).toBe('failed');
    expect(run.steps[0]!.status).toBe('failed');
    expect(run.steps[0]!.message).toMatch(/^Not allowed: .*blocked app/);
    expect(run.steps[1]!.status).toBe('skipped');
    expect(h.device.performed).toHaveLength(0);
  });

  it('refuses to start in Observe Only mode', async () => {
    h.settings.mutate((d) => {
      d.permissions.controlMode = 'observe';
    });
    const id = workflow([{ id: 'a', type: 'press_home' }]);
    await expect(h.service.run(id, 'user')).rejects.toThrow('Workflows need Assisted or Supervised mode');
    expect(h.device.currentLease).toBeNull();
    expect(h.service.runs(id)).toHaveLength(0);
  });

  it('refuses to start when stop is latched, another lease is active, or mirroring is not connected', async () => {
    const id = workflow([{ id: 'a', type: 'press_home' }]);

    h.device.stopLatched = true;
    await expect(h.service.run(id, 'user')).rejects.toThrow(/emergency stop/i);
    h.device.stopLatched = false;

    const other = h.device.acquireLease('ai', 'AI task “Open Maps”');
    await expect(h.service.run(id, 'user')).rejects.toThrow('AI task “Open Maps” is already controlling the iPhone');
    other.release();

    h.device.mirroringState = 'paused';
    await expect(h.service.run(id, 'user')).rejects.toThrow(/paused/);
    h.device.mirroringState = 'not_running';
    await expect(h.service.run(id, 'user')).rejects.toThrow(/not connected/);
  });

  it('asks for approval for every action in Assisted mode', async () => {
    h.settings.mutate((d) => {
      d.permissions.controlMode = 'assisted';
    });
    const decisions = autoDecide(h, () => 'approved');
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'tap_text', label: 'General' },
      { id: 'c', type: 'wait', ms: 100 },
      { id: 'd', type: 'press_home' },
    ]);
    const run = await runToEnd(id);
    decisions.unsubscribe();

    expect(run.status).toBe('succeeded');
    expect(decisions.requests.map((r) => r.action.tool)).toEqual(['launch_app', 'tap', 'press_home']);
    expect(decisions.requests.every((r) => r.actor === 'workflow')).toBe(true);
    expect(h.device.performed).toHaveLength(3);
    for (const [index, p] of h.device.performed.entries()) {
      expect(p.ctx.decision.verdict).toBe('require_approval');
      expect(p.ctx.approvalId).toBe(decisions.requests[index]!.id);
    }
  });

  it('retries from the failed step', async () => {
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'tap_text', label: 'Bluetooth' },
      { id: 'c', type: 'tap_text', label: 'General' },
    ]);
    const first = await runToEnd(id);
    expect(first.status).toBe('failed');

    h.device.screens.settings!.push({ label: 'Bluetooth', x: 205, y: 420 });
    const retried = await h.service.retry(first.id, true, 'user');
    expect(retried.retryOf).toBe(first.id);
    const run = await h.service.waitForRun(retried.id);

    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => s.status)).toEqual(['skipped', 'succeeded', 'succeeded']);
    expect(run.steps[0]!.message).toBe('Skipped (retry from failed step)');
    expect(h.device.performed.map((p) => p.action.kind)).toEqual(['launch_app', 'tap', 'tap']);
    expect(h.service.runs(id)).toHaveLength(2);
  });

  it('fails a tap_point recorded for a different window size', async () => {
    const id = workflow([{ id: 'a', type: 'tap_point', x: 100, y: 120, geometryId: '390x844' }]);
    const run = await runToEnd(id);
    expect(run.status).toBe('failed');
    expect(run.steps[0]!.message).toMatch(/recorded for a different window size \(390x844\)/);
    expect(h.device.performed).toHaveLength(0);

    const ok = workflow([{ id: 'a', type: 'tap_point', x: 100, y: 120, geometryId: '410x898' }], 'Point tap');
    const okRun = await runToEnd(ok);
    expect(okRun.status).toBe('succeeded');
    expect(h.device.performed[0]!.action).toEqual({ kind: 'tap', x: 100, y: 120 });
  });

  it('never writes sensitive typed text to the activity history or run results', async () => {
    h.settings.mutate((d) => {
      d.privacy.logTypedText = true;
      // Sensitive steps are refused while this is on (see "passwords and codes").
      d.permissions.blockTypingOnAuthScreens = false;
    });
    const id = workflow([
      { id: 'a', type: 'type_text', text: 'hunter2-secret', sensitive: true },
      { id: 'b', type: 'type_text', text: 'hello world' },
    ]);
    const run = await runToEnd(id);

    expect(run.status).toBe('succeeded');
    expect(run.steps[0]!.message).toBe('Typed «14 characters»');
    expect(run.steps[1]!.message).toBe('Typed “hello world”');
    const history = JSON.stringify(h.activity.query({ limit: 1000 }));
    expect(history).not.toContain('hunter2');
    expect(history).toContain('«14 characters»');
    expect(history).toContain('hello world');
    expect(JSON.stringify(h.runEvents)).not.toContain('hunter2');
    // The phone still receives the real text; the device log is told to hide it.
    expect(h.device.performed[0]!.action).toEqual({ kind: 'type_text', text: 'hunter2-secret' });
    expect(h.device.performed[0]!.ctx.sensitive).toBe(true);
    expect(h.device.performed[1]!.ctx.sensitive).toBeUndefined();
  });

  it('redacts all typed text from history unless logging typed text is enabled', async () => {
    const id = workflow([{ id: 'a', type: 'type_text', text: 'hello world' }]);
    const run = await runToEnd(id);
    expect(run.steps[0]!.message).toBe('Typed «11 characters»');
    expect(JSON.stringify(h.activity.query({ limit: 1000 }))).not.toContain('hello world');
  });

  it('refuses open_url with guidance and runs ai_task through the agent service', async () => {
    const id = workflow([
      { id: 'a', type: 'ai_task', instruction: 'Dismiss any pop-up', maxActions: 3 },
      { id: 'b', type: 'open_url', url: 'https://example.com' },
    ]);
    const run = await runToEnd(id);
    expect(run.steps[0]!.status).toBe('succeeded');
    expect(h.agents.embedded).toHaveLength(1);
    expect(h.agents.embedded[0]!.workflowRunId).toBe(run.id);
    expect(h.agents.embedded[0]!.maxActions).toBe(3);
    expect(run.steps[1]!.message).toBe('Mirroir cannot open URLs on iPhone; use launch_app Safari + type_text');
    expect(run.status).toBe('failed');
  });

  it('pauses the embedded AI task together with the run', async () => {
    let finishAi: () => void = () => undefined;
    h.agents.embeddedGate = new Promise<void>((resolve) => {
      finishAi = resolve;
    });
    const id = workflow([
      { id: 'a', type: 'ai_task', instruction: 'Clear notifications' },
      { id: 'b', type: 'press_home' },
    ]);
    const started = await h.service.run(id, 'user');
    await waitUntil(() => h.agents.embedded.length === 1);

    h.service.pause(started.id);
    expect(h.agents.taskControl).toEqual(['pause:task_fake']);
    expect(h.device.currentLease!.paused).toBe(true);
    h.service.resume(started.id);
    expect(h.agents.taskControl).toEqual(['pause:task_fake', 'resume:task_fake']);
    expect(h.device.currentLease!.paused).toBe(false);

    finishAi();
    const run = await h.service.waitForRun(started.id);
    expect(run.status).toBe('succeeded');
    expect(h.agents.embedded[0]!.leaseId).toBe(h.device.performed[0]!.ctx.leaseId);
  });

  it('cancels a paused AI step when the run is stopped, so control is released', async () => {
    h.agents.embeddedGate = new Promise<void>(() => undefined);
    const id = workflow([{ id: 'a', type: 'ai_task', instruction: 'Clear notifications' }]);
    const started = await h.service.run(id, 'user');
    await waitUntil(() => h.agents.embedded.length === 1);
    h.service.pause(started.id);
    h.service.stop(started.id, 'Stopped by the user.');
    const run = await h.service.waitForRun(started.id);
    expect(run.status).toBe('stopped');
    expect(h.agents.taskControl).toEqual(['pause:task_fake', 'cancel:task_fake']);
    expect(h.device.currentLease).toBeNull();
  });

  it('reads the screen with the AI provider and reuses the value in later steps', async () => {
    h.device.current = 'about';
    h.agents.replies.push('iPhone 17', 'NOT FOUND');
    const id = workflow([
      { id: 'a', type: 'read_screen', saveAs: 'model', instruction: 'the phone model' },
      { id: 'b', type: 'type_text', text: 'My phone is {model}' },
      { id: 'c', type: 'read_screen', saveAs: 'serial', instruction: 'the serial number' },
    ]);
    const run = await runToEnd(id);

    expect(run.steps[0]!.output).toBe('iPhone 17');
    expect(h.agents.completions[0]!.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(h.agents.completions[0]!.content)).toContain('the phone model');
    expect(h.device.performed[0]!.action).toEqual({ kind: 'type_text', text: 'My phone is iPhone 17' });
    expect(run.status).toBe('failed');
    expect(run.steps[2]!.message).toBe('The AI could not find “the serial number” on screen');

    h.agents.providerAvailable = false;
    const fallback = await runToEnd(workflow([{ id: 'a', type: 'read_screen', saveAs: 'all', instruction: 'everything' }], 'Fallback'));
    expect(fallback.status).toBe('succeeded');
    expect(fallback.steps[0]!.output).toContain('iPhone 17');
    expect(fallback.steps[0]!.message).toMatch(/No AI provider is configured/);
  });

  it('replays swipe steps as Mirroir swipes computed from the window geometry', async () => {
    const id = workflow([
      { id: 'a', type: 'swipe', direction: 'up' },
      { id: 'b', type: 'swipe', direction: 'left', distance: 'long' },
    ]);
    const run = await runToEnd(id);
    expect(run.status).toBe('succeeded');
    // Mirroir drag (a real touch flick), not its scroll-wheel swipe with a momentum tail.
    expect(h.device.performed.map((p) => p.action)).toEqual([
      { kind: 'swipe', fromX: 205, fromY: 629, toX: 205, toY: 269, durationMs: 300 },
      { kind: 'swipe', fromX: 318, fromY: 449, toX: 92, toY: 449, durationMs: 300 },
    ]);
  });

  it('fails when the run has more steps than the configured limit', async () => {
    h.settings.mutate((d) => {
      d.automation.maxStepsPerRun = 1;
    });
    const id = workflow([
      { id: 'a', type: 'press_home' },
      { id: 'b', type: 'press_home' },
    ]);
    const run = await runToEnd(id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/limit is 1 steps per run/);
    expect(run.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(h.device.performed).toHaveLength(0);
  });
});

describe('passwords and codes', () => {
  it('refuses a sensitive type_text step (a stored password) and never types it', async () => {
    h.settings.mutate((d) => {
      d.permissions.controlMode = 'assisted';
    });
    const decisions = autoDecide(h, () => 'approved');
    const id = workflow([
      { id: 'a', type: 'press_home' },
      { id: 'b', type: 'type_text', text: 'hunter2', sensitive: true },
    ]);
    const run = await runToEnd(id);
    decisions.unsubscribe();

    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'failed']);
    expect(run.steps[1]!.message).toBe('This step types a password or code. Enter it yourself on the iPhone (replace the step with a checkpoint).');
    // Denied outright: not even offered as an approval.
    expect(decisions.requests.map((r) => r.action.tool)).toEqual(['press_home']);
    expect(h.device.performed.map((p) => p.action.kind)).toEqual(['press_home']);
    expect(JSON.stringify(h.runEvents)).not.toContain('hunter2');
  });

  it('refuses typing on a screen with a password or code field, like the AI path', async () => {
    h.device.screens.login = [
      { label: 'Sign In', x: 205, y: 100 },
      { label: 'Email', x: 205, y: 250 },
      { label: 'Password', x: 205, y: 320 },
      { label: 'Forgot password?', x: 205, y: 420 },
    ];
    h.device.screens.otp = [
      { label: 'Enter the 6-digit code we sent to +1 555 0100', x: 205, y: 150 },
      { label: 'Code', x: 205, y: 300 },
      { label: 'Resend', x: 205, y: 400 },
    ];

    h.device.current = 'login';
    const login = await runToEnd(workflow([{ id: 'a', type: 'type_text', text: 'hunter2' }], 'Log in'));
    expect(login.status).toBe('failed');
    expect(login.steps[0]!.message).toMatch(/^Not allowed: .*Typing into "Password" looks like entering a secret/);

    h.device.current = 'otp';
    const otp = await runToEnd(workflow([{ id: 'a', type: 'type_text', text: '483920' }], 'Enter code'));
    expect(otp.status).toBe('failed');
    expect(otp.steps[0]!.message).toMatch(/^Not allowed: .*Typing into "Code" looks like entering a secret/);

    expect(h.device.performed).toHaveLength(0);
  });

  it('refuses typing into a secret field the workflow tapped just before', async () => {
    // "Wi-Fi Password" is not a bare field label, so only the tapped field reveals it.
    h.device.screens.wifi = [
      { label: 'Join Network', x: 205, y: 100 },
      { label: 'Wi-Fi Password', x: 205, y: 300 },
      { label: 'Join', x: 350, y: 100 },
    ];
    h.device.current = 'wifi';
    const decisions = autoDecide(h, () => 'approved');
    const run = await runToEnd(
      workflow([
        { id: 'a', type: 'tap_text', label: 'Wi-Fi Password' },
        { id: 'b', type: 'type_text', text: 'letmein' },
      ]),
    );
    decisions.unsubscribe();

    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'failed']);
    expect(run.steps[1]!.message).toMatch(/^Not allowed: .*Typing into "Wi-Fi Password" looks like entering a secret/);
    expect(h.device.performed.map((p) => p.action.kind)).toEqual(['tap']);
  });

  it('never types a value read from a code screen', async () => {
    h.device.screens.sms = [
      { label: 'Messages', x: 205, y: 60 },
      { label: 'Your verification code is 483920', x: 205, y: 300 },
    ];
    h.device.current = 'sms';
    const decisions = autoDecide(h, () => 'approved');
    const run = await runToEnd(
      workflow([
        { id: 'a', type: 'read_screen', saveAs: 'otp' },
        { id: 'b', type: 'launch_app', app: 'Settings' },
        { id: 'c', type: 'type_text', text: 'Code: {otp}' },
      ]),
    );
    decisions.unsubscribe();

    expect(run.steps[0]!.output).not.toContain('483920');
    expect(run.status).toBe('failed');
    expect(run.steps[2]!.message).toBe(
      '{otp} looks like a password or code read from the screen, so it is not typed. Enter it yourself on the iPhone (replace the step with a checkpoint).',
    );
    expect(h.device.performed.map((p) => p.action.kind)).toEqual(['launch_app']);
    expect(JSON.stringify(h.runEvents)).not.toContain('483920');
  });
});

describe('pause and stop while an action is queued', () => {
  it('passes the run signal to every device action, so a stop drops a queued action', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    h.device.whileQueued = (_action, ctx) => {
      seen.push(ctx.signal);
      h.service.stop(h.service.activeRun()!.id, 'Stopped by the user.');
    };
    const started = await h.service.run(workflow([{ id: 'a', type: 'press_home' }]), 'user');
    const run = await h.service.waitForRun(started.id);

    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(run.status).toBe('stopped');
    expect(run.error).toBe('Stopped by the user.');
    expect(h.device.performed).toHaveLength(0);
    expect(h.device.currentLease).toBeNull();
  });

  it('waits for resume and retries the step when a pause refuses its queued action', async () => {
    let pausedWhileQueued = false;
    h.device.whileQueued = (action) => {
      if (action.kind === 'tap' && !pausedWhileQueued) {
        pausedWhileQueued = true;
        h.service.pause(h.service.activeRun()!.id);
      }
    };
    const id = workflow([
      { id: 'a', type: 'launch_app', app: 'Settings' },
      { id: 'b', type: 'tap_text', label: 'General' },
      { id: 'c', type: 'assert_text', label: 'About', present: true },
    ]);
    const started = await h.service.run(id, 'user');
    await waitUntil(() => pausedWhileQueued);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The refused tap was not executed and the run waits, paused.
    expect(h.service.getRun(started.id)!.status).toBe('paused');
    expect(h.service.getRun(started.id)!.steps[1]!.status).toBe('running');
    expect(h.device.performed.map((p) => p.action.kind)).toEqual(['launch_app']);

    h.service.resume(started.id);
    const run = await h.service.waitForRun(started.id);

    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(run.steps[1]!.message).toBe('Tapped “General”');
    expect(h.device.performed.map((p) => p.action)).toEqual([
      { kind: 'launch_app', name: 'Settings' },
      { kind: 'tap', x: 205, y: 340 },
    ]);
    expect(h.device.leasePausedHistory).toEqual([true, false]);
  });
});
