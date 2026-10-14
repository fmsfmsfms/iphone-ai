// Live view of the iPhone Mirroring window through the bundled ScreenCaptureKit
// helper (`iphone-ai-capture`, Swift). Unlike Mirroir's `screenshot` tool —
// a full PNG over MCP stdio that occupies Mirroir's single serial lane — the
// helper sends JPEG frames on its stdout and never touches Mirroir, so the
// lane stays free for actions while the viewer is live. It takes single
// window screenshots (at most MAX_LIVE_FPS per second), not a continuous
// stream: starting a stream makes iPhone Mirroring add overlay UI that
// Mirroir 0.40.1 reads as "Paused", which blocks all control.
//
// Helper protocol (stdout): a sequence of messages, each
//   [4-byte BE uint32 N = length of the rest][1 byte type][N-1 bytes payload]
//   type 0x01 STATUS  UTF-8 JSON {event, message?, code?, ptW?, ptH?, pxW?, pxH?}
//   type 0x02 FRAME   [4-byte BE uint32 H][H bytes UTF-8 JSON {seq, ts, ptW, ptH, pxW, pxH}][JPEG]
// stdin: JSON lines {"cmd":"config",…} / {"cmd":"stop"}; EOF or SIGTERM stops it.
// The helper captures exactly what Mirroir's screenshot captures (the window
// via SCContentFilter(desktopIndependentWindow:)), so window points match
// Mirroir's tap coordinates. It never activates apps or posts input, so —
// unlike Mirroir's screenshot — it may run while Mirroring is paused.
//
// Lifecycle: the helper runs while a viewer is visible or an AI task /
// workflow holds control, live capture is enabled, Screen Recording is
// confirmed and iPhone Mirroring is running (connected or paused). It stops
// 10 s after the last of those goes false. Errors, exits and stalls restart it
// with backoff; meanwhile ScreenStream polling (which pauses only while live
// frames are actually arriving) keeps the viewer updated.
//
// Conflict safety latch: when Mirroir's state goes from connected to paused
// while the helper is capturing, the helper is stopped and kept stopped for a
// short probe. If Mirroir reports connected again within conflictProbeMs of
// the helper exiting, capture itself caused the "pause": live capture stays
// off for this backend session (ScreenStream polls Mirroir screenshots
// instead) until the live capture switch or frame rate is changed. If the
// pause persists, or the user's Resume (a capture with resume allowed) ended
// it, it was genuine and the normal rules apply again. The latch
// only ever stops capture; every input gate keeps using Mirroir's state.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LIVE_FPS,
  LIVE_CONFLICT_ERROR,
  MAX_LIVE_FPS,
  MIN_LIVE_FPS,
  type ActivitySeverity,
  type DeviceStatus,
  type LiveFrameHeader,
  type MirroringState,
  type WindowGeometry,
} from '@iphone-ai/shared';

import type { EventHub } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import type { SettingsStore } from '../core/settings-store.js';

/** Bundle id of Apple's iPhone Mirroring app (the window the helper captures). */
export const MIRRORING_BUNDLE_ID = 'com.apple.ScreenContinuity';
export const LIVE_MAX_LONG_EDGE = 1600;
export const LIVE_JPEG_QUALITY = 0.7;
/** ScreenStream polling pauses while a live frame arrived within this window. */
export const LIVE_WINDOW_MS = 2000;
export const LIVE_ACTIVE_REASON = 'Live capture active';
/** Why the helper is not started while the conflict latch is set. */
export const LIVE_CONFLICT_REASON = 'live view turned off: it made Mirroir report iPhone Mirroring as paused';

const MSG_STATUS = 0x01;
const MSG_FRAME = 0x02;
/** Upper bound for one helper message (a 1600-px JPEG is far smaller). */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
/** A helper session that delivered frames this long is healthy: its exit resets the backoff. */
const HEALTHY_SESSION_MS = 10_000;
const STDERR_LINES_PER_MINUTE = 20;

// ───────────────────────────── wire protocol ─────────────────────────────

export type HelperStatusEvent = 'waiting' | 'started' | 'window' | 'error' | 'stopped';

export interface HelperStatus {
  event: HelperStatusEvent;
  message?: string;
  code?: 'permission' | 'no_window' | 'stream_failed' | string;
  ptW?: number;
  ptH?: number;
  pxW?: number;
  pxH?: number;
}

export interface HelperFrameHeader {
  seq: number;
  /** Epoch ms when ScreenCaptureKit captured the frame. */
  ts: number;
  /** Window size in points (integers, truncated). */
  ptW: number;
  ptH: number;
  /** JPEG size in pixels. */
  pxW: number;
  pxH: number;
}

export type HelperMessage =
  | { type: 'status'; status: HelperStatus }
  | { type: 'frame'; header: HelperFrameHeader; jpeg: Buffer }
  | { type: 'unknown'; code: number };

export class HelperProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperProtocolError';
  }
}

