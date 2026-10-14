// WebSocket /ws: pushes every ServerEvent to connected UIs and receives
// viewer visibility / activity pings that drive screenshot polling.
// Authentication (cookie + Origin + Host) already happened in the security hook.

import type { FastifyInstance } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import { WS_PATH, type ServerEvent } from '@iphone-ai/shared';

import { newId } from '../core/ids.js';
import { WS_CLOSE_SESSION_ENDED } from './auth.js';
import type { RouteDeps } from './guards.js';
import { exportableSettings } from './redaction.js';

const HEARTBEAT_MS = 30_000;
/** Clients that cannot keep up (e.g. a stalled remote browser) are dropped. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const ACTIVITY_PING_MIN_INTERVAL_MS = 500;

const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('viewer'), visible: z.boolean(), interactive: z.boolean() }),
  z.object({ type: z.literal('activity_ping') }),
  z.object({ type: z.literal('ping'), t: z.number().optional() }),
]);

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

interface Connection {
  id: string;
  sessionId: string;
  /** Remote sessions receive settings events redacted (see redaction.ts). */
  remote: boolean;
  socket: WebSocket;
  alive: boolean;
  lastActivityPing: number;
}

export function registerWebSocket(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;
  const connections = new Map<string, Connection>();
  const log = ctx.log.child('ws');

  const send = (conn: Connection, payload: string): void => {
    const ws = conn.socket;
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      log.warn('Dropping slow WebSocket client', { connection: conn.id, buffered: ws.bufferedAmount });
      ws.terminate();
      return;
    }
    ws.send(payload, (err) => {
      if (err) ws.terminate();
    });
  };

  const unsubscribe = ctx.hub.subscribe((event: ServerEvent) => {
    if (connections.size === 0) return;
    let payload: string;
    let remotePayload: string;
    try {
      payload = JSON.stringify(event);
      remotePayload = event.type === 'settings' ? JSON.stringify({ ...event, settings: exportableSettings(event.settings) }) : payload;
    } catch (err) {
      log.warn('Could not serialise an event', { type: event.type, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const conn of connections.values()) send(conn, conn.remote ? remotePayload : payload);
  });

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
    unsubscribe();
    for (const conn of connections.values()) conn.socket.terminate();
    connections.clear();
  });

  app.get(WS_PATH, { websocket: true }, (socket, request) => {
    const session = request.authSession;
    if (!session) {
      socket.close(WS_CLOSE_SESSION_ENDED, 'Unauthenticated');
      return;
    }
    const conn: Connection = {
      id: newId('ws'),
      sessionId: session.id,
      remote: session.kind === 'remote',
      socket,
      alive: true,
      lastActivityPing: 0,
    };
    connections.set(conn.id, conn);
    const untrack = auth.trackSocket(session.id, (code, reason) => socket.close(code, reason));

    socket.on('pong', () => {
      conn.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToString(data));
      } catch {
        return;
      }
      const result = clientEventSchema.safeParse(parsed);
      if (!result.success) return;
      const message = result.data;
      switch (message.type) {
        case 'viewer':
          ctx.stream.setViewer(conn.id, {
            visible: message.visible,
            interactive: message.interactive && auth.canControl(session),
          });
          break;
        case 'activity_ping': {
          const now = Date.now();
          if (now - conn.lastActivityPing >= ACTIVITY_PING_MIN_INTERVAL_MS) {
            conn.lastActivityPing = now;
            ctx.stream.markActivity();
          }
          break;
        }
        case 'ping':
          break;
      }
    });

    socket.on('close', () => {
      connections.delete(conn.id);
      untrack();
      ctx.stream.setViewer(conn.id, null);
    });

    socket.on('error', (err) => {
      log.debug('WebSocket error', { connection: conn.id, error: err.message });
    });

    const hello: ServerEvent = {
      type: 'hello',
      sessionId: session.id,
      serverVersion: ctx.version,
      remote: session.kind === 'remote',
      canControl: auth.canControl(session),
    };
    send(conn, JSON.stringify(hello));
  });
}
