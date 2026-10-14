// Authentication and request gatekeeping on the local listener.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE } from '@iphone-ai/shared';

import { AuthService } from '../../src/http/auth.js';
import { startLocalServer } from '../../src/http/server.js';
import {
  createHarness,
  DESKTOP_TOKEN,
  LOCAL_HOST,
  LOCAL_ORIGIN,
  localHeaders,
  loginDesktop,
  rawHttpStatus,
  sessionCookieFrom,
  type Harness,
} from './harness.js';

describe('HTTP security (local listener)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('serves /api/health without a session', async () => {
    const res = await h.local.app.inject({ method: 'GET', url: '/api/health', headers: { host: LOCAL_HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: '0.1.0-test' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
  });

  it('rejects API calls without a session cookie (401)', async () => {
    const res = await h.local.app.inject({ method: 'GET', url: '/api/status', headers: { host: LOCAL_HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('rejects an unknown session cookie (401)', async () => {
    const res = await h.local.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: LOCAL_HOST, cookie: `${SESSION_COOKIE}=not-a-real-session` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('desktop token login sets an HttpOnly SameSite=Strict cookie that authenticates', async () => {
    const res = await h.local.app.inject({
      method: 'GET',
      url: `/auth/desktop?token=${encodeURIComponent(DESKTOP_TOKEN)}`,
      headers: { host: LOCAL_HOST },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const raw = String(res.headers['set-cookie']);
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Secure/i);
    const cookie = sessionCookieFrom(res.headers['set-cookie']);

    const status = await h.local.app.inject({ method: 'GET', url: '/api/status', headers: { host: LOCAL_HOST, cookie: cookie! } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ stopLatched: false });

    const session = await h.local.app.inject({ method: 'GET', url: '/api/auth/session', headers: { host: LOCAL_HOST, cookie: cookie! } });
    expect(session.json()).toMatchObject({ kind: 'desktop', canControl: true, remote: false });

    // Only the hash of the token is stored.
    const token = cookie!.split('=')[1]!;
    const rows = h.ctx.db.all<{ token_hash: string }>('SELECT token_hash FROM remote_sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a wrong desktop token and sets no cookie', async () => {
    const res = await h.local.app.inject({
      method: 'GET',
      url: '/auth/desktop?token=wrong-token',
      headers: { host: LOCAL_HOST },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    const missing = await h.local.app.inject({ method: 'GET', url: '/auth/desktop', headers: { host: LOCAL_HOST } });
    expect(missing.statusCode).toBe(403);
  });

  it('rejects a mismatched Host header (DNS rebinding)', async () => {
    const cookie = await loginDesktop(h);
    for (const host of ['evil.example', `evil.example:47823`, '127.0.0.1:9999', '192.168.1.10:47823']) {
      const res = await h.local.app.inject({ method: 'GET', url: '/api/status', headers: { host, cookie } });
      expect(res.statusCode).toBe(421);
      expect(res.json()).toMatchObject({ error: { code: 'bad_host' } });
    }
    const health = await h.local.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'attacker.example:47823' } });
    expect(health.statusCode).toBe(421);
    const ok = await h.local.app.inject({ method: 'GET', url: '/api/status', headers: { host: 'localhost:47823', cookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const cookie = await loginDesktop(h);
    const res = await h.local.app.inject({
      method: 'POST',
      url: '/api/control/stop',
      headers: { host: LOCAL_HOST, origin: LOCAL_ORIGIN, cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'csrf' } });
    expect(h.fakes.device.emergencyStop).not.toHaveBeenCalled();
  });

  it('rejects a foreign Origin', async () => {
    const cookie = await loginDesktop(h);
    const res = await h.local.app.inject({
      method: 'POST',
      url: '/api/control/stop',
      headers: { host: LOCAL_HOST, origin: 'http://evil.example', cookie, [CSRF_HEADER]: '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'bad_origin' } });
    const nullOrigin = await h.local.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: LOCAL_HOST, origin: 'null', cookie },
    });
    expect(nullOrigin.statusCode).toBe(403);
    expect(h.fakes.device.emergencyStop).not.toHaveBeenCalled();
  });

  it('accepts a same-origin state-changing request', async () => {
    const cookie = await loginDesktop(h);
    const res = await h.local.app.inject({ method: 'POST', url: '/api/control/stop', headers: localHeaders(cookie) });
    expect(res.statusCode).toBe(200);
    expect(h.fakes.device.emergencyStop).toHaveBeenCalledWith('Stopped by the user', 'user');
  });

  it('logout revokes the session', async () => {
    const cookie = await loginDesktop(h);
    const out = await h.local.app.inject({ method: 'POST', url: '/api/auth/logout', headers: localHeaders(cookie) });
    expect(out.statusCode).toBe(204);
    const after = await h.local.app.inject({ method: 'GET', url: '/api/status', headers: localHeaders(cookie) });
    expect(after.statusCode).toBe(401);
  });

  it('one-time browser links work once and only for desktop sessions', async () => {
    const cookie = await loginDesktop(h);
    const link = await h.local.app.inject({ method: 'POST', url: '/api/auth/browser-link', headers: localHeaders(cookie), payload: {} });
    expect(link.statusCode).toBe(200);
    const { url } = link.json<{ url: string }>();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:47823\/auth\/local\?code=/);
    const pathAndQuery = url.replace(LOCAL_ORIGIN, '');

    const exchange = await h.local.app.inject({ method: 'GET', url: pathAndQuery, headers: { host: LOCAL_HOST } });
    expect(exchange.statusCode).toBe(302);
    const browserCookie = sessionCookieFrom(exchange.headers['set-cookie']);
    expect(browserCookie).not.toBeNull();
    const session = await h.local.app.inject({ method: 'GET', url: '/api/auth/session', headers: localHeaders(browserCookie) });
    expect(session.json()).toMatchObject({ kind: 'local-browser', canControl: true });

    const reuse = await h.local.app.inject({ method: 'GET', url: pathAndQuery, headers: { host: LOCAL_HOST } });
    expect(reuse.statusCode).toBe(403);
    expect(reuse.headers['set-cookie']).toBeUndefined();

    const fromBrowser = await h.local.app.inject({ method: 'POST', url: '/api/auth/browser-link', headers: localHeaders(browserCookie) });
    expect(fromBrowser.statusCode).toBe(403);
    expect(fromBrowser.json()).toMatchObject({ error: { code: 'desktop_only' } });
  });

  it('keeps local-browser sessions short-lived: browser-session cookie, 8 h, revoked on the next launch', async () => {
    const cookie = await loginDesktop(h);
    const link = await h.local.app.inject({ method: 'POST', url: '/api/auth/browser-link', headers: localHeaders(cookie), payload: {} });
    const exchange = await h.local.app.inject({ method: 'GET', url: link.json<{ url: string }>().url.replace(LOCAL_ORIGIN, ''), headers: { host: LOCAL_HOST } });
    expect(exchange.statusCode).toBe(302);
    const raw = String(exchange.headers['set-cookie']);
    expect(raw).not.toMatch(/Max-Age/i);
    expect(raw).not.toMatch(/Expires/i);
    const browserCookie = sessionCookieFrom(exchange.headers['set-cookie']);
    const row = h.ctx.db.get<{ created_at: number; expires_at: number }>("SELECT created_at, expires_at FROM remote_sessions WHERE kind = 'local-browser'");
    expect(row!.expires_at - row!.created_at).toBe(8 * 3_600_000);
    const before = await h.local.app.inject({ method: 'GET', url: '/api/auth/session', headers: localHeaders(browserCookie) });
    expect(before.statusCode).toBe(200);

    // The next backend launch revokes it (like desktop sessions).
    new AuthService(h.ctx).startup();
    const after = await h.local.app.inject({ method: 'GET', url: '/api/auth/session', headers: localHeaders(browserCookie) });
    expect(after.statusCode).toBe(401);
  });

  it('does not expose remote-login on the local listener', async () => {
    const res = await h.local.app.inject({
      method: 'POST',
      url: '/api/auth/remote-login',
      headers: localHeaders(null),
      payload: { passcode: 'whatever-123' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('maps unknown API routes to a JSON 404 and treats empty JSON bodies as absent', async () => {
    const cookie = await loginDesktop(h);
    const missing = await h.local.app.inject({ method: 'GET', url: '/api/nope', headers: localHeaders(cookie) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
    const empty = await h.local.app.inject({
      method: 'POST',
      url: '/api/control/stop',
      headers: localHeaders(cookie, { 'content-type': 'application/json' }),
      payload: '',
    });
    expect(empty.statusCode).toBe(200);
  });

  it('gates percent-encoded spellings of API paths on the routed path (401 without a session)', async () => {
    h.ctx.activity.record({ category: 'manual', type: 'tool.call', actor: 'user', summary: 'private event' });
    for (const url of [
      '/%61pi/settings',
      '/ap%69/settings',
      '/%61pi/screen/frame/latest',
      '/%61pi/activity',
      '/%61pi/activity/export?format=csv',
      '/%61pi/diagnostics/export',
      '/%61pi/connection/stderr',
      '/%61pi/status',
      '/%61pi/providers',
      '/%61pi/conversations/c1/messages',
      '/api%2Fsettings',
      '/%61pi/nope',
    ]) {
      const res = await h.local.app.inject({ method: 'GET', url, headers: { host: LOCAL_HOST } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toMatchObject({ error: { code: 'unauthenticated' } });
    }
    expect(h.fakes.device.getLatestFrame).not.toHaveBeenCalled();
    expect(h.fakes.mirroir.recentStderr).not.toHaveBeenCalled();

    const ws = await h.local.app.inject({ method: 'GET', url: '/w%73', headers: { host: LOCAL_HOST, origin: LOCAL_ORIGIN } });
    expect(ws.statusCode).toBe(401);

    // Public endpoints stay public in any spelling; malformed escapes are refused.
    const health = await h.local.app.inject({ method: 'GET', url: '/%61pi/health', headers: { host: LOCAL_HOST } });
    expect(health.statusCode).toBe(200);
    const malformed = await h.local.app.inject({ method: 'GET', url: '/api/%E0%A4%A', headers: { host: LOCAL_HOST } });
    expect(malformed.statusCode).toBe(400);

    // With a session the encoded spelling works and is still treated as an API response.
    const cookie = await loginDesktop(h);
    const ok = await h.local.app.inject({ method: 'GET', url: '/%61pi/settings', headers: { host: LOCAL_HOST, cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('refuses absolute-form request targets over a real socket', async () => {
    const server = await startLocalServer(h.ctx, { port: 0, desktopToken: DESKTOP_TOKEN, devOrigins: [] });
    try {
      const host = `127.0.0.1:${server.port}`;
      expect(await rawHttpStatus(server.port, '/api/settings', host)).toBe(401);
      expect(await rawHttpStatus(server.port, `http://${host}/api/settings`, host)).toBe(400);
      expect(await rawHttpStatus(server.port, `http://${host}/%61pi/settings`, host)).toBe(400);
      expect(await rawHttpStatus(server.port, 'http://evil.example/%61pi/settings', host)).toBe(400);
      expect(await rawHttpStatus(server.port, '/%61pi/settings', host)).toBe(401);
      expect(await rawHttpStatus(server.port, '/api/health', host)).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('serves a "not built" page at / when the UI is missing', async () => {
    const res = await h.local.app.inject({ method: 'GET', url: '/', headers: { host: LOCAL_HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('not built');
  });
});