const STATUS_EVENTS = new Set<HelperStatusEvent>(['waiting', 'started', 'window', 'error', 'stopped']);

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function decodeMessage(type: number, payload: Buffer): HelperMessage {
  if (type === MSG_STATUS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new HelperProtocolError('STATUS payload is not valid JSON.');
    }
    const status = parsed as HelperStatus;
    if (!status || typeof status !== 'object' || !STATUS_EVENTS.has(status.event)) {
      throw new HelperProtocolError('STATUS payload has no known "event".');
    }
    return { type: 'status', status };
  }
  if (type === MSG_FRAME) {
    if (payload.length < 4) throw new HelperProtocolError('FRAME payload is too short.');
    const headerLength = payload.readUInt32BE(0);
    if (headerLength === 0 || 4 + headerLength > payload.length) {
      throw new HelperProtocolError('FRAME header length is out of range.');
    }
    let header: HelperFrameHeader;
    try {
      header = JSON.parse(payload.subarray(4, 4 + headerLength).toString('utf8')) as HelperFrameHeader;
    } catch {
      throw new HelperProtocolError('FRAME header is not valid JSON.');
    }
    if (
      !header ||
      typeof header.seq !== 'number' ||
      !positiveInt(header.ts) ||
      !positiveInt(header.ptW) ||
      !positiveInt(header.ptH) ||
      !positiveInt(header.pxW) ||
      !positiveInt(header.pxH)
    ) {
      throw new HelperProtocolError('FRAME header is missing seq/ts/ptW/ptH/pxW/pxH.');
    }
    const jpeg = payload.subarray(4 + headerLength);
    if (jpeg.length === 0) throw new HelperProtocolError('FRAME has no image data.');
    return { type: 'frame', header, jpeg };
  }
  return { type: 'unknown', code: type };
}

/** Incremental parser for the helper's framed stdout (chunks may split or join messages anywhere). */
export class HelperStreamParser {
  private chunks: Buffer[] = [];
  private buffered = 0;

  /** Feeds a chunk; returns every message completed by it. Throws HelperProtocolError on corrupt input. */
  push(chunk: Buffer): HelperMessage[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out: HelperMessage[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      const length = this.peekLength();
      if (length < 1 || length > MAX_MESSAGE_BYTES) {
        throw new HelperProtocolError(`Message length ${length} is out of range.`);
      }
      if (this.buffered < 4 + length) break;
      const message = this.take(4 + length);
      out.push(decodeMessage(message[4]!, message.subarray(5)));
    }
    return out;
  }

  get pendingBytes(): number {
    return this.buffered;
  }

  private peekLength(): number {
    if (this.chunks[0]!.length < 4) this.chunks = [Buffer.concat(this.chunks, this.buffered)];
    return this.chunks[0]!.readUInt32BE(0);
  }

  private take(count: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= count) {
      const out = first.subarray(0, count);
      if (first.length === count) this.chunks.shift();
      else this.chunks[0] = first.subarray(count);
      this.buffered -= count;
      return out;
    }
    const all = Buffer.concat(this.chunks, this.buffered);
    const rest = all.subarray(count);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return all.subarray(0, count);
  }
}

/** Encodes one `/ws/screen` binary message: [u32 BE header length][JSON LiveFrameHeader][JPEG]. */
export function encodeLiveFrameMessage(header: LiveFrameHeader, jpeg: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, jpeg]);
}

/** Decodes a `/ws/screen` binary message (tests and tooling; the UI has its own copy). */
export function decodeLiveFrameMessage(message: Buffer): { header: LiveFrameHeader; jpeg: Buffer } {
  if (message.length < 4) throw new HelperProtocolError('Message too short.');
  const length = message.readUInt32BE(0);
  if (4 + length > message.length) throw new HelperProtocolError('Header length out of range.');
  const header = JSON.parse(message.subarray(4, 4 + length).toString('utf8')) as LiveFrameHeader;
  return { header, jpeg: message.subarray(4 + length) };
}

// ───────────────────────────── helper discovery ─────────────────────────────

export interface CaptureHelperCommand {
  command: string;
  /** Extra arguments placed before the standard CLI flags (tests use this for the fake helper). */
  args: string[];
}

export interface ResolvedCaptureHelper {
  helper: CaptureHelperCommand | null;
  /** Why live capture is unavailable when `helper` is null. */
  reason: string | null;
}

function tauriTriple(arch: string): string {
  if (arch === 'arm64') return 'aarch64-apple-darwin';
  if (arch === 'x64') return 'x86_64-apple-darwin';
  return `${arch}-apple-darwin`;
}

function defaultRepoRoot(): string | null {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  } catch {
    return null;
  }
}

/**
 * Finds the capture helper: env IPHONE_AI_CAPTURE_BIN (set by the desktop
 * shell), else — in development, never in mock mode — the Tauri sidecar build
 * at <repo>/src-tauri/binaries/iphone-ai-capture-<arch>-apple-darwin.
 */
export function resolveCaptureHelper(
  options: {
    env?: NodeJS.ProcessEnv;
    /** Mock Mirroir session: never pick up the real helper implicitly (it would capture the real phone). */
    mock?: boolean;
    platform?: NodeJS.Platform;
    arch?: string;
    repoRoot?: string | null;
  } = {},
): ResolvedCaptureHelper {
  const env = options.env ?? process.env;
  const explicit = env.IPHONE_AI_CAPTURE_BIN?.trim();
  if (explicit) {
    if (existsSync(explicit)) return { helper: { command: explicit, args: [] }, reason: null };
    return { helper: null, reason: `the capture helper set in IPHONE_AI_CAPTURE_BIN was not found (${explicit})` };
  }
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { helper: null, reason: 'ScreenCaptureKit live capture needs macOS' };
  }
  if (options.mock) {
    return { helper: null, reason: 'mock Mirroir mode (there is no real iPhone Mirroring session to capture)' };
  }
  const root = options.repoRoot === undefined ? defaultRepoRoot() : options.repoRoot;
  if (root) {
    const candidate = path.join(root, 'src-tauri', 'binaries', `iphone-ai-capture-${tauriTriple(options.arch ?? process.arch)}`);
    if (existsSync(candidate)) return { helper: { command: candidate, args: [] }, reason: null };
  }
  return { helper: null, reason: 'the iphone-ai-capture helper is not installed' };
}

