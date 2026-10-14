// Live frames over GET /ws/screen (same origin, same cookie session as /ws).
//
// The backend relays JPEG frames that its ScreenCaptureKit helper captures
// from the iPhone Mirroring window — no Mirroir calls, so the device lane stays
// free for actions. Each binary message is
//
//   [4-byte big-endian uint32 H][H bytes UTF-8 JSON header][JPEG bytes]
//
// with a FrameMeta-like header (LiveFrameHeader in @iphone-ai/shared: seq,
// capturedAt, receivedAt, latencyMs, widthPx, heightPx, mimeType, pxPerPt,
// geometry, source: 'screencapturekit'). `geometry` is non-null only when the
// captured window size matches Mirroir's current geometry, so touch mapping
// (lib/geometry.ts) works exactly like it does for polled screenshots. Live and
// polled frames share one sequence space.
//
// - Connects only while a PhoneViewer is mounted, the page is visible, live
//   capture is enabled and the backend reports it available; reconnects with
//   backoff.
// - Decodes off the main thread with createImageBitmap. While a decode is
//   pending, newer frames replace the one waiting (latest wins, never a queue).
// - Frames go straight to subscribed canvases (no React render per frame);
//   React reads a throttled snapshot: the frame shape (size, scale, geometry),
//   whether frames are flowing (one shown in the last 2 s), client-measured
//   fps and latency.

import { WS_SCREEN_PATH, type FrameMeta, type WindowGeometry } from '@iphone-ai/shared';
import { useSyncExternalStore } from 'react';

import { appStore, type StoreState } from '../state/store';
import { backoffDelay } from './ws';

/** Live frames count as flowing while one was shown within this window; otherwise polled frames take over. */
export const LIVE_FRESH_MS = 2000;
/** fps and latency are measured over this window. */
export const STATS_WINDOW_MS = 2000;
/** How often the React snapshot refreshes its numbers while frames flow. */
export const STATS_PUBLISH_MS = 500;
const MAX_HEADER_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface ScreenMessage {
  /** The frame's metadata (`source: 'screencapturekit'`, `receivedAt` set; times are the Mac's clock). */
  meta: FrameMeta;
  jpeg: Uint8Array<ArrayBuffer>;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseGeometry(value: unknown): WindowGeometry | null {
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;
  const widthPt = g['widthPt'];
  const heightPt = g['heightPt'];
  const geometryId = g['geometryId'];
  if (!isFiniteNumber(widthPt) || !isFiniteNumber(heightPt) || widthPt <= 0 || heightPt <= 0) return null;
  if (typeof geometryId !== 'string' || geometryId.length === 0) return null;
  const declared = g['orientation'];
  const orientation = declared === 'landscape' || declared === 'portrait' ? declared : widthPt > heightPt ? 'landscape' : 'portrait';
  const observedAt = g['observedAt'];
  return { widthPt, heightPt, orientation, geometryId, observedAt: isFiniteNumber(observedAt) ? observedAt : 0 };
}

/** Validates a /ws/screen header into FrameMeta (null when a required field is missing). */
export function parseFrameHeader(value: unknown): FrameMeta | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const h = value as Record<string, unknown>;
  const { seq, capturedAt, receivedAt, latencyMs, widthPx, heightPx, pxPerPt, mimeType } = h;
  if (!isFiniteNumber(seq) || seq < 0) return null;
  if (!isFiniteNumber(capturedAt) || capturedAt <= 0) return null;
  if (!isFiniteNumber(widthPx) || !isFiniteNumber(heightPx) || widthPx <= 0 || heightPx <= 0) return null;
  const received = isFiniteNumber(receivedAt) ? receivedAt : capturedAt;
  return {
    seq,
    capturedAt,
    latencyMs: isFiniteNumber(latencyMs) && latencyMs >= 0 ? latencyMs : Math.max(0, received - capturedAt),
    widthPx,
    heightPx,
    mimeType: typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg',
    pxPerPt: isFiniteNumber(pxPerPt) && pxPerPt > 0 ? pxPerPt : null,
    geometry: parseGeometry(h['geometry']),
    source: 'screencapturekit',
    receivedAt: received,
  };
}

