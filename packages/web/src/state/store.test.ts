import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeApproval,
  makeBootstrap,
  makeFrame,
  makeMessage,
  makeRun,
  makeSettings,
  makeStatus,
  makeStep,
  makeStream,
  makeTask,
} from '../test/fixtures';
import {
  appStore,
  createInitialState,
  dispatchServerEvent,
  isNewerFrame,
  reduceBootstrap,
  reduceServerEvent,
  registerViewer,
  resetStoreForTests,
  shallowEqual,
  useAppStore,
  type StoreState,
} from './store';

function apply(state: StoreState, ...events: Parameters<typeof reduceServerEvent>[1][]): StoreState {
  return events.reduce<StoreState>((s, e) => ({ ...s, ...reduceServerEvent(s, e) }), state);
}

afterEach(() => resetStoreForTests());

describe('reduceServerEvent', () => {
  it('hello records the session capabilities', () => {
    const s = apply(createInitialState(), { type: 'hello', sessionId: 's', serverVersion: '1.2.3', remote: true, canControl: false });
    expect(s.hello).toEqual({ sessionId: 's', serverVersion: '1.2.3', remote: true, canControl: false });
    expect(s.version).toBe('1.2.3');
  });

  it('status updates the device status and the stop state', () => {
    const latched = makeStatus({ stopLatched: true, stopReason: 'User pressed STOP' });
    const s = apply(createInitialState(), { type: 'status', status: latched });
    expect(s.status).toBe(latched);
    expect(s.stop.latched).toBe(true);
    expect(s.stop.reason).toBe('User pressed STOP');
    const released = apply(s, { type: 'status', status: makeStatus() });
    expect(released.stop).toEqual({ latched: false, reason: null, at: null });
  });

  it('frame keeps only newer frames', () => {
    const s = apply(createInitialState(), { type: 'frame', meta: makeFrame(5) }, { type: 'frame', meta: makeFrame(3) });
    expect(s.frame?.seq).toBe(5);
    expect(apply(s, { type: 'frame', meta: makeFrame(6) }).frame?.seq).toBe(6);
  });

  it('frame accepts a restarted sequence when it was captured later', () => {
    const s = apply(createInitialState(), { type: 'frame', meta: makeFrame(500, { capturedAt: 1_000 }) });
    expect(isNewerFrame(s.frame, makeFrame(1, { capturedAt: 900 }))).toBe(false);
    const restarted = apply(s, { type: 'frame', meta: makeFrame(1, { capturedAt: 5_000 }) });
    expect(restarted.frame?.seq).toBe(1);
  });

  it('stream_stats replaces the stream stats', () => {
    const stats = makeStream({ measuredFps: 0.4 });
    expect(apply(createInitialState(), { type: 'stream_stats', stats }).stream).toBe(stats);
  });

  it('activity prepends events, dedupes and caps the list', () => {
    const event = {
      id: 'a1',
      at: 1,
      sessionId: 's',
      category: 'manual' as const,
      type: 'tool.call',
      actor: 'user' as const,
      severity: 'info' as const,
      summary: 'Tapped',
      tool: 'tap',
      success: true,
      durationMs: 10,
      taskId: null,
      workflowRunId: null,
      detail: null,
    };
    const s = apply(createInitialState(), { type: 'activity', event }, { type: 'activity', event }, { type: 'activity', event: { ...event, id: 'a2' } });
    expect(s.activity.map((e) => e.id)).toEqual(['a2', 'a1']);
  });

  it('chat_delta accumulates streaming text until the final chat_message', () => {
    let s = apply(
      createInitialState(),
      { type: 'chat_message', message: makeMessage({ id: 'm1', role: 'assistant', text: '', streaming: true }) },
      { type: 'chat_delta', conversationId: 'conv_1', messageId: 'm1', delta: 'Hel' },
      { type: 'chat_delta', conversationId: 'conv_1', messageId: 'm1', delta: 'lo' },
    );
    expect(s.streaming['m1']?.text).toBe('Hello');
    s = apply(s, { type: 'chat_message', message: makeMessage({ id: 'm1', role: 'assistant', text: 'Hello!', streaming: false }) });
    expect(s.streaming['m1']).toBeUndefined();
    expect(s.messagesByConversation['conv_1']?.map((m) => m.text)).toEqual(['Hello!']);
  });

  it('chat_message keeps messages ordered by time', () => {
    const s = apply(
      createInitialState(),
      { type: 'chat_message', message: makeMessage({ id: 'b', createdAt: 20 }) },
      { type: 'chat_message', message: makeMessage({ id: 'a', createdAt: 10 }) },
    );
    expect(s.messagesByConversation['conv_1']?.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('task_update tracks the active task and clears it when terminal', () => {
    let s = apply(createInitialState(), { type: 'task_update', task: makeTask() });
    expect(s.activeTaskId).toBe('task_1');
    s = apply(s, { type: 'task_update', task: makeTask({ status: 'completed' }) });
    expect(s.activeTaskId).toBeNull();
    expect(s.lastTaskId).toBe('task_1');
    expect(s.tasks['task_1']?.status).toBe('completed');
  });

  it('never turns a finished task back into a running one (a late action response)', () => {
    let s = apply(createInitialState(), { type: 'task_update', task: makeTask({ status: 'cancelled' }) });
    s = apply(s, { type: 'task_update', task: makeTask({ status: 'paused' }) });
    expect(s.tasks['task_1']?.status).toBe('cancelled');
    expect(s.activeTaskId).toBeNull();
  });

  it('task_step upserts steps ordered by index', () => {
    const s = apply(
      createInitialState(),
      { type: 'task_step', step: makeStep({ id: 's2', index: 1 }) },
      { type: 'task_step', step: makeStep({ id: 's1', index: 0 }) },
      { type: 'task_step', step: makeStep({ id: 's2', index: 1, title: 'updated' }) },
    );
    expect(s.stepsByTask['task_1']?.map((x) => `${x.id}:${x.title}`)).toEqual(['s1:Tap “Settings”', 's2:updated']);
  });

  it('approval_requested / approval_resolved move approvals between lists', () => {
    let s = apply(createInitialState(), { type: 'approval_requested', approval: makeApproval() });
    expect(s.approvals).toHaveLength(1);
    s = apply(s, { type: 'approval_resolved', approval: makeApproval({ status: 'approved' }) });
    expect(s.approvals).toHaveLength(0);
    expect(s.recentApprovals[0]?.status).toBe('approved');
  });

  it('workflow_run tracks the active run', () => {
    let s = apply(createInitialState(), { type: 'workflow_run', run: makeRun() });
    expect(s.activeRunId).toBe('run_1');
    s = apply(s, { type: 'workflow_run', run: makeRun({ status: 'succeeded' }) });
    expect(s.activeRunId).toBeNull();
  });

  it('settings replaces the settings', () => {
    const settings = makeSettings((x) => (x.general.language = 'ar'));
    expect(apply(createInitialState(), { type: 'settings', settings }).settings?.general.language).toBe('ar');
  });

  it('stop_engaged / stop_released latch and release the stop', () => {
    let s = apply(createInitialState(), { type: 'status', status: makeStatus() });
    s = apply(s, { type: 'stop_engaged', reason: 'Esc Esc', at: 42 });
    expect(s.stop).toEqual({ latched: true, reason: 'Esc Esc', at: 42 });
    expect(s.status?.stopLatched).toBe(true);
    s = apply(s, { type: 'stop_released', at: 50 });
    expect(s.stop.latched).toBe(false);
    expect(s.status?.stopLatched).toBe(false);
  });

  it('toast queues a notification', () => {
    const s = apply(createInitialState(), { type: 'toast', level: 'warning', title: 'Heads up', message: 'Paused' });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ level: 'warning', title: 'Heads up', message: 'Paused', source: 'server' });
  });
});

describe('reduceBootstrap', () => {
  it('marks the app ready and loads everything', () => {
    const data = makeBootstrap({ pendingApprovals: [makeApproval()], activeTask: makeTask(), activeRun: makeRun() });
    const s = { ...createInitialState(), ...reduceBootstrap(createInitialState(), data) };
    expect(s.boot).toBe('ready');
    expect(s.session?.canControl).toBe(true);
    expect(s.approvals).toHaveLength(1);
    expect(s.activeTaskId).toBe('task_1');
    expect(s.activeRunId).toBe('run_1');
  });

  it('clears stale active markers', () => {
    const before = apply(createInitialState(), { type: 'task_update', task: makeTask() }, { type: 'workflow_run', run: makeRun() });
    const s = { ...before, ...reduceBootstrap(before, makeBootstrap()) };
    expect(s.activeTaskId).toBeNull();
    expect(s.activeRunId).toBeNull();
    expect(s.tasks['task_1']).toBeDefined();
  });
});

describe('store hooks', () => {
  it('useAppStore re-renders on change and keeps derived values stable with shallowEqual', () => {
    const { result } = renderHook(() => useAppStore((s) => s.approvals.map((a) => a.id), shallowEqual));
    const first = result.current;
    expect(first).toEqual([]);
    act(() => dispatchServerEvent({ type: 'stream_stats', stats: makeStream() }));
    expect(result.current).toBe(first);
    act(() => dispatchServerEvent({ type: 'approval_requested', approval: makeApproval() }));
    expect(result.current).toEqual(['appr_1']);
  });

  it('registerViewer counts mounted viewers', () => {
    const a = registerViewer();
    const b = registerViewer();
    expect(appStore.getState().ui.viewers).toBe(2);
    a();
    a();
    expect(appStore.getState().ui.viewers).toBe(1);
    b();
    expect(appStore.getState().ui.viewers).toBe(0);
  });
});
