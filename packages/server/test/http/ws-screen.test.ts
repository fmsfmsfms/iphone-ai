// WebSocket /ws/screen: binary live frames relayed from LiveCapture. The
// integration tests drive LiveCapture with the FAKE capture helper
// (test/live-capture/fake-capture-helper.mjs) — no ScreenCaptureKit, no phone.

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import { silentLogger } from '../../src/core/logger.js';
import { decodeLiveFrameMessage, LiveCapture, LiveFrame } from '../../src/device/live-capture.js';
import { REMOTE_SCREEN_MAX_FPS, SCREEN_WS_MAX_BUFFERED_BYTES, ScreenRelay, type ScreenSocket } from '../../src/http/ws-screen.js';
import { makeTempDir, sleep, waitFor } from '../helpers/context.js';
import { fakeHelper, fakeJpeg, type FakeHelper } from '../live-capture/helpers.js';
import {
  createHarness,
  LOCAL_HOST,
  LOCAL_ORIGIN,
  localHeaders,
  loginDesktop,
  loginRemote,
  REMOTE_ADDRESS,
  REMOTE_HOST,
  type Harness,
} from './harness.js';

class FakeFeed extends EventEmitter {
  current: LiveFrame | null = null;
  latest(): LiveFrame | null {
    return this.current;
  }
  push(frame: LiveFrame): void {
    this.current = frame;
    this.emit('frame', frame);
  }
}

class FakeSocket implements ScreenSocket {
  readyState = 1;
  readonly OPEN = 1;
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  terminated = false;
  send(data: Buffer, _options: { binary: boolean }, callback: (err?: Error) => void): void {
    this.sent.push(data);
    callback();
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  seqs(): number[] {
    return this.sent.map((m) => decodeLiveFrameMessage(m).header.seq);
  }
}

function frame(seq: number): LiveFrame {
  return new LiveFrame(
    {
      seq,
      capturedAt: 1000 + seq,
      latencyMs: 3,
      widthPx: 730,
      heightPx: 1600,
      mimeType: 'image/jpeg',
      pxPerPt: 1.7805,
      geometry: null,
      source: 'screencapturekit',
      receivedAt: 1003 + seq,
    },
    fakeJpeg(seq),
    { width: 410, height: 898 },
  );
}

describe('ScreenRelay', () => {
  it('sends the latest frame on connect, then every new frame to local sessions', () => {
    const feed = new FakeFeed();
    feed.push(frame(1));
    const relay = new ScreenRelay(feed);
    const socket = new FakeSocket();
    relay.add('a', socket, { remote: false });
    expect(socket.seqs()).toEqual([1]);
    for (let seq = 2; seq <= 40; seq += 1) feed.push(frame(seq));
    expect(socket.seqs()).toHaveLength(40);
    expect(decodeLiveFrameMessage(socket.sent[0]!).jpeg.equals(fakeJpeg(1))).toBe(true);
  });

  it('skips frames (never queues) while a socket has more than 1.5 MB buffered, and keeps the connection', () => {
    const feed = new FakeFeed();
    const relay = new ScreenRelay(feed);
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    relay.add('slow', slow, { remote: false });
    relay.add('fast', fast, { remote: false });
    feed.push(frame(1));
    slow.bufferedAmount = SCREEN_WS_MAX_BUFFERED_BYTES + 1;
    feed.push(frame(2));
    feed.push(frame(3));
    slow.bufferedAmount = SCREEN_WS_MAX_BUFFERED_BYTES; // at the limit: sends again
    feed.push(frame(4));
    expect(slow.seqs()).toEqual([1, 4]);
    expect(fast.seqs()).toEqual([1, 2, 3, 4]);
    expect(slow.terminated).toBe(false);
    expect(relay.clientStats('slow')).toEqual({ sent: 2, skippedBackpressure: 2, skippedRate: 0 });
  });

  it(`caps remote sessions at ${REMOTE_SCREEN_MAX_FPS} fps`, () => {
    let now = 0;
    const feed = new FakeFeed();
    const relay = new ScreenRelay(feed, () => now);
    const remote = new FakeSocket();
    const local = new FakeSocket();
    relay.add('remote', remote, { remote: true });
    relay.add('local', local, { remote: false });
    // 30 fps for 3 seconds.
    for (let i = 1; i <= 90; i += 1) {
      now = Math.round(i * (1000 / 30));
      feed.push(frame(i));
    }
    expect(local.sent).toHaveLength(90);
    expect(remote.sent.length).toBeGreaterThanOrEqual(28);
    expect(remote.sent.length).toBeLessThanOrEqual(31);
    // Never two frames closer than the cap allows (minus the arrival tolerance).
    const times = remote.seqs().map((seq) => Math.round(seq * (1000 / 30)));
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90);
  });

  it('does not write to closed sockets or resend a frame', () => {
    const feed = new FakeFeed();
    feed.push(frame(5));
    const relay = new ScreenRelay(feed);
    const socket = new FakeSocket();
    relay.add('a', socket, { remote: false });
    feed.push(frame(5));
    feed.push(frame(4));
    socket.readyState = 3;
    feed.push(frame(6));
    expect(socket.seqs()).toEqual([5]);
  });

  it('stops relaying after close and drops the feed subscription', () => {
    const feed = new FakeFeed();
    const relay = new ScreenRelay(feed);
    const socket = new FakeSocket();
    relay.add('a', socket, { remote: false });
    relay.close();
    expect(socket.terminated).toBe(true);
    expect(feed.listenerCount('frame')).toBe(0);
  });
});

