import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './messages';
import { makeBootstrap, makeSettings, makeStep, makeTask } from '../../test/fixtures';
import { appStore, reduceBootstrap, resetStoreForTests, setConnection, setTaskSteps, upsertTask } from '../../state/store';
import { ConversationView } from './ConversationView';
import { TaskBlock } from './TaskBlock';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const withKey = (acknowledged: boolean) =>
  makeSettings((s) => {
    s.ai.providers = s.ai.providers.map((p) => (p.id === 'claude-api' ? { ...p, hasApiKey: true } : p));
    s.privacy.cloudDisclosureAcknowledged = acknowledged;
  });

beforeEach(() => {
  resetStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('TaskBlock', () => {
  it('explains a failure and retries the same instruction', async () => {
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withKey(true) })));
      upsertTask(makeTask({ status: 'failed', instruction: 'Open Settings', error: 'Claude rate limit reached. Try again shortly.', endedAt: 5 }));
    });
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<TaskBlock taskId="task_1" defaultExpanded={false} onRetry={onRetry} />);
    expect(screen.getByText('The AI provider is busy')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledWith('Open Settings');
  });

  it('shows the verification result and the steps of a completed task', async () => {
    act(() => {
      upsertTask(makeTask({ status: 'completed', endedAt: 5, outcome: { success: true, verified: true, summary: 'Settings is open' } }));
      setTaskSteps('task_1', [makeStep({ id: 'st1', title: 'Tap “Settings”' })]);
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { task: appStore.getState().tasks['task_1'], steps: [] })));
    render(<TaskBlock taskId="task_1" defaultExpanded />);
    expect(screen.getByText('Verified on screen')).toBeInTheDocument();
    expect(screen.queryByText('The task failed')).not.toBeInTheDocument();
    expect(await screen.findByText('Tap “Settings”')).toBeInTheDocument();
  });
});

describe('ConversationView', () => {
  it('blocks the first send behind the cloud disclosure until it is acknowledged', async () => {
    const acknowledged = withKey(true);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, acknowledged));
    vi.stubGlobal('fetch', fetchMock);
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withKey(false) })));
      setConnection({ socket: 'open' });
    });
    render(<ConversationView conversation={null} onCreated={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText('Before you send: Claude (Anthropic API) runs in the cloud')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/settings');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ privacy: { cloudDisclosureAcknowledged: true } }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).not.toBeDisabled());
  });

  it('explains why sending is unavailable when Mirroring is paused', () => {
    act(() => {
      const boot = makeBootstrap({ settings: withKey(true) });
      boot.status.mirroring.state = 'paused';
      appStore.setState((s) => reduceBootstrap(s, boot));
      setConnection({ socket: 'open' });
    });
    render(<ConversationView conversation={null} onCreated={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).toBeDisabled();
    expect(screen.getAllByText('iPhone Mirroring is paused. Lock your iPhone and keep it nearby, then click Resume in Live Control.').length).toBeGreaterThan(0);
    expect(screen.getByText(/can look and describe, but not tap/)).toBeInTheDocument();
  });
});
