import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appStore, reduceBootstrap, registerViewer, resetStoreForTests } from '../state/store';
import { encodeScreenMessage, makeBootstrap, makeLiveHeader, makeSettings, makeStream } from '../test/fixtures';
import {
  averageWithin,
  chooseFrameSource,
  frameLatencyMs,
  LiveScreenClient,
  measureFps,
  parseScreenMessage,
  screenWsUrl,
  shouldConnectLive,
  type DecodedImage,
  type FrameDecoder,
  type LiveFrame,
  type SocketLike,
} from './live-screen';

const JPEG = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

describe('parseScreenMessage', () => {
  it('splits the header and the JPEG bytes and builds FrameMeta', () => {
    const parsed = parseScreenMessage(encodeScreenMessage(makeLiveHeader(7), JPEG));
    expect(parsed).not.toBeNull();
    expect(parsed!.meta).toEqual({
      seq: 7,
      capturedAt: 100_007,
      latencyMs: 5,
      widthPx: 820,
      heightPx: 1780,
      mimeType: 'image/jpeg',
      pxPerPt: 2,
      geometry: { widthPt: 410, heightPt: 890, orientation: 'portrait', geometryId: '410x890', observedAt: 1_000 },
      source: 'screencapturekit',
      receivedAt: 100_012,
    });
    expect([...parsed!.jpeg]).toEqual([...JPEG]);
  });

  it('reads a view into a larger buffer (non-zero offset)', () => {
    const message = new Uint8Array(encodeScreenMessage(makeLiveHeader(3), JPEG));
    const big = new Uint8Array(message.length + 16);
    big.set(message, 9);
    const parsed = parseScreenMessage(big.subarray(9, 9 + message.length));
    expect(parsed?.meta.seq).toBe(3);
    expect([...parsed!.jpeg]).toEqual([...JPEG]);
  });

  it('keeps geometry null when the window does not match Mirroir (touches stay off)', () => {
    expect(parseScreenMessage(encodeScreenMessage(makeLiveHeader(1, { geometry: null })))?.meta.geometry).toBeNull();
    expect(parseScreenMessage(encodeScreenMessage(makeLiveHeader(1, { geometry: { widthPt: 410 } })))?.meta.geometry).toBeNull();
  });

  it('derives latency from receivedAt when the header has none', () => {
    const header = makeLiveHeader(2, { latencyMs: undefined, capturedAt: 1_000, receivedAt: 1_042 });
    expect(parseScreenMessage(encodeScreenMessage(header))?.meta.latencyMs).toBe(42);
  });

  it('rejects malformed messages', () => {
    const valid = new Uint8Array(encodeScreenMessage(makeLiveHeader(1)));
    expect(parseScreenMessage('text frame')).toBeNull();
    expect(parseScreenMessage(new ArrayBuffer(3))).toBeNull();
    // Header length points past the end / leaves no JPEG bytes.
    const tooLong = valid.slice();
    new DataView(tooLong.buffer).setUint32(0, valid.length, false);
    expect(parseScreenMessage(tooLong.buffer)).toBeNull();
    expect(parseScreenMessage(encodeScreenMessage(makeLiveHeader(1), new Uint8Array(0)))).toBeNull();
    // Zero-length header, invalid JSON, missing required fields.
    expect(parseScreenMessage(new Uint8Array([0, 0, 0, 0, 0xff]).buffer)).toBeNull();
    const badJson = new TextEncoder().encode('{nope');
    const bad = new Uint8Array(4 + badJson.length + 1);
    new DataView(bad.buffer).setUint32(0, badJson.length, false);
    bad.set(badJson, 4);
    expect(parseScreenMessage(bad.buffer)).toBeNull();
    expect(parseScreenMessage(encodeScreenMessage(makeLiveHeader(1, { seq: 'x' })))).toBeNull();
    expect(parseScreenMessage(encodeScreenMessage(makeLiveHeader(1, { widthPx: 0 })))).toBeNull();
    expect(parseScreenMessage(encodeScreenMessage(makeLiveHeader(1, { capturedAt: null })))).toBeNull();
    expect(parseScreenMessage(encodeScreenMessage([1, 2, 3]))).toBeNull();
  });

  it('builds the same-origin URL', () => {
    expect(screenWsUrl({ protocol: 'http:', host: '127.0.0.1:47823' })).toBe('ws://127.0.0.1:47823/ws/screen');
    expect(screenWsUrl({ protocol: 'https:', host: 'mac.tailnet:47824' })).toBe('wss://mac.tailnet:47824/ws/screen');
  });
});

