// Regression tests for the AI-path safety fixes, end to end: scripted model,
// real AgentService / toolkit / policy / approvals / DeviceController, MOCK
// Mirroir (no phone).

import { afterEach, describe, expect, it } from 'vitest';

import type { ServerEvent } from '@iphone-ai/shared';

import { jpegDimensions } from '../../src/ai/image.js';
import { pngDimensions } from '../../src/device/png.js';
import type { ExecutableTool, LoopProvider, LoopRequest } from '../../src/ai/types.js';
import { call, createHarness, idOf, lastResultText, waitFor, waitForTask, type Harness } from './harness.js';

let h: Harness;

afterEach(async () => {
  await h.close();
});

const toolCalls = (names: string[]) => h.calls().filter((c) => names.includes(c.name ?? ''));
const requested = () =>
  h.events.filter((e): e is Extract<ServerEvent, { type: 'approval_requested' }> => e.type === 'approval_requested').map((e) => e.approval);

async function startTask(text: string, conversationId = h.agents.createConversation().id) {
  const { task } = await h.agents.startTask(conversationId, { text }, 'user');
  return task;
}

describe('blocked apps reached by a partial name or already on screen (control-safety#0)', () => {
  it('denies open_app with a fragment of a blocked name and never sends launch_app', async () => {
    h = await createHarness('supervised');
    let result = '';
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('open_app', { name: 'Walle', reason: 'injected' })] };
      result = text;
      return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'blocked' })] };
    });
    const task = await startTask('Open Walle');
    await waitForTask(h, task.id);
    expect(result).toContain('BLOCKED');
    expect(toolCalls(['launch_app'])).toEqual([]);
    expect(h.phone().stack).not.toContain('app:Wallet');
  });

  it('tells the model when a blocked app is open and requires approval for actions inside it (Home stays free)', async () => {
    h = await createHarness('supervised');
    h.writeState({ screen: 'app:Wallet', resetSeq: 1 });
    const seen: string[] = [];
    h.setScript(({ turn, lastResultText: text }) => {
      seen.push(text);
      if (turn === 0) return { toolCalls: [call('tap', { element_id: idOf(text, 'Apple Cash'), reason: 'open cash' })] };
      if (turn === 1) return { toolCalls: [call('go_home', { reason: 'leave the blocked app' })] };
      return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'Wallet is blocked.' })] };
    });
    const task = await startTask('Show my Apple Cash balance');
    await waitFor(() => h.approvals.listPending().length === 1);
    const pending = h.approvals.listPending()[0]!;
    expect(pending.reasons.join(' ')).toMatch(/blocked app \(Wallet\) appears to be open/);
    h.approvals.decide(pending.id, 'rejected', 'user');
    await waitForTask(h, task.id);
    expect(seen[0]).toContain('SAFETY: A blocked app (Wallet) appears to be open');
    expect(toolCalls(['tap'])).toEqual([]);
    expect(toolCalls(['press_home']).length).toBe(1);
    expect(requested().length).toBe(1);
    expect(h.activity.query({ categories: ['policy'] }).some((e) => e.type === 'policy.blocked_app_on_screen')).toBe(true);
  });
});

describe('line breaks in type_text (control-safety#1)', () => {
  it('asks before typing text that ends in Return; rejecting it types nothing', async () => {
    h = await createHarness('supervised');
    h.writeState({ screen: 'safari', resetSeq: 1 });
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('tap', { element_id: idOf(text, 'Search or enter website name'), reason: 'focus' })] };
      if (turn === 1) return { toolCalls: [call('type_text', { text: 'attacker.example\n', reason: 'go' })] };
      return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'rejected' })] };
    });
    const task = await startTask('Open attacker.example');
    await waitFor(() => h.approvals.listPending().length === 1);
    const pending = h.approvals.listPending()[0]!;
    expect(pending.reasons.join(' ')).toMatch(/line break/);
    // The card shows the Return.
    expect(pending.summary).toContain('attacker.example⏎');
    h.approvals.decide(pending.id, 'rejected', 'user');
    await waitForTask(h, task.id);
    expect(toolCalls(['type_text', 'press_key'])).toEqual([]);
    expect(h.phone().safariUrl).toBeNull();
  });
});

