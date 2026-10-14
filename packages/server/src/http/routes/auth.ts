// Sign-in flows: desktop token, one-time local browser code, remote passcode.

import { execFile } from 'node:child_process';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { remoteLoginSchema } from '@iphone-ai/shared';

import {
  clearSessionCookie,
  DESKTOP_SESSION_TTL_MS,
  LOCAL_BROWSER_SESSION_TTL_MS,
  safeEqual,
  setSessionCookie,
} from '../auth.js';
import { HttpError } from '../errors.js';
import { noContent, parseBody, requireDesktop, requireSession, sessionSummary, type RouteDeps } from '../guards.js';
import { htmlPage } from '../static-ui.js';

const browserLinkSchema = z.object({ open: z.boolean().optional() });

function userAgentOf(header: string | string[] | undefined): string | null {
  return typeof header === 'string' ? header : null;
}

export function openWithSystem(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [target], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  if (deps.listener === 'local') {
    app.get<{ Querystring: { token?: string } }>('/auth/desktop', async (request, reply) => {
      const expected = deps.desktopToken;
      const token = typeof request.query.token === 'string' ? request.query.token : '';
      if (!expected || !token || !safeEqual(token, expected)) {
        ctx.activity.record({
          category: 'security',
          type: 'auth.desktop_rejected',
          actor: 'system',
          severity: 'warning',
          summary: 'A desktop sign-in link with an invalid token was rejected.',
          detail: { ip: request.ip },
        });
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(htmlPage('Sign-in link not valid', 'This sign-in link is not valid for the running iPhone AI. Quit and reopen the iPhone AI app.'));
      }
      const { token: sessionToken } = auth.createSession({
        kind: 'desktop',
        canControl: true,
        ttlMs: DESKTOP_SESSION_TTL_MS,
        ip: request.ip,
        userAgent: userAgentOf(request.headers['user-agent']),
      });
      setSessionCookie(reply, sessionToken, null);
      ctx.activity.record({ category: 'session', type: 'auth.desktop', actor: 'user', summary: 'The iPhone AI window signed in.' });
      return reply.redirect('/', 302);
    });

    app.get<{ Querystring: { code?: string } }>('/auth/local', async (request, reply) => {
      const code = typeof request.query.code === 'string' ? request.query.code : '';
      if (!auth.consumeLoginCode(code)) {
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(htmlPage('Link expired', 'Browser links work once and expire after 2 minutes. Open a new one from the iPhone AI app (Settings → Open in browser).'));
      }
      const { token } = auth.createSession({
        kind: 'local-browser',
        canControl: true,
        ttlMs: LOCAL_BROWSER_SESSION_TTL_MS,
        ip: request.ip,
        userAgent: userAgentOf(request.headers['user-agent']),
      });
      setSessionCookie(reply, token, LOCAL_BROWSER_SESSION_TTL_MS);
      ctx.activity.record({
        category: 'security',
        type: 'auth.local_browser',
        actor: 'user',
        summary: 'A browser on this Mac signed in with a one-time link.',
      });
      return reply.redirect('/', 302);
    });

    app.post('/api/auth/browser-link', async (request) => {
      requireDesktop(request);
      const body = parseBody(browserLinkSchema, request.body);
      const code = auth.createLoginCode();
      const url = `${deps.baseUrl()}/auth/local?code=${encodeURIComponent(code)}`;
      const opened = body.open === true ? await openWithSystem(url) : false;
      return { url, opened };
    });
  }

  if (deps.listener === 'remote') {
    app.post('/api/auth/remote-login', async (request, reply) => {
      const ip = request.ip;
      const waitMs = auth.loginLimiter.retryAfterMs(ip);
      if (waitMs > 0) {
        void reply.header('retry-after', String(Math.ceil(waitMs / 1000)));
        throw new HttpError(429, 'rate_limited', `Too many failed attempts. Try again in ${Math.ceil(waitMs / 60_000)} minute(s).`);
      }
      const body = parseBody(remoteLoginSchema, request.body);
      const verdict = await auth.verifyRemotePasscode(body.passcode);
      if (verdict === 'not_configured') {
        throw new HttpError(403, 'remote_not_configured', 'Remote access has no passcode set on the Mac.');
      }
      if (verdict === 'invalid') {
        auth.loginLimiter.fail(ip);
        ctx.activity.record({
          category: 'security',
          type: 'auth.remote_failed',
          actor: 'system',
          severity: 'warning',
          summary: `Failed remote sign-in attempt from ${ip}.`,
          detail: { ip, deviceName: body.deviceName ?? null },
        });
        throw new HttpError(401, 'invalid_passcode', 'The passcode is not correct.');
      }
      auth.loginLimiter.succeed(ip);
      const remote = ctx.settings.get().remote;
      const ttlMs = remote.sessionTtlHours * 3_600_000;
      const { session, token } = auth.createSession({
        kind: 'remote',
        canControl: remote.allowRemoteControl,
        ttlMs,
        deviceName: body.deviceName ?? null,
        ip,
        userAgent: userAgentOf(request.headers['user-agent']),
      });
      setSessionCookie(reply, token, ttlMs);
      ctx.activity.record({
        category: 'security',
        type: 'auth.remote',
        actor: 'remote-user',
        severity: 'warning',
        summary: `Remote device ${session.deviceName ? `"${session.deviceName}" ` : ''}signed in from ${ip} (${session.canControl ? 'control allowed' : 'view-only'}).`,
        detail: { sessionId: session.id, ip, expiresAt: session.expiresAt },
      });
      return { ok: true };
    });
  }

  app.post('/api/auth/logout', async (request, reply) => {
    const session = requireSession(request);
    auth.revoke(session.id, 'Signed out');
    clearSessionCookie(reply);
    ctx.activity.record({
      category: 'session',
      type: 'auth.logout',
      actor: session.kind === 'remote' ? 'remote-user' : 'user',
      summary: session.kind === 'remote' ? 'A remote device signed out.' : 'A session signed out.',
    });
    return noContent(reply);
  });

  app.get('/api/auth/session', async (request) => sessionSummary(requireSession(request), auth));
}
