// Regression tests for keeping the store in step with the server: records that
// ended while the socket was down, remote control rights, stale approval cards
// and which listener served the page.

import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { makeApproval, makeBootstrap, makeMessage, makeRun, makeSettings, makeStep, makeTask } from '../test/fixtures';
import { calledRoutes, errorResponse, jsonResponse, routeFetch } from '../test/http';
import {
  appStore,
  bootstrap,
  createInitialState,
  decideApproval,
  detectListener,
  dispatchServerEvent,
  finishedStreaming,
  guessListenerKind,
  notifyError,
  reduceBootstrap,
  reduceServerEvent,
  resetStoreForTests,
  staleAfterBootstrap,
  type StoreState,
} from './store';

const REMOTE_SESSION = { id: 'sess_r', kind: 'remote', canControl: true, remote: true } as const;

function apply(state: StoreState, ...events: Parameters<typeof reduceServerEvent>[1][]): StoreState {
  return events.reduce<StoreState>((s, e) => ({ ...s, ...reduceServerEvent(s, e) }), state);
}

function boot(state: StoreState, data = makeBootstrap()): StoreState {
  return { ...state, ...reduceBootstrap(state, data) };
}

beforeEach(() => resetStoreForTests());

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('reconnect after missed events (finished work kept showing as running)', () => {
  it('lists live runs, live tasks and streaming conversations the bootstrap no longer reports', () => {
    let s = boot(createInitialState());
    s = apply(
      s,
      { type: 'workflow_run', run: makeRun({ id: 'r1', status: 'running' }) },
      { type: 'workflow_run', run: makeRun({ id: 'r2', status: 'running' }) },
      { type: 'task_update', task: makeTask({ id: 't1', status: 'running' }) },
      { type: 'task_update', task: makeTask({ id: 't0', status: 'completed', endedAt: 2 }) },
      { type: 'chat_message', message: makeMessage({ id: 'm1', role: 'assistant', text: 'Working', streaming: true }) },
    );
    const stale = staleAfterBootstrap(s, makeBootstrap({ activeRun: makeRun({ id: 'r2', status: 'running' }) }));
    expect(stale).toEqual({ runIds: ['r1'], taskIds: ['t1'], conversationIds: ['conv_1'] });
  });

  it('refetches them after bootstrap so the run, task, steps and reply show their real state', async () => {
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap()));
      dispatchServerEvent({ type: 'workflow_run', run: makeRun({ id: 'r1', status: 'running' }) });
      dispatchServerEvent({ type: 'task_update', task: makeTask({ id: 't1', status: 'running' }) });
      dispatchServerEvent({ type: 'chat_message', message: makeMessage({ id: 'm1', role: 'assistant', text: 'Working', streaming: true }) });
    });
    const cancelled = makeTask({ id: 't1', status: 'cancelled', endedAt: 5 });
    const fetchMock = routeFetch({
      '/api/bootstrap': () => jsonResponse(200, makeBootstrap()),
      '/api/workflow-runs/r1': () => jsonResponse(200, makeRun({ id: 'r1', status: 'stopped', endedAt: 5 })),
      '/api/tasks/t1': () => jsonResponse(200, { task: cancelled, steps: [makeStep({ id: 's9', taskId: 't1' })] }),
      '/api/conversations/conv_1/messages': () => jsonResponse(200, [makeMessage({ id: 'm1', role: 'assistant', text: 'Stopped.' })]),
      '/api/conversations/conv_1/tasks': () => jsonResponse(200, [cancelled]),
    });

    await act(async () => {
      expect(await bootstrap()).toBe(true);
    });

    await waitFor(() => {
      const s = appStore.getState();
      expect(s.workflowRuns['r1']?.status).toBe('stopped');
      expect(s.tasks['t1']?.status).toBe('cancelled');
      expect(s.stepsByTask['t1']?.map((step) => step.id)).toEqual(['s9']);
      expect(s.streaming).toEqual({});
      expect(s.messagesByConversation['conv_1']?.map((m) => m.text)).toEqual(['Stopped.']);
    });
    expect(appStore.getState().activeRunId).toBeNull();
    expect(appStore.getState().activeTaskId).toBeNull();
    expect(calledRoutes(fetchMock)).toEqual(
      expect.arrayContaining(['GET /api/workflow-runs/r1', 'GET /api/tasks/t1', 'GET /api/conversations/conv_1/messages']),
    );
  });

  it('does not refetch work the server still reports as active', async () => {
    const run = makeRun({ id: 'r1', status: 'running' });
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap()));
      dispatchServerEvent({ type: 'workflow_run', run });
    });
    const fetchMock = routeFetch({ '/api/bootstrap': () => jsonResponse(200, makeBootstrap({ activeRun: run })) });
    await act(async () => {
      await bootstrap();
    });
    expect(calledRoutes(fetchMock)).toEqual(['GET /api/bootstrap']);
  });

  it('ends "typing…" only for replies the server shows as finished or gone', () => {
    const streaming: StoreState['streaming'] = {
      done: { conversationId: 'c', messageId: 'done', text: 'a', updatedAt: 10 },
      live: { conversationId: 'c', messageId: 'live', text: 'b', updatedAt: 10 },
      gone: { conversationId: 'c', messageId: 'gone', text: 'c', updatedAt: 10 },
      newer: { conversationId: 'c', messageId: 'newer', text: 'd', updatedAt: 50 },
      other: { conversationId: 'x', messageId: 'other', text: 'e', updatedAt: 10 },
    };
    const messages = [
      makeMessage({ id: 'done', conversationId: 'c', role: 'assistant' }),
      makeMessage({ id: 'live', conversationId: 'c', role: 'assistant', streaming: true }),
    ];
    // "newer" got its first delta after the list was requested, so the list couldn't contain it yet.
    expect(finishedStreaming(streaming, 'c', messages, 20).sort()).toEqual(['done', 'gone']);
  });
});

