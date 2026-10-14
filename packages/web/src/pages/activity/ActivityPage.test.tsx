import type { ActivityEvent } from '@iphone-ai/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBootstrap } from '../../test/fixtures';
import { appStore, dispatchServerEvent, reduceBootstrap, resetStoreForTests } from '../../state/store';
import ActivityPage from './index';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const NOW = Date.now();
const today = new Date(NOW);
/** Local midnight today: keeps the Today / Yesterday grouping stable whenever the test runs. */
const TODAY_START = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

function ev(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 'evt',
    at: NOW,
    sessionId: 'sess_1',
    category: 'manual',
    type: 'tool.call',
    actor: 'user',
    severity: 'info',
    summary: 'Tapped the screen',
    tool: 'tap',
    success: true,
    durationMs: 140,
    taskId: null,
    workflowRunId: null,
    detail: null,
    ...overrides,
  };
}

const HISTORY: ActivityEvent[] = [
  ev({
    id: 'e1',
    at: TODAY_START + 60_000,
    category: 'ai',
    actor: 'ai',
    summary: 'AI tapped “Send” in Messages',
    taskId: 'task_1',
    detail: { reasons: ['Sending messages requires approval'], args: { x: 300, y: 820 } },
  }),
  ev({ id: 'e2', at: TODAY_START - 3_600_000, category: 'connection', actor: 'system', summary: 'Mirroir started', tool: null, success: null, durationMs: null }),
];

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  resetStoreForTests();
  appStore.setState((s) => reduceBootstrap(s, makeBootstrap()));
  appStore.setState({ connection: { ...appStore.getState().connection, socket: 'open' } });
  window.location.hash = '#/activity';
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith('/api/activity?')) {
      const params = new URLSearchParams(url.split('?')[1]);
      const search = params.get('search');
      return json(200, search ? HISTORY.filter((e) => e.summary.toLowerCase().includes(search.toLowerCase())) : HISTORY);
    }
    if (url === '/api/tasks/task_1') {
      return json(200, {
        task: {
          id: 'task_1',
          conversationId: 'conv_1',
          instruction: 'Reply to Sara',
          status: 'completed',
          providerId: 'claude-api',
          providerLabel: 'Claude (Anthropic API)',
          model: 'claude-opus-5-5',
          mode: 'assisted',
          createdAt: NOW - 120_000,
          startedAt: NOW - 120_000,
          endedAt: NOW - 30_000,
          actionsUsed: 3,
          maxActions: 25,
          currentActivity: null,
          outcome: null,
          error: null,
        },
        steps: [],
      });
    }
    return json(404, { error: { code: 'not_found', message: url } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
  window.location.hash = '';
});

describe('ActivityPage', () => {
  it('groups the history by day and prepends live events', async () => {
    render(<ActivityPage />);
    expect(await screen.findByText('AI tapped “Send” in Messages')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/activity?limit=100');

    act(() => {
      dispatchServerEvent({ type: 'activity', event: ev({ id: 'live1', at: Date.now(), summary: 'You pressed Home', tool: 'press_home' }) });
    });
    const items = within(screen.getByRole('region', { name: 'Today' })).getAllByRole('button');
    expect(items[0]).toHaveAccessibleName(/You pressed Home/);
  });

  it('opens the detail drawer with readable details and the related task', async () => {
    render(<ActivityPage />);
    await userEvent.click(await screen.findByRole('button', { name: /AI tapped “Send” in Messages/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Event details' });
    expect(within(dialog).getByText('Sending messages requires approval')).toBeInTheDocument();
    expect(within(dialog).getByText('Args › X')).toBeInTheDocument();
    expect(await within(dialog).findByText('Reply to Sara')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show raw' }));
    expect(within(dialog).getByText(/"reasons": \[/)).toBeInTheDocument();
  });

  it('searches on the server after a short pause', async () => {
    render(<ActivityPage />);
    await screen.findByText('Mirroir started');
    await userEvent.type(screen.getByRole('searchbox'), 'mirroir');
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/activity?search=mirroir&limit=100')).toBe(true));
    await waitFor(() => expect(screen.queryByText('AI tapped “Send” in Messages')).not.toBeInTheDocument());
    expect(screen.getByText('Mirroir started')).toBeInTheDocument();
  });

  it('applies a task filter from the link', async () => {
    window.location.hash = '#/activity?taskId=task_1';
    render(<ActivityPage />);
    await waitFor(() => expect(fetchMock.mock.calls[0]![0]).toBe('/api/activity?taskId=task_1&limit=100'));
    expect(screen.getByText('task_1')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    fetchMock.mockImplementation(async () => json(200, []));
    render(<ActivityPage />);
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });
});