// ───────────────────────────── service ─────────────────────────────

/** A connection activity row recorded on LiveCapture's behalf (it has no activity log of its own). */
export interface LiveActivityEntry {
  type: string;
  severity: ActivitySeverity;
  summary: string;
  detail?: Record<string, unknown>;
}

/** What LiveCapture needs from DeviceController (kept narrow for tests). */
export interface LiveCaptureDevice {
  getStatus(): DeviceStatus;
  readonly geometry: WindowGeometry | null;
  /** Shared frame sequence with Mirroir screenshots, so a higher seq is always newer. */
  nextFrameSeq(): number;
  /** Records a connection activity row (the conflict latch). */
  recordConnectionActivity?(entry: LiveActivityEntry): void;
  /** When a user-allowed capture last made Mirroir press Resume (that resume is not a capture conflict). */
  readonly lastUserResumeAt?: number | null;
}

/** A polled Mirroir frame, used to notice a helper that went silent while the screen keeps changing. */
export interface PolledFrameInfo {
  meta: { capturedAt: number; latencyMs: number };
  data: Buffer;
}

export interface LiveCaptureTimings {
  /** Keep the helper running this long after it stopped being needed. */
  stopDelayMs: number;
  /** "Frames are flowing" window (ScreenStream polling pauses inside it). */
  liveWindowMs: number;
  /** Silence that counts as a stall (no first frame after "started", or a stuck stream). */
  stallMs: number;
  /** A helper that never reports "started"/"waiting" is restarted after this long. */
  startupTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Retry delay after the helper reported missing Screen Recording permission. */
  permissionRetryMs: number;
  /** "Live capture stats" log interval while running. */
  statsIntervalMs: number;
  /** Watchdog tick. */
  tickMs: number;
  /** Grace period after {"cmd":"stop"} + EOF before SIGTERM (SIGKILL 3 s later). */
  killGraceMs: number;
  /**
   * Conflict probe: after the helper exited, Mirroir reporting "connected"
   * again within this window latches live capture off for the session.
   */
  conflictProbeMs: number;
}

export const DEFAULT_LIVE_TIMINGS: LiveCaptureTimings = {
  stopDelayMs: 10_000,
  liveWindowMs: LIVE_WINDOW_MS,
  stallMs: 3000,
  startupTimeoutMs: 15_000,
  retryBaseMs: 1000,
  retryMaxMs: 30_000,
  permissionRetryMs: 60_000,
  statsIntervalMs: 60_000,
  tickMs: 500,
  killGraceMs: 2000,
  conflictProbeMs: 5000,
};

export interface LiveCaptureOptions {
  device: LiveCaptureDevice;
  settings: SettingsStore;
  hub: EventHub;
  log: Logger;
  helper: CaptureHelperCommand | null;
  /** Shown when `helper` is null. */
  unavailableReason?: string | null;
  timings?: Partial<LiveCaptureTimings>;
}

/** One relayed live frame (JPEG) and its `/ws/screen` message, encoded once for every viewer. */
export class LiveFrame {
  private encoded: Buffer | null = null;

  constructor(
    readonly meta: LiveFrameHeader,
    readonly data: Buffer,
    /** Captured window size in points (as reported by the helper). */
    readonly windowPt: { width: number; height: number },
  ) {}

  message(): Buffer {
    this.encoded ??= encodeLiveFrameMessage(this.meta, this.data);
    return this.encoded;
  }
}

export interface LiveCaptureStats {
  /** Helper installed, live capture enabled in settings and not latched off by a capture conflict. */
  available: boolean;
  /** A live frame arrived within the live window. */
  delivering: boolean;
  /** A helper process is running. */
  running: boolean;
  phase: 'idle' | 'starting' | 'waiting' | 'capturing' | 'stopping';
  targetFps: number;
  /** Frames per second received over the last 10 s. */
  measuredFps: number;
  /** Capture → backend latency, average of recent frames. */
  avgLatencyMs: number;
  lastFrameAt: number | null;
  /** Why live frames are not arriving (null while delivering or when nothing is wrong). */
  error: string | null;
  totalFrames: number;
}

type StopReason = 'idle' | 'disabled' | 'shutdown' | 'conflict-probe' | 'stall' | 'protocol' | 'startup-timeout' | 'stuck' | 'error';
/** Stops that are failures: the helper is restarted with backoff while it is still needed. */
const RETRY_REASONS = new Set<StopReason>(['stall', 'protocol', 'startup-timeout', 'stuck', 'error']);

interface HelperSession {
  id: number;
  child: ChildProcess;
  parser: HelperStreamParser;
  startedAt: number;
  phase: 'starting' | 'waiting' | 'capturing';
  /** When the helper last reported "started"/"window" (capture running). */
  capturingSince: number | null;
  firstFrameAt: number | null;
  lastFrameAt: number | null;
  frames: number;
  fps: number;
  stopping: StopReason | null;
  permissionDenied: boolean;
  lastStatusError: string | null;
  /** When the helper last reported an error (it gets stallMs to recover with a frame or to exit). */
  errorAt: number | null;
  stderrRest: string;
  timers: NodeJS.Timeout[];
  ended: boolean;
}

export class LiveCapture extends EventEmitter {
  private readonly device: LiveCaptureDevice;
  private readonly settings: SettingsStore;
  private readonly hub: EventHub;
  private readonly log: Logger;
  private readonly helper: CaptureHelperCommand | null;
  private readonly unavailableReason: string;
  private readonly t: LiveCaptureTimings;

