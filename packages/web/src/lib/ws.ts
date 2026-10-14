// Realtime link to the backend (`/ws`, same origin).
//
// - Exponential-backoff reconnect (0.5 s → 15 s, with jitter).
// - GET /api/bootstrap on every (re)connect so state is never stale.
// - Sends `viewer` (visible = page visible AND a PhoneViewer is mounted;
//   interactive = manual control on), throttled `activity_ping` on user input
//   and a `ping` keep-alive.

import { WS_PATH, type ClientEvent, type ServerEvent } from '@iphone-ai/shared';

import { appStore, bootstrap, dispatchServerEvent, setBoot, setConnection } from '../state/store';
import { api, ApiError } from './api';

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const ACTIVITY_PING_THROTTLE_MS = 4_000;
const VIEWER_DEBOUNCE_MS = 120;
/** Show the full-screen "backend unreachable" state after this long without a connection. */
const UNREACHABLE_AFTER_MS = 12_000;

const SERVER_EVENT_TYPES = new Set<ServerEvent['type']>([
  'hello',
  'status',
  'frame',
  'stream_stats',
  'activity',
  'chat_message',
  'chat_delta',
  'task_update',
  'task_step',
  'approval_requested',
  'approval_resolved',
  'workflow_run',
  'settings',
  'stop_engaged',
  'stop_released',
  'toast',
]);

export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_EVENT_TYPES.has(type as ServerEvent['type'])) return null;
  return parsed as ServerEvent;
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt));
  const jitter = base * 0.2 * random();
  return Math.round(Math.min(MAX_BACKOFF_MS, base + jitter));
}

export function wsUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${WS_PATH}`;
}

class RealtimeClient {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastViewerKey = '';
  private lastActivityPing = 0;
  private viewerTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeStore = appStore.subscribe(() => this.syncViewer());
    this.listen(document, 'visibilitychange', () => {
      this.syncViewer();
      if (document.visibilityState === 'visible' && !this.socket && !this.stopped) this.reconnectNow();
    });
    const onInput = () => this.activityPing();
    for (const type of ['pointerdown', 'keydown', 'wheel'] as const) this.listen(window, type, onInput, { passive: true, capture: true });
    this.listen(window, 'online', () => this.reconnectNow());
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close(1000, 'client stopped');
      this.socket = null;
    }
    setConnection({ socket: 'closed' });
  }

  send(event: ClientEvent): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }

  /** Retry immediately (e.g. from a "Try again" button). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private listen(
    target: Window | Document,
    type: string,
    handler: () => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  private connect(): void {
    if (this.stopped) return;
    if (appStore.getState().boot === 'unauthorized') return;
    setConnection({ socket: this.attempts === 0 && !appStore.getState().connection.lastOpenAt ? 'connecting' : 'reconnecting', nextRetryAt: null });
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.lastViewerKey = '';
      setConnection({ socket: 'open', attempts: 0, lastOpenAt: Date.now(), downSince: null, nextRetryAt: null });
      this.startPing();
      this.syncViewer();
      void bootstrap();
    };
    socket.onmessage = (message: MessageEvent) => {
      const event = parseServerEvent(message.data);
      if (event) dispatchServerEvent(event);
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.stopPing();
      if (this.stopped) return;
      const now = Date.now();
      const conn = appStore.getState().connection;
      setConnection({ socket: 'reconnecting', lastCloseAt: now, downSince: conn.downSince ?? now });
      void this.diagnoseDisconnect();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || appStore.getState().boot === 'unauthorized') return;
    const delay = backoffDelay(this.attempts);
    this.attempts += 1;
    setConnection({ attempts: this.attempts, nextRetryAt: Date.now() + delay });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * A WebSocket close carries no HTTP status, so probe the session endpoint:
   * 401 → session expired; network failure for long enough → backend unreachable.
   */
  private async diagnoseDisconnect(): Promise<void> {
    try {
      await api.auth.session({ quiet401: true });
    } catch (err) {
      if (!(err instanceof ApiError)) return;
      if (err.status === 401) {
        setBoot('unauthorized');
        return;
      }
      if (err.isUnreachable) {
        const downSince = appStore.getState().connection.downSince;
        if (downSince && Date.now() - downSince >= UNREACHABLE_AFTER_MS && appStore.getState().boot === 'ready') {
          setBoot('unreachable', err.message);
        }
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.viewerTimer) clearTimeout(this.viewerTimer);
    this.viewerTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * Coalesces viewer changes: a viewer unmounting and another mounting in the
   * same tick (route change, StrictMode) must not pause and resume polling.
   */
  private syncViewer(): void {
    if (this.viewerTimer) return;
    this.viewerTimer = setTimeout(() => {
      this.viewerTimer = null;
      this.sendViewer();
    }, VIEWER_DEBOUNCE_MS);
  }

  private sendViewer(): void {
    const state = appStore.getState();
    const visible = document.visibilityState === 'visible' && state.ui.viewers > 0;
    const interactive = state.settings?.permissions.manualControlEnabled ?? false;
    const key = `${visible}:${interactive}`;
    if (key === this.lastViewerKey) return;
    if (this.send({ type: 'viewer', visible, interactive })) this.lastViewerKey = key;
  }

  private activityPing(): void {
    const now = Date.now();
    if (now - this.lastActivityPing < ACTIVITY_PING_THROTTLE_MS) return;
    if (this.send({ type: 'activity_ping' })) this.lastActivityPing = now;
  }
}

export const realtime = new RealtimeClient();

/** Starts the realtime link (idempotent); returns a stop function for tests/HMR. */
export function startRealtime(): () => void {
  realtime.start();
  return () => realtime.stop();
}
