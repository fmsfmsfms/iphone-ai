// Real sockets: the local listener binds 127.0.0.1 on a random port and the
// cookie + WebSocket flow works over actual HTTP.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CSRF_HEADER } from '@iphone-ai/shared';

import { startLocalServer, type LocalServer } from '../../src/http/server.js';
import { createHarness, DESKTOP_TOKEN, sessionCookieFrom, type Harness } from './harness.js';

describe('startLocalServer (real sockets)', () => {
  let h: Harness;
  let server: LocalServer;

  beforeEach(async () => {
    h = await createHarness();
    server = await startLocalServer(h.ctx, { port: 0, desktopToken: DESKTOP_TOKEN, devOrigins: [] });
  });

  afterEach(async () => {
    await server.close();
    await h.close();
  });

  it('binds 127.0.0.1, logs in, serves the API and the WebSocket', async () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const address = server.app.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');

    const login = await fetch(`${server.url}/auth/desktop?token=${DESKTOP_TOKEN}`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const cookie = sessionCookieFrom(login.headers.getSetCookie());
    expect(cookie).not.toBeNull();

    const status = await fetch(`${server.url}/api/status`, { headers: { cookie: cookie! } });
    expect(status.status).toBe(200);

    const stop = await fetch(`${server.url}/api/control/stop`, {
      method: 'POST',
      headers: { cookie: cookie!, origin: server.url, [CSRF_HEADER]: '1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(stop.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie: cookie!, origin: server.url } });
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      ws.once('error', reject);
    });
    expect(hello).toMatchObject({ type: 'hello', remote: false });
    const settingsEvent = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => {
        const event = JSON.parse(String(data)) as Record<string, unknown>;
        if (event.type === 'settings') resolve(event);
      });
    });
    h.ctx.settings.mutate((draft) => {
      draft.general.theme = 'light';
    });
    expect(await settingsEvent).toMatchObject({ type: 'settings', settings: { general: { theme: 'light' } } });
    ws.close();

    const rejected = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { origin: server.url } });
    const outcome = await new Promise<string>((resolve) => {
      rejected.once('unexpected-response', (_req, res) => resolve(`status ${res.statusCode}`));
      rejected.once('open', () => resolve('open'));
      rejected.once('error', (err) => resolve(`error ${err.message}`));
    });
    expect(outcome).toBe('status 401');
    rejected.terminate();
  });
});
