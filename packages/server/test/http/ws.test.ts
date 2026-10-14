// WebSocket /ws: authentication, hello, event fan-out and viewer messages.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { createHarness, LOCAL_HOST, LOCAL_ORIGIN, loginDesktop, type Harness } from './harness.js';

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
  });
}

describe('WebSocket /ws', () => {
  let h: Harness;
  let cookie: string;

  beforeEach(async () => {
    h = await createHarness();
    cookie = await loginDesktop(h);
  });

  afterEach(async () => {
    await h.close();
  });

  it('greets, forwards hub events and handles viewer messages', async () => {
    let first: Promise<Record<string, unknown>> | null = null;
    const ws = await h.local.app.injectWS(
      '/ws',
      { headers: { cookie, origin: LOCAL_ORIGIN, host: LOCAL_HOST } },
      {
        onInit: (socket) => {
          first = nextMessage(socket);
        },
      },
    );
    const hello = await first!;
    expect(hello).toMatchObject({ type: 'hello', serverVersion: '0.1.0-test', remote: false, canControl: true });
    expect(typeof hello.sessionId).toBe('string');

    const toast = nextMessage(ws);
    h.ctx.hub.publish({ type: 'toast', level: 'info', title: 'Hello there' });
    expect(await toast).toEqual({ type: 'toast', level: 'info', title: 'Hello there' });

    ws.send(JSON.stringify({ type: 'viewer', visible: true, interactive: true }));
    ws.send(JSON.stringify({ type: 'activity_ping' }));
    ws.send('not json');
    await vi.waitFor(() => {
      expect(h.fakes.stream.setViewer).toHaveBeenCalledWith(expect.stringMatching(/^ws_/), { visible: true, interactive: true });
      expect(h.fakes.stream.markActivity).toHaveBeenCalled();
    });

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.terminate();
    await closed;
    await vi.waitFor(() => expect(h.fakes.stream.setViewer).toHaveBeenLastCalledWith(expect.stringMatching(/^ws_/), null));
  });

  it('rejects upgrades without a session or with a foreign or missing Origin', async () => {
    await expect(
      h.local.app.injectWS('/ws', { headers: { origin: LOCAL_ORIGIN, host: LOCAL_HOST } }),
    ).rejects.toThrow(/401/);
    await expect(
      h.local.app.injectWS('/ws', { headers: { cookie, origin: 'http://evil.example', host: LOCAL_HOST } }),
    ).rejects.toThrow(/403/);
    await expect(h.local.app.injectWS('/ws', { headers: { cookie, host: LOCAL_HOST } })).rejects.toThrow(/403/);
  });
});
