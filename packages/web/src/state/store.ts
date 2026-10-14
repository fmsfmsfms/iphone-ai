// App state: a tiny external store read through useSyncExternalStore (no
// extra dependency). The WebSocket feeds ServerEvents into `reduceServerEvent`,
// which is pure so it can be unit-tested. Actions talk to the REST API and
// apply the authoritative responses — nothing is updated optimistically for
// device actions.

import { useRef, useSyncExternalStore } from 'react';

import {
  TERMINAL_TASK_STATUSES,
  type ActivityEvent,
  type AgentStep,
  type AgentTask,
  type AppSettings,
  type ApprovalRequest,
  type ChatMessage,
  type ControlMode,
  type DeviceStatus,
  type FrameMeta,
  type ServerEvent,
  type SettingsPatch,
  type StreamStats,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@iphone-ai/shared';

import {
  api,
  ApiError,
  errorMessage,
  setUnauthorizedHandler,
  type BootstrapResponse,
  type ListenerKind,
  type SessionInfo,
} from '../lib/api';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type BootState = 'loading' | 'ready' | 'unauthorized' | 'unreachable';
export type SocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface ConnectionState {
  socket: SocketState;
  attempts: number;
  lastOpenAt: number | null;
  lastCloseAt: number | null;
  nextRetryAt: number | null;
  /** When the socket first went down (null while connected). */
  downSince: number | null;
}

export interface HelloInfo {
  sessionId: string;
  serverVersion: string;
  remote: boolean;
  canControl: boolean;
}

export interface ToastItem {
  id: number;
  level: ToastLevel;
  title: string;
  message?: string;
  at: number;
  /** Server-originated toasts vs. UI notifications. */
  source: 'server' | 'ui';
}

export interface StreamingMessage {
  conversationId: string;
  messageId: string;
  text: string;
  updatedAt: number;
}

export interface StopState {
  latched: boolean;
  reason: string | null;
  at: number | null;
}

export interface UiState {
  /** Number of PhoneViewer components currently mounted. */
  viewers: number;
  /** Whether the "focus moved to iPhone Mirroring" toast has been shown this session. */
  focusStealToastShown: boolean;
  /** Last lastFocusSteal timestamp the user has been told about. */
  focusStealAcknowledgedAt: number | null;
  /** Live Control's assistant pane (which lists every pending approval) is collapsed. */
  liveAssistantCollapsed: boolean;
}

export interface StoreState {
  boot: BootState;
  bootError: string | null;
  connection: ConnectionState;
  hello: HelloInfo | null;
  session: SessionInfo | null;
  /**
   * Which listener served this page (null until known). The remote listener
   * gets a passcode sign-in instead of "reopen from the iPhone AI app".
   */
  listenerKind: ListenerKind | null;
  version: string | null;
  status: DeviceStatus | null;
  settings: AppSettings | null;
  stream: StreamStats | null;
  /** Latest frame announcement (frames are polled screenshots, not video). */
  frame: FrameMeta | null;
  approvals: ApprovalRequest[];
  recentApprovals: ApprovalRequest[];
  /** Task currently running (non-terminal), if any. */
  activeTaskId: string | null;
  /** Most recently updated task, terminal or not. */
  lastTaskId: string | null;
  tasks: Record<string, AgentTask>;
  stepsByTask: Record<string, AgentStep[]>;
  messagesByConversation: Record<string, ChatMessage[]>;
  /** Streaming assistant text by message id. */
  streaming: Record<string, StreamingMessage>;
  workflowRuns: Record<string, WorkflowRun>;
  activeRunId: string | null;
  /** Live activity events received over the socket (newest first). */
  activity: ActivityEvent[];
  toasts: ToastItem[];
  stop: StopState;
  ui: UiState;
}

export const MAX_LIVE_ACTIVITY = 200;
export const MAX_TOASTS = 30;
export const MAX_RECENT_APPROVALS = 50;

export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'paused', 'awaiting_approval'];