describe('client-side numbers', () => {
  it('measures fps over the last 2 s and drops when frames stop', () => {
    const times = Array.from({ length: 61 }, (_, i) => 10_000 + i * (1000 / 30));
    const last = times[times.length - 1]!;
    expect(measureFps(times, last)).toBeCloseTo(30, 0);
    // Frames stopped one second ago: half the rate.
    expect(measureFps(times, last + 1000)).toBeLessThan(16);
    expect(measureFps(times, last + 2500)).toBe(0);
    expect(measureFps([], 5_000)).toBe(0);
    expect(measureFps([4_000], 5_000)).toBe(0.5);
    // Two frames decoded back to back do not read as hundreds of fps.
    expect(measureFps([5_000, 5_001], 5_001)).toBe(20);
  });

  it('computes latency on the Mac clock locally and from the backend timestamps remotely', () => {
    expect(frameLatencyMs({ capturedAt: 1_000, receivedAt: 1_010 }, 1_045, true)).toBe(45);
    expect(frameLatencyMs({ capturedAt: 1_000, receivedAt: 1_010 }, 99_999, false)).toBe(10);
    expect(frameLatencyMs({ capturedAt: 1_000, receivedAt: 1_010 }, 900, true)).toBe(0);
  });

  it('averages samples inside the window', () => {
    const samples = [
      { at: 1_000, value: 100 },
      { at: 3_500, value: 40 },
      { at: 4_000, value: 50 },
    ];
    expect(averageWithin(samples, 4_000)).toBe(45);
    expect(averageWithin(samples, 10_000)).toBeNull();
  });
});

describe('chooseFrameSource', () => {
  it('shows live frames while they flow', () => {
    expect(chooseFrameSource({ flowing: true, capturedAt: 10, hasFrame: true }, { capturedAt: 50, hasFrame: true })).toBe('live');
  });

  it('falls back to the polled screenshot when live frames stop and it is newer', () => {
    expect(chooseFrameSource({ flowing: false, capturedAt: 10, hasFrame: true }, { capturedAt: 50, hasFrame: true })).toBe('polled');
    expect(chooseFrameSource({ flowing: false, capturedAt: null, hasFrame: false }, { capturedAt: 50, hasFrame: true })).toBe('polled');
  });

  it('never jumps back in time to an older polled screenshot', () => {
    expect(chooseFrameSource({ flowing: false, capturedAt: 90, hasFrame: true }, { capturedAt: 50, hasFrame: true })).toBe('live');
    expect(chooseFrameSource({ flowing: false, capturedAt: 90, hasFrame: true }, { capturedAt: null, hasFrame: true })).toBe('live');
    expect(chooseFrameSource({ flowing: false, capturedAt: 90, hasFrame: true }, { capturedAt: null, hasFrame: false })).toBe('live');
    expect(chooseFrameSource({ flowing: false, capturedAt: null, hasFrame: false }, { capturedAt: null, hasFrame: false })).toBeNull();
  });
});

describe('shouldConnectLive', () => {
  beforeEach(() => resetStoreForTests());

  it('needs a visible viewer, a ready app, live capture on and available', () => {
    appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ stream: makeStream({ liveAvailable: true }) })));
    expect(shouldConnectLive(appStore.getState(), true)).toBe(false); // no viewer mounted
    const unregister = registerViewer();
    expect(shouldConnectLive(appStore.getState(), true)).toBe(true);
    expect(shouldConnectLive(appStore.getState(), false)).toBe(false);
    appStore.setState({ stream: makeStream({ liveAvailable: false }) });
    expect(shouldConnectLive(appStore.getState(), true)).toBe(false);
    appStore.setState({ stream: makeStream({ liveAvailable: true }), settings: makeSettings((x) => (x.connection.screenshot.liveCapture = false)) });
    expect(shouldConnectLive(appStore.getState(), true)).toBe(false);
    appStore.setState({ settings: makeSettings(), boot: 'unauthorized' });
    expect(shouldConnectLive(appStore.getState(), true)).toBe(false);
    unregister();
  });
});

