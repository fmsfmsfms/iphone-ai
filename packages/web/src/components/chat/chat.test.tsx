import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeApproval, makeBootstrap, makeMessage, makeStep, makeTask } from '../../test/fixtures';
import { appStore, dispatchServerEvent, reduceBootstrap, resetStoreForTests, setTaskSteps, upsertTask } from '../../state/store';
import { ApprovalCard, ChatThread, Composer, explainTaskFailure, formatCountdown, TaskCard, TaskStatusBar, type TaskRenderContext } from './index';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetStoreForTests();
  appStore.setState((s) => reduceBootstrap(s, makeBootstrap()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('ApprovalCard', () => {
  it('shows the request and sends the decision', async () => {
    const approval = makeApproval();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { ...approval, status: 'approved' }));
    vi.stubGlobal('fetch', fetchMock);
    act(() => dispatchServerEvent({ type: 'approval_requested', approval }));

    render(<ApprovalCard approval={approval} />);
    expect(screen.getByText('Tap “Send” in Messages')).toBeInTheDocument();
    expect(screen.getByText('High risk')).toBeInTheDocument();
    expect(screen.getByText('Sending messages requires approval')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/approvals/appr_1');
    expect(init?.body).toBe(JSON.stringify({ decision: 'approved' }));
    await waitFor(() => expect(appStore.getState().approvals).toHaveLength(0));
  });

  it('drops a card the server no longer holds, with an info note instead of an error', async () => {
    const approval = makeApproval();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(404, { error: { code: 'approval_not_pending', message: 'This approval is no longer pending.' } })),
    );
    act(() => dispatchServerEvent({ type: 'approval_requested', approval }));
    render(<ApprovalCard approval={approval} />);
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(appStore.getState().approvals).toHaveLength(0));
    const last = appStore.getState().toasts.at(-1);
    expect(last).toMatchObject({ level: 'info', title: 'This request was already answered elsewhere, or it expired.' });
  });

  it('shows expired requests without decision buttons', () => {
    render(<ApprovalCard approval={makeApproval({ expiresAt: Date.now() - 1000 })} />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('formats the countdown', () => {
    expect(formatCountdown(125_000)).toBe('2:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('ChatThread', () => {
  it('merges streaming deltas into the conversation', () => {
    act(() => {
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'u1', text: 'Open Settings', createdAt: 1 }) });
      dispatchServerEvent({ type: 'chat_delta', conversationId: 'conv_1', messageId: 'a1', delta: 'Opening Settings' });
    });
    render(<ChatThread conversationId="conv_1" />);
    expect(screen.getByText('Open Settings')).toBeInTheDocument();
    expect(screen.getByText('Opening Settings')).toBeInTheDocument();
    act(() => {
      dispatchServerEvent({ type: 'chat_delta', conversationId: 'conv_1', messageId: 'a1', delta: ' now.' });
    });
    expect(screen.getByText('Opening Settings now.')).toBeInTheDocument();
  });

  it('shows an empty state for a new conversation', () => {
    render(<ChatThread conversationId="conv_empty" />);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });
});

const SUMMARY = 'The For You feed wouldn’t move to the next post, so I couldn’t scroll through 20 videos.';

/** How often `text` occurs in the rendered page (across element boundaries). */
function occurrences(text: string): number {
  return (document.body.textContent ?? '').split(text).length - 1;
}

/** A failed task whose summary is stored as outcome, error and reply — like the backend does. */
function seedFailedTask() {
  act(() => {
    dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'u1', text: 'open tiktok and scroll for 20 videos', taskId: 'task_1', createdAt: 1 }) });
    dispatchServerEvent({
      type: 'chat_message',
      message: makeMessage({ id: 'a1', role: 'assistant', text: `Opening TikTok.\n\n${SUMMARY}`, taskId: 'task_1', createdAt: 2 }),
    });
    upsertTask(
      makeTask({
        status: 'failed',
        instruction: 'open tiktok and scroll for 20 videos',
        endedAt: 4_000,
        actionsUsed: 14,
        currentActivity: null,
        outcome: { success: false, verified: false, summary: SUMMARY },
        error: SUMMARY,
      }),
    );
    setTaskSteps('task_1', [
      ...Array.from({ length: 13 }, (_, i) => makeStep({ id: `s${i}`, index: i, title: `Swipe up ${i + 1}`, createdAt: 1_002 + i })),
      makeStep({ id: 's13', index: 13, type: 'verify', title: 'Could not complete the task', detail: SUMMARY, tool: null, createdAt: 1_100 }),
    ]);
  });
}

const renderTaskCard = (taskId: string, { hasReply, reply }: TaskRenderContext) => <TaskCard taskId={taskId} showSummary={!hasReply} reply={reply} />;

