// Live Control's assistant panel must gate sending behind the cloud privacy
// notice exactly like the AI Assistant page (it used to send straight away),
// and show the conversation as one clean thread: one scroll area, each task
// inline in its turn, the final summary once, every pending approval visible.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './messages';
import { appStore, dispatchServerEvent, reduceBootstrap, resetStoreForTests, setConnection } from '../../state/store';
import { makeApproval, makeBootstrap, makeMessage, makeSettings, makeTask } from '../../test/fixtures';
import { calledRoutes, jsonResponse, routeFetch } from '../../test/http';
import { AssistantPanel } from './AssistantPanel';

const conversation = { id: 'conv_1', title: 'Live', createdAt: 1, updatedAt: 2 };

const withCloudProvider = (acknowledged: boolean) =>
  makeSettings((s) => {
    s.ai.providers = s.ai.providers.map((p) => (p.id === 'claude-api' ? { ...p, hasApiKey: true } : p));
    s.ai.activeProviderId = 'claude-api';
    s.privacy.cloudDisclosureAcknowledged = acknowledged;
  });

function setup(acknowledged: boolean, session = makeBootstrap().session) {
  const fetchMock = routeFetch({
    '/api/conversations': () => jsonResponse(200, [conversation]),
    '/api/conversations/conv_1/messages': () => jsonResponse(200, []),
    '/api/conversations/conv_1/tasks': () => jsonResponse(200, []),
    'PUT /api/settings': () => jsonResponse(200, withCloudProvider(true)),
  });
  act(() => {
    appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withCloudProvider(acknowledged), session })));
    setConnection({ socket: 'open' });
  });
  render(<AssistantPanel />);
  return fetchMock;
}

beforeEach(() => resetStoreForTests());

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('Live Control assistant panel', () => {
  it('blocks sending to a cloud provider until the privacy notice is accepted', async () => {
    const fetchMock = setup(false);
    const box = await screen.findByRole('textbox', { name: 'Instruction for the AI' });
    expect(screen.getByText('Before you send: Claude (Anthropic API) runs in the cloud')).toBeInTheDocument();
    expect(box).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(screen.queryByText('Before you send: Claude (Anthropic API) runs in the cloud')).not.toBeInTheDocument();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/api/settings');
    expect(put[1]?.body).toBe(JSON.stringify({ privacy: { cloudDisclosureAcknowledged: true } }));
    expect(calledRoutes(fetchMock)).not.toContain('POST /api/conversations/conv_1/messages');
  });

  it('sends normally once the notice was accepted', async () => {
    setup(true);
    const box = await screen.findByRole('textbox', { name: 'Instruction for the AI' });
    expect(box).not.toBeDisabled();
    expect(screen.queryByText(/runs in the cloud/)).not.toBeInTheDocument();
  });

  it('tells a remote device the notice can only be accepted on the Mac', async () => {
    setup(false, { id: 'sess_r', kind: 'remote', canControl: true, remote: true });
    const box = await screen.findByRole('textbox', { name: 'Instruction for the AI' });
    expect(box).toBeDisabled();
    expect(screen.getByText(/can only be accepted on the Mac/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I understand' })).not.toBeInTheDocument();
  });
});

describe('Live Control assistant panel conversation', () => {
  const SUMMARY = 'The For You feed wouldn’t move to the next post. I swiped up several times, but the screen stayed on the same video.';
  const failed = makeTask({
    id: 'task_9',
    status: 'failed',
    instruction: 'open tiktok and scroll for 20 videos',
    endedAt: 9_000,
    actionsUsed: 14,
    currentActivity: null,
    outcome: { success: false, verified: false, summary: SUMMARY },
    error: SUMMARY,
  });

  function setupConversation() {
    routeFetch({
      '/api/conversations': () => jsonResponse(200, [conversation]),
      '/api/conversations/conv_1/messages': () =>
        jsonResponse(200, [
          makeMessage({ id: 'u9', text: 'open tiktok and scroll for 20 videos', taskId: 'task_9', createdAt: 5 }),
          makeMessage({ id: 'a9', role: 'assistant', text: `Opening TikTok.\n\n${SUMMARY}`, taskId: 'task_9', createdAt: 6 }),
        ]),
      '/api/conversations/conv_1/tasks': () => jsonResponse(200, [failed]),
    });
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withCloudProvider(true) })));
      setConnection({ socket: 'open' });
    });
    return render(<AssistantPanel />);
  }

  it('is one scroll area with the task inline and the summary shown once', async () => {
    const { container } = setupConversation();
    const log = await screen.findByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(log).toHaveTextContent('open tiktok and scroll for 20 videos'));
    expect(container.querySelectorAll('.app-scroll')).toHaveLength(1);
    expect(log).toContainElement(screen.getByRole('region', { name: 'AI task' }));
    expect((document.body.textContent ?? '').split(SUMMARY).length - 1).toBe(1);
    expect(screen.getByText('Failed', { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show steps' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).not.toBeDisabled();
  });

  it('lists every pending approval: a task’s inline, an automation’s after the conversation', async () => {
    setupConversation();
    const log = await screen.findByRole('log', { name: 'Conversation' });
    await waitFor(() => expect(log).toHaveTextContent('open tiktok and scroll for 20 videos'));
    act(() => {
      dispatchServerEvent({ type: 'approval_requested', approval: makeApproval({ id: 'ap_task', taskId: 'task_9', summary: 'Open TikTok' }) });
      dispatchServerEvent({
        type: 'approval_requested',
        approval: makeApproval({ id: 'ap_wf', taskId: null, workflowRunId: 'run_1', actor: 'workflow', summary: 'Tap “Send” in Messages' }),
      });
    });
    const cards = screen.getAllByRole('article', { name: 'Approval request' });
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(log).toContainElement(card);
    expect(cards[0]).toHaveTextContent('Open TikTok');
    expect(cards[1]).toHaveTextContent('Tap “Send” in Messages');
    expect(screen.getByRole('heading', { name: 'Needs your approval' })).toBeInTheDocument();
  });
});
