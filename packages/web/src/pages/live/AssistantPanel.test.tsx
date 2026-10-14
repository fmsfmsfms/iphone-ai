// Live Control's assistant panel must gate sending behind the cloud privacy
// notice exactly like the AI Assistant page (it used to send straight away).

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './messages';
import { appStore, reduceBootstrap, resetStoreForTests, setConnection } from '../../state/store';
import { makeBootstrap, makeSettings } from '../../test/fixtures';
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