describe('coordinate taps on labelled rows (control-safety#2)', () => {
  it('denies a tap on the right side of a blocked app row', async () => {
    h = await createHarness('supervised');
    h.writeState({ screen: 'notifications', resetSeq: 1 });
    let result = '';
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('tap', { x: 380, y: 779, reason: 'chevron' })] };
      result = text;
      return { toolCalls: [call('finish_task', { status: 'failed', summary: 'blocked' })] };
    });
    const task = await startTask('Open Wallet notification settings');
    await waitForTask(h, task.id);
    expect(result).toMatch(/BLOCKED.*may hit "Wallet"/s);
    expect(toolCalls(['tap'])).toEqual([]);
  });

  it('still allows a coordinate tap on the right side of a harmless row', async () => {
    h = await createHarness('supervised');
    h.writeState({ screen: 'settings', resetSeq: 1 });
    h.setScript(({ turn }) =>
      turn === 0
        ? { toolCalls: [call('tap', { x: 380, y: 664, reason: 'General row chevron' })] }
        : { toolCalls: [call('finish_task', { status: 'success', summary: 'General open', evidence: ['About'] })] },
    );
    const task = await startTask('Open General');
    const done = await waitForTask(h, task.id);
    expect(done.status).toBe('completed');
    expect(toolCalls(['tap']).length).toBe(1);
    expect(h.phone().stack.at(-1)).toBe('general');
    expect(requested()).toEqual([]);
  });
});

describe('approval re-checks the screen before acting (control-safety#3, robustness#4)', () => {
  async function tapWifiWithApproval(changeWhilePending: () => void) {
    h = await createHarness('assisted');
    h.writeState({ screen: 'settings', resetSeq: 1 });
    let afterApproval = '';
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('tap', { element_id: idOf(text, 'Wi-Fi'), reason: 'open Wi-Fi' })] };
      afterApproval = text;
      return { toolCalls: [call('finish_task', { status: 'failed', summary: 'done' })] };
    });
    const task = await startTask('Open Wi-Fi settings');
    await waitFor(() => h.approvals.listPending().length === 1);
    changeWhilePending();
    h.approvals.decide(h.approvals.listPending()[0]!.id, 'approved', 'user');
    await waitForTask(h, task.id);
    return afterApproval;
  }

  it('does not perform an approved tap when the screen changed while the card was open', async () => {
    const text = await tapWifiWithApproval(() => h.writeState({ screen: 'messages', resetSeq: 2 }));
    expect(text).toContain('The screen changed while waiting for approval');
    expect(toolCalls(['tap'])).toEqual([]);
    expect(h.phone().stack).toEqual(['messages']);
  });

  it('performs the approved tap when the screen is unchanged', async () => {
    await tapWifiWithApproval(() => undefined);
    expect(toolCalls(['tap']).length).toBe(1);
    expect(h.phone().stack.at(-1)).toBe('wifi');
  });

  it('withdraws the card and acts on nothing when control is lowered to Observe Only', async () => {
    h = await createHarness('assisted');
    let result = '';
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('go_home', { reason: 'home' })] };
      result = text;
      return { toolCalls: [call('finish_task', { status: 'failed', summary: 'stopped' })] };
    });
    const task = await startTask('Go home');
    await waitFor(() => h.approvals.listPending().length === 1);
    const id = h.approvals.listPending()[0]!.id;
    h.settings.update({ permissions: { controlMode: 'observe' } });
    expect(h.approvals.listPending()).toEqual([]);
    expect(h.approvals.decide(id, 'approved', 'user')).toBeNull();
    await waitForTask(h, task.id);
    expect(result).toMatch(/cancelled/);
    expect(toolCalls(['press_home'])).toEqual([]);
  });

  it('waits out a pause after approval and re-checks the screen the user left behind', async () => {
    h = await createHarness('assisted');
    h.writeState({ screen: 'settings', resetSeq: 1 });
    let afterApproval = '';
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('tap', { element_id: idOf(text, 'Wi-Fi'), reason: 'open Wi-Fi' })] };
      afterApproval = text;
      return { toolCalls: [call('finish_task', { status: 'failed', summary: 'done' })] };
    });
    const task = await startTask('Open Wi-Fi settings');
    await waitFor(() => h.approvals.listPending().length === 1);
    h.agents.pauseTask(task.id);
    h.approvals.decide(h.approvals.listPending()[0]!.id, 'approved', 'user');
    // The user uses the phone while the task is paused.
    h.writeState({ screen: 'home', resetSeq: 2 });
    await new Promise((r) => setTimeout(r, 600));
    expect(toolCalls(['tap'])).toEqual([]);
    h.agents.resumeTask(task.id);
    await waitForTask(h, task.id);
    expect(toolCalls(['tap'])).toEqual([]);
    // The toolkit itself waited for the resume and then saw the new screen.
    expect(afterApproval).toContain('The screen changed while waiting for approval');
  });
});