describe('ChatThread with tasks', () => {
  it('is one scroll area with each task inline in its assistant turn, in order', () => {
    seedFailedTask();
    const { container } = render(<ChatThread conversationId="conv_1" renderTask={renderTaskCard} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(container.querySelectorAll('.app-scroll')).toHaveLength(1);
    expect(log).toHaveClass('app-scroll');
    // Instruction → reply → task (the newest thing last), all inside the same scroll area.
    const text = log.textContent ?? '';
    const order = ['open tiktok and scroll for 20 videos', 'Opening TikTok.', 'Failed'].map((part) => text.indexOf(part));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).toContainElement(screen.getByRole('region', { name: 'AI task' }));
  });

  it('shows the final summary once, with a quiet failure indicator instead of an error block', () => {
    seedFailedTask();
    render(<ChatThread conversationId="conv_1" renderTask={renderTaskCard} />);
    expect(occurrences(SUMMARY)).toBe(1);
    expect(screen.getByText('Failed', { exact: true })).toHaveClass('text-danger');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The instruction is the user's bubble only — the task card doesn't repeat it.
    expect(occurrences('open tiktok and scroll for 20 videos')).toBe(1);
    // "Failed" and the reply say it all: no boilerplate paragraph, no verification note for a failure.
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not verified/)).not.toBeInTheDocument();
    expect(screen.getByText('14 of 25 actions')).toBeInTheDocument();
  });

  it('offers “Try again” on the newest task only', () => {
    seedFailedTask();
    act(() => {
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'u2', text: 'try once more', taskId: 'task_2', createdAt: 10 }) });
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'a2', role: 'assistant', text: 'Still stuck.', taskId: 'task_2', createdAt: 11 }) });
      upsertTask(makeTask({ id: 'task_2', status: 'failed', instruction: 'try once more', endedAt: 20, error: 'Still stuck.', outcome: { success: false, verified: false, summary: 'Still stuck.' } }));
    });
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatThread
        conversationId="conv_1"
        renderTask={(taskId, { hasReply, latest }) => <TaskCard taskId={taskId} showSummary={!hasReply} onRetry={latest ? onRetry : undefined} />}
      />,
    );
    expect(screen.getAllByRole('region', { name: 'AI task' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
  });

  it('keeps a finished task’s steps collapsed until asked', async () => {
    seedFailedTask();
    render(<ChatThread conversationId="conv_1" renderTask={renderTaskCard} />);
    const toggle = screen.getByRole('button', { name: 'Show 14 steps' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Task steps' })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide steps' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list', { name: 'Task steps' })).toBeInTheDocument();
    expect(screen.getByText('Swipe up 13')).toBeInTheDocument();
    // The closing check keeps its title but not a third copy of the summary.
    expect(screen.getByText('Could not complete the task')).toBeInTheDocument();
    expect(occurrences(SUMMARY)).toBe(1);
    // Where it ran is with the details, not on the card.
    expect(screen.getByText('Claude (Anthropic API) · claude-opus-5-5')).toBeInTheDocument();
  });

  it('keeps what a closing check adds (the evidence) but not the repeated summary', async () => {
    act(() => {
      upsertTask(makeTask({ status: 'completed', endedAt: 5, outcome: { success: true, verified: true, summary: 'Wi-Fi settings are open.' } }));
      setTaskSteps('task_1', [
        makeStep({ id: 'v1', type: 'verify', title: 'Finished — verified on screen', detail: 'Wi-Fi settings are open.\nEvidence: “Wi-Fi”', tool: null }),
      ]);
    });
    render(<TaskCard taskId="task_1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 step' }));
    expect(screen.getByText('Evidence: “Wi-Fi”')).toBeInTheDocument();
    expect(screen.queryByText(/Wi-Fi settings are open/)).not.toBeInTheDocument();
  });

  it('shows the task’s outcome in the card when it has no reply message', () => {
    act(() => {
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'u1', taskId: 'task_1' }) });
      upsertTask(makeTask({ status: 'stopped', endedAt: 5, outcome: { success: false, verified: false, summary: 'Stopped by the emergency stop.' }, error: 'Stopped by the emergency stop.' }));
    });
    render(<ChatThread conversationId="conv_1" renderTask={renderTaskCard} />);
    expect(occurrences('Stopped by the emergency stop')).toBe(1);
    expect(screen.getByText('Stopped', { exact: true })).toHaveClass('text-danger');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('gives a specific cause the reply doesn’t state one short line and a shortcut to the fix', async () => {
    act(() => {
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'u1', taskId: 'task_1' }) });
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'a1', role: 'assistant', text: 'Looking at the screen.', taskId: 'task_1', createdAt: 2 }) });
      upsertTask(makeTask({ status: 'failed', endedAt: 5, error: 'Invalid API key (HTTP 401).' }));
      setTaskSteps('task_1', [makeStep({ id: 's1', title: 'Look at the screen' })]);
    });
    render(<ChatThread conversationId="conv_1" renderTask={renderTaskCard} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('The AI provider rejected the sign-in');
    expect(note).not.toHaveTextContent('Check it in Settings');
    expect(screen.getByRole('button', { name: 'Manage providers' })).toBeInTheDocument();
    // The longer advice waits with the steps.
    expect(screen.queryByText(/Check it in Settings/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 step' }));
    expect(screen.getByText(/Check it in Settings/)).toBeInTheDocument();
  });

  it('adds no reason line when the reply already states the error, but keeps the shortcut to the fix', () => {
    const error = 'Invalid API key (HTTP 401).';
    act(() => {
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'u1', taskId: 'task_1' }) });
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'a1', role: 'assistant', text: `Looking at the screen.\n\n${error}`, taskId: 'task_1', createdAt: 2 }) });
      upsertTask(makeTask({ status: 'failed', endedAt: 5, error }));
    });
    render(<ChatThread conversationId="conv_1" renderTask={renderTaskCard} />);
    expect(occurrences(error)).toBe(1);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText('The AI provider rejected the sign-in')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage providers' })).toBeInTheDocument();
  });
});