// ---------------------------------------------------------------------------
// LiveScreenClient
// ---------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.(new Event('open'));
  }
  send(data: ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
  drop(): void {
    this.closed = true;
    this.onclose?.(new CloseEvent('close'));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function decoded(width = 820, height = 1780) {
  return { image: {} as CanvasImageSource, width, height, release: vi.fn<() => void>() };
}

describe('LiveScreenClient', () => {
  let sockets: FakeSocket[];
  let visible: boolean;

  beforeEach(() => {
    resetStoreForTests();
    appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ stream: makeStream({ liveAvailable: true }) })));
    sockets = [];
    visible = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStoreForTests();
  });

  const makeClient = (decode: FrameDecoder = async () => decoded()) =>
    new LiveScreenClient({
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      decode,
      isPageVisible: () => visible,
      url: () => 'ws://127.0.0.1:47823/ws/screen',
    });

  it('connects only while a viewer is mounted, visible and live capture is available', () => {
    const client = makeClient();
    client.start();
    expect(sockets).toHaveLength(0);

    const unregister = registerViewer();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://127.0.0.1:47823/ws/screen');
    expect(sockets[0]!.binaryType).toBe('arraybuffer');
    expect(client.getState().socket).toBe('connecting');
    sockets[0]!.open();
    expect(client.getState().socket).toBe('open');

    appStore.setState({ stream: makeStream({ liveAvailable: false }) });
    expect(sockets[0]!.closed).toBe(true);
    expect(client.getState().socket).toBe('idle');

    appStore.setState({ stream: makeStream({ liveAvailable: true }) });
    expect(sockets).toHaveLength(2);

    visible = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sockets[1]!.closed).toBe(true);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sockets).toHaveLength(3);

    unregister();
    expect(sockets[2]!.closed).toBe(true);
    client.stop();
  });

  it('reconnects with backoff after the socket drops', () => {
    vi.useFakeTimers();
    const client = makeClient();
    client.start();
    const unregister = registerViewer();
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(client.getState().socket).toBe('reconnecting');
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(650); // first retry: 0.5 s + jitter
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop();
    vi.advanceTimersByTime(900);
    expect(sockets).toHaveLength(2); // second retry waits ~1 s
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(3);
    // A successful open resets the backoff.
    sockets[2]!.open();
    sockets[2]!.drop();
    vi.advanceTimersByTime(650);
    expect(sockets).toHaveLength(4);
    unregister();
    client.stop();
  });

  it('decodes one frame at a time and drops stale ones (latest wins, never a queue)', async () => {
    const resolvers: ((value: DecodedImage) => void)[] = [];
    const decodedBytes: number[] = [];
    const decode = vi.fn(
      (jpeg: Uint8Array) =>
        new Promise<DecodedImage>((resolve) => {
          decodedBytes.push(jpeg[0]!);
          resolvers.push(resolve);
        }),
    );
    const client = makeClient(decode);
    const shown: number[] = [];
    client.subscribeFrames((frame: LiveFrame) => shown.push(frame.meta.seq));

    client.receive(encodeScreenMessage(makeLiveHeader(1), new Uint8Array([1])));
    client.receive(encodeScreenMessage(makeLiveHeader(2), new Uint8Array([2])));
    client.receive(encodeScreenMessage(makeLiveHeader(3), new Uint8Array([3])));
    client.receive(encodeScreenMessage(makeLiveHeader(4), new Uint8Array([4])));
    expect(decode).toHaveBeenCalledTimes(1);

    const first = decoded();
    resolvers[0]!(first);
    await flush();
    expect(shown).toEqual([1]);
    // Frames 2 and 3 were replaced while waiting; only the newest is decoded next.
    expect(decodedBytes).toEqual([1, 4]);

    const second = decoded();
    resolvers[1]!(second);
    await flush();
    expect(shown).toEqual([1, 4]);
    expect(first.release).toHaveBeenCalledTimes(1); // replaced bitmap freed after drawing
    expect(second.release).not.toHaveBeenCalled();
    expect(client.getFrame()?.meta.seq).toBe(4);
  });

  it('ignores an older frame or the same frame re-sent after a reconnect', async () => {
    const client = makeClient();
    const shown: number[] = [];
    client.subscribeFrames((frame) => shown.push(frame.meta.seq));
    client.receive(encodeScreenMessage(makeLiveHeader(5)));
    await flush();
    client.receive(encodeScreenMessage(makeLiveHeader(5)));
    await flush();
    client.receive(encodeScreenMessage(makeLiveHeader(4)));
    await flush();
    client.receive(encodeScreenMessage(makeLiveHeader(6)));
    await flush();
    expect(shown).toEqual([5, 6]);
  });

  it('skips frames that fail to decode and keeps going', async () => {
    const decode = vi.fn(async (jpeg: Uint8Array) => {
      if (jpeg[0] === 0) throw new Error('corrupt');
      return decoded();
    });
    const client = makeClient(decode);
    client.receive(encodeScreenMessage(makeLiveHeader(1), new Uint8Array([0])));
    await flush();
    expect(client.getFrame()).toBeNull();
    client.receive(encodeScreenMessage(makeLiveHeader(2), new Uint8Array([1])));
    await flush();
    expect(client.getFrame()?.meta.seq).toBe(2);
  });

  it('measures fps and latency client-side and stops counting as live 2 s after the last frame', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const client = makeClient();
    const states: boolean[] = [];
    client.subscribe(() => states.push(client.getState().flowing));

    for (let i = 0; i < 31; i += 1) {
      const now = Date.now();
      client.receive(encodeScreenMessage(makeLiveHeader(10 + i, { capturedAt: now - 40, receivedAt: now - 30 })));
      await flush();
      vi.advanceTimersByTime(i === 30 ? 0 : 33);
    }
    vi.advanceTimersByTime(500);
    let state = client.getState();
    expect(state.flowing).toBe(true);
    expect(state.fps).toBeGreaterThan(25);
    expect(state.fps).toBeLessThanOrEqual(31);
    expect(state.latencyMs).toBe(40); // the Mac's own clock: now − capturedAt
    expect(state.view).toMatchObject({ width: 820, height: 1780, meta: { pxPerPt: 2, geometry: { geometryId: '410x890' } } });
    const view = state.view;

    vi.advanceTimersByTime(1600);
    state = client.getState();
    expect(state.flowing).toBe(false);
    expect(state.fps).toBe(0);
    expect(state.latencyMs).toBeNull();
    // The shape is kept (same identity), so the last frame can still be shown and touched.
    expect(state.view).toBe(view);
    expect(states[0]).toBe(true);
  });

  it('uses the backend timestamps for latency on a remote device', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    appStore.setState({ session: { id: 's', kind: 'remote', canControl: false, remote: true } });
    const client = makeClient();
    client.receive(encodeScreenMessage(makeLiveHeader(1, { capturedAt: 50, receivedAt: 62 })));
    await flush();
    expect(client.getState().latencyMs).toBe(12);
  });

  it('starts a new view when the frame shape changes (rotation, new window size)', async () => {
    const decode = vi.fn(async (jpeg: Uint8Array) => (jpeg[0] === 2 ? decoded(1780, 820) : decoded()));
    const client = makeClient(decode);
    client.receive(encodeScreenMessage(makeLiveHeader(1), new Uint8Array([1])));
    await flush();
    const first = client.getState().view;
    client.receive(encodeScreenMessage(makeLiveHeader(2), new Uint8Array([1])));
    await flush();
    expect(client.getState().view).toBe(first);
    const landscape = { widthPt: 890, heightPt: 410, orientation: 'landscape', geometryId: '890x410', observedAt: 2 };
    client.receive(encodeScreenMessage(makeLiveHeader(3, { widthPx: 1780, heightPx: 820, geometry: landscape }), new Uint8Array([2])));
    await flush();
    expect(client.getState().view).not.toBe(first);
    expect(client.getState().view).toMatchObject({ width: 1780, height: 820, meta: { seq: 3, geometry: { geometryId: '890x410' } } });
  });
});