export function createInitialState(): StoreState {
  return {
    boot: 'loading',
    bootError: null,
    connection: { socket: 'idle', attempts: 0, lastOpenAt: null, lastCloseAt: null, nextRetryAt: null, downSince: null },
    hello: null,
    session: null,
    listenerKind: null,
    version: null,
    status: null,
    settings: null,
    stream: null,
    frame: null,
    approvals: [],
    recentApprovals: [],
    activeTaskId: null,
    lastTaskId: null,
    tasks: {},
    stepsByTask: {},
    messagesByConversation: {},
    streaming: {},
    workflowRuns: {},
    activeRunId: null,
    activity: [],
    toasts: [],
    stop: { latched: false, reason: null, at: null },
    ui: { viewers: 0, focusStealToastShown: false, focusStealAcknowledgedAt: null, liveAssistantCollapsed: false },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface Store<S> {
  getState(): S;
  setState(update: Partial<S> | ((state: S) => Partial<S> | S)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(update) {
      const patch = typeof update === 'function' ? update(state) : update;
      if (patch === state) return;
      const next = { ...state, ...patch };
      // Skip notifications when nothing changed.
      let changed = false;
      for (const key of Object.keys(patch) as (keyof S)[]) {
        if (!Object.is(state[key], next[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const appStore = createStore<StoreState>(createInitialState());

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

function isTerminalTask(task: AgentTask): boolean {
  return TERMINAL_TASK_STATUSES.includes(task.status);
}

function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function upsertMessage(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  return upsertById(list, message).sort((a, b) => a.createdAt - b.createdAt);
}

function upsertStep(list: readonly AgentStep[], step: AgentStep): AgentStep[] {
  return upsertById(list, step).sort((a, b) => a.index - b.index || a.createdAt - b.createdAt);
}

/**
 * Frames are ordered by sequence number, except that a backend restart resets
 * the sequence: a lower seq captured later than the current frame wins.
 */
export function isNewerFrame(current: FrameMeta | null, next: FrameMeta): boolean {
  if (!current) return true;
  if (next.seq > current.seq) return true;
  return next.seq < current.seq && next.capturedAt > current.capturedAt;
}

let toastSeq = 0;
export function makeToast(level: ToastLevel, title: string, message: string | undefined, source: ToastItem['source']): ToastItem {
  toastSeq += 1;
  const toast: ToastItem = { id: toastSeq, level, title, at: Date.now(), source };
  if (message) toast.message = message;
  return toast;
}

function withTask(state: StoreState, task: AgentTask): Partial<StoreState> {
  const tasks = { ...state.tasks, [task.id]: task };
  let activeTaskId = state.activeTaskId;
  if (!isTerminalTask(task)) activeTaskId = task.id;
  else if (activeTaskId === task.id) activeTaskId = null;
  return { tasks, activeTaskId, lastTaskId: task.id };
}

function withRun(state: StoreState, run: WorkflowRun): Partial<StoreState> {
  const workflowRuns = { ...state.workflowRuns, [run.id]: run };
  let activeRunId = state.activeRunId;
  if (ACTIVE_RUN_STATUSES.includes(run.status)) activeRunId = run.id;
  else if (activeRunId === run.id) activeRunId = null;
  return { workflowRuns, activeRunId };
}

function withStatus(state: StoreState, status: DeviceStatus): Partial<StoreState> {
  const stop: StopState = status.stopLatched
    ? { latched: true, reason: status.stopReason, at: (state.stop.latched ? state.stop.at : null) ?? Date.now() }
    : { latched: false, reason: null, at: null };
  // Keep the previous object when nothing changed so stop subscribers don't re-render.
  return { status, stop: shallowEqual(stop, state.stop) ? state.stop : stop };
}

/** Applies one ServerEvent to the state (pure). */
export function reduceServerEvent(state: StoreState, event: ServerEvent): Partial<StoreState> {
  switch (event.type) {
    case 'hello':
      return {
        hello: { sessionId: event.sessionId, serverVersion: event.serverVersion, remote: event.remote, canControl: event.canControl },
        version: event.serverVersion,
        session: state.session ? { ...state.session, canControl: event.canControl, remote: event.remote } : state.session,
      };
    case 'status':
      return withStatus(state, event.status);
    case 'frame':
      return isNewerFrame(state.frame, event.meta) ? { frame: event.meta } : {};
    case 'stream_stats':
      return { stream: event.stats };
    case 'activity': {
      if (state.activity.some((e) => e.id === event.event.id)) return {};
      return { activity: [event.event, ...state.activity].slice(0, MAX_LIVE_ACTIVITY) };
    }
    case 'chat_message': {
      const { message } = event;
      const current = state.messagesByConversation[message.conversationId] ?? [];
      const messagesByConversation = { ...state.messagesByConversation, [message.conversationId]: upsertMessage(current, message) };
      if (message.streaming) {
        // Keep any deltas already received for this message.
        const existing = state.streaming[message.id];
        const streaming = {
          ...state.streaming,
          [message.id]: {
            conversationId: message.conversationId,
            messageId: message.id,
            text: existing && existing.text.length > message.text.length ? existing.text : message.text,
            updatedAt: Date.now(),
          },
        };
        return { messagesByConversation, streaming };
      }
      if (!(message.id in state.streaming)) return { messagesByConversation };
      const { [message.id]: _done, ...streaming } = state.streaming;
      return { messagesByConversation, streaming };
    }
    case 'chat_delta': {
      const existing = state.streaming[event.messageId];
      return {
        streaming: {
          ...state.streaming,
          [event.messageId]: {
            conversationId: event.conversationId,
            messageId: event.messageId,
            text: (existing?.text ?? '') + event.delta,
            updatedAt: Date.now(),
          },
        },
      };
    }
    case 'task_update':
      return withTask(state, event.task);
    case 'task_step': {
      const current = state.stepsByTask[event.step.taskId] ?? [];
      return { stepsByTask: { ...state.stepsByTask, [event.step.taskId]: upsertStep(current, event.step) } };
    }
    case 'approval_requested': {
      const { approval } = event;
      if (approval.status !== 'pending') return {};
      return { approvals: upsertById(state.approvals, approval).sort((a, b) => a.createdAt - b.createdAt) };
    }
    case 'approval_resolved': {
      const { approval } = event;
      return {
        approvals: state.approvals.filter((a) => a.id !== approval.id),
        recentApprovals: [approval, ...state.recentApprovals.filter((a) => a.id !== approval.id)].slice(0, MAX_RECENT_APPROVALS),
      };
    }
    case 'workflow_run':
      return withRun(state, event.run);
    case 'settings': {
      // Fail-safe: a remote session loses control the moment the Mac turns remote
      // control off. Never grants control here; granting comes from the server (hello/bootstrap).
      const remote = state.session?.remote ?? state.hello?.remote ?? false;
      if (remote && !event.settings.remote.allowRemoteControl && (state.session?.canControl || state.hello?.canControl)) {
        return {
          settings: event.settings,
          session: state.session ? { ...state.session, canControl: false } : state.session,
          hello: state.hello ? { ...state.hello, canControl: false } : state.hello,
        };
      }
      return { settings: event.settings };
    }
    case 'stop_engaged':
      return {
        stop: { latched: true, reason: event.reason, at: event.at },
        status: state.status ? { ...state.status, stopLatched: true, stopReason: event.reason } : state.status,
      };
    case 'stop_released':
      return {
        stop: { latched: false, reason: null, at: null },
        status: state.status ? { ...state.status, stopLatched: false, stopReason: null } : state.status,
      };
    case 'toast': {
      const toast = makeToast(event.level, event.title, event.message, 'server');
      return { toasts: [...state.toasts, toast].slice(-MAX_TOASTS) };
    }
    default: {
      const unknown: never = event;
      void unknown;
      return {};
    }
  }
}

/** Applies GET /api/bootstrap (pure). */
export function reduceBootstrap(state: StoreState, data: BootstrapResponse): Partial<StoreState> {
  let next: Partial<StoreState> = {
    boot: 'ready',
    bootError: null,
    session: data.session,
    listenerKind: data.session.remote ? 'remote' : 'local',
    version: data.version,
    settings: data.settings,
    stream: data.stream,
    // A snapshot taken before an approval_resolved event must not bring that card back.
    approvals: data.pendingApprovals
      .filter((a) => a.status === 'pending' && !state.recentApprovals.some((r) => r.id === a.id))
      .sort((a, b) => a.createdAt - b.createdAt),
    ...withStatus(state, data.status),
  };
  const merged = { ...state, ...next };
  if (data.activeTask) {
    next = { ...next, ...withTask(merged, data.activeTask) };
  } else if (state.activeTaskId) {
    // The server says nothing is running; keep the task record but clear the active marker.
    // bootstrap() refetches records that were live so they don't keep showing "Running".
    next = { ...next, activeTaskId: null };
  }
  if (data.activeRun) {
    next = { ...next, ...withRun({ ...state, ...next }, data.activeRun) };
  } else if (state.activeRunId) {
    next = { ...next, activeRunId: null };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type EqualityFn<T> = (a: T, b: T) => boolean;

/** Shallow equality for arrays and plain objects (useful for derived selectors). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a) as (keyof T)[];
  const kb = Object.keys(b) as (keyof T)[];
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Subscribes to a slice of the store. The selector may be an inline function;
 * pass `shallowEqual` when it builds new arrays/objects.
 */
export function useAppStore<T>(selector: (state: StoreState) => T, isEqual: EqualityFn<T> = Object.is): T {
  const cache = useRef<{ state: StoreState; selector: (state: StoreState) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = appStore.getState();
    const cached = cache.current;
    if (cached && cached.state === state && cached.selector === selector) return cached.value;
    const value = selector(state);
    if (cached && isEqual(cached.value, value)) {
      cache.current = { state, selector, value: cached.value };
      return cached.value;
    }
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(appStore.subscribe, getSnapshot, getSnapshot);
}

export const useStatus = () => useAppStore((s) => s.status);
export const useSettings = () => useAppStore((s) => s.settings);
export const useStream = () => useAppStore((s) => s.stream);
export const useFrameMeta = () => useAppStore((s) => s.frame);
export const useApprovals = () => useAppStore((s) => s.approvals);
export const useStopState = () => useAppStore((s) => s.stop);
export const useConnection = () => useAppStore((s) => s.connection);
export const useSession = () => useAppStore((s) => s.session);
export const useBoot = () => useAppStore((s) => s.boot);
export const useLiveActivity = () => useAppStore((s) => s.activity);

export function useActiveTask(): AgentTask | null {
  return useAppStore((s) => (s.activeTaskId ? (s.tasks[s.activeTaskId] ?? null) : null));
}

export function useTask(taskId: string | null | undefined): AgentTask | null {
  return useAppStore((s) => (taskId ? (s.tasks[taskId] ?? null) : null));
}

const NO_STEPS: AgentStep[] = [];
export function useTaskSteps(taskId: string | null | undefined): AgentStep[] {
  return useAppStore((s) => (taskId ? (s.stepsByTask[taskId] ?? NO_STEPS) : NO_STEPS));
}

const NO_MESSAGES: ChatMessage[] = [];
export function useConversationMessages(conversationId: string | null | undefined): ChatMessage[] {
  return useAppStore((s) => (conversationId ? (s.messagesByConversation[conversationId] ?? NO_MESSAGES) : NO_MESSAGES));
}

/** Streaming (not yet final) assistant messages of one conversation. */
export function useStreamingMessages(conversationId: string | null | undefined): StreamingMessage[] {
  return useAppStore(
    (s) => (conversationId ? Object.values(s.streaming).filter((m) => m.conversationId === conversationId) : []),
    shallowEqual,
  );
}

export function useActiveRun(): WorkflowRun | null {
  return useAppStore((s) => (s.activeRunId ? (s.workflowRuns[s.activeRunId] ?? null) : null));
}

export function useWorkflowRun(runId: string | null | undefined): WorkflowRun | null {
  return useAppStore((s) => (runId ? (s.workflowRuns[runId] ?? null) : null));
}

/** Pending approvals for one task (or all when taskId is omitted). */
export function useTaskApprovals(taskId?: string | null): ApprovalRequest[] {
  return useAppStore((s) => (taskId ? s.approvals.filter((a) => a.taskId === taskId) : s.approvals), shallowEqual);
}

export function useCanControl(): boolean {
  return useAppStore((s) => s.session?.canControl ?? s.hello?.canControl ?? false);
}

/** True for the desktop app and local browsers; false for remote devices (the backend reserves some actions for the Mac). */
export function useIsLocal(): boolean {
  return useAppStore((s) => !(s.session?.remote ?? s.hello?.remote ?? false));
}

/** Best guess before /api/health answers: the local listener only binds 127.0.0.1 (and Vite dev uses localhost). */
export function guessListenerKind(hostname: string): ListenerKind {
  const host = hostname.trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' ? 'local' : 'remote';
}

/** Which listener served this page, falling back to the host-name guess until it is known. */
export function useListenerKind(): ListenerKind {
  const known = useAppStore((s) => s.listenerKind);
  return known ?? guessListenerKind(window.location.hostname);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const set = appStore.setState;

export function dispatchServerEvent(event: ServerEvent): void {
  const before = appStore.getState();
  set((state) => reduceServerEvent(state, event));
  if (
    event.type === 'settings' &&
    (before.session?.remote ?? before.hello?.remote) &&
    before.settings &&
    before.settings.remote.allowRemoteControl !== event.settings.remote.allowRemoteControl
  ) {
    // Remote control was turned off or on at the Mac: reload this session's
    // effective rights from the server (the reducer only ever removes them).
    void bootstrap();
  }
}

/** Records a UI notification; ToastBridge shows it with HeroUI's toast(). */
export function notify(level: ToastLevel, title: string, message?: string): void {
  const toast = makeToast(level, title, message, 'ui');
  set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));
}

/** Shows an error toast for any thrown value (ApiError messages come from the backend). */
export function notifyError(title: string, err: unknown): void {
  notify('error', title, errorMessage(err));
  // The server says this session can't control (e.g. remote control was turned off
  // on the Mac): reload the authoritative session so the UI stops offering controls.
  if (err instanceof ApiError && err.code === 'view_only') void bootstrap();
}

let bootstrapInFlight: Promise<boolean> | null = null;

/**
 * Records that may be stale after the socket was down: live runs and tasks the
 * server no longer reports as active (they ended while events weren't
 * arriving) and conversations with an unfinished streaming reply.
 */
export function staleAfterBootstrap(state: StoreState, data: BootstrapResponse): { runIds: string[]; taskIds: string[]; conversationIds: string[] } {
  const runIds = Object.values(state.workflowRuns)
    .filter((r) => ACTIVE_RUN_STATUSES.includes(r.status) && r.id !== data.activeRun?.id)
    .map((r) => r.id);
  const taskIds = Object.values(state.tasks)
    .filter((t) => !isTerminalTask(t) && t.id !== data.activeTask?.id)
    .map((t) => t.id);
  // Their conversations may have missed the final reply (or the whole reply) too.
  const conversationIds = [
    ...new Set([
      ...Object.values(state.streaming).map((m) => m.conversationId),
      ...taskIds.map((id) => state.tasks[id]!.conversationId),
    ]),
  ];
  return { runIds, taskIds, conversationIds };
}

/** Best-effort refresh of records that may have changed while events weren't arriving. */
function refreshStale(stale: ReturnType<typeof staleAfterBootstrap>): void {
  for (const id of stale.runIds) void api.workflowRuns.get(id).then(upsertRun, () => undefined);
  for (const id of stale.taskIds) void loadTask(id).catch(() => undefined); // also refreshes its steps
  for (const id of stale.conversationIds) void loadConversation(id).catch(() => undefined);
}

/** Loads GET /api/bootstrap. Returns true on success. */
export function bootstrap(): Promise<boolean> {
  if (bootstrapInFlight) return bootstrapInFlight;
  bootstrapInFlight = (async () => {
    try {
      const data = await api.bootstrap();
      const stale = staleAfterBootstrap(appStore.getState(), data);
      set((state) => reduceBootstrap(state, data));
      refreshStale(stale);
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          set({ boot: 'unauthorized', bootError: err.message });
          void detectListener();
        } else if (err.isUnreachable) {
          if (appStore.getState().boot === 'loading') set({ boot: 'unreachable', bootError: err.message });
        } else if (appStore.getState().boot === 'loading') {
          set({ boot: 'unreachable', bootError: err.message });
        }
      } else if (appStore.getState().boot === 'loading') {
        set({ boot: 'unreachable', bootError: errorMessage(err) });
      }
      return false;
    } finally {
      bootstrapInFlight = null;
    }
  })();
  return bootstrapInFlight;
}

setUnauthorizedHandler(() => {
  set({ boot: 'unauthorized', bootError: null });
  void detectListener();
});

let listenerProbe: Promise<ListenerKind | null> | null = null;

/**
 * Asks the public GET /api/health which listener served this page (cached once
 * known). Resolves to null when the probe fails; callers then use the host-name guess.
 */
export function detectListener(): Promise<ListenerKind | null> {
  const known = appStore.getState().listenerKind;
  if (known) return Promise.resolve(known);
  if (listenerProbe) return listenerProbe;
  listenerProbe = (async () => {
    try {
      const health = await api.health({ quiet401: true });
      const kind = health.listener === 'remote' || health.listener === 'local' ? health.listener : null;
      if (kind) set({ listenerKind: kind });
      return kind;
    } catch {
      return null;
    } finally {
      listenerProbe = null;
    }
  })();
  return listenerProbe;
}

export function setConnection(patch: Partial<ConnectionState>): void {
  set((state) => ({ connection: { ...state.connection, ...patch } }));
}

export function setBoot(boot: BootState, bootError: string | null = null): void {
  set({ boot, bootError });
}

/** Applies an authoritative DeviceStatus returned by a REST call. */
export function applyStatus(status: DeviceStatus): void {
  set((state) => withStatus(state, status));
}

export function applySettings(settings: AppSettings): void {
  set({ settings });
}

export function upsertTask(task: AgentTask): void {
  set((state) => withTask(state, task));
}

export function setTaskSteps(taskId: string, steps: AgentStep[]): void {
  set((state) => {
    const current = state.stepsByTask[taskId] ?? [];
    let merged = current;
    for (const step of steps) merged = upsertStep(merged, step);
    return { stepsByTask: { ...state.stepsByTask, [taskId]: merged } };
  });
}

export function upsertMessages(conversationId: string, messages: ChatMessage[]): void {
  set((state) => {
    let list = state.messagesByConversation[conversationId] ?? [];
    for (const message of messages) list = upsertMessage(list, message);
    return { messagesByConversation: { ...state.messagesByConversation, [conversationId]: list } };
  });
}

/**
 * Streaming entries of one conversation that the server's message list shows
 * are finished (or gone). `fetchedAt` protects deltas that arrived after the
 * list was requested for a message the list could not contain yet.
 */
export function finishedStreaming(
  streaming: StoreState['streaming'],
  conversationId: string,
  messages: readonly ChatMessage[],
  fetchedAt: number,
): string[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const done: string[] = [];
  for (const entry of Object.values(streaming)) {
    if (entry.conversationId !== conversationId) continue;
    const message = byId.get(entry.messageId);
    if (message ? !message.streaming : entry.updatedAt < fetchedAt) done.push(entry.messageId);
  }
  return done;
}

/**
 * Replaces a conversation's messages with the server's list (e.g. after
 * clearing or a reconnect) and drops "typing…" state for replies it shows as finished.
 */
export function replaceMessages(conversationId: string, messages: ChatMessage[], fetchedAt = Date.now()): void {
  set((state) => {
    const done = finishedStreaming(state.streaming, conversationId, messages, fetchedAt);
    let streaming = state.streaming;
    if (done.length > 0) {
      streaming = { ...state.streaming };
      for (const id of done) delete streaming[id];
    }
    return {
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: [...messages].sort((a, b) => a.createdAt - b.createdAt),
      },
      streaming,
    };
  });
}

export function upsertRun(run: WorkflowRun): void {
  set((state) => withRun(state, run));
}

export function upsertApproval(approval: ApprovalRequest): void {
  set((state) =>
    approval.status === 'pending'
      ? reduceServerEvent(state, { type: 'approval_requested', approval })
      : reduceServerEvent(state, { type: 'approval_resolved', approval }),
  );
}

/** PhoneViewer registration; drives the `viewer` ClientEvent. Returns the unregister function. */
export function registerViewer(): () => void {
  set((state) => ({ ui: { ...state.ui, viewers: state.ui.viewers + 1 } }));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    set((state) => ({ ui: { ...state.ui, viewers: Math.max(0, state.ui.viewers - 1) } }));
  };
}

export function setUi(patch: Partial<UiState>): void {
  set((state) => ({ ui: { ...state.ui, ...patch } }));
}

// --- Device & safety -------------------------------------------------------

/** Engages the emergency stop. */
export async function engageStop(reason = 'Stopped from iPhone AI'): Promise<void> {
  try {
    const status = await api.control.stop(reason);
    applyStatus(status);
  } catch (err) {
    notifyError('Could not engage the emergency stop', err);
    throw err;
  }
}

export async function rearmControl(): Promise<void> {
  const status = await api.control.rearm();
  applyStatus(status);
}

export async function setControlMode(mode: ControlMode): Promise<void> {
  const settings = await api.control.setMode(mode);
  applySettings(settings);
}

export async function setManualControl(enabled: boolean): Promise<void> {
  const settings = await api.control.setManual(enabled);
  applySettings(settings);
}

export async function setActiveProvider(providerId: string): Promise<void> {
  const settings = await api.providers.setActive(providerId);
  applySettings(settings);
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const settings = await api.settings.update(patch);
  applySettings(settings);
  return settings;
}

export async function refreshConnection(): Promise<DeviceStatus> {
  const status = await api.connection.refresh();
  applyStatus(status);
  return status;
}

export async function restartMcp(): Promise<DeviceStatus> {
  const status = await api.connection.restart();
  applyStatus(status);
  return status;
}

export async function captureScreen(options: { resume?: boolean; settleMs?: number } = {}): Promise<FrameMeta> {
  const meta = await api.screen.capture(options);
  set((state) => (isNewerFrame(state.frame, meta) ? { frame: meta } : {}));
  return meta;
}

// --- AI tasks & approvals --------------------------------------------------

export async function decideApproval(id: string, decision: 'approved' | 'rejected', note?: string): Promise<ApprovalRequest> {
  try {
    const approval = await api.approvals.decide(id, decision, note);
    upsertApproval(approval);
    return approval;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'approval_not_pending') {
      // The server no longer holds it (decided elsewhere, expired or cancelled): drop the card.
      set((state) => ({ approvals: state.approvals.filter((a) => a.id !== id) }));
    }
    throw err;
  }
}

export async function pauseTask(id: string): Promise<void> {
  upsertTask(await api.tasks.pause(id));
}

export async function resumeTask(id: string): Promise<void> {
  upsertTask(await api.tasks.resume(id));
}

export async function cancelTask(id: string): Promise<void> {
  upsertTask(await api.tasks.cancel(id));
}

/** Loads a task and its steps into the store. */
export async function loadTask(id: string): Promise<{ task: AgentTask; steps: AgentStep[] }> {
  const result = await api.tasks.get(id);
  set((state) => {
    const tasks = { ...state.tasks, [result.task.id]: result.task };
    let steps = state.stepsByTask[id] ?? [];
    for (const step of result.steps) steps = upsertStep(steps, step);
    return { tasks, stepsByTask: { ...state.stepsByTask, [id]: steps } };
  });
  return result;
}

/** Loads a conversation's messages and tasks into the store. */
export async function loadConversation(conversationId: string): Promise<void> {
  const fetchedAt = Date.now();
  const [messages, tasks] = await Promise.all([api.conversations.messages(conversationId), api.conversations.tasks(conversationId)]);
  replaceMessages(conversationId, messages, fetchedAt);
  set((state) => {
    const nextTasks = { ...state.tasks };
    let lastTaskId = state.lastTaskId;
    let activeTaskId = state.activeTaskId;
    for (const task of tasks) {
      nextTasks[task.id] = task;
      if (!isTerminalTask(task)) activeTaskId = task.id;
    }
    const newest = [...tasks].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (newest && (!lastTaskId || !state.tasks[lastTaskId] || state.tasks[lastTaskId]!.createdAt <= newest.createdAt)) {
      lastTaskId = newest.id;
    }
    return { tasks: nextTasks, lastTaskId, activeTaskId };
  });
}

/** Sends a chat message, which starts an AI task on the server. */
export async function sendChatMessage(conversationId: string, text: string, options: { providerId?: string; maxActions?: number } = {}) {
  const result = await api.conversations.send(conversationId, { text, ...options });
  upsertMessages(conversationId, [result.message]);
  upsertTask(result.task);
  return result;
}

/** Test helper: resets the singleton store. */
export function resetStoreForTests(): void {
  appStore.setState(createInitialState());
}
