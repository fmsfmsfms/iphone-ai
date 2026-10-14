// Approval toasts may be skipped only when a card for that approval is
// actually on screen (they used to be skipped on every AI Assistant page,
// including for workflow approvals and other conversations' tasks).

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Route } from '../lib/router';
import { appStore, dispatchServerEvent, reduceBootstrap, resetStoreForTests, setUi } from '../state/store';
import { makeApproval, makeBootstrap, makeRun, makeTask } from '../test/fixtures';
import { approvalCardVisible, approvalReviewTarget, ApprovalWatcher } from './Watchers';

const toastMock = vi.hoisted(() => {
  let n = 0;
  return Object.assign(
    vi.fn(() => {
      n += 1;
      return `toast-${n}`;
    }),
    { close: vi.fn() },
  );
});

vi.mock('@heroui/react', async (importOriginal) => ({ ...(await importOriginal<typeof import('@heroui/react')>()), toast: toastMock }));

const aiInA = makeApproval({ id: 'apr_a', taskId: 'task_a', summary: 'Task in conversation A' });
const aiInB = makeApproval({ id: 'apr_b', taskId: 'task_b', summary: 'Task in conversation B' });
const workflow = makeApproval({ id: 'apr_w', actor: 'workflow', taskId: null, workflowRunId: 'run_1', summary: 'Workflow step' });

beforeEach(() => {
  resetStoreForTests();
  toastMock.mockClear();
  toastMock.close.mockClear();
  act(() => {
    appStore.setState((s) => reduceBootstrap(s, makeBootstrap()));
    dispatchServerEvent({ type: 'task_update', task: makeTask({ id: 'task_a', conversationId: 'conv_A', status: 'completed', endedAt: 2 }) });
    dispatchServerEvent({ type: 'task_update', task: makeTask({ id: 'task_b', conversationId: 'conv_B', status: 'awaiting_approval' }) });
    dispatchServerEvent({ type: 'workflow_run', run: makeRun({ id: 'run_1', workflowId: 'wf_1', status: 'awaiting_approval' }) });
  });
});

afterEach(() => {
  window.location.hash = '';
  resetStoreForTests();
});

describe('approvalCardVisible', () => {
  const visible = (approval: typeof aiInA, route: Route) => approvalCardVisible(approval, route, appStore.getState());

  it('on the AI Assistant only for the selected conversation’s tasks', () => {
    expect(visible(aiInB, { name: 'assistant', conversationId: 'conv_B' })).toBe(true);
    expect(visible(aiInA, { name: 'assistant', conversationId: 'conv_B' })).toBe(false);
    expect(visible(workflow, { name: 'assistant', conversationId: 'conv_B' })).toBe(false);
    expect(visible(aiInB, { name: 'assistant' })).toBe(false);
  });

  it('on Automations only on the run’s own workflow page', () => {
    expect(visible(workflow, { name: 'automations', workflowId: 'wf_1' })).toBe(true);
    expect(visible(workflow, { name: 'automations', workflowId: 'wf_2' })).toBe(false);
    expect(visible(workflow, { name: 'automations' })).toBe(false);
    expect(visible(aiInB, { name: 'automations', workflowId: 'wf_1' })).toBe(false);
  });

  it('on Live Control unless its assistant pane is collapsed', () => {
    expect(visible(workflow, { name: 'live' })).toBe(true);
    act(() => setUi({ liveAssistantCollapsed: true }));
    expect(visible(workflow, { name: 'live' })).toBe(false);
  });

  it('nowhere else, and not for tasks or runs the store doesn’t know', () => {
    expect(visible(aiInB, { name: 'dashboard' })).toBe(false);
    expect(visible(makeApproval({ taskId: 'unknown' }), { name: 'assistant', conversationId: 'conv_B' })).toBe(false);
  });
});

describe('approvalReviewTarget', () => {
  it('opens a page that renders the card (never the bare workflow list)', () => {
    const s = appStore.getState();
    expect(approvalReviewTarget(workflow, s)).toEqual({ name: 'automations', workflowId: 'wf_1' });
    expect(approvalReviewTarget(aiInA, s)).toEqual({ name: 'assistant', conversationId: 'conv_A' });
    expect(approvalReviewTarget(makeApproval({ taskId: null, workflowRunId: 'gone' }), s)).toEqual({ name: 'live' });
  });
});

describe('ApprovalWatcher', () => {
  it('announces approvals whose card is not on the current AI Assistant conversation', () => {
    window.location.hash = '#/assistant/conv_B';
    render(<ApprovalWatcher />);
    act(() => {
      dispatchServerEvent({ type: 'approval_requested', approval: aiInA });
      dispatchServerEvent({ type: 'approval_requested', approval: workflow });
      dispatchServerEvent({ type: 'approval_requested', approval: aiInB });
    });
    const announced = toastMock.mock.calls.map((call) => (call as unknown as [string, { description?: string }])[1]?.description);
    expect(announced).toEqual(['Task in conversation A', 'Workflow step']);
  });

  it('stays quiet on Live Control while the assistant pane lists the approval', () => {
    window.location.hash = '#/live';
    render(<ApprovalWatcher />);
    act(() => dispatchServerEvent({ type: 'approval_requested', approval: workflow }));
    expect(toastMock).not.toHaveBeenCalled();
  });
});
