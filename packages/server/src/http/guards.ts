// Per-route authorization helpers and shared route plumbing.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Actor } from '@iphone-ai/shared';

import type { AppContext } from '../core/services.js';
import type { RemoteAccessApi } from '../remote/remote-access.js';
import type { AuthService, AuthSession, ListenerKind } from './auth.js';
import { HttpError } from './errors.js';

export interface RouteDeps {
  ctx: AppContext;
  auth: AuthService;
  /** Resolved lazily: main.ts may construct the remote-access service after the local listener. */
  remote(): RemoteAccessApi | null;
  listener: ListenerKind;
  desktopToken: string | null;
  /** http://host:port of this listener (port known after listen). */
  baseUrl(): string;
}

export interface SessionSummary {
  id: string;
  kind: AuthSession['kind'];
  canControl: boolean;
  remote: boolean;
}

export function requireSession(request: FastifyRequest): AuthSession {
  const session = request.authSession;
  if (!session) throw new HttpError(401, 'unauthenticated', 'Sign in to iPhone AI first.');
  return session;
}

/** Desktop app and local browser sessions (never remote devices). */
export function requireLocal(request: FastifyRequest): AuthSession {
  const session = requireSession(request);
  if (session.kind === 'remote') {
    throw new HttpError(403, 'local_only', 'This can only be changed from the Mac (the iPhone AI app or a local browser).');
  }
  return session;
}

export function requireDesktop(request: FastifyRequest): AuthSession {
  const session = requireSession(request);
  if (session.kind !== 'desktop') {
    throw new HttpError(403, 'desktop_only', 'This is only available in the iPhone AI desktop app.');
  }
  return session;
}

/** Sessions allowed to drive the phone (remote ones only when remote control is granted and still allowed). */
export function requireControl(request: FastifyRequest, auth: AuthService): AuthSession {
  const session = requireSession(request);
  if (!auth.canControl(session)) {
    throw new HttpError(403, 'view_only', 'This remote session is view-only. Remote control is turned off on the Mac.');
  }
  return session;
}

export function actorFor(session: AuthSession): Actor {
  return session.kind === 'remote' ? 'remote-user' : 'user';
}

/** Label recorded as "decided by" / "requested by" in the audit log. */
export function sessionLabel(session: AuthSession): string {
  if (session.kind === 'remote') return `remote:${session.deviceName ?? session.id}`;
  return session.kind === 'desktop' ? 'user' : 'user (browser)';
}

export function sessionSummary(session: AuthSession, auth: AuthService): SessionSummary {
  return { id: session.id, kind: session.kind, canControl: auth.canControl(session), remote: session.kind === 'remote' };
}

/** Parses a body with a shared zod schema; an absent body is treated as {}. ZodErrors become 400s. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  return schema.parse(body ?? {});
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}

export function pathOf(url: string): string {
  const index = url.indexOf('?');
  return index >= 0 ? url.slice(0, index) : url;
}
