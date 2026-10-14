// End-to-end tests of the AI task loop with a SCRIPTED model (no network),
// the real AgentService / toolkit / policy / approvals / DeviceController, and
// the MOCK Mirroir server (no phone). These verify control flow and safety
// behaviour; they are not real-device results.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderError } from '../../src/ai/types.js';
import { call, createHarness, idOf, waitFor, waitForTask, type Harness } from './harness.js';

describe('AI task loop (scripted model × mock Mirroir)', () => {
  let h: Harness;

  afterEach(async () => {
    await h.close();
  });

  describe('supervised mode', () => {
    beforeEach(async () => {
      h = await createHarness('supervised');
    });

    it('opens Settings, navigates to Wi-Fi and verifies the result on screen', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { text: 'Opening Settings.', toolCalls: [call('open_app', { name: 'Settings', reason: 'Wi-Fi lives in Settings' })] };
        if (turn === 1) return { toolCalls: [call('tap', { element_id: idOf(lastResultText, 'Wi-Fi'), reason: 'open Wi-Fi' })] };
        return { toolCalls: [call('finish_task', { status: 'success', summary: 'Wi-Fi settings are open.', evidence: ['Wi-Fi'] })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Navigate to Wi-Fi settings.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('completed');
      expect(done.outcome).toMatchObject({ success: true, verified: true });
      const names = h.calls().map((c) => c.name);
      expect(names).toContain('launch_app');
      expect(names).toContain('tap');
      expect(names.filter((n) => n === 'describe_screen').length).toBeGreaterThanOrEqual(3);
      const steps = h.agents.getTask(task.id)!.steps;
      expect(steps.some((s) => s.type === 'tool_call' && s.tool?.name === 'launch_app' && s.tool.ok)).toBe(true);
      expect(steps.some((s) => s.type === 'verify')).toBe(true);
      const messages = h.agents.getMessages(conversation.id);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('marks success as NOT verified when the evidence is not on the final screen', async () => {
      h.setScript(({ turn }) =>
        turn === 0
          ? { toolCalls: [call('finish_task', { status: 'success', summary: 'Done', evidence: ['Battery Percentage'] })] }
          : { text: 'ok' },
      );
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Check my battery percentage.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.outcome).toMatchObject({ success: true, verified: false });
    });

    it('blocks opening a blocked app and never sends launch_app to Mirroir', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { toolCalls: [call('open_app', { name: 'Wallet', reason: 'test' })] };
        expect(lastResultText).toContain('BLOCKED');
        return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'Wallet is blocked.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Open Wallet.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('failed');
      expect(h.calls().some((c) => c.name === 'launch_app')).toBe(false);
      expect(h.activity.query({ categories: ['policy'] }).some((e) => e.type === 'policy.denied')).toBe(true);
    });

    it('refuses the same action on an unchanged screen after two attempts', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn < 4) return { toolCalls: [call('tap', { x: 30, y: 870, reason: 'tap empty area' })] };
        expect(lastResultText).toContain('Loop detected');
        return { toolCalls: [call('finish_task', { status: 'failed', summary: 'Stuck.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Tap the corner.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('failed');
      expect(h.calls().filter((c) => c.name === 'tap').length).toBe(2);
    });

    it('reports provider failures as a failed task with a readable error', async () => {
      h.failProvider(new ProviderError('Cannot reach the Anthropic API. Check your network connection.', true, 'unavailable'));
      const conversation = h.agents.createConversation();
      await expect(h.agents.startTask(conversation.id, { text: 'Open Settings.' }, 'user')).rejects.toThrow(/Cannot reach/);
      expect(h.agents.activeTask()).toBeNull();
    });

    it('stops the task and terminates Mirroir when STOP is pressed during an action', async () => {
      h.writeState({ slowMs: { launch_app: 8000 } });
      h.setScript(({ turn }) =>
        turn === 0
          ? { toolCalls: [call('open_app', { name: 'Settings', reason: 'slow launch' })] }
          : { toolCalls: [call('finish_task', { status: 'failed', summary: 'should not get here' })] },
      );
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Open Settings.' }, 'user');
      await waitFor(() => h.calls().some((c) => c.name === 'launch_app'));
      await h.device.emergencyStop('test', 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('stopped');
      expect(h.calls().some((c) => c.signal === 'SIGTERM')).toBe(true);
      expect(h.device.isStopLatched).toBe(true);
      h.device.rearm('user');
      await waitFor(() => h.mirroir.isReady(), 20000);
    });

    it('fails gracefully when iPhone Mirroring disconnects during the task', async () => {
      h.setScript(({ turn }) => {
        if (turn === 0) {
          h.writeState({ mirroring: 'not_running' });
          return { toolCalls: [call('go_home', { reason: 'start from home' })] };
        }
        return { toolCalls: [call('finish_task', { status: 'failed', summary: 'Mirroring disconnected.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Go home.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('failed');
      const steps = h.agents.getTask(task.id)!.steps;
      expect(steps.some((s) => /not connected|not running/i.test(`${s.detail ?? ''} ${s.tool?.result ?? ''}`))).toBe(true);
    });
  });

  describe('assisted mode', () => {
    beforeEach(async () => {
      h = await createHarness('assisted');
    });

    it('waits for approval and executes only after the user approves', async () => {
      h.setScript(({ turn }) =>
        turn === 0
          ? { toolCalls: [call('open_app', { name: 'Settings', reason: 'open settings' })] }
          : { toolCalls: [call('finish_task', { status: 'success', summary: 'Settings open', evidence: ['Settings'] })] },
      );
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Open Settings on my iPhone.' }, 'user');
      await waitFor(() => h.approvals.listPending().length === 1);
      expect(h.calls().some((c) => c.name === 'launch_app')).toBe(false);
      const pending = h.approvals.listPending()[0]!;
      h.approvals.decide(pending.id, 'approved', 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('completed');
      expect(h.calls().some((c) => c.name === 'launch_app')).toBe(true);
    });

    it('does not execute a rejected action', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { toolCalls: [call('go_home', { reason: 'home' })] };
        expect(lastResultText).toContain('REJECTED');
        return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'You rejected going home.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Go home.' }, 'user');
      await waitFor(() => h.approvals.listPending().length === 1);
      h.approvals.decide(h.approvals.listPending()[0]!.id, 'rejected', 'user', 'not now');
      await waitForTask(h, task.id);
      expect(h.calls().some((c) => c.name === 'press_home')).toBe(false);
    });
  });

  describe('observe-only mode', () => {
    beforeEach(async () => {
      h = await createHarness('observe');
    });

    it('offers only observation tools and never sends input', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { toolCalls: [call('tap', { x: 10, y: 10, reason: 'try' })] };
        expect(lastResultText).toMatch(/Unknown or unavailable tool/);
        return { toolCalls: [call('finish_task', { status: 'success', summary: 'The Home Screen is showing.', evidence: ['Settings'] })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'What is on my screen?' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(h.provider!.seenTools[0]).toEqual(['observe_screen', 'wait', 'finish_task']);
      expect(done.status).toBe('completed');
      const inputTools = ['tap', 'swipe', 'type_text', 'launch_app', 'press_home', 'press_key'];
      expect(h.calls().some((c) => inputTools.includes(c.name ?? ''))).toBe(false);
      expect(h.device.currentLease).toBeNull();
    });
  });
});