function nextBinary(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
  });
}

describe('WebSocket /ws/screen (fake capture helper)', () => {
  let h: Harness;
  let helper: FakeHelper;
  let cookie: string;

  beforeEach(async () => {
    const dir = makeTempDir();
    helper = fakeHelper(dir, { jpegBytes: 2048 });
    h = await createHarness({
      live: ({ device, settings, hub }) =>
        new LiveCapture({
          device,
          settings,
          hub,
          log: silentLogger,
          helper: helper.command,
          timings: { tickMs: 50, stopDelayMs: 300 },
        }),
    });
    cookie = await loginDesktop(h);
  });

  afterEach(async () => {
    await h.close();
  });

  function startLive(): void {
    h.ctx.live.setViewerSource(() => 1);
    h.ctx.live.start();
  }

  it('requires a session and a matching Origin', async () => {
    await expect(h.local.app.injectWS('/ws/screen', { headers: { origin: LOCAL_ORIGIN, host: LOCAL_HOST } })).rejects.toThrow(/401/);
    await expect(
      h.local.app.injectWS('/ws/screen', { headers: { cookie, origin: 'http://evil.example', host: LOCAL_HOST } }),
    ).rejects.toThrow(/403/);
    await expect(h.local.app.injectWS('/ws/screen', { headers: { cookie, host: LOCAL_HOST } })).rejects.toThrow(/403/);
    // Percent-encoded spellings of the path get the same checks.
    await expect(h.local.app.injectWS('/ws%2Fscreen', { headers: { cookie, host: LOCAL_HOST } })).rejects.toThrow(/40[34]/);
  });

  it('sends the latest frame immediately on connect, then streams new frames', async () => {
    startLive();
    await waitFor(() => h.ctx.live.latest() !== null, { message: 'no live frame from the fake helper' });
    let first: Promise<Buffer> | null = null;
    const ws = await h.local.app.injectWS(
      '/ws/screen',
      { headers: { cookie, origin: LOCAL_ORIGIN, host: LOCAL_HOST } },
      {
        onInit: (socket) => {
          first = nextBinary(socket);
        },
      },
    );
    const { header, jpeg } = decodeLiveFrameMessage(await first!);
    expect(header).toMatchObject({
      mimeType: 'image/jpeg',
      source: 'screencapturekit',
      widthPx: 730,
      heightPx: 1600,
      pxPerPt: 1.7805,
      // The harness device has no Mirroir geometry, so none is attached.
      geometry: null,
    });
    expect(header.receivedAt).toBeGreaterThanOrEqual(header.capturedAt);
    expect(jpeg.length).toBe(2048);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);

    const seqs: number[] = [header.seq];
    ws.on('message', (data) => seqs.push(decodeLiveFrameMessage(data as Buffer).header.seq));
    await waitFor(() => seqs.length >= 6, { message: 'frames were not streamed' });
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    ws.terminate();
  });

  it('streams to remote sessions too (view-only sessions may watch)', async () => {
    await h.setPasscode();
    h.ctx.settings.mutate((draft) => {
      draft.remote.enabled = true;
      draft.remote.bindAddress = REMOTE_ADDRESS;
    });
    const remote = h.remoteServer();
    const remoteCookie = await loginRemote(h, remote);
    startLive();
    const ws = await remote.app.injectWS('/ws/screen', { headers: { cookie: remoteCookie, origin: `http://${REMOTE_HOST}`, host: REMOTE_HOST } });
    const received: number[] = [];
    const started = Date.now();
    ws.on('message', (data) => received.push(decodeLiveFrameMessage(data as Buffer).header.seq));
    await waitFor(() => received.length >= 3, { message: 'no frames on the remote listener' });
    await sleep(1000);
    const elapsed = (Date.now() - started) / 1000;
    // The fake helper produces 30 fps; remote viewers get at most 10.
    expect(received.length / elapsed).toBeLessThanOrEqual(REMOTE_SCREEN_MAX_FPS + 1);
    ws.terminate();
  });

  it('GET /api/screen/frame/latest serves the newer of the live JPEG and the polled PNG', async () => {
    const none = await h.local.app.inject({ method: 'GET', url: '/api/screen/frame/latest', headers: localHeaders(cookie) });
    expect(none.statusCode).toBe(404);

    startLive();
    await waitFor(() => h.ctx.live.latest() !== null);
    const liveRes = await h.local.app.inject({ method: 'GET', url: '/api/screen/frame/latest', headers: localHeaders(cookie) });
    expect(liveRes.statusCode).toBe(200);
    expect(liveRes.headers['content-type']).toBe('image/jpeg');
    expect(liveRes.headers['x-frame-source']).toBe('screencapturekit');
    expect(Number(liveRes.headers['x-frame-seq'])).toBeGreaterThan(0);

    const png = Buffer.from('polled png');
    h.fakes.device.getLatestFrame.mockReturnValue({ meta: { seq: 1_000_000, mimeType: 'image/png', source: 'mirroir-screenshot' }, data: png });
    const polledRes = await h.local.app.inject({ method: 'GET', url: '/api/screen/frame/latest', headers: localHeaders(cookie) });
    expect(polledRes.headers['content-type']).toBe('image/png');
    expect(polledRes.headers['x-frame-source']).toBe('mirroir-screenshot');
    expect(polledRes.headers['x-frame-seq']).toBe('1000000');
    expect(polledRes.rawPayload.equals(png)).toBe(true);
  });
});
