// Remote listener: passcode login, rate limiting, view-only sessions,
// revocation, and the RemoteAccessService lifecycle.

import { homedir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext, NetworkAddress } from '../../src/core/services.js';
import { LoginRateLimiter } from '../../src/http/auth.js';
import { createHttpServer, type CreateHttpServerOptions, type HttpServerHandle } from '../../src/http/server.js';
import { bindAddressProblem, isTailscaleAddress } from '../../src/remote/network.js';
import { hashPasscode, REMOTE_PASSCODE_ACCOUNT, verifyPasscode } from '../../src/remote/passcode.js';
import { RemoteAccessService } from '../../src/remote/remote-access.js';
import {
  createHarness,
  LOCAL_HOST,
  LOCAL_ORIGIN,
  localHeaders,
  loginDesktop,
  loginRemote,
  PASSCODE,
  rawHttpStatus,
  REMOTE_ADDRESS,
  REMOTE_HOST,
  remoteHeaders,
  type Harness,
} from './harness.js';

const TAP = { action: { kind: 'tap', x: 10, y: 10 }, geometryId: '410x898', frameSeq: null };

describe('remote listener', () => {
  let h: Harness;
  let remote: HttpServerHandle;

  beforeEach(async () => {
    h = await createHarness();
    await h.setPasscode();
    h.ctx.settings.mutate((draft) => {
      draft.permissions.manualControlEnabled = true;
      draft.remote.enabled = true;
      draft.remote.bindAddress = REMOTE_ADDRESS;
    });
    remote = h.remoteServer();
  });

  afterEach(async () => {
    await h.close();
  });

  it('accepts only its configured address in the Host header', async () => {
    const wrong = await remote.app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:47824' } });
    expect(wrong.statusCode).toBe(421);
    const ok = await remote.app.inject({ method: 'GET', url: '/api/health', headers: { host: REMOTE_HOST } });
    expect(ok.statusCode).toBe(200);
    const desktop = await remote.app.inject({ method: 'GET', url: '/auth/desktop?token=x', headers: { host: REMOTE_HOST } });
    expect(desktop.statusCode).toBe(404);
  });

  it('gates percent-encoded spellings of API paths without a session (401)', async () => {
    for (const url of [
      '/%61pi/screen/frame/latest',
      '/%61pi/conversations/c1/messages',
      '/%61pi/activity/export?format=csv',
      '/%61pi/settings',
      '/ap%69/settings',
      '/%61pi/diagnostics/info',
    ]) {
      const res = await remote.app.inject({ method: 'GET', url, headers: { host: REMOTE_HOST } });
      expect(res.statusCode, url).toBe(401);
    }
    expect(h.fakes.device.getLatestFrame).not.toHaveBeenCalled();
    const health = await remote.app.inject({ method: 'GET', url: '/%61pi/health', headers: { host: REMOTE_HOST } });
    expect(health.statusCode).toBe(200);
  });

  it('refuses absolute-form request targets on a real remote socket', async () => {
    const server = createHttpServer(h.ctx, { host: '127.0.0.1', port: 0, desktopToken: null, listener: 'remote', auth: h.auth });
    try {
      const { port } = await server.listen();
      const host = `127.0.0.1:${port}`;
      expect(await rawHttpStatus(port, '/api/settings', host)).toBe(401);
      expect(await rawHttpStatus(port, `http://${host}/api/settings`, host)).toBe(400);
      expect(await rawHttpStatus(port, `http://${host}/%61pi/screen/frame/latest`, host)).toBe(400);
      expect(await rawHttpStatus(port, '/%61pi/settings', host)).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('refuses everything once remote access is turned off', async () => {
    const cookie = await loginRemote(h, remote);
    h.ctx.settings.mutate((draft) => {
      draft.remote.enabled = false;
    });
    const res = await remote.app.inject({ method: 'GET', url: '/api/status', headers: remoteHeaders(cookie) });
    expect(res.statusCode).toBe(503);
    const login = await remote.app.inject({
      method: 'POST',
      url: '/api/auth/remote-login',
      headers: remoteHeaders(null),
      payload: { passcode: PASSCODE },
    });
    expect(login.statusCode).toBe(503);
  });

  it('signs in with the passcode and is view-only by default', async () => {
    const cookie = await loginRemote(h, remote);
    const session = await remote.app.inject({ method: 'GET', url: '/api/auth/session', headers: remoteHeaders(cookie) });
    expect(session.json()).toMatchObject({ kind: 'remote', canControl: false, remote: true });

    const action = await remote.app.inject({ method: 'POST', url: '/api/control/action', headers: remoteHeaders(cookie), payload: TAP });
    expect(action.statusCode).toBe(403);
    expect(action.json()).toMatchObject({ error: { code: 'view_only' } });
    expect(h.fakes.device.perform).not.toHaveBeenCalled();

    // A remote cookie is not valid on the local listener.
    const local = await h.local.app.inject({ method: 'GET', url: '/api/status', headers: localHeaders(cookie) });
    expect(local.statusCode).toBe(401);
  });

  it('lets a view-only remote session use the emergency stop', async () => {
    const cookie = await loginRemote(h, remote);
    const res = await remote.app.inject({ method: 'POST', url: '/api/control/stop', headers: remoteHeaders(cookie), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopLatched: true });
    expect(h.fakes.device.emergencyStop).toHaveBeenCalledWith('Stopped from remote device "Test iPad"', 'remote-user');
  });

  it('allows remote control only when granted, and never escalation of the mode', async () => {
    h.ctx.settings.mutate((draft) => {
      draft.remote.allowRemoteControl = true;
    });
    const cookie = await loginRemote(h, remote);
    const action = await remote.app.inject({ method: 'POST', url: '/api/control/action', headers: remoteHeaders(cookie), payload: TAP });
    expect(action.statusCode).toBe(200);
    const [, actionCtx] = h.fakes.device.perform.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(actionCtx).toMatchObject({ actor: 'remote-user', remoteControlAllowed: true, decision: { verdict: 'allow' } });

    const escalate = await remote.app.inject({ method: 'PUT', url: '/api/control/mode', headers: remoteHeaders(cookie), payload: { mode: 'supervised' } });
    expect(escalate.statusCode).toBe(403);
    const settings = await remote.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: remoteHeaders(cookie),
      payload: { remote: { allowRemoteControl: true } },
    });
    expect(settings.statusCode).toBe(403);
    const deescalate = await remote.app.inject({ method: 'PUT', url: '/api/control/mode', headers: remoteHeaders(cookie), payload: { mode: 'observe' } });
    expect(deescalate.statusCode).toBe(200);

    // Turning remote control off on the Mac takes effect for existing sessions immediately.
    h.ctx.settings.mutate((draft) => {
      draft.remote.allowRemoteControl = false;
    });
    const after = await remote.app.inject({ method: 'POST', url: '/api/control/action', headers: remoteHeaders(cookie), payload: TAP });
    expect(after.statusCode).toBe(403);
  });

  it('rate limits failed logins (429 after 5 failures)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await remote.app.inject({
        method: 'POST',
        url: '/api/auth/remote-login',
        headers: remoteHeaders(null),
        payload: { passcode: `wrong-passcode-${i}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const blocked = await remote.app.inject({
      method: 'POST',
      url: '/api/auth/remote-login',
      headers: remoteHeaders(null),
      payload: { passcode: PASSCODE },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    const failures = h.ctx.activity.query({ categories: ['security'] }).filter((e) => e.type === 'auth.remote_failed');
    expect(failures).toHaveLength(5);
  });

  it('never shows remote sessions credentials in provider URLs or the macOS account name', async () => {
    const secretUrl = 'https://proxy.example/v1?api-key=SECRET123';
    h.ctx.settings.mutate((draft) => {
      const openai = draft.ai.providers.find((p) => p.id === 'openai')!;
      openai.baseUrl = secretUrl;
      draft.connection.mirroirBinaryPath = path.join(homedir(), 'bin', 'mirroir');
    });
    const dataDir = path.join(homedir(), 'Library', 'Application Support', 'iPhone AI');
    (h.ctx as { paths: AppContext['paths'] }).paths = { ...h.ctx.paths, dataDir };
    h.fakes.mirroir.resolveBinary.mockReturnValue(path.join(homedir(), 'bin', 'mirroir'));
    const cookie = await loginRemote(h, remote);
    const desktop = await loginDesktop(h);

    for (const url of ['/api/settings', '/api/providers', '/api/bootstrap', '/api/diagnostics/info']) {
      const res = await remote.app.inject({ method: 'GET', url, headers: remoteHeaders(cookie) });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('SECRET123');
      expect(res.body, url).not.toContain(homedir());
    }
    const providers = await remote.app.inject({ method: 'GET', url: '/api/providers', headers: remoteHeaders(cookie) });
    // Still visibly configured for the remote UI.
    expect(providers.json<{ id: string; baseUrl: string | null }[]>().find((p) => p.id === 'openai')?.baseUrl).toBe(
      'https://proxy.example/v1?[redacted]',
    );
    const info = await remote.app.inject({ method: 'GET', url: '/api/diagnostics/info', headers: remoteHeaders(cookie) });
    expect(info.json()).toMatchObject({ dataDir: '~/Library/Application Support/iPhone AI', mirroirBinary: '~/bin/mirroir' });

    // A general-only PUT from a control-granted remote session gets the redacted settings back too.
    h.ctx.settings.mutate((draft) => {
      draft.remote.allowRemoteControl = true;
    });
    const controlCookie = await loginRemote(h, remote);
    const put = await remote.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: remoteHeaders(controlCookie),
      payload: { general: { theme: 'light' } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('SECRET123');
    const mode = await remote.app.inject({ method: 'PUT', url: '/api/control/mode', headers: remoteHeaders(controlCookie), payload: { mode: 'observe' } });
    expect(mode.statusCode).toBe(200);
    expect(mode.body).not.toContain('SECRET123');

    // WebSocket settings events: redacted for remote connections, complete for local ones.
    const remoteWs = await remote.app.injectWS('/ws', { headers: { cookie, origin: `http://${REMOTE_HOST}`, host: REMOTE_HOST } });
    const localWs = await h.local.app.injectWS('/ws', { headers: { cookie: desktop, origin: LOCAL_ORIGIN, host: LOCAL_HOST } });
    const settingsEvent = (ws: typeof remoteWs) =>
      new Promise<string>((resolve) => {
        ws.on('message', (data) => {
          const text = String(data);
          if ((JSON.parse(text) as { type: string }).type === 'settings') resolve(text);
        });
      });
    const remoteEvent = settingsEvent(remoteWs);
    const localEvent = settingsEvent(localWs);
    h.ctx.hub.publish({ type: 'settings', settings: h.ctx.settings.get() });
    expect(await remoteEvent).not.toContain('SECRET123');
    expect(await localEvent).toContain(secretUrl);
    remoteWs.terminate();
    localWs.terminate();

    // Local sessions keep the full values (the Settings editor round-trips them).
    const local = await h.local.app.inject({ method: 'GET', url: '/api/settings', headers: localHeaders(desktop) });
    expect(local.json<{ ai: { providers: { id: string; baseUrl: string | null }[] } }>().ai.providers.find((p) => p.id === 'openai')?.baseUrl).toBe(secretUrl);
    const localInfo = await h.local.app.inject({ method: 'GET', url: '/api/diagnostics/info', headers: localHeaders(desktop) });
    expect(localInfo.json()).toMatchObject({ dataDir });
  });

  it('scrubs the raw health-check output', async () => {
    h.fakes.device.checkHealth.mockResolvedValue({ ok: true, text: `All checks passed\nlog: ${homedir()}/Library/Logs/mirroir.log` });
    const desktop = await loginDesktop(h);
    const res = await h.local.app.inject({ method: 'POST', url: '/api/connection/check-health', headers: localHeaders(desktop) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ raw: string }>().raw).toBe('All checks passed\nlog: ~/Library/Logs/mirroir.log');
  });

  it('rate limits parallel failed logins too (attempts are reserved before verifying)', async () => {
    const login = (passcode: string) =>
      remote.app.inject({ method: 'POST', url: '/api/auth/remote-login', headers: remoteHeaders(null), payload: { passcode } });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => login(`wrong-passcode-${i}`)));
    const counts: Record<number, number> = {};
    for (const res of results) counts[res.statusCode] = (counts[res.statusCode] ?? 0) + 1;
    expect((counts[401] ?? 0) + (counts[429] ?? 0)).toBe(40);
    expect(counts[401] ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts[401] ?? 0).toBeLessThanOrEqual(5);
    const failures = () => h.ctx.activity.query({ categories: ['security'] }).filter((e) => e.type === 'auth.remote_failed');
    expect(failures().length).toBe(counts[401]);

    // Sequential attempts use up the rest of the budget, then everything is refused.
    for (let i = counts[401] ?? 0; i < 5; i += 1) expect((await login(`again-wrong-${i}`)).statusCode).toBe(401);
    const blocked = await login(PASSCODE);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    expect(failures()).toHaveLength(5);
  });

  it('a correct passcode after a failure still signs in and clears the failures', async () => {
    const wrong = await remote.app.inject({
      method: 'POST',
      url: '/api/auth/remote-login',
      headers: remoteHeaders(null),
      payload: { passcode: 'wrong-passcode' },
    });
    expect(wrong.statusCode).toBe(401);
    await loginRemote(h, remote);
    // Successful logins do not use up the failure budget.
    for (let i = 0; i < 6; i += 1) await loginRemote(h, remote);
  });

  it('a revoked session gets 401 and its WebSocket is closed', async () => {
    const service = new RemoteAccessService(h.ctx, { auth: h.auth, listAddresses: () => [] });
    const desktop = await loginDesktop(h);
    const cookie = await loginRemote(h, remote);

    const ws = await remote.app.injectWS('/ws', { headers: { cookie, origin: `http://${REMOTE_HOST}`, host: REMOTE_HOST } });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

    const list = await h.local.app.inject({ method: 'GET', url: '/api/remote/sessions', headers: localHeaders(desktop) });
    expect(list.statusCode).toBe(200);
    const sessions = list.json<{ id: string; kind: string; current?: boolean }[]>();
    const target = sessions.find((s) => s.kind === 'remote');
    expect(target).toBeDefined();
    expect(sessions.find((s) => s.kind === 'desktop')?.current).toBe(true);

    const revoke = await h.local.app.inject({ method: 'DELETE', url: `/api/remote/sessions/${target!.id}`, headers: localHeaders(desktop) });
    expect(revoke.statusCode).toBe(204);
    expect(await closed).toBe(4401);

    const after = await remote.app.inject({ method: 'GET', url: '/api/auth/session', headers: remoteHeaders(cookie) });
    expect(after.statusCode).toBe(401);

    const desktopRevoke = await h.local.app.inject({
      method: 'DELETE',
      url: `/api/remote/sessions/${sessions.find((s) => s.kind === 'desktop')!.id}`,
      headers: localHeaders(desktop),
    });
    expect(desktopRevoke.statusCode).toBe(403);
    await service.stop();
  });

  it('only local sessions may set the passcode; changing it signs out remote sessions', async () => {
    const service = new RemoteAccessService(h.ctx, { auth: h.auth, listAddresses: () => [] });
    const cookie = await loginRemote(h, remote);
    const fromRemote = await remote.app.inject({
      method: 'PUT',
      url: '/api/remote/passcode',
      headers: remoteHeaders(cookie),
      payload: { passcode: 'another passcode' },
    });
    expect(fromRemote.statusCode).toBe(403);

    const desktop = await loginDesktop(h);
    const short = await h.local.app.inject({ method: 'PUT', url: '/api/remote/passcode', headers: localHeaders(desktop), payload: { passcode: 'short' } });
    expect(short.statusCode).toBe(400);
    const set = await h.local.app.inject({
      method: 'PUT',
      url: '/api/remote/passcode',
      headers: localHeaders(desktop),
      payload: { passcode: 'another passcode' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ passcodeSet: true });
    const stored = await h.secrets.get(REMOTE_PASSCODE_ACCOUNT);
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain('another passcode');

    const old = await remote.app.inject({ method: 'GET', url: '/api/auth/session', headers: remoteHeaders(cookie) });
    expect(old.statusCode).toBe(401);
    await service.stop();
  });
});