describe('remote control rights follow the Mac', () => {
  const remoteBoot = (allow: boolean) =>
    makeBootstrap({ session: { ...REMOTE_SESSION, canControl: allow }, settings: makeSettings((x) => (x.remote.allowRemoteControl = allow)) });

  it('a settings event turning remote control off removes control at once, and never grants it', () => {
    let s = boot(createInitialState(), remoteBoot(true));
    s = apply(s, { type: 'hello', sessionId: 'sess_r', serverVersion: '1', remote: true, canControl: true });
    s = apply(s, { type: 'settings', settings: makeSettings((x) => (x.remote.allowRemoteControl = false)) });
    expect(s.session?.canControl).toBe(false);
    expect(s.hello?.canControl).toBe(false);
    s = apply(s, { type: 'settings', settings: makeSettings((x) => (x.remote.allowRemoteControl = true)) });
    expect(s.session?.canControl).toBe(false);
  });

  it('leaves local sessions alone', () => {
    let s = boot(createInitialState());
    s = apply(s, { type: 'settings', settings: makeSettings((x) => (x.remote.allowRemoteControl = false)) });
    expect(s.session?.canControl).toBe(true);
  });

  it('reloads the session from the server when the Mac turns remote control back on', async () => {
    act(() => appStore.setState((s) => reduceBootstrap(s, remoteBoot(false))));
    expect(appStore.getState().session?.canControl).toBe(false);
    const fetchMock = routeFetch({ '/api/bootstrap': () => jsonResponse(200, remoteBoot(true)) });
    act(() => dispatchServerEvent({ type: 'settings', settings: makeSettings((x) => (x.remote.allowRemoteControl = true)) }));
    await waitFor(() => expect(appStore.getState().session?.canControl).toBe(true));
    expect(calledRoutes(fetchMock)).toEqual(['GET /api/bootstrap']);
  });

  it('a "view_only" refusal reloads the authoritative session', async () => {
    act(() => appStore.setState((s) => reduceBootstrap(s, remoteBoot(true))));
    const fetchMock = routeFetch({ '/api/bootstrap': () => jsonResponse(200, remoteBoot(false)) });
    act(() => notifyError('Couldn’t tap', new ApiError(403, 'view_only', 'This remote session is view-only.')));
    await waitFor(() => expect(appStore.getState().session?.canControl).toBe(false));
    expect(calledRoutes(fetchMock)).toEqual(['GET /api/bootstrap']);
  });
});

describe('approval cards the server no longer holds', () => {
  it('drops the card when deciding answers approval_not_pending', async () => {
    const approval = makeApproval();
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap()));
      dispatchServerEvent({ type: 'approval_requested', approval });
    });
    routeFetch({ 'POST /api/approvals/appr_1': () => errorResponse(404, 'approval_not_pending', 'This approval is no longer pending.') });
    await expect(decideApproval('appr_1', 'approved')).rejects.toMatchObject({ code: 'approval_not_pending' });
    expect(appStore.getState().approvals).toEqual([]);
  });

  it('keeps the card on other errors', async () => {
    act(() => dispatchServerEvent({ type: 'approval_requested', approval: makeApproval() }));
    routeFetch({ 'POST /api/approvals/appr_1': () => errorResponse(403, 'view_only', 'View only.') });
    await expect(decideApproval('appr_1', 'approved')).rejects.toBeInstanceOf(ApiError);
    expect(appStore.getState().approvals).toHaveLength(1);
  });

  it('a bootstrap snapshot taken before approval_resolved does not bring the card back', () => {
    const approval = makeApproval();
    let s = apply(createInitialState(), { type: 'approval_requested', approval }, { type: 'approval_resolved', approval: { ...approval, status: 'approved' } });
    s = boot(s, makeBootstrap({ pendingApprovals: [approval, makeApproval({ id: 'appr_2' })] }));
    expect(s.approvals.map((a) => a.id)).toEqual(['appr_2']);
  });
});

describe('which listener served the page', () => {
  it('is recorded from the bootstrap session', () => {
    expect(boot(createInitialState()).listenerKind).toBe('local');
    expect(boot(createInitialState(), makeBootstrap({ session: REMOTE_SESSION })).listenerKind).toBe('remote');
  });

  it('falls back to the host name', () => {
    expect(guessListenerKind('127.0.0.1')).toBe('local');
    expect(guessListenerKind('localhost')).toBe('local');
    expect(guessListenerKind('[::1]')).toBe('local');
    expect(guessListenerKind('100.101.102.103')).toBe('remote');
    expect(guessListenerKind('mac.tailnet.ts.net')).toBe('remote');
  });

  it('asks the public health endpoint once and caches the answer', async () => {
    const fetchMock = routeFetch({ '/api/health': () => jsonResponse(200, { ok: true, version: '1', listener: 'remote' }) });
    await expect(detectListener()).resolves.toBe('remote');
    await expect(detectListener()).resolves.toBe('remote');
    expect(appStore.getState().listenerKind).toBe('remote');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks the page unauthorized on a 401 bootstrap and probes the listener', async () => {
    routeFetch({
      '/api/bootstrap': () => errorResponse(401, 'unauthenticated', 'Sign in to iPhone AI first.'),
      '/api/health': () => jsonResponse(200, { ok: true, version: '1', listener: 'remote' }),
    });
    await act(async () => {
      expect(await bootstrap()).toBe(false);
    });
    expect(appStore.getState().boot).toBe('unauthorized');
    await waitFor(() => expect(appStore.getState().listenerKind).toBe('remote'));
  });
});
