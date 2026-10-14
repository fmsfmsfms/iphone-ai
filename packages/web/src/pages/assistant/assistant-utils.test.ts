import type { Conversation } from '@iphone-ai/shared';
import { describe, expect, it } from 'vitest';

import { makeApproval, makeSettings, makeStatus, makeStep, makeTask } from '../../test/fixtures';
import {
  assistantBlockReason,
  explainTaskFailure,
  filterConversations,
  groupConversations,
  interleaveApprovals,
  isUntitled,
  needsCloudDisclosure,
  nextConversationAfterRemoval,
  reasonText,
  sortConversations,
  type SendContext,
} from './assistant-utils';

const conv = (id: string, updatedAt: number, title = id): Conversation => ({ id, title, createdAt: updatedAt, updatedAt });

describe('conversations', () => {
  it('sorts newest first and filters by title', () => {
    const list = sortConversations([conv('a', 1), conv('b', 3), conv('c', 2)]);
    expect(list.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(filterConversations([conv('x', 1, 'Open Settings'), conv('y', 1, 'Battery')], 'settings').map((c) => c.id)).toEqual(['x']);
    expect(filterConversations(list, '  ')).toHaveLength(3);
  });

  it('groups by last activity', () => {
    const now = new Date(2026, 9, 14, 15, 0).getTime();
    const hour = 3600 * 1000;
    const groups = groupConversations(
      [conv('t', now - hour), conv('y', now - 20 * hour), conv('w', now - 4 * 24 * hour), conv('o', now - 30 * 24 * hour)],
      now,
    );
    expect(groups.map((g) => [g.group, g.items.map((c) => c.id)])).toEqual([
      ['today', ['t']],
      ['yesterday', ['y']],
      ['week', ['w']],
      ['older', ['o']],
    ]);
  });

  it('treats the backend default title as untitled', () => {
    expect(isUntitled({ title: 'New conversation' })).toBe(true);
    expect(isUntitled({ title: '' })).toBe(true);
    expect(isUntitled({ title: 'Open Settings' })).toBe(false);
  });

  it('picks the neighbour after a deletion', () => {
    const list = [conv('a', 3), conv('b', 2), conv('c', 1)];
    expect(nextConversationAfterRemoval(list, 'b')?.id).toBe('c');
    expect(nextConversationAfterRemoval(list, 'c')?.id).toBe('b');
    expect(nextConversationAfterRemoval([conv('a', 1)], 'a')).toBeNull();
  });
});

describe('interleaveApprovals', () => {
  it('places pending approvals where they were requested', () => {
    const steps = [
      makeStep({ id: 's1', index: 0, createdAt: 100 }),
      makeStep({ id: 's2', index: 1, createdAt: 200 }),
      makeStep({ id: 's3', index: 2, createdAt: 400 }),
    ];
    const approval = makeApproval({ id: 'ap', createdAt: 300 });
    const items = interleaveApprovals(steps, [approval]);
    expect(items.map((i) => (i.kind === 'steps' ? i.steps.map((s) => s.id).join(',') : i.approval.id))).toEqual(['s1,s2', 'ap', 's3']);
  });

  it('puts approvals newer than every step at the end', () => {
    const items = interleaveApprovals([makeStep({ id: 's1', createdAt: 100 })], [makeApproval({ id: 'late', createdAt: 900 })]);
    expect(items.map((i) => i.kind)).toEqual(['steps', 'approval']);
    expect(interleaveApprovals([], [])).toEqual([]);
  });
});

describe('explainTaskFailure', () => {
  it('returns null for successful or running tasks', () => {
    expect(explainTaskFailure(makeTask({ status: 'running' }))).toBeNull();
    expect(explainTaskFailure(makeTask({ status: 'completed', outcome: { success: true, verified: true, summary: 'Done' } }))).toBeNull();
  });

  it('explains common failures with a next step', () => {
    const failed = (error: string) => explainTaskFailure(makeTask({ status: 'failed', error }));
    expect(failed('Claude rejected the API key. Check it in Settings → AI Providers.')).toMatchObject({ kind: 'auth', canRetry: false, action: 'settings-ai' });
    expect(failed('Choose a model for LM Studio (local) in Settings → AI Providers.')).toMatchObject({ kind: 'config', action: 'settings-ai' });
    expect(failed('Claude rate limit reached. Try again shortly.')).toMatchObject({ kind: 'rateLimit', canRetry: true });
    expect(failed('Cannot reach the Anthropic API. Check your network connection.')).toMatchObject({ kind: 'network' });
    expect(failed('Time limit reached (300s).')).toMatchObject({ kind: 'timeout' });
    expect(failed('The task reached its step limit before finishing.')).toMatchObject({ kind: 'stepLimit' });
    expect(failed('Stopped: the AI kept repeating actions that did not change the screen.')).toMatchObject({ kind: 'loop' });
    expect(failed('iPhone Mirroring is paused. Lock your iPhone and keep it nearby, then click Resume.')).toMatchObject({ kind: 'mirroring', action: 'live' });
    expect(failed('Something odd')).toMatchObject({ kind: 'generic', canRetry: true });
  });

  it('distinguishes cancel, emergency stop and unsuccessful completion', () => {
    expect(explainTaskFailure(makeTask({ status: 'cancelled', error: 'Cancelled by you.' }))?.kind).toBe('cancelled');
    expect(explainTaskFailure(makeTask({ status: 'stopped', error: 'Stopped by the emergency stop.' }))?.kind).toBe('emergencyStop');
    expect(
      explainTaskFailure(makeTask({ status: 'completed', outcome: { success: false, verified: false, summary: 'Could not find it' } }))?.kind,
    ).toBe('unsuccessful');
  });
});

describe('assistantBlockReason', () => {
  const settingsWithKey = makeSettings((s) => {
    s.ai.providers = s.ai.providers.map((p) => (p.id === 'claude-api' ? { ...p, hasApiKey: true } : p));
  });
  const ctx: SendContext = {
    settings: settingsWithKey,
    session: { id: 's', kind: 'desktop', canControl: true, remote: false },
    status: makeStatus(),
    stopLatched: false,
    activeTask: null,
    connected: true,
    conversationId: 'conv_1',
  };

  it('allows sending when everything is ready', () => {
    expect(assistantBlockReason(ctx)).toBeNull();
  });

  it('names the provider problem', () => {
    const reason = assistantBlockReason({ ...ctx, settings: makeSettings() });
    expect(reason).toMatchObject({ key: 'assistant.reason.provider', action: 'settings-ai' });
    const text = reasonText(reason!, (key, vars) => (key === 'provider.reason.noKey' ? 'Needs an API key.' : `${key}|${vars?.['provider']}|${vars?.['reason']}`));
    expect(text).toBe('assistant.reason.provider|Claude (Anthropic API)|Needs an API key.');
  });

  it('accepts the Claude Code login provider without an API key', () => {
    const settings = makeSettings((s) => {
      s.ai.activeProviderId = 'claude-code';
    });
    expect(assistantBlockReason({ ...ctx, settings })).toBeNull();
  });

  it('needs a model id for local providers', () => {
    const settings = makeSettings((s) => {
      s.ai.activeProviderId = 'lmstudio';
    });
    expect(assistantBlockReason({ ...ctx, settings })?.vars?.['reasonKey']).toBe('provider.reason.noModel');
  });

  it('blocks on stop, running tasks and device state', () => {
    expect(assistantBlockReason({ ...ctx, stopLatched: true })?.key).toBe('composer.reason.stopLatched');
    expect(assistantBlockReason({ ...ctx, activeTask: makeTask({ conversationId: 'conv_1' }) })?.key).toBe('composer.reason.taskRunning');
    expect(assistantBlockReason({ ...ctx, activeTask: makeTask({ conversationId: 'other' }) })).toMatchObject({
      key: 'assistant.reason.taskElsewhere',
      action: 'open-task',
    });
    const status = makeStatus();
    expect(assistantBlockReason({ ...ctx, status: { ...status, server: { ...status.server, state: 'crashed' } } })?.key).toBe('assistant.reason.mcp');
    expect(assistantBlockReason({ ...ctx, status: { ...status, mirroring: { ...status.mirroring, state: 'paused' } } })?.key).toBe('assistant.reason.paused');
    expect(
      assistantBlockReason({ ...ctx, status: { ...status, permissions: { ...status.permissions, screenRecording: 'denied' } } })?.key,
    ).toBe('assistant.reason.screenRecording');
    expect(assistantBlockReason({ ...ctx, connected: false })?.key).toBe('composer.reason.offline');
  });

  it('asks for the cloud disclosure only for cloud providers', () => {
    const settings = makeSettings();
    const cloud = settings.ai.providers.find((p) => p.id === 'claude-api')!;
    const local = settings.ai.providers.find((p) => p.id === 'lmstudio')!;
    expect(needsCloudDisclosure(settings, cloud)).toBe(true);
    expect(needsCloudDisclosure(settings, local)).toBe(false);
    settings.privacy.cloudDisclosureAcknowledged = true;
    expect(needsCloudDisclosure(settings, cloud)).toBe(false);
  });
});