describe('drafts typed by someone else (control-safety#5)', () => {
  it('a later task cannot send a draft typed by an earlier task without approval', async () => {
    h = await createHarness('supervised');
    h.writeState({ screen: 'conversation:Mom', resetSeq: 1 });
    const conversationId = h.agents.createConversation().id;
    h.setScript(({ turn, lastResultText: text }) => {
      if (turn === 0) return { toolCalls: [call('tap', { element_id: idOf(text, 'iMessage'), reason: 'focus' })] };
      if (turn === 1) return { toolCalls: [call('type_text', { text: 'I quit', reason: 'draft' })] };
      return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'Draft ready, not sent.' })] };
    });
    const first = await startTask('Draft "I quit" to Mom but do not send', conversationId);
    await waitForTask(h, first.id);

    h.setScript(({ turn }) =>
      turn === 0
        ? { toolCalls: [call('tap', { x: 378, y: 800, reason: 'tap the arrow' })] }
        : { toolCalls: [call('finish_task', { status: 'failed', summary: 'not sent' })] },
    );
    const second = await startTask('Tap the arrow', conversationId);
    await waitFor(() => h.approvals.listPending().length === 1);
    expect(h.approvals.listPending()[0]!.reasons.join(' ')).toMatch(/send or submit/);
    h.approvals.decide(h.approvals.listPending()[0]!.id, 'rejected', 'user');
    await waitForTask(h, second.id);
    expect(h.phone().conversations.Mom!.some((m) => m.from === 'me')).toBe(false);
  });

  it('text the user typed by hand also needs approval before an AI tap sends it', async () => {
    h = await createHarness('supervised');
    h.settings.update({ permissions: { manualControlEnabled: true } });
    h.writeState({ screen: 'conversation:Mom', resetSeq: 1 });
    const allow = { verdict: 'allow' as const, risk: 'low' as const, reasons: [], rules: [] };
    await h.device.perform({ kind: 'tap', x: 180, y: 800 }, { actor: 'user', decision: allow, geometryId: h.device.geometry?.geometryId ?? null });
    await h.device.perform({ kind: 'type_text', text: 'hello' }, { actor: 'user', decision: allow });
    h.setScript(({ turn }) =>
      turn === 0
        ? { toolCalls: [call('tap', { x: 378, y: 800, reason: 'tap the arrow' })] }
        : { toolCalls: [call('finish_task', { status: 'failed', summary: 'not sent' })] },
    );
    const task = await startTask('Tap the arrow');
    await waitFor(() => h.approvals.listPending().length === 1);
    h.approvals.decide(h.approvals.listPending()[0]!.id, 'rejected', 'user');
    await waitForTask(h, task.id);
    expect(h.phone().conversations.Mom!.some((m) => m.from === 'me')).toBe(false);
  });
});