describe('RemoteAccessService', () => {
  let h: Harness;
  const tailscale: NetworkAddress = { iface: 'utun4', address: REMOTE_ADDRESS, tailscale: true };

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  function fakeFactory() {
    const created: CreateHttpServerOptions[] = [];
    const closes: ReturnType<typeof vi.fn>[] = [];
    const factory = (_ctx: unknown, options: CreateHttpServerOptions): HttpServerHandle => {
      created.push(options);
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return {
        app: undefined as never,
        auth: h.auth,
        listen: async () => ({ port: options.port, url: `http://${options.host}:${options.port}` }),
        close,
      };
    };
    return { created, closes, factory };
  }

  it('listens only when enabled with a passcode on an existing address, and follows settings', async () => {
    const { created, closes, factory } = fakeFactory();
    const service = new RemoteAccessService(h.ctx, { auth: h.auth, createServer: factory, listAddresses: () => [tailscale] });
    await service.start();
    expect(created).toHaveLength(0);
    expect(service.info().listening).toBe(false);

    await h.setPasscode();
    h.ctx.settings.mutate((draft) => {
      draft.remote.enabled = true;
      draft.remote.bindAddress = REMOTE_ADDRESS;
    });
    await service.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ host: REMOTE_ADDRESS, port: 47824, listener: 'remote', desktopToken: null });
    const info = service.info();
    expect(info).toMatchObject({ listening: true, url: `http://${REMOTE_ADDRESS}:47824`, error: null });
    expect(info.addresses).toEqual([tailscale]);

    h.ctx.settings.mutate((draft) => {
      draft.remote.enabled = false;
    });
    await service.reconcile();
    expect(closes[0]).toHaveBeenCalled();
    expect(service.info().listening).toBe(false);
    await service.stop();
  });

  it('refuses 0.0.0.0 and addresses that are not on an interface', async () => {
    const { created, factory } = fakeFactory();
    await h.setPasscode();
    const service = new RemoteAccessService(h.ctx, { auth: h.auth, createServer: factory, listAddresses: () => [tailscale] });
    h.ctx.settings.mutate((draft) => {
      draft.remote.enabled = true;
      draft.remote.bindAddress = '0.0.0.0';
    });
    await service.start();
    expect(created).toHaveLength(0);
    expect(service.info().error).toMatch(/every network interface/);

    h.ctx.settings.mutate((draft) => {
      draft.remote.bindAddress = '100.64.9.9';
    });
    await service.reconcile();
    expect(created).toHaveLength(0);
    expect(service.info().error).toMatch(/not assigned/);
    await service.stop();
  });

  it('serves /api/remote through the local listener', async () => {
    const service = new RemoteAccessService(h.ctx, { auth: h.auth, listAddresses: () => [tailscale] });
    const desktop = await loginDesktop(h);
    const res = await h.local.app.inject({ method: 'GET', url: '/api/remote', headers: localHeaders(desktop) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ listening: false, url: null, addresses: [tailscale], settings: { enabled: false } });
    await service.stop();
    const gone = await h.local.app.inject({ method: 'GET', url: '/api/remote', headers: localHeaders(desktop) });
    expect(gone.statusCode).toBe(503);
  });
});