describe('TaskCard', () => {
  beforeEach(() => {
    // A running task loads its steps once (live step).
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => jsonResponse(200, { task: appStore.getState().tasks['task_1'] ?? makeTask(), steps: [] })),
    );
  });

  it('shows a running task’s live step with pause and cancel', async () => {
    act(() => upsertTask(makeTask({ status: 'running', currentActivity: 'Tapping “Wi-Fi”' })));
    render(<TaskCard taskId="task_1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/task_1', expect.anything()));
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('Tapping “Wi-Fi”')).toBeInTheDocument();
    expect(screen.getByText('2 of 25 actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show steps' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps a pending approval visible and actionable while the steps are collapsed', () => {
    act(() => {
      upsertTask(makeTask({ status: 'awaiting_approval', currentActivity: 'Waiting for your approval: Tap “Send”' }));
      dispatchServerEvent({ type: 'approval_requested', approval: makeApproval() });
    });
    render(<TaskCard taskId="task_1" compact />);
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'Approval request' });
    expect(card).toHaveTextContent('Tap “Send” in Messages');
    // The conversation finds it (to bring it into view) and can move focus to it.
    expect(card).toHaveAttribute('data-pending-approval');
    expect(card).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled();
    expect(screen.queryByRole('list', { name: 'Task steps' })).not.toBeInTheDocument();
    // The card says what it waits for; the live step doesn't repeat it.
    expect(screen.queryByText(/Waiting for your approval/)).not.toBeInTheDocument();
  });

  it('labels a task the AI handed back as needing you', () => {
    act(() =>
      upsertTask(makeTask({ status: 'failed', endedAt: 5, outcome: { success: false, verified: false, summary: 'Please sign in to TikTok.' }, error: 'Needs your help.' })),
    );
    render(<TaskCard taskId="task_1" />);
    expect(screen.getByText('Needs you')).toHaveClass('text-warning');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('says a finished task that didn’t succeed with its status alone', () => {
    act(() => upsertTask(makeTask({ status: 'completed', endedAt: 5, outcome: { success: false, verified: false, summary: 'Could not find it.' } })));
    render(<TaskCard taskId="task_1" />);
    expect(screen.getByText('Didn’t succeed')).toHaveClass('text-warning');
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Not verified/)).not.toBeInTheDocument();
  });

  it('says when a reported success was not confirmed by the final screen', () => {
    act(() => upsertTask(makeTask({ status: 'completed', endedAt: 5, outcome: { success: true, verified: false, summary: 'Done.' } })));
    render(<TaskCard taskId="task_1" />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();
  });
});

describe('TaskStatusBar', () => {
  it('keeps a running task’s status, live step, pause and cancel in one line, and leads back to the card', async () => {
    act(() => upsertTask(makeTask({ status: 'running', currentActivity: 'Tapping “Wi-Fi”' })));
    const onReveal = vi.fn();
    render(<TaskStatusBar taskId="task_1" compact onReveal={onReveal} />);
    const bar = screen.getByRole('region', { name: 'Running task' });
    expect(bar).toHaveTextContent('Working · Tapping “Wi-Fi”');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /^Working/ }));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('shows nothing once the task has ended', () => {
    act(() => upsertTask(makeTask({ status: 'completed', endedAt: 5, outcome: { success: true, verified: true, summary: 'Done.' } })));
    const { container } = render(<TaskStatusBar taskId="task_1" onReveal={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('explainTaskFailure', () => {
  it('does not mistake an app sign-in in the AI’s summary for a provider login problem', () => {
    const failure = explainTaskFailure(makeTask({ status: 'failed', error: SUMMARY + ' TikTok may need you to sign in first.' }));
    expect(failure?.kind).toBe('generic');
    expect(failure?.titleKey).toBe('task.failure.generic.title');
  });
});

describe('Composer', () => {
  it('sends with Cmd/Ctrl+Enter and clears the draft', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: 'Instruction for the AI' });
    await userEvent.type(box, 'Open Safari');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Open Safari'));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('is disabled with a visible reason', () => {
    render(<Composer onSend={vi.fn()} disabledReason="Set up an AI provider in Settings to start a task." />);
    expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).toBeDisabled();
    expect(screen.getAllByText('Set up an AI provider in Settings to start a task.').length).toBeGreaterThan(0);
  });
});