describe('approval cards show the text being typed (control-safety#6)', () => {
  it('shows the full text live, but stores and audits only the character count', async () => {
    h = await createHarness('supervised');
    const secretish = 'transfer 5000 to SA03 8000 1234';
    h.setScript(({ turn }) =>
      turn === 0
        ? { toolCalls: [call('type_text', { text: secretish, reason: 'payment note' })] }
        : { toolCalls: [call('finish_task', { status: 'failed', summary: 'rejected' })] },
    );
    const task = await startTask('Write the transfer note');
    await waitFor(() => h.approvals.listPending().length === 1);
    const pending = h.approvals.listPending()[0]!;
    expect(pending.summary).toContain(secretish);
    expect(pending.action.args.text).toBe(secretish);
    expect(requested()[0]!.summary).toContain(secretish);
    h.approvals.decide(pending.id, 'rejected', 'user');
    await waitForTask(h, task.id);
    const row = h.db.get<{ summary: string; action_json: string }>('SELECT summary, action_json FROM approvals WHERE id = ?', pending.id)!;
    expect(row.summary).toContain('«31 characters»');
    expect(row.action_json).not.toContain('SA03');
    const resolved = h.events.filter((e) => e.type === 'approval_resolved');
    expect(JSON.stringify(resolved)).not.toContain('SA03');
    expect(JSON.stringify(h.activity.query({}))).not.toContain('SA03');
  });
});

/** A loop provider (like the Claude Agent SDK) that drives the toolkit's executable tools itself. */
function loopProvider(run: (tools: Record<string, ExecutableTool>, request: LoopRequest) => Promise<void>, onRun?: () => void) {
  return (config: LoopProvider['config']): LoopProvider => ({
    kind: 'loop',
    config,
    async runLoop(request) {
      onRun?.();
      await run(Object.fromEntries(request.tools.map((t) => [t.name, t])), request);
      return { finalText: '', stop: 'end' };
    },
    async complete() {
      return '';
    },
    async test() {
      return { ok: true, latencyMs: 0, message: 'loop', model: 'loop', supportsTools: true, supportsVision: false };
    },
  });
}

describe('nothing runs after finish_task (control-safety#10)', () => {
  it('refuses a tool call made after finish_task by a loop provider', async () => {
    h = await createHarness('supervised');
    let afterFinish: { isError: boolean; text: string } | null = null;
    h.setProvider(
      loopProvider(async (tools) => {
        await tools.open_app!.execute({ name: 'Settings', reason: 'open' });
        await tools.finish_task!.execute({ status: 'success', summary: 'Settings open', evidence: ['Wi-Fi'] });
        const out = await tools.tap!.execute({ element_id: 'e3', reason: 'after finish' });
        afterFinish = { isError: out.isError, text: out.content.map((c) => (c.type === 'text' ? c.text : '')).join('') };
      }),
    );
    const task = await startTask('Open Settings');
    const done = await waitForTask(h, task.id);
    expect(afterFinish).toMatchObject({ isError: true });
    expect(afterFinish!.text).toContain('already finished');
    expect(toolCalls(['tap'])).toEqual([]);
    expect(done.outcome).toMatchObject({ success: true, verified: true, summary: 'Settings open' });
  });
});

describe('cancel before a loop provider starts (robustness#8)', () => {
  it('records the task as cancelled and never starts the provider loop', async () => {
    h = await createHarness('supervised');
    let started = false;
    h.setProvider(
      loopProvider(
        async () => undefined,
        () => {
          started = true;
        },
      ),
    );
    h.writeState({ slowMs: { describe_screen: 1200 } });
    const task = await startTask('Open Settings');
    await waitFor(() => h.calls().some((c) => c.name === 'describe_screen'));
    h.agents.cancelTask(task.id, 'Cancelled by the user');
    const done = await waitForTask(h, task.id);
    expect(done.status).toBe('cancelled');
    expect(started).toBe(false);
  });
});