describe('LoginRateLimiter', () => {
  it('counts a reserved attempt until it finishes, and allows one verification per IP at a time', () => {
    const limiter = new LoginRateLimiter(2, 60_000, 10, 2);
    const first = limiter.reserve('1.1.1.1', 1000);
    expect(first.ticket).toBe(1000);
    // Same IP while the first is still being verified: refused, but not counted.
    expect(limiter.reserve('1.1.1.1', 1001)).toMatchObject({ ticket: null, busy: true });
    const other = limiter.reserve('2.2.2.2', 1002);
    expect(other.ticket).not.toBeNull();
    // Global in-flight cap.
    expect(limiter.reserve('3.3.3.3', 1003)).toMatchObject({ ticket: null, busy: true });
    limiter.finish('1.1.1.1', first.ticket!, 'invalid');
    limiter.finish('2.2.2.2', other.ticket!, 'not_configured');

    const second = limiter.reserve('1.1.1.1', 1004);
    expect(second.ticket).not.toBeNull();
    limiter.finish('1.1.1.1', second.ticket!, 'invalid');
    // Two failures recorded for 1.1.1.1 → locked out; 2.2.2.2's attempt was un-counted.
    expect(limiter.reserve('1.1.1.1', 1005)).toMatchObject({ ticket: null, busy: false });
    expect(limiter.retryAfterMs('1.1.1.1', 1005)).toBe(60_000 - 5);
    expect(limiter.retryAfterMs('2.2.2.2', 1005)).toBe(0);

    const ok = limiter.reserve('2.2.2.2', 1006);
    limiter.finish('2.2.2.2', ok.ticket!, 'ok');
    expect(limiter.retryAfterMs('2.2.2.2', 1007)).toBe(0);
  });
});

describe('remote helpers', () => {
  it('hashes and verifies passcodes with scrypt', async () => {
    const hash = await hashPasscode('open sesame 123');
    expect(await verifyPasscode('open sesame 123', hash)).toBe(true);
    expect(await verifyPasscode('open sesame 124', hash)).toBe(false);
    expect(await verifyPasscode('open sesame 123', 'scrypt$999999999$8$1$AAAA$BBBB')).toBe(false);
    expect(await verifyPasscode('x', 'plain-text')).toBe(false);
  });

  it('flags Tailscale CGNAT addresses and rejects unsafe bind addresses', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.127.255.254')).toBe(true);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('192.168.1.2')).toBe(false);
    const available: NetworkAddress[] = [{ iface: 'en0', address: '192.168.1.2', tailscale: false }];
    expect(bindAddressProblem('0.0.0.0', available)).not.toBeNull();
    expect(bindAddressProblem('127.0.0.1', available)).not.toBeNull();
    expect(bindAddressProblem('10.0.0.1', available)).not.toBeNull();
    expect(bindAddressProblem('', available)).not.toBeNull();
    expect(bindAddressProblem('192.168.1.2', available)).toBeNull();
  });
});
