import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeApproval, makeBootstrap, makeMessage } from '../../test/fixtures';
import { appStore, dispatchServerEvent, reduceBootstrap, resetStoreForTests } from '../../state/store';
import { ApprovalCard, ChatThread, Composer, formatCountdown } from './index';

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
