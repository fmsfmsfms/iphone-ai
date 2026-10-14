// Request gatekeeping, run before anything else on every request:
//  1. Host header must be the address this listener serves (DNS-rebinding defence) → 421
//  2. Origin, when present (always for /ws and /ws/screen), must be this listener's origin → 403
//  3. State-changing methods must carry the x-iphone-ai header (CSRF defence) → 403
//  4. /api/* (except health and remote-login), /ws and /ws/screen need a valid session cookie → 401
// plus security headers on every response.
//
// The router (find-my-way) percent-decodes paths and accepts absolute-form
// request targets, so the raw request.url is not what gets routed. Decisions
// therefore consider every spelling the router could have used: the raw path,
// its percent-decoded form and the matched route pattern. Only origin-form
// targets ("/path") are accepted.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, SESSION_COOKIE, WS_PATH, WS_SCREEN_PATH } from '@iphone-ai/shared';

import { readCookie, type AuthService, type ListenerKind } from './auth.js';
import { HttpError } from './errors.js';
import { pathOf } from './guards.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
/** WebSocket endpoints: event stream and binary live frames. */
const WS_PATHS: ReadonlySet<string> = new Set([WS_PATH, WS_SCREEN_PATH]);

export interface SecurityOptions {
  listener: ListenerKind;
  auth: AuthService;
  /** Lower-case host:port values accepted in the Host header. */
  allowedHosts(): ReadonlySet<string>;
  /** Extra exact origins (local listener only, e.g. the Vite dev server). */
  extraOrigins: ReadonlySet<string>;
  /** False while the listener must refuse everything (remote access just turned off). */
  enabled(): boolean;
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function isPublic(method: string, path: string): boolean {
  return (method === 'GET' && path === '/api/health') || (method === 'POST' && path === '/api/auth/remote-login');
}

export function needsSession(method: string, path: string): boolean {
  if (WS_PATHS.has(path)) return true;
  if (!isApiPath(path)) return false;
  return !isPublic(method, path);
}

/** Percent-decoded path, or null when the escapes are malformed. */
function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** The raw path, its decoded form and the matched route pattern (undefined on a 404). */
function routingViews(request: FastifyRequest, raw: string, decoded: string | null): string[] {
  const views = [raw];
  if (decoded !== null && decoded !== raw) views.push(decoded);
  const routed = request.routeOptions.url;
  if (typeof routed === 'string' && !views.includes(routed)) views.push(routed);
  return views;
}

function setSecurityHeaders(reply: FastifyReply, host: string, views: readonly string[]): void {
  void reply.header('x-content-type-options', 'nosniff');
  void reply.header('referrer-policy', 'no-referrer');
  void reply.header('x-frame-options', 'DENY');
  void reply.header('cross-origin-opener-policy', 'same-origin');
  void reply.header('cross-origin-resource-policy', 'same-origin');
  const wsSource = /^[a-z0-9.\-[\]:]+$/i.test(host) ? ` ws://${host}` : '';
  void reply.header(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${wsSource}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  if (views.some((path) => isApiPath(path) || path.startsWith('/auth/'))) {
    void reply.header('cache-control', 'no-store');
  }
}

export function installSecurityHooks(app: FastifyInstance, options: SecurityOptions): void {
  // A WebSocket upgrade answered with an HTTP response (rejected here, or a
  // 404) leaves the detached upgrade socket open; destroy it so clients see
  // the failure and server.close() does not wait for it. Successful upgrades
  // hijack the reply and never reach onResponse.
  app.addHook('onResponse', async (request) => {
    if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket') return;
    const socket = request.raw.socket;
    if (socket && !socket.destroyed) socket.destroy();
  });

  app.addHook('onRequest', async (request, reply) => {
    const raw = pathOf(request.url);
    const decoded = decodePath(raw);
    const views = routingViews(request, raw, decoded);
    const host = (request.headers.host ?? '').trim().toLowerCase();
    setSecurityHeaders(reply, options.allowedHosts().has(host) ? host : '', views);
    const upgrade = (request.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if (upgrade) void reply.header('connection', 'close');

    if (!options.allowedHosts().has(host)) {
      throw new HttpError(421, 'bad_host', 'This request was addressed to a host iPhone AI does not serve.');
    }
    if (!request.url.startsWith('/')) {
      throw new HttpError(400, 'bad_request_target', 'Only origin-form request targets are accepted.');
    }
    if (decoded === null) {
      throw new HttpError(400, 'bad_path', 'Malformed URL path.');
    }
    if (!options.enabled()) {
      throw new HttpError(503, 'remote_disabled', 'Remote access is turned off on the Mac.');
    }

    const isWs = views.some((view) => WS_PATHS.has(view));
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const normalized = origin.trim().toLowerCase();
      if (normalized !== `http://${host}` && !options.extraOrigins.has(normalized)) {
        throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
      }
    } else if (isWs) {
      throw new HttpError(403, 'bad_origin', 'WebSocket connections must come from the iPhone AI page.');
    }

    if (STATE_CHANGING.has(request.method)) {
      const marker = request.headers[CSRF_HEADER];
      if (typeof marker !== 'string' || marker.trim() === '') {
        throw new HttpError(403, 'csrf', `Missing the ${CSRF_HEADER} request header.`);
      }
    }

    if (isWs || views.some(isApiPath)) {
      request.authSession = options.auth.resolve(readCookie(request.headers.cookie, SESSION_COOKIE), options.listener);
      // Public only when every spelling of the path agrees it is public.
      if (!request.authSession && views.some((path) => needsSession(request.method, path))) {
        throw new HttpError(401, 'unauthenticated', 'Sign in to iPhone AI first.');
      }
    }
  });
}