  private started = false;
  private session: HelperSession | null = null;
  private sessionCounter = 0;
  private viewerSource: () => number = () => 0;
  private latestFrame: LiveFrame | null = null;
  private lastFrameAt: number | null = null;
  private delivering = false;
  private lastError: string | null = null;
  private waitingReason: string | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private stopTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private unsubscribers: (() => void)[] = [];
  private readonly frameTimes: number[] = [];
  private readonly latencies: number[] = [];
  private totalFrames = 0;
  private interval = { frames: 0, latencySum: 0, since: Date.now(), ran: false };
  private stderrBudget = { windowStart: 0, lines: 0, dropped: 0 };
  /** Previous polled Mirroir frame (stuck-stream detection). */
  private lastPolled: PolledFrameInfo | null = null;
  /** The next helper session announces itself at info level. */
  private announce = true;
  /** Mirroring state seen at the previous evaluation (connected → paused detection). */
  private lastMirroringState: MirroringState | null = null;
  /** Conflict probe in progress: the helper was stopped after Mirroir reported a pause while it captured. */
  private probe: { startedAt: number; helperExitedAt: number | null } | null = null;
  /** Capture made Mirroir report "paused": live capture stays off until its settings change. */
  private conflict = false;

  constructor(options: LiveCaptureOptions) {
    super();
    this.setMaxListeners(50);
    this.device = options.device;
    this.settings = options.settings;
    this.hub = options.hub;
    this.log = options.log.child('live');
    this.helper = options.helper;
    this.unavailableReason = options.unavailableReason ?? 'the iphone-ai-capture helper is not installed';
    this.t = { ...DEFAULT_LIVE_TIMINGS, ...options.timings };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.helper) {
      this.log.info(`Live capture unavailable: ${this.unavailableReason}`);
    }
    this.lastMirroringState = this.device.getStatus().mirroring.state;
    // Device status covers lease, permission and Mirroring changes; settings cover the switch and fps.
    this.unsubscribers.push(
      this.hub.subscribe((event) => {
        if (event.type === 'status') this.evaluate();
      }),
    );
    let previous = this.settings.get().connection.screenshot;
    this.unsubscribers.push(
      this.settings.onChange((next) => {
        const cfg = next.connection.screenshot;
        const fpsChanged = cfg.liveFps !== previous.liveFps;
        if (fpsChanged) this.sendConfig();
        const toggled = cfg.liveCapture !== previous.liveCapture;
        previous = cfg;
        // Changing the switch or the frame rate is the user's way to try live capture again.
        const cleared = (toggled || fpsChanged) && this.clearConflict();
        this.evaluate();
        if (toggled || cleared) this.emitState();
      }),
    );
    this.tickTimer = setInterval(() => this.tick(), this.t.tickMs);
    this.tickTimer.unref();
    this.statsTimer = setInterval(() => this.logStats(), this.t.statsIntervalMs);
    this.statsTimer.unref();
    this.evaluate();
  }

  /** Stops the helper now and waits (briefly) for it to exit. */
  async shutdown(): Promise<void> {
    this.started = false;
    for (const off of this.unsubscribers.splice(0)) off();
    for (const timer of [this.stopTimer, this.retryTimer, this.tickTimer, this.statsTimer]) {
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    this.stopTimer = this.retryTimer = this.tickTimer = this.statsTimer = null;
    const session = this.session;
    if (!session) return;
    const exited = new Promise<void>((resolve) => {
      if (session.ended) resolve();
      else session.child.once('exit', () => resolve());
    });
    this.stopHelper(session, 'shutdown', true);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500).unref());
    await Promise.race([exited, timeout]);
    if (!session.ended) session.child.kill('SIGKILL');
  }

  /** Synchronous last resort for process exit (the helper must never outlive the backend). */
  killNow(): void {
    const session = this.session;
    if (session && !session.ended) {
      try {
        session.child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  /** ScreenStream provides the number of visible viewers. */
  setViewerSource(source: () => number): void {
    this.viewerSource = source;
  }

  // ───────────────────────────── queries ─────────────────────────────

  /** Helper installed, live capture enabled in settings and not latched off by a capture conflict. */
  get available(): boolean {
    return this.helper !== null && this.settings.get().connection.screenshot.liveCapture && !this.conflict;
  }

  /** True while live capture is latched off for this session (it made Mirroir report a pause). */
  get conflictLatched(): boolean {
    return this.conflict;
  }

  /** True while live frames are arriving (one within the live window). */
  isDelivering(now = Date.now()): boolean {
    return this.lastFrameAt !== null && now - this.lastFrameAt < this.t.liveWindowMs && this.session !== null;
  }

  latest(): LiveFrame | null {
    return this.latestFrame;
  }

  stats(now = Date.now()): LiveCaptureStats {
    this.trim(now);
    const delivering = this.isDelivering(now);
    const windowSec = this.frameTimes.length > 1 ? (now - this.frameTimes[0]!) / 1000 : 10;
    const measuredFps = this.frameTimes.length > 1 ? (this.frameTimes.length - 1) / Math.max(windowSec, 1) : 0;
    const avgLatencyMs = this.latencies.length
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : 0;
    const session = this.session;
    let error: string | null = null;
    if (!this.helper) error = `Live capture unavailable: ${this.unavailableReason}.`;
    else if (!delivering && this.settings.get().connection.screenshot.liveCapture) {
      error = this.conflict ? LIVE_CONFLICT_ERROR : (this.lastError ?? (session?.phase === 'waiting' ? this.waitingReason : null));
    }
    return {
      available: this.available,
      delivering,
      running: session !== null,
      phase: session ? (session.stopping ? 'stopping' : session.phase) : 'idle',
      targetFps: this.configuredFps(),
      measuredFps: Math.round(measuredFps * 100) / 100,
      avgLatencyMs,
      lastFrameAt: this.lastFrameAt,
      error,
      totalFrames: this.totalFrames,
    };
  }

  // ───────────────────────────── decisions ─────────────────────────────

  private configuredFps(): number {
    const fps = Math.round(this.settings.get().connection.screenshot.liveFps);
    if (!Number.isFinite(fps)) return DEFAULT_LIVE_FPS;
    return Math.min(MAX_LIVE_FPS, Math.max(MIN_LIVE_FPS, fps));
  }

  /**
   * Whether the helper should run now. `immediate` stops (helper missing,
   * switched off) skip the grace period; the others stop it after stopDelayMs.
   */
  private wanted(): { ok: true } | { ok: false; reason: string; immediate: boolean } {
    if (!this.helper) return { ok: false, reason: this.unavailableReason, immediate: true };
    if (!this.settings.get().connection.screenshot.liveCapture) {
      return { ok: false, reason: 'live capture is turned off in Settings', immediate: true };
    }
    if (this.conflict) return { ok: false, reason: LIVE_CONFLICT_REASON, immediate: true };
    if (this.probe) {
      return { ok: false, reason: 'checking whether live capture made Mirroir report iPhone Mirroring as paused', immediate: true };
    }
    const status = this.device.getStatus();
    if (status.permissions.screenRecording !== 'granted') {
      return { ok: false, reason: 'Screen Recording permission not confirmed', immediate: false };
    }
    const state = status.mirroring.state;
    // ScreenCaptureKit capture has no side effects, so (unlike Mirroir's screenshot) it may run while paused.
    if (state !== 'connected' && state !== 'paused') {
      return { ok: false, reason: 'iPhone Mirroring is not running', immediate: false };
    }
    const controlled = status.controlOwner === 'ai' || status.controlOwner === 'workflow';
    if (!controlled && this.viewerSource() === 0) {
      return { ok: false, reason: 'no visible viewer', immediate: false };
    }
    return { ok: true };
  }

  /** Re-evaluates whether the helper should run (cheap; called on every relevant change). */
  evaluate(): void {
    if (!this.started) return;
    this.observeMirroring();
    const want = this.wanted();
    if (want.ok) {
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      this.ensureRunning();
    } else {
      if (this.retryTimer) {
        // Not needed any more: the next start is scheduled when it is needed again (backoff kept).
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      const session = this.session;
      if (session && !session.stopping) {
        if (want.immediate) this.stopHelper(session, 'disabled');
        else if (!this.stopTimer) {
          this.stopTimer = setTimeout(() => {
            this.stopTimer = null;
            const again = this.wanted();
            if (!again.ok && this.session && !this.session.stopping) {
              this.log.debug('Live capture no longer needed; stopping the helper', { reason: again.reason });
              this.stopHelper(this.session, 'idle');
            }
          }, this.t.stopDelayMs);
          this.stopTimer.unref();
        }
      }
    }
    this.updateDelivering();
  }

  // ───────────────────────────── capture conflict ─────────────────────────────

  /**
   * Starts a conflict probe on a connected → paused transition while the
   * helper captures, and settles a running probe from the next status polls.
   */
  private observeMirroring(): void {
    const state = this.device.getStatus().mirroring.state;
    const previous = this.lastMirroringState;
    this.lastMirroringState = state;
    const probe = this.probe;
    if (probe) {
      const resumedAt = this.device.lastUserResumeAt ?? null;
      if (state === 'connected' && resumedAt !== null && resumedAt >= probe.startedAt) {
        // The user's Resume ended the pause, not stopping capture: it was genuine.
        this.probe = null;
        this.log.info('iPhone Mirroring was resumed by the user during the live capture conflict check; the pause was genuine, live capture may run again');
      } else if (state === 'connected') this.latchConflict(probe);
      else if (state !== 'paused') {
        // Not running, no window…: unrelated to capture; the normal rules decide.
        this.probe = null;
        this.log.info('Live capture conflict check ended: iPhone Mirroring is no longer paused', { state });
      }
      return;
    }
    if (previous !== 'connected' || state !== 'paused' || this.conflict) return;
    const session = this.session;
    if (!session || session.stopping || session.ended || session.phase !== 'capturing') return;
    this.probe = { startedAt: Date.now(), helperExitedAt: null };
    this.log.info('Mirroir reported iPhone Mirroring as paused while live capture was running; stopping the helper to check whether capture caused it', {
      frames: session.frames,
    });
    this.stopHelper(session, 'conflict-probe');
  }

  /** Mirroir reported connected again right after the helper stopped: capture caused the "pause". */
  private latchConflict(probe: { startedAt: number; helperExitedAt: number | null }): void {
    this.probe = null;
    this.conflict = true;
    const sinceStopMs = probe.helperExitedAt === null ? null : Date.now() - probe.helperExitedAt;
    this.log.warn(`Live capture turned off for this session: ${LIVE_CONFLICT_REASON} (polling screenshots instead)`, {
      probeMs: Date.now() - probe.startedAt,
      sinceHelperExitMs: sinceStopMs,
    });
    this.device.recordConnectionActivity?.({
      type: 'live.conflict',
      severity: 'warning',
      summary:
        'Live view was turned off for this session: it made Mirroir report iPhone Mirroring as paused. The screen is updated with Mirroir screenshots instead.',
      detail: { probeMs: Date.now() - probe.startedAt, sinceHelperExitMs: sinceStopMs },
    });
    this.emitState();
  }

  /** Clears the latch (and a running probe). Returns true when the latch was set. */
  private clearConflict(): boolean {
    this.probe = null;
    if (!this.conflict) return false;
    this.conflict = false;
    this.log.info('Live capture conflict latch cleared by a settings change; live capture may run again');
    return true;
  }

  /** Ends a probe whose pause outlived the window: it was genuine, so the normal rules apply again. */
  private checkProbeDeadline(now: number): void {
    const probe = this.probe;
    if (!probe || probe.helperExitedAt === null || now - probe.helperExitedAt < this.t.conflictProbeMs) return;
    this.probe = null;
    this.log.info('iPhone Mirroring stayed paused after live capture stopped; the pause is genuine, live capture may run again', {
      probeMs: now - probe.startedAt,
    });
    this.evaluate();
  }

  private ensureRunning(): void {
    if (this.session || this.retryTimer) return;
    const wait = this.nextAttemptAt - Date.now();
    if (wait > 0) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.evaluate();
      }, wait);
      this.retryTimer.unref();
      return;
    }
    this.spawnHelper();
  }

  // ───────────────────────────── helper process ─────────────────────────────

  private spawnHelper(): void {
    const helper = this.helper;
    if (!helper) return;
    const fps = this.configuredFps();
    const args = [
      ...helper.args,
      '--bundle-id',
      MIRRORING_BUNDLE_ID,
      '--fps',
      String(fps),
      '--max-long-edge',
      String(LIVE_MAX_LONG_EDGE),
      '--quality',
      String(LIVE_JPEG_QUALITY),
    ];
    let child: ChildProcess;
    try {
      // Not detached: the helper stays in the backend's process group, which
      // the desktop shell kills on quit.
      child = spawn(helper.command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.onSpawnFailure(err instanceof Error ? err.message : String(err));
      return;
    }
    const session: HelperSession = {
      id: ++this.sessionCounter,
      child,
      parser: new HelperStreamParser(),
      startedAt: Date.now(),
      phase: 'starting',
      capturingSince: null,
      firstFrameAt: null,
      lastFrameAt: null,
      frames: 0,
      fps,
      stopping: null,
      permissionDenied: false,
      lastStatusError: null,
      errorAt: null,
      stderrRest: '',
      timers: [],
      ended: false,
    };
    this.session = session;
    this.interval.ran = true;
    this.log.debug('Starting the live capture helper', { command: helper.command, fps, session: session.id });
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(session, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => this.onStderr(session, text));
    child.stdin?.on('error', () => undefined);
    child.on('error', (err) => {
      // Spawn failures (ENOENT, EACCES) arrive here, possibly without an 'exit'.
      session.lastStatusError ??= `The live capture helper could not be started (${err.message}).`;
      this.endSession(session, null, null);
    });
    child.on('exit', (code, signal) => this.endSession(session, code, signal));
    this.emitState();
  }

  private onSpawnFailure(message: string): void {
    this.failures += 1;
    this.lastError = `The live capture helper could not be started (${message}).`;
    this.nextAttemptAt = Date.now() + this.backoffDelay();
    this.log.info(`Live capture unavailable: ${this.lastError}`);
    this.emitState();
    this.evaluate();
  }

  private backoffDelay(): number {
    return Math.min(this.t.retryMaxMs, this.t.retryBaseMs * 2 ** Math.max(0, this.failures - 1));
  }

  private stopHelper(session: HelperSession, reason: StopReason, signalNow = RETRY_REASONS.has(reason)): void {
    if (session.ended) return;
    if (!session.stopping) session.stopping = reason;
    try {
      session.child.stdin?.write('{"cmd":"stop"}\n');
      session.child.stdin?.end();
    } catch {
      // stdin already closed
    }
    const term = () => {
      if (!session.ended) session.child.kill('SIGTERM');
    };
    if (signalNow) term();
    else session.timers.push(setTimeout(term, this.t.killGraceMs));
    session.timers.push(
      setTimeout(() => {
        if (!session.ended) session.child.kill('SIGKILL');
      }, this.t.killGraceMs + 3000),
    );
    for (const timer of session.timers) timer.unref();
    this.emitState();
  }

  private sendConfig(): void {
    const session = this.session;
    if (!session || session.stopping || session.ended) return;
    const fps = this.configuredFps();
    session.fps = fps;
    try {
      session.child.stdin?.write(`${JSON.stringify({ cmd: 'config', fps, maxLongEdge: LIVE_MAX_LONG_EDGE, quality: LIVE_JPEG_QUALITY })}\n`);
      this.log.info(`Live capture frame rate changed to ${fps} fps`);
    } catch {
      // the exit handler deals with a dead helper
    }
  }

  private endSession(session: HelperSession, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.ended) return;
    session.ended = true;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    if (this.session !== session) return;
    this.session = null;
    const now = Date.now();
    const healthy = session.firstFrameAt !== null && now - session.firstFrameAt >= HEALTHY_SESSION_MS;
    if (healthy) this.failures = 0;
    const stop = session.stopping;
    if (stop === 'conflict-probe' && this.probe) this.probe.helperExitedAt = now;
    if (stop && !RETRY_REASONS.has(stop)) {
      // Asked to stop (not needed, turned off, shutting down).
      this.nextAttemptAt = 0;
      this.waitingReason = null;
      if (this.lastError && session.frames > 0) this.lastError = null;
      this.announce = true;
      this.log.info('Live capture stopped', { reason: stop, frames: session.frames });
    } else if (session.permissionDenied || code === 2) {
      this.failures += 1;
      this.lastError =
        session.lastStatusError ??
        'Screen Recording permission was denied to the live capture helper. Allow iPhone AI in System Settings › Privacy & Security › Screen & System Audio Recording.';
      this.nextAttemptAt = now + this.t.permissionRetryMs;
      this.announce = true;
      this.log.info(`Live capture unavailable: ${this.lastError} (retrying in ${Math.round(this.t.permissionRetryMs / 1000)} s; polling screenshots meanwhile)`);
    } else {
      this.failures += 1;
      const delay = this.backoffDelay();
      this.nextAttemptAt = now + delay;
      const what = stop
        ? describeRetryReason(stop, this.t.stallMs)
        : `the live capture helper exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`;
      // A silent-but-healthy stream restart is routine; everything else is worth a line at info.
      const routine = stop === 'stuck' && session.frames > 0;
      this.lastError = session.lastStatusError ?? capitalize(`${what}.`);
      if (routine) this.log.debug(`Live capture restarting: ${what}`, { retryInMs: delay });
      else {
        this.announce = true;
        this.log.info(`Live capture unavailable: ${what} (retrying in ${Math.round(delay / 100) / 10} s; polling screenshots meanwhile)`, {
          frames: session.frames,
        });
      }
    }
    this.emitState();
    this.updateDelivering();
    this.evaluate();
  }

  // ───────────────────────────── helper output ─────────────────────────────

  private onStdout(session: HelperSession, chunk: Buffer): void {
    if (session.ended || this.session !== session) return;
    let messages: HelperMessage[];
    try {
      messages = session.parser.push(chunk);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.lastStatusError = `The live capture helper sent malformed data (${message}).`;
      this.log.warn('Live capture protocol error; restarting the helper', { error: message });
      this.stopHelper(session, 'protocol');
      return;
    }
    for (const message of messages) {
      if (session.ended || session.stopping) return;
      if (message.type === 'status') this.onStatus(session, message.status);
      else if (message.type === 'frame') this.onFrame(session, message.header, message.jpeg);
      else this.log.debug('Ignoring an unknown live capture message', { type: message.code });
    }
  }

  private onStatus(session: HelperSession, status: HelperStatus): void {
    switch (status.event) {
      case 'waiting': {
        if (session.phase !== 'waiting') {
          this.log.info('Live capture waiting for the iPhone Mirroring window', { message: status.message ?? null });
        }
        session.phase = 'waiting';
        session.capturingSince = null;
        this.waitingReason = status.message ? `Waiting for the iPhone Mirroring window: ${status.message}` : 'Waiting for the iPhone Mirroring window.';
        break;
      }
      case 'started':
      case 'window': {
        if (status.event === 'window' && status.ptW && status.ptH) {
          this.log.info(`Live capture window is ${status.ptW}x${status.ptH} pt`, { pxW: status.pxW ?? null, pxH: status.pxH ?? null });
        }
        if (session.phase !== 'capturing') session.capturingSince = Date.now();
        session.phase = 'capturing';
        this.waitingReason = null;
        break;
      }
      case 'error': {
        const text = status.message?.trim() || `capture error (${status.code ?? 'unknown'})`;
        if (status.code === 'permission') {
          session.permissionDenied = true;
          session.lastStatusError = `Screen Recording permission was denied to the live capture helper (${text}).`;
        } else {
          session.lastStatusError = `Live capture error: ${text}`;
        }
        this.lastError = session.lastStatusError;
        session.errorAt = Date.now();
        this.log.warn('Live capture helper reported an error', { code: status.code ?? null, message: text });
        break;
      }
      case 'stopped':
        this.log.debug('Live capture helper stopped', { message: status.message ?? null });
        break;
    }
    this.emitState();
  }

  private onFrame(session: HelperSession, header: HelperFrameHeader, jpeg: Buffer): void {
    const receivedAt = Date.now();
    const geometry = this.device.geometry;
    // Touch coordinates may only be derived from this frame when its window size matches Mirroir's.
    const matching = geometry && geometry.widthPt === header.ptW && geometry.heightPt === header.ptH ? geometry : null;
    const meta: LiveFrameHeader = {
      seq: this.device.nextFrameSeq(),
      capturedAt: header.ts,
      latencyMs: Math.max(0, receivedAt - header.ts),
      widthPx: header.pxW,
      heightPx: header.pxH,
      mimeType: 'image/jpeg',
      pxPerPt: Math.round((header.pxW / header.ptW) * 10000) / 10000,
      geometry: matching,
      source: 'screencapturekit',
      receivedAt,
    };
    const frame = new LiveFrame(meta, jpeg, { width: header.ptW, height: header.ptH });
    const first = session.frames === 0;
    session.frames += 1;
    session.lastFrameAt = receivedAt;
    session.firstFrameAt ??= receivedAt;
    if (session.phase !== 'capturing') {
      session.phase = 'capturing';
      session.capturingSince ??= receivedAt;
    }
    this.latestFrame = frame;
    this.lastFrameAt = receivedAt;
    this.lastError = null;
    this.waitingReason = null;
    this.totalFrames += 1;
    this.frameTimes.push(receivedAt);
    this.latencies.push(meta.latencyMs);
    this.interval.frames += 1;
    this.interval.latencySum += meta.latencyMs;
    this.trim(receivedAt);
    if (first) {
      const line = `Live capture started (ScreenCaptureKit, ${header.pxW}x${header.pxH} px, ${session.fps} fps)`;
      if (this.announce) this.log.info(line, { windowPt: `${header.ptW}x${header.ptH}`, geometryMatches: matching !== null });
      else this.log.debug(line);
      this.announce = false;
    }
    this.emit('frame', frame);
    this.updateDelivering(receivedAt);
  }

  private onStderr(session: HelperSession, text: string): void {
    const combined = session.stderrRest + text;
    const lines = combined.split(/\r?\n/);
    session.stderrRest = (lines.pop() ?? '').slice(-2000);
    const now = Date.now();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (now - this.stderrBudget.windowStart >= 60_000) {
        if (this.stderrBudget.dropped > 0) {
          this.log.info('Live capture helper log lines dropped', { dropped: this.stderrBudget.dropped });
        }
        this.stderrBudget = { windowStart: now, lines: 0, dropped: 0 };
      }
      if (this.stderrBudget.lines >= STDERR_LINES_PER_MINUTE) {
        this.stderrBudget.dropped += 1;
        continue;
      }
      this.stderrBudget.lines += 1;
      this.log.info(`capture helper: ${line.slice(0, 500)}`);
    }
  }

  // ───────────────────────────── watchdog ─────────────────────────────

  /**
   * Called by ScreenStream for every polled Mirroir screenshot. Polling runs
   * only while live frames are not arriving; two consecutive polled
   * screenshots that differ, both taken after the last live frame and after
   * a stall-length silence, mean the screen is changing but the helper's
   * stream is not delivering — it is restarted (with backoff). A silent helper
   * on an unchanging screen is left alone: the helper does not re-send an
   * unchanged screenshot (it repeats the last frame about once per second
   * instead), so a pause in new frames alone is not a failure (restarting on
   * it would also flicker the macOS recording indicator).
   */
  notePolledFrame(frame: PolledFrameInfo): void {
    const previous = this.lastPolled;
    this.lastPolled = frame;
    const session = this.session;
    if (!previous || !session || session.stopping || session.phase !== 'capturing' || session.frames === 0) return;
    const lastLive = this.lastFrameAt ?? 0;
    const previousStarted = previous.meta.capturedAt - previous.meta.latencyMs;
    if (previousStarted <= lastLive) return;
    if (frame.meta.capturedAt - lastLive < this.t.stallMs) return;
    if (previous.data.equals(frame.data)) return;
    this.log.debug('Live capture went silent while the screen keeps changing; restarting the helper');
    this.stopHelper(session, 'stuck');
  }

  private tick(): void {
    const now = Date.now();
    const session = this.session;
    if (session && !session.stopping && !session.ended) {
      if (session.errorAt !== null && (session.lastFrameAt ?? 0) < session.errorAt && now - session.errorAt >= this.t.stallMs) {
        // Reported an error and neither recovered nor exited.
        this.stopHelper(session, 'error');
      } else if (session.phase === 'starting' && now - session.startedAt >= this.t.startupTimeoutMs) {
        this.stopHelper(session, 'startup-timeout');
      } else if (session.phase === 'capturing' && session.frames === 0) {
        const since = session.capturingSince ?? session.startedAt;
        if (now - since >= this.t.stallMs) this.stopHelper(session, 'stall');
      }
    }
    this.checkProbeDeadline(now);
    this.updateDelivering(now);
  }

  private updateDelivering(now = Date.now()): void {
    const delivering = this.isDelivering(now);
    if (delivering !== this.delivering) {
      this.delivering = delivering;
      this.log.debug(delivering ? 'Live frames are arriving (polling paused)' : 'Live frames stopped arriving (polling resumes)');
      this.emitState();
    }
  }

  private emitState(): void {
    this.emit('state');
  }

  private trim(now: number): void {
    const cutoff = now - 10_000;
    while (this.frameTimes.length && this.frameTimes[0]! < cutoff) this.frameTimes.shift();
    while (this.latencies.length > 60) this.latencies.shift();
  }

  private logStats(): void {
    const now = Date.now();
    const { frames, latencySum, since, ran } = this.interval;
    this.interval = { frames: 0, latencySum: 0, since: now, ran: this.session !== null };
    if (!ran && this.session === null) return;
    const seconds = Math.max(1, (now - since) / 1000);
    const fps = Math.round((frames / seconds) * 10) / 10;
    const avgLatencyMs = frames > 0 ? Math.round(latencySum / frames) : 0;
    this.log.info(`Live capture stats: fps=${fps}, avgLatencyMs=${avgLatencyMs}, frames=${frames}`, {
      totalFrames: this.totalFrames,
      targetFps: this.configuredFps(),
      phase: this.session ? this.session.phase : 'idle',
      delivering: this.isDelivering(now),
    });
  }
}

function describeRetryReason(reason: StopReason, stallMs: number): string {
  switch (reason) {
    case 'stall':
      return `the live capture helper delivered no frame within ${Math.round(stallMs / 100) / 10} s of starting`;
    case 'stuck':
      return 'the live capture stream stopped delivering frames while the screen kept changing';
    case 'startup-timeout':
      return 'the live capture helper did not start in time';
    case 'protocol':
      return 'the live capture helper sent malformed data';
    case 'error':
      return 'the live capture helper reported an error and did not recover';
    default:
      return 'the live capture helper stopped';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
