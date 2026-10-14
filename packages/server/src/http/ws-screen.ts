// WebSocket /ws/screen: relays live ScreenCaptureKit frames (JPEG) to UIs.
//
// Each message is binary: [4-byte BE uint32 H][H bytes UTF-8 JSON
// LiveFrameHeader][JPEG bytes] (see LiveFrameHeader in packages/shared). The
// latest frame is sent on connect. Viewers that cannot keep up are skipped
// (never queued): a frame is dropped for a connection whose socket still has
// more than 1.5 MB buffered. Remote sessions are capped at 10 fps.
// Authentication (cookie + Origin + Host) already happened in the security
// hook; any authenticated session may view. Viewing does not drive capture —
// the /ws `viewer` messages do (ScreenStream viewer tracking).

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { WS_SCREEN_PATH } from '@iphone-ai/shared';

import { newId } from '../core/ids.js';
import type { LiveFrame } from '../device/live-capture.js';
import { WS_CLOSE_SESSION_ENDED } from './auth.js';
import type { RouteDeps } from './guards.js';

/** Skip a frame for a connection whose socket has more than this queued. */
export const SCREEN_WS_MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024;
/** Frame-rate cap for remote sessions (bandwidth over Tailscale / LAN). */
export const REMOTE_SCREEN_MAX_FPS = 10;
const REMOTE_MIN_INTERVAL_MS = 1000 / REMOTE_SCREEN_MAX_FPS;
/** Frames arrive on the capture clock; allow this much early arrival without exceeding the cap on average. */
const RATE_TOLERANCE_MS = 10;
const HEARTBEAT_MS = 30_000;

/** The parts of a WebSocket the relay uses (a fake in unit tests). */
export interface ScreenSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }, callback: (err?: Error) => void): void;
  terminate(): void;
}

/** Source of live frames (LiveCapture). */
export interface LiveFrameFeed {
  latest(): LiveFrame | null;
  on(event: 'frame', listener: (frame: LiveFrame) => void): unknown;
  off(event: 'frame', listener: (frame: LiveFrame) => void): unknown;
}

export interface ScreenClientStats {
  sent: number;
  skippedBackpressure: number;
  skippedRate: number;
}

interface ScreenClient extends ScreenClientStats {
  id: string;
  socket: ScreenSocket;
  remote: boolean;
  /** Remote rate cap: earliest time the next frame may go out. */
  nextAllowedAt: number;
  /** Last frame sent (never send the same or an older frame twice). */
  lastSeq: number;
}

export type DeliveryOutcome = 'sent' | 'backpressure' | 'rate' | 'closed' | 'stale';

/** Fans live frames out to /ws/screen connections with per-connection backpressure. */
export class ScreenRelay {
  private readonly clients = new Map<string, ScreenClient>();
  private readonly onFrame = (frame: LiveFrame) => this.broadcast(frame);
  private closed = false;

  constructor(
    private readonly feed: LiveFrameFeed,
    private readonly now: () => number = Date.now,
  ) {
    feed.on('frame', this.onFrame);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Adds a connection and sends it the latest frame right away. Returns the remover. */
  add(id: string, socket: ScreenSocket, options: { remote: boolean }): () => void {
    const client: ScreenClient = {
      id,
      socket,
      remote: options.remote,
      nextAllowedAt: 0,
      lastSeq: 0,
      sent: 0,
      skippedBackpressure: 0,
      skippedRate: 0,
    };
    this.clients.set(id, client);
    const latest = this.feed.latest();
    if (latest) this.deliver(client, latest, this.now());
    return () => {
      this.clients.delete(id);
    };
  }

  clientStats(id: string): ScreenClientStats | null {
    const client = this.clients.get(id);
    return client ? { sent: client.sent, skippedBackpressure: client.skippedBackpressure, skippedRate: client.skippedRate } : null;
  }

  broadcast(frame: LiveFrame): void {
    if (this.closed || this.clients.size === 0) return;
    const now = this.now();
    for (const client of this.clients.values()) this.deliver(client, frame, now);
  }

  private deliver(client: ScreenClient, frame: LiveFrame, now: number): DeliveryOutcome {
    const socket = client.socket;
    if (socket.readyState !== socket.OPEN) return 'closed';
    if (frame.meta.seq <= client.lastSeq) return 'stale';
    if (socket.bufferedAmount > SCREEN_WS_MAX_BUFFERED_BYTES) {
      client.skippedBackpressure += 1;
      return 'backpressure';
    }
    if (client.remote) {
      if (now < client.nextAllowedAt - RATE_TOLERANCE_MS) {
        client.skippedRate += 1;
        return 'rate';
      }
      client.nextAllowedAt = Math.max(now, client.nextAllowedAt) + REMOTE_MIN_INTERVAL_MS;
    }
    client.lastSeq = frame.meta.seq;
    client.sent += 1;
    socket.send(frame.message(), { binary: true }, (err) => {
      if (err) socket.terminate();
    });
    return 'sent';
  }

  close(): void {
    this.closed = true;
    this.feed.off('frame', this.onFrame);
    for (const client of this.clients.values()) client.socket.terminate();
    this.clients.clear();
  }
}

interface Connection {
  id: string;
  sessionId: string;
  socket: WebSocket;
  alive: boolean;
}

export function registerScreenWebSocket(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;
  const relay = new ScreenRelay(ctx.live);
  const connections = new Map<string, Connection>();
  const log = ctx.log.child('ws-screen');

  const heartbeat = setInterval(() => {
    for (const conn of connections.values()) {
      if (!auth.isActive(conn.sessionId)) {
        conn.socket.close(WS_CLOSE_SESSION_ENDED, 'Session ended');
        continue;
      }
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    relay.close();
    for (const conn of connections.values()) conn.socket.terminate();
    connections.clear();
  });

  app.get(WS_SCREEN_PATH, { websocket: true }, (socket, request) => {
    const session = request.authSession;
    if (!session) {
      socket.close(WS_CLOSE_SESSION_ENDED, 'Unauthenticated');
      return;
    }
    const conn: Connection = { id: newId('wss'), sessionId: session.id, socket, alive: true };
    connections.set(conn.id, conn);
    const untrack = auth.trackSocket(session.id, (code, reason) => socket.close(code, reason));
    socket.on('pong', () => {
      conn.alive = true;
    });
    // Nothing is expected from clients; any message just proves liveness.
    socket.on('message', () => {
      conn.alive = true;
    });
    let remove: (() => void) | null = null;
    socket.on('close', () => {
      const stats = relay.clientStats(conn.id);
      connections.delete(conn.id);
      untrack();
      remove?.();
      if (stats) log.debug('Live screen viewer disconnected', { connection: conn.id, ...stats });
    });
    socket.on('error', (err) => {
      log.debug('Live screen WebSocket error', { connection: conn.id, error: err.message });
    });
    remove = relay.add(conn.id, socket, { remote: session.kind === 'remote' });
  });
}