describe('workflow Stop or Pause while an ai_task step builds its provider (robustness#1)', () => {
  it('a Stop during the provider build ends the embedded task before it acts', async () => {
    h = await createHarness('supervised');
    h.setBuildDelay(300);
    h.setScript(({ turn, lastResultText: text }) =>
      turn === 0
        ? { toolCalls: [call('open_app', { name: 'Settings', reason: 'open' })] }
        : turn === 1
          ? { toolCalls: [call('tap', { element_id: idOf(text, 'Wi-Fi'), reason: 'wifi' })] }
          : { toolCalls: [call('finish_task', { status: 'success', summary: 'ok', evidence: ['Wi-Fi'] })] },
    );
    const lease = h.device.acquireLease('workflow', 'Workflow “test”');
    const stop = new AbortController();
    const running = h.agents.runEmbeddedTask({ instruction: 'Open Wi-Fi', workflowRunId: 'run_test', leaseId: lease.id, signal: stop.signal });
    setTimeout(() => stop.abort(new Error('Stopped by the user')), 50);
    const result = await running;
    lease.release();
    expect(result.success).toBe(false);
    expect(h.agents.getTask(result.taskId)!.task.status).toBe('stopped');
    expect(toolCalls(['launch_app', 'tap'])).toEqual([]);
  });

  it('a workflow paused before the embedded task existed keeps the task from acting until it resumes', async () => {
    h = await createHarness('supervised');
    h.setScript(({ turn }) =>
      turn === 0
        ? { toolCalls: [call('open_app', { name: 'Settings', reason: 'open' })] }
        : { toolCalls: [call('finish_task', { status: 'success', summary: 'ok', evidence: ['Wi-Fi'] })] },
    );
    const lease = h.device.acquireLease('workflow', 'Workflow “test”');
    h.device.setLeasePaused(lease.id, true);
    const running = h.agents.runEmbeddedTask({ instruction: 'Open Settings', workflowRunId: 'run_test', leaseId: lease.id, signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 800));
    expect(toolCalls(['launch_app'])).toEqual([]);
    h.device.setLeasePaused(lease.id, false);
    const result = await running;
    lease.release();
    expect(result.success).toBe(true);
    expect(toolCalls(['launch_app']).length).toBe(1);
  });
});

describe('overlapping task starts (robustness#2)', () => {
  it('only one of two overlapping starts runs, and it stays cancellable', async () => {
    h = await createHarness('supervised');
    h.setBuildDelay(60);
    h.setScript(() => ({ toolCalls: [call('wait', { seconds: 1, reason: 'keep running' })] }));
    const a = h.agents.createConversation().id;
    const b = h.agents.createConversation().id;
    const results = await Promise.allSettled([
      h.agents.startTask(a, { text: 'First' }, 'user'),
      h.agents.startTask(b, { text: 'Second' }, 'user'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0]!.reason as { code?: string }).code).toBe('lease_conflict');
    const task = (fulfilled[0] as PromiseFulfilledResult<{ task: { id: string } }>).value.task;
    expect(h.agents.activeTask()?.id).toBe(task.id);
    h.agents.cancelTask(task.id, 'Cancelled by the user');
    expect((await waitForTask(h, task.id)).status).toBe('cancelled');
  });
});

describe('screenshots sent to the model (robustness#6)', () => {
  it('sends downscaled JPEGs, keeps the stored screenshot full size, and stops attaching images after the cap', async () => {
    h = await createHarness('observe');
    const observations = 33;
    h.setScript(({ turn }) =>
      turn < observations
        ? { toolCalls: [call('observe_screen')] }
        : { toolCalls: [call('finish_task', { status: 'failed', summary: 'looked around' })] },
    );
    const task = await startTask('Look at the screen many times');
    await waitForTask(h, task.id, 60000);
    const history = h.provider!.requests.at(-1)!;
    const images = history.flatMap((m) =>
      m.role === 'user' ? m.content : m.role === 'tool_results' ? m.results.flatMap((r) => r.content) : [],
    ).filter((c): c is { type: 'image'; mimeType: string; data: string } => c.type === 'image');
    expect(images.length).toBe(30);
    for (const image of images.slice(0, 2)) {
      if (process.platform === 'darwin') {
        expect(image.mimeType).toBe('image/jpeg');
        const dims = jpegDimensions(Buffer.from(image.data, 'base64'))!;
        expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(1400);
      }
    }
    expect(lastResultText(history)).toContain('No screenshot attached');
    // The stored step screenshot keeps the original full-resolution PNG.
    const shot = h.agents.getTask(task.id)!.steps.find((s) => s.screenshotId)!;
    const stored = h.screenshots.get(shot.screenshotId!)!;
    expect(stored.mimeType).toBe('image/png');
    expect(pngDimensions(stored.data)).toEqual({ width: 820, height: 1796 });
  });
});
