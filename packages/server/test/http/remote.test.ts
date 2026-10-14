// Remote listener: passcode login, rate limiting, view-only sessions,
// revocation, and the RemoteAccessService lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkAddress } from '../../src/core/services.js';
import type { CreateHttpServerOptions, HttpServerHandle } from '../../src/http/server.js';
import { bindAddressProblem, isTailscaleAddress } from '../../src/remote/network.js';
import { hashPasscode, REMOTE_PASSCODE_ACCOUNT, verifyPasscode } from '../../src/remote/passcode.js';
import { RemoteAccessService } from '../../src/remote/remote-access.js';
import {
  createHarness,
  localHeaders,
  loginDesktop,
  loginRemote,
  PASSCODE,
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