/** Splits one /ws/screen binary message into its header and JPEG bytes (null when malformed). */
export function parseScreenMessage(data: unknown): ScreenMessage | null {
  let buffer: ArrayBuffer;
  let offset = 0;
  let length: number;
  if (data instanceof ArrayBuffer) {
    buffer = data;
    length = data.byteLength;
  } else if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) {
    buffer = data.buffer;
    offset = data.byteOffset;
    length = data.byteLength;
  } else {
    return null;
  }
  if (length < 5) return null;
  const headerLength = new DataView(buffer, offset, 4).getUint32(0, false);
  // At least one JPEG byte must follow the header.
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || 4 + headerLength >= length) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 4, headerLength)));
  } catch {
    return null;
  }
  const meta = parseFrameHeader(json);
  if (!meta) return null;
  const jpegStart = offset + 4 + headerLength;
  return { meta, jpeg: new Uint8Array(buffer, jpegStart, offset + length - jpegStart) };
}

export function screenWsUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${WS_SCREEN_PATH}`;
}

// ---------------------------------------------------------------------------
// Client-side numbers
// ---------------------------------------------------------------------------

/**
 * Frames per second shown over the last `windowMs`, from display times
 * (client clock). Uses the span from the oldest frame in the window to `now`,
 * so the number drops as soon as frames stop arriving.
 */
export function measureFps(times: readonly number[], now: number, windowMs: number = STATS_WINDOW_MS): number {
  let count = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const t of times) {
    if (t <= now - windowMs || t > now) continue;
    count += 1;
    if (t < oldest) oldest = t;
  }
  if (count < 2) return (count * 1000) / windowMs;
  // A floor on the span keeps a burst (two frames decoded back to back) from reading as hundreds of fps.
  return ((count - 1) * 1000) / Math.max(now - oldest, 50);
}

/**
 * Capture-to-display latency of one frame. On the Mac itself (same clock as
 * the backend) it is `now − capturedAt`; a remote device's clock may be skewed,
 * so there it is the backend's `receivedAt − capturedAt`.
 */
export function frameLatencyMs(meta: Pick<FrameMeta, 'capturedAt' | 'receivedAt'>, clientNow: number, sameClock: boolean): number {
  return Math.max(0, (sameClock ? clientNow : (meta.receivedAt ?? meta.capturedAt)) - meta.capturedAt);
}

/** Mean of the samples taken within the window, or null when there are none. */
export function averageWithin(samples: readonly { at: number; value: number }[], now: number, windowMs: number = STATS_WINDOW_MS): number | null {
  let sum = 0;
  let count = 0;
  for (const s of samples) {
    if (s.at <= now - windowMs || s.at > now) continue;
    sum += s.value;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

/** Whether a viewer should hold a /ws/screen connection right now. */
export function shouldConnectLive(state: StoreState, pageVisible: boolean): boolean {
  if (!pageVisible || state.ui.viewers === 0 || state.boot !== 'ready') return false;
  if (state.settings?.connection.screenshot.liveCapture === false) return false;
  if (state.stream?.liveAvailable === false) return false;
  return true;
}

/**
 * Which picture the viewer shows: live frames while they flow; otherwise the
 * polled screenshot — unless the last live frame is newer than it (both
 * capture times come from the Mac's clock), so falling back never jumps back
 * in time.
 */
export function chooseFrameSource(live: { flowing: boolean; capturedAt: number | null; hasFrame: boolean }, polled: { capturedAt: number | null; hasFrame: boolean }): 'live' | 'polled' | null {
  if (live.hasFrame && live.flowing) return 'live';
  if (!polled.hasFrame) return live.hasFrame ? 'live' : null;
  if (!live.hasFrame) return 'polled';
  if (live.capturedAt !== null && (polled.capturedAt === null || live.capturedAt > polled.capturedAt)) return 'live';
  return 'polled';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type LiveSocketState = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface LiveView {
  /** Meta of the first frame with this shape; the identity is stable while size, scale and geometry stay the same. */
  meta: FrameMeta;
  /** Decoded bitmap size (the canvas' intrinsic size). */
  width: number;
  height: number;
}

export interface LiveScreenState {
  socket: LiveSocketState;
  view: LiveView | null;
  /** A live frame was shown within the last LIVE_FRESH_MS. */
  flowing: boolean;
  /** Measured on this device over the last 2 s. */
  fps: number;
  latencyMs: number | null;
  /** Client clock when the latest live frame was shown. */
  lastFrameAt: number | null;
  /** Mac clock when the latest live frame was captured. */
  lastCapturedAt: number | null;
}

export interface LiveFrame {
  meta: FrameMeta;
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Frees the decoded bitmap once it has been replaced. */
  release: () => void;
}

export type FrameDecoder = (jpeg: Uint8Array<ArrayBuffer>, mimeType: string) => Promise<DecodedImage>;

/** The parts of a WebSocket the client uses (a fake in tests). */
export interface SocketLike {
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface LiveScreenDeps {
  createSocket: (url: string) => SocketLike;
  decode: FrameDecoder;
  now: () => number;
  isPageVisible: () => boolean;
  url: () => string;
}

/** createImageBitmap where available (off the main thread); an <img> decode otherwise. */
export const decodeJpeg: FrameDecoder = async (jpeg, mimeType) => {
  const blob = new Blob([jpeg], { type: mimeType });
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, release: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
};

function defaultDeps(): LiveScreenDeps {
  return {
    createSocket: (url) => new WebSocket(url),
    decode: decodeJpeg,
    now: () => Date.now(),
    isPageVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    url: () => screenWsUrl(),
  };
}

const INITIAL_STATE: LiveScreenState = {
  socket: 'idle',
  view: null,
  flowing: false,
  fps: 0,
  latencyMs: null,
  lastFrameAt: null,
  lastCapturedAt: null,
};

function sameShape(view: LiveView | null, frame: LiveFrame): view is LiveView {
  if (!view) return false;
  const a = view.meta;
  const b = frame.meta;
  return (
    view.width === frame.width &&
    view.height === frame.height &&
    a.widthPx === b.widthPx &&
    a.heightPx === b.heightPx &&
    a.pxPerPt === b.pxPerPt &&
    (a.geometry?.geometryId ?? null) === (b.geometry?.geometryId ?? null)
  );
}

export class LiveScreenClient {
  private deps: LiveScreenDeps;
  private state: LiveScreenState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly frameListeners = new Set<(frame: LiveFrame) => void>();
  private frame: LiveFrame | null = null;
  private releaseFrame: (() => void) | null = null;
  private socket: SocketLike | null = null;
  private started = false;
  private attempts = 0;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private decoding = false;
  private waiting: ScreenMessage | null = null;
  private samples: { at: number; value: number }[] = [];
  private lastShown: { seq: number; capturedAt: number; at: number } | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(deps: Partial<LiveScreenDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** Replaces dependencies (tests). */
  configure(deps: Partial<LiveScreenDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** Follows the store and page visibility, connecting while a viewer needs live frames (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.cleanups.push(appStore.subscribe(() => this.evaluate()));
    if (typeof document !== 'undefined') {
      const onVisibility = () => this.evaluate();
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    this.evaluate();
  }

  stop(): void {
    this.started = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.disconnect();
  }

  /** Stops and forgets every frame and number (tests). */
  reset(): void {
    this.stop();
    this.generation += 1;
    for (const timer of [this.staleTimer, this.publishTimer]) if (timer) clearTimeout(timer);
    this.staleTimer = null;
    this.publishTimer = null;
    this.releaseFrame?.();
    this.releaseFrame = null;
    this.frame = null;
    this.decoding = false;
    this.waiting = null;
    this.samples = [];
    this.lastShown = null;
    this.state = INITIAL_STATE;
    this.emit();
  }

  getState = (): LiveScreenState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The latest decoded frame (stays valid until the next one replaces it). */
  getFrame = (): LiveFrame | null => this.frame;

  /** Called synchronously with every new frame (for canvases; no React render per frame). */
  subscribeFrames = (listener: (frame: LiveFrame) => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  /** Handles one /ws/screen message (the socket calls this; tests may too). */
  receive(data: unknown): void {
    const message = parseScreenMessage(data);
    if (!message) return;
    if (this.decoding) {
      // Latest wins: at most one frame waits for the decoder, older ones are dropped.
      this.waiting = message;
      return;
    }
    void this.decodeAndShow(message);
  }

  // --- connection ----------------------------------------------------------

  private evaluate(): void {
    const wanted = this.started && shouldConnectLive(appStore.getState(), this.deps.isPageVisible());
    if (wanted) {
      if (!this.socket && !this.reconnectTimer) this.connect();
    } else if (this.socket || this.reconnectTimer) {
      this.disconnect();
    }
  }

  private connect(): void {
    this.setState({ socket: this.attempts === 0 ? 'connecting' : 'reconnecting' });
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(this.deps.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.setState({ socket: 'open' });
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => {
      // onclose follows.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setState({ socket: 'reconnecting' });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started) {
      this.setState({ socket: 'idle' });
      return;
    }
    const delay = backoffDelay(this.attempts);
    this.attempts += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.evaluate();
    }, delay);
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempts = 0;
    this.waiting = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, 'viewer hidden');
      } catch {
        // already closed
      }
    }
    this.setState({ socket: 'idle' });
  }

  // --- frames --------------------------------------------------------------

  private async decodeAndShow(message: ScreenMessage): Promise<void> {
    const generation = this.generation;
    this.decoding = true;
    try {
      let decoded: DecodedImage;
      try {
        decoded = await this.deps.decode(message.jpeg, message.meta.mimeType);
      } catch {
        return; // a frame that cannot be decoded is skipped
      }
      if (generation !== this.generation) {
        decoded.release();
        return;
      }
      this.show(message.meta, decoded);
    } finally {
      if (generation === this.generation) {
        this.decoding = false;
        const next = this.waiting;
        this.waiting = null;
        if (next) void this.decodeAndShow(next);
      }
    }
  }

  private show(meta: FrameMeta, decoded: DecodedImage): void {
    const last = this.lastShown;
    // In order on one socket; after a reconnect the server re-sends its latest frame.
    if (last && (meta.capturedAt < last.capturedAt || (meta.capturedAt === last.capturedAt && meta.seq === last.seq))) {
      decoded.release();
      return;
    }
    const now = this.deps.now();
    const frame: LiveFrame = { meta, image: decoded.image, width: decoded.width, height: decoded.height };
    const previousRelease = this.releaseFrame;
    this.frame = frame;
    this.releaseFrame = decoded.release;
    this.lastShown = { seq: meta.seq, capturedAt: meta.capturedAt, at: now };
    for (const listener of [...this.frameListeners]) {
      try {
        listener(frame);
      } catch {
        // one broken canvas must not stop the others
      }
    }
    // Every canvas has drawn the new frame; the previous bitmap is no longer needed.
    previousRelease?.();

    const sameClock = !(appStore.getState().session?.remote ?? false);
    this.samples.push({ at: now, value: frameLatencyMs(meta, now, sameClock) });
    while (this.samples.length > 0 && this.samples[0]!.at <= now - STATS_WINDOW_MS) this.samples.shift();

    const view = sameShape(this.state.view, frame) ? this.state.view : { meta, width: frame.width, height: frame.height };
    if (this.staleTimer) clearTimeout(this.staleTimer);
    // A little past the window so the check below sees the frame as no longer fresh.
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.publish();
    }, LIVE_FRESH_MS + 20);

    if (view !== this.state.view || !this.state.flowing) {
      this.publish(view);
    } else if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.publish();
      }, STATS_PUBLISH_MS);
    }
  }

  private publish(view: LiveView | null = this.state.view): void {
    const now = this.deps.now();
    const last = this.lastShown;
    const flowing = Boolean(last && now - last.at < LIVE_FRESH_MS);
    this.setState({
      view,
      flowing,
      fps: flowing ? measureFps(this.samples.map((s) => s.at), now) : 0,
      latencyMs: flowing ? averageWithin(this.samples, now) : null,
      lastFrameAt: last?.at ?? null,
      lastCapturedAt: last?.capturedAt ?? null,
    });
  }

  private setState(patch: Partial<LiveScreenState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof LiveScreenState)[]) {
      if (!Object.is(this.state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const liveScreen = new LiveScreenClient();

/** Starts the live-frame link (idempotent); returns a stop function. */
export function startLiveScreen(): () => void {
  liveScreen.start();
  return () => liveScreen.stop();
}

export function useLiveScreen(): LiveScreenState {
  return useSyncExternalStore(liveScreen.subscribe, liveScreen.getState, liveScreen.getState);
}
