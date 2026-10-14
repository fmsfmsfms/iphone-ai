// The single control lane to the iPhone.
//
// • Every Mirroir call goes through one priority queue (Mirroir is single-
//   threaded anyway): stop > actions > observations > status > live frames.
// • A control lease prevents manual input and AI/workflow input from
//   interleaving. Manual input is refused while a task holds the lease,
//   unless that task is paused.
// • The emergency stop latches: queued actions are rejected, lease holders are
//   aborted, and an in-flight input call is ended by SIGTERM-ing Mirroir (its
//   signal handler lifts held touches/keys). Nothing runs until re-armed.
// • Coordinate actions re-read the live window geometry immediately before
//   executing and are refused if it no longer matches the frame the
//   coordinates were computed from.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  ACTION_TOOL,
  type ActionResult,
  type Actor,
  type ControlOwner,
  type DeviceAction,
  type DeviceStatus,
  type FrameMeta,
  type MacPermissions,
  type MirroringInfo,
  type PolicyDecision,
  type ScreenDescription,
  type WindowGeometry,
} from '@iphone-ai/shared';

import type { ActivityLog } from '../core/activity-log.js';
import type { EventHub } from '../core/events.js';
import { newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import { redactToolArgs } from '../core/redact.js';
import type { SettingsStore } from '../core/settings-store.js';
import { McpUnavailableError, type MirroirManager, type ToolCallOutcome } from '../mcp/mirroir-manager.js';
import {
  classifyInputError,
  geometryId,
  makeGeometry,
  parseDescribeScreen,
  parseStatus,
  screenFingerprint,
} from '../mcp/parsers.js';
import { base64PngDimensions } from './png.js';

export class DeviceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'stop_latched'
      | 'lease_conflict'
      | 'not_connected'
      | 'paused'
      | 'geometry_changed'
      | 'geometry_unknown'
      | 'out_of_bounds'
      | 'not_authorized'
      | 'mcp_unavailable'
      | 'screen_capture_unavailable'
      | 'aborted'
      | 'tool_failed',
    readonly status = 409,
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

type JobPriority = 0 | 1 | 2 | 3 | 4;
const PRIORITY = { stop: 0, action: 1, observe: 2, status: 3, frame: 4 } as const;

interface Job<T> {
  id: string;
  label: string;
  priority: JobPriority;
  mutating: boolean;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
}

export interface Lease {
  id: string;
  owner: Exclude<ControlOwner, 'none' | 'manual'>;
  label: string;
  /** Aborted when the emergency stop fires or the lease is revoked. */
  signal: AbortSignal;
  paused: boolean;
  release(): void;
}

interface LeaseRecord {
  lease: Lease;
  controller: AbortController;
}

export interface Frame {
  meta: FrameMeta;
  data: Buffer;
}

export interface ActionContext {
  actor: Actor;
  leaseId?: string | null;
  geometryId?: string | null;
  taskId?: string | null;
  workflowRunId?: string | null;
  /** The policy decision that authorised the action; require_approval needs an approval id. */
  decision: PolicyDecision;
  approvalId?: string | null;
  /** Remote viewers must have been granted control (checked by the HTTP layer too). */
  remoteControlAllowed?: boolean;
}

const POINTER_KINDS = new Set(['tap', 'double_tap', 'long_press', 'swipe', 'drag']);
/** Tools that make iPhone Mirroring the frontmost app (focus leaves iPhone AI). */
const FOCUS_STEALING_TOOLS = new Set(['tap', 'double_tap', 'long_press', 'swipe', 'drag', 'type_text', 'press_key', 'launch_app', 'scroll_to', 'press_back']);

export class DeviceController extends EventEmitter {
  private readonly queue: Job<unknown>[] = [];
  private running: Job<unknown> | null = null;
  private pendingFrame: Promise<Frame> | null = null;
  private pendingStatus: Promise<MirroringInfo> | null = null;
  private leaseRecord: LeaseRecord | null = null;
  private stopLatched = false;
  private stopReason: string | null = null;
  private lastFocusSteal: number | null = null;
  private mirroring: MirroringInfo = { state: 'unknown', rawStatus: '', target: 'iphone', geometry: null, checkedAt: null };
  private permissions: MacPermissions = { screenRecording: 'unknown', accessibility: 'unknown', source: 'none', checkedAt: null };
  private latestFrame: Frame | null = null;
  private frameSeq = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private doctorTimer: NodeJS.Timeout | null = null;
  private statusPublishTimer: NodeJS.Timeout | null = null;
  private describeWarm = false;
  private readonly log: Logger;

  constructor(
    private readonly mirroir: MirroirManager,
    private readonly settings: SettingsStore,
    private readonly hub: EventHub,
    private readonly activity: ActivityLog,
    log: Logger,
  ) {
    super();
    this.log = log.child('device');
    this.mirroir.on('state', () => this.publishStatus());
    this.mirroir.on('exit', () => {
      this.mirroring = { ...this.mirroring, state: 'unknown', checkedAt: Date.now() };
      this.publishStatus();
    });
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    const tick = () => {
      void this.refreshStatus().catch(() => undefined);
    };
    this.statusTimer = setInterval(tick, 2000);
    this.statusTimer.unref();
    tick();
    const doctor = () => {
      void this.refreshPermissions().finally(() => {
        const allGranted = this.permissions.screenRecording === 'granted' && this.permissions.accessibility === 'granted';
        this.doctorTimer = setTimeout(doctor, allGranted ? 5 * 60_000 : 15_000);
        this.doctorTimer.unref();
      });
    };
    doctor();
  }

  stopMonitoring(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.doctorTimer) clearTimeout(this.doctorTimer);
    this.statusTimer = null;
    this.doctorTimer = null;
  }

  // ───────────────────────────── status ─────────────────────────────

  getStatus(): DeviceStatus {
    return {
      server: this.mirroir.info(),
      mirroring: this.mirroring,
      permissions: this.permissions,
      controlOwner: this.leaseRecord ? this.leaseRecord.lease.owner : 'none',
      stopLatched: this.stopLatched,
      stopReason: this.stopReason,
      queueDepth: this.queue.filter((j) => j.priority <= PRIORITY.observe).length,
      actionInFlight: this.running?.mutating ?? false,
      lastFocusSteal: this.lastFocusSteal,
    };
  }

  get geometry(): WindowGeometry | null {
    return this.mirroring.geometry;
  }

  get isStopLatched(): boolean {
    return this.stopLatched;
  }

  get currentLease(): Lease | null {
    return this.leaseRecord?.lease ?? null;
  }

  getLatestFrame(): Frame | null {
    return this.latestFrame;
  }

  /** Screenshots are only safe once Screen Recording is confirmed: without it Mirroir's fallback activates iPhone Mirroring (focus steal). */
  canCaptureScreen(): boolean {
    return this.permissions.screenRecording === 'granted' && this.mirroring.state === 'connected';
  }

  publishStatus(): void {
    if (this.statusPublishTimer) return;
    this.statusPublishTimer = setTimeout(() => {
      this.statusPublishTimer = null;
      this.hub.publish({ type: 'status', status: this.getStatus() });
    }, 50);
  }

  /** Reads Mirroir `status` (AX only — no capture, no focus change, never resumes). */
  async refreshStatus(): Promise<MirroringInfo> {
    if (!this.mirroir.isReady()) {
      return this.mirroring;
    }
    if (this.pendingStatus) return this.pendingStatus;
    this.pendingStatus = this.enqueue('status', PRIORITY.status, false, async () => {
      const out = await this.mirroir.call('status', {}, { timeoutMs: 10000 });
      return this.applyStatusText(out.text);
    }).finally(() => {
      this.pendingStatus = null;
    });
    return this.pendingStatus;
  }

  private applyStatusText(text: string): MirroringInfo {
    const parsed = parseStatus(text);
    const previous = this.mirroring;
    let geometry: WindowGeometry | null = null;
    if (parsed.geometry) {
      const sameSize =
        previous.geometry &&
        previous.geometry.widthPt === parsed.geometry.widthPt &&
        previous.geometry.heightPt === parsed.geometry.heightPt;
      geometry = sameSize && previous.geometry
        ? { ...previous.geometry, observedAt: Date.now() }
        : makeGeometry(parsed.geometry.widthPt, parsed.geometry.heightPt, parsed.geometry.orientation);
    }
    this.mirroring = {
      state: parsed.state,
      rawStatus: parsed.raw,
      target: this.settings.get().connection.target,
      geometry,
      checkedAt: Date.now(),
    };
    if (previous.state !== parsed.state) {
      this.onMirroringTransition(previous.state, parsed.state);
    }
    if (previous.geometry?.geometryId !== geometry?.geometryId || previous.state !== parsed.state) {
      this.publishStatus();
      this.emit('mirroring', this.mirroring);
    }
    return this.mirroring;
  }

  private onMirroringTransition(from: MirroringInfo['state'], to: MirroringInfo['state']): void {
    const summaries: Record<MirroringInfo['state'], string> = {
      connected: 'iPhone Mirroring is connected.',
      paused: 'iPhone Mirroring is paused — unlock the iPhone or click Resume.',
      not_running: 'iPhone Mirroring is not running.',
      no_window: 'iPhone Mirroring is running but no window was found (check Accessibility permission).',
      error: 'iPhone Mirroring status could not be read.',
      unknown: 'iPhone Mirroring status is unknown.',
    };
    if (from === 'unknown' && to === 'not_running') return;
    this.activity.record({
      category: 'connection',
      type: `mirroring.${to}`,
      actor: 'system',
      severity: to === 'connected' ? 'info' : 'warning',
      summary: summaries[to],
    });
    if (to === 'connected' && this.permissions.screenRecording !== 'granted') {
      void this.refreshPermissions();
    }
  }

  /** Runs `mirroir doctor --json` for Screen Recording / Accessibility (no TCC prompt, no focus change). */
  async refreshPermissions(): Promise<MacPermissions> {
    const checks = await this.mirroir.runDoctor();
    if (!checks) return this.permissions;
    const find = (name: string) => checks.find((c) => c.name === name);
    const capture = find('Screen capture');
    const ax = find('Accessibility');
    const next: MacPermissions = {
      screenRecording: capture ? (capture.status === 'passed' ? 'granted' : 'denied') : 'unknown',
      accessibility: ax ? (ax.status === 'passed' ? 'granted' : 'denied') : 'unknown',
      source: 'mirroir doctor',
      checkedAt: Date.now(),
    };
    const changed =
      next.screenRecording !== this.permissions.screenRecording || next.accessibility !== this.permissions.accessibility;
    this.permissions = next;
    if (changed) {
      this.activity.record({
        category: 'connection',
        type: 'permissions.checked',
        actor: 'system',
        severity: next.screenRecording === 'granted' && next.accessibility === 'granted' ? 'info' : 'warning',
        summary: `macOS permissions — Screen Recording: ${next.screenRecording}, Accessibility: ${next.accessibility}.`,
      });
      this.publishStatus();
      this.emit('permissions', next);
    }
    return next;
  }

  // ───────────────────────────── queue ─────────────────────────────

  private enqueue<T>(label: string, priority: JobPriority, mutating: boolean, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { id: newId('job'), label, priority, mutating, run, resolve, reject, enqueuedAt: Date.now() };
      // Insert after the last job of equal or higher priority (FIFO within a priority).
      let index = this.queue.length;
      while (index > 0 && this.queue[index - 1]!.priority > priority) index -= 1;
      this.queue.splice(index, 0, job as Job<unknown>);
      this.publishStatus();
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    if (job.mutating) this.publishStatus();
    try {
      job.resolve(await job.run());
    } catch (err) {
      job.reject(err);
    } finally {
      this.running = null;
      this.publishStatus();
      void this.pump();
    }
  }

  // ───────────────────────────── leases ─────────────────────────────

  /** Claims exclusive control for an AI task or workflow run. */
  acquireLease(owner: Lease['owner'], label: string): Lease {
    if (this.stopLatched) {
      throw new DeviceError('Emergency stop is engaged. Re-arm control first.', 'stop_latched');
    }
    if (this.leaseRecord) {
      throw new DeviceError(
        `${this.leaseRecord.lease.label} is already controlling the iPhone. Stop it first.`,
        'lease_conflict',
      );
    }
    const controller = new AbortController();
    const id = newId('lease');
    const lease: Lease = {
      id,
      owner,
      label,
      signal: controller.signal,
      paused: false,
      release: () => {
        if (this.leaseRecord?.lease.id === id) {
          this.leaseRecord = null;
          this.publishStatus();
        }
      },
    };
    this.leaseRecord = { lease, controller };
    this.publishStatus();
    return lease;
  }

  setLeasePaused(leaseId: string, paused: boolean): void {
    if (this.leaseRecord?.lease.id === leaseId) {
      this.leaseRecord.lease.paused = paused;
      this.publishStatus();
    }
  }

  // ───────────────────────────── emergency stop ─────────────────────────────

  async emergencyStop(reason: string, actor: Actor): Promise<void> {
    const alreadyLatched = this.stopLatched;
    this.stopLatched = true;
    this.stopReason = reason;
    const at = Date.now();
    this.hub.publish({ type: 'stop_engaged', reason, at });

    // 1. Abort whoever holds control (AI task / workflow run).
    if (this.leaseRecord) {
      this.leaseRecord.controller.abort(new DeviceError('Stopped by the emergency stop.', 'stop_latched'));
      this.leaseRecord = null;
    }
    // 2. Reject every queued input action.
    const rejected = this.queue.filter((j) => j.mutating);
    for (const job of rejected) {
      job.reject(new DeviceError('Cancelled by the emergency stop.', 'stop_latched'));
    }
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]!.mutating) this.queue.splice(i, 1);
    }
    // 3. An input call already executing cannot be cancelled over MCP; SIGTERM
    //    makes Mirroir interrupt playbacks and release held touches/keys.
    const inFlight = this.running?.mutating ? this.running.label : null;
    if (inFlight) {
      await this.mirroir.terminate(`Emergency stop during "${inFlight}"`);
      void this.mirroir.start();
    }
    this.emit('stop', { reason, actor });
    this.publishStatus();
    if (!alreadyLatched) {
      this.activity.record({
        category: 'security',
        type: 'stop.engaged',
        actor,
        severity: 'warning',
        summary: `Emergency stop engaged: ${reason}`,
        detail: {
          cancelledQueuedActions: rejected.length,
          interruptedInFlight: inFlight,
          note: inFlight
            ? 'Mirroir was terminated with SIGTERM to release held input. Input already delivered to macOS cannot be undone.'
            : 'No input was executing.',
        },
      });
    }
  }

  rearm(actor: Actor): void {
    if (!this.stopLatched) return;
    this.stopLatched = false;
    this.stopReason = null;
    this.hub.publish({ type: 'stop_released', at: Date.now() });
    this.activity.record({
      category: 'security',
      type: 'stop.released',
      actor,
      summary: 'Control re-armed after the emergency stop.',
    });
    this.publishStatus();
  }

  // ───────────────────────────── actions ─────────────────────────────

  async perform(action: DeviceAction, ctx: ActionContext): Promise<ActionResult> {
    this.assertAuthorized(action, ctx);
    const tool = ACTION_TOOL[action.kind];
    const label = `${ctx.actor}:${tool}`;
    return this.enqueue(label, PRIORITY.action, true, async () => {
      // Re-check at execution time: the stop may have fired while queued.
      this.assertAuthorized(action, ctx);
      if (!this.mirroir.isReady()) {
        throw new DeviceError('The Mirroir MCP server is not running.', 'mcp_unavailable', 503);
      }
      const info = await this.readLiveStatus();
      if (info.state !== 'connected') {
        throw new DeviceError(
          info.state === 'paused'
            ? 'iPhone Mirroring is paused. Unlock the iPhone or click Resume, then try again.'
            : `iPhone Mirroring is not connected (${info.rawStatus || info.state}).`,
          info.state === 'paused' ? 'paused' : 'not_connected',
        );
      }
      if (POINTER_KINDS.has(action.kind)) this.assertGeometry(action, ctx, info.geometry);

      const args = toolArgs(action);
      const started = Date.now();
      let outcome: ToolCallOutcome;
      try {
        outcome = await this.mirroir.call(tool, args, { timeoutMs: toolTimeout(action) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.recordAction(action, ctx, false, Date.now() - started, message);
        if (err instanceof McpUnavailableError) throw new DeviceError(message, 'mcp_unavailable', 503);
        throw new DeviceError(message, 'tool_failed', 502);
      }
      const focusChanged = FOCUS_STEALING_TOOLS.has(tool);
      if (focusChanged) {
        this.lastFocusSteal = Date.now();
        this.emit('focus_steal', { actor: ctx.actor, tool });
      }
      const durationMs = Date.now() - started;
      this.recordAction(action, ctx, outcome.ok, durationMs, outcome.text);
      if (!outcome.ok) {
        const kind = classifyInputError(outcome.text);
        if (kind === 'paused') void this.refreshStatus();
      }
      this.emit('action', { action, ctx, ok: outcome.ok });
      return { ok: outcome.ok, tool, durationMs, message: outcome.text, focusChanged };
    });
  }

  private assertAuthorized(action: DeviceAction, ctx: ActionContext): void {
    if (this.stopLatched) {
      throw new DeviceError('Emergency stop is engaged. Re-arm control to continue.', 'stop_latched');
    }
    if (ctx.decision.verdict === 'deny') {
      throw new DeviceError(ctx.decision.reasons[0] ?? 'Action denied by policy.', 'not_authorized', 403);
    }
    if (ctx.decision.verdict === 'require_approval' && !ctx.approvalId) {
      throw new DeviceError('This action needs approval first.', 'not_authorized', 403);
    }
    const lease = this.leaseRecord?.lease ?? null;
    if (ctx.actor === 'user' || ctx.actor === 'remote-user') {
      if (!this.settings.get().permissions.manualControlEnabled) {
        throw new DeviceError('Manual control is turned off.', 'not_authorized', 403);
      }
      if (ctx.actor === 'remote-user' && !ctx.remoteControlAllowed) {
        throw new DeviceError('This remote session is view-only.', 'not_authorized', 403);
      }
      if (lease && !lease.paused) {
        throw new DeviceError(`${lease.label} is controlling the iPhone. Pause or stop it to use manual control.`, 'lease_conflict');
      }
    } else if (ctx.actor === 'ai' || ctx.actor === 'workflow') {
      if (!lease || lease.id !== ctx.leaseId) {
        throw new DeviceError('This task no longer holds control of the iPhone.', 'lease_conflict');
      }
      if (lease.signal.aborted) throw new DeviceError('The task was stopped.', 'aborted');
    } else {
      throw new DeviceError('This actor cannot send input.', 'not_authorized', 403);
    }
    void action;
  }

  private assertGeometry(action: DeviceAction, ctx: ActionContext, geometry: WindowGeometry | null): void {
    if (!geometry) {
      throw new DeviceError('The iPhone window geometry is unknown, so touches are not sent. Refresh the screen.', 'geometry_unknown');
    }
    if (!ctx.geometryId) {
      throw new DeviceError('Touch coordinates must say which window geometry they were computed for.', 'geometry_unknown');
    }
    if (ctx.geometryId !== geometry.geometryId) {
      throw new DeviceError(
        `The iPhone window changed size (${ctx.geometryId} → ${geometry.geometryId}). Refresh the screen and try again.`,
        'geometry_changed',
      );
    }
    const points: [number, number][] = [];
    if ('x' in action) points.push([action.x, action.y]);
    if ('fromX' in action) points.push([action.fromX, action.fromY], [action.toX, action.toY]);
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x > geometry.widthPt || y > geometry.heightPt) {
        throw new DeviceError(
          `(${Math.round(x)}, ${Math.round(y)}) is outside the iPhone window (${geometry.widthPt}×${geometry.heightPt} pt).`,
          'out_of_bounds',
          400,
        );
      }
    }
  }

  /** Reads `status` inline (we are already inside a queued job). */
  private async readLiveStatus(): Promise<MirroringInfo> {
    const out = await this.mirroir.call('status', {}, { timeoutMs: 10000 });
    return this.applyStatusText(out.text);
  }

  private recordAction(action: DeviceAction, ctx: ActionContext, ok: boolean, durationMs: number, message: string): void {
    const settings = this.settings.get();
    const tool = ACTION_TOOL[action.kind];
    if ((ctx.actor === 'user' || ctx.actor === 'remote-user') && !settings.permissions.auditManualActions) return;
    const { kind: _kind, ...rest } = action;
    const args = redactToolArgs(tool, rest as Record<string, unknown>, { keepTypedText: settings.privacy.logTypedText });
    this.activity.record({
      category: ctx.actor === 'ai' ? 'ai' : ctx.actor === 'workflow' ? 'workflow' : 'manual',
      type: 'tool.call',
      actor: ctx.actor,
      severity: ok ? 'info' : 'warning',
      summary: `${describeAction(action, settings.privacy.logTypedText)} — ${ok ? 'done' : `failed: ${firstLine(message)}`}`,
      tool,
      success: ok,
      durationMs,
      taskId: ctx.taskId ?? null,
      workflowRunId: ctx.workflowRunId ?? null,
      detail: {
        args,
        result: ok ? firstLine(message) : message.slice(0, 500),
        approvalId: ctx.approvalId ?? null,
        policy: { verdict: ctx.decision.verdict, rules: ctx.decision.rules },
      },
    });
  }

  // ───────────────────────────── observation ─────────────────────────────

  /**
   * Captures a screenshot. `settleMs` > 0 waits until two consecutive frames
   * match (Mirroir polls every 60 ms) — used after actions.
   * `allowResume` must be true for user-initiated captures while paused,
   * because Mirroir presses the Resume button in that case.
   */
  async captureFrame(options: { settleMs?: number; reason?: string; allowResume?: boolean; priority?: 'frame' | 'observe' } = {}): Promise<Frame> {
    this.assertCaptureAllowed(options.allowResume === true);
    const priority = options.priority === 'observe' ? PRIORITY.observe : PRIORITY.frame;
    if (priority === PRIORITY.frame && this.pendingFrame) return this.pendingFrame;
    const promise = this.enqueue('screenshot', priority, false, async () => {
      this.assertCaptureAllowed(options.allowResume === true);
      const settle = Math.max(0, Math.min(options.settleMs ?? 0, 5000));
      const started = Date.now();
      const out = await this.mirroir.call('screenshot', { settle_ms: settle }, { timeoutMs: 20000 + settle });
      if (!out.ok || out.images.length === 0) {
        throw new DeviceError(out.text || 'Screenshot failed.', 'tool_failed', 502);
      }
      return this.storeFrame(out.images[0]!.data, out.images[0]!.mimeType, Date.now() - started);
    });
    if (priority === PRIORITY.frame) {
      this.pendingFrame = promise.finally(() => {
        this.pendingFrame = null;
      });
      return this.pendingFrame;
    }
    return promise;
  }

  private assertCaptureAllowed(allowResume: boolean): void {
    if (!this.mirroir.isReady()) throw new DeviceError('The Mirroir MCP server is not running.', 'mcp_unavailable', 503);
    if (this.permissions.screenRecording !== 'granted') {
      throw new DeviceError(
        'Screen Recording permission is not confirmed for iPhone AI, so screenshots are not taken (Mirroir would fall back to activating the Mirroring window).',
        'screen_capture_unavailable',
        412,
      );
    }
    const state = this.mirroring.state;
    if (state === 'paused' && !allowResume) {
      throw new DeviceError('iPhone Mirroring is paused. Unlock the iPhone or click Resume.', 'paused');
    }
    if (state !== 'connected' && state !== 'paused') {
      throw new DeviceError('iPhone Mirroring is not connected.', 'not_connected');
    }
  }

  private storeFrame(base64: string, mimeType: string, latencyMs: number): Frame {
    const data = Buffer.from(base64, 'base64');
    const dims = base64PngDimensions(base64) ?? { width: 0, height: 0 };
    const geometry = this.mirroring.geometry;
    this.frameSeq += 1;
    const meta: FrameMeta = {
      seq: this.frameSeq,
      capturedAt: Date.now(),
      latencyMs,
      widthPx: dims.width,
      heightPx: dims.height,
      mimeType,
      pxPerPt: geometry && dims.width > 0 ? dims.width / geometry.widthPt : null,
      geometry,
    };
    const frame: Frame = { meta, data };
    this.latestFrame = frame;
    this.hub.publish({ type: 'frame', meta });
    this.emit('frame', frame);
    return frame;
  }

  /**
   * OCR description of the screen (Mirroir describe_screen, never with
   * scroll:true — that variant really swipes the phone).
   */
  async describe(options: { includeImage?: boolean; settleFirst?: boolean; allowResume?: boolean } = {}): Promise<ScreenDescription> {
    this.assertCaptureAllowed(options.allowResume === true);
    return this.enqueue('describe_screen', PRIORITY.observe, false, async () => {
      this.assertCaptureAllowed(options.allowResume === true);
      if (options.settleFirst) {
        const settled = await this.mirroir.call('screenshot', { settle_ms: 1500 }, { timeoutMs: 25000 });
        if (settled.ok && settled.images[0]) this.storeFrame(settled.images[0].data, settled.images[0].mimeType, settled.durationMs);
      }
      const out = await this.mirroir.call(
        'describe_screen',
        { omit_screenshot: options.includeImage === false },
        { timeoutMs: this.describeWarm ? 30000 : 90000 },
      );
      if (!out.ok) throw new DeviceError(out.text || 'describe_screen failed.', 'tool_failed', 502);
      this.describeWarm = true;
      const parsed = parseDescribeScreen(out.text);
      const image = out.images[0] ?? null;
      return {
        capturedAt: Date.now(),
        elements: parsed.elements,
        rawText: out.text,
        imageBase64: image?.data ?? null,
        imageMimeType: image?.mimeType ?? null,
        geometry: this.mirroring.geometry,
        fingerprint: screenFingerprint(parsed.elements),
      };
    });
  }

  /** Runs check_health on demand (it can activate Mirroring if capture fails, so only when the user asks). */
  async checkHealth(): Promise<ToolCallOutcome> {
    return this.enqueue('check_health', PRIORITY.observe, false, () => this.mirroir.call('check_health', {}, { timeoutMs: 90000 }));
  }

  /** Raw read-only tool call for diagnostics (list_targets, get_orientation, list_skills…). */
  async readOnlyCall(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
    const allowed = new Set(['status', 'get_orientation', 'list_targets', 'list_skills', 'get_skill']);
    if (!allowed.has(tool)) throw new DeviceError(`"${tool}" is not available as a diagnostic call.`, 'not_authorized', 403);
    return this.enqueue(tool, PRIORITY.status, false, () => this.mirroir.call(tool, args, { timeoutMs: 15000 }));
  }

  /** Brings iPhone AI back to the front after an input tool activated iPhone Mirroring (desktop app only). */
  refocusApp(): void {
    const bundleId = process.env.IPHONE_AI_BUNDLE_ID;
    if (!bundleId) return;
    const child = spawn('/usr/bin/open', ['-b', bundleId], { stdio: 'ignore', detached: false });
    child.on('error', () => undefined);
  }

  /** Opens Apple's iPhone Mirroring app (user request; launching it is not device input). */
  openMirroringApp(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('/usr/bin/open', ['-a', 'iPhone Mirroring'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => {
        setTimeout(() => void this.refreshStatus().catch(() => undefined), 1500);
        resolve(code === 0);
      });
    });
  }

  currentGeometryId(): string | null {
    const g = this.mirroring.geometry;
    return g ? geometryId(g.widthPt, g.heightPt) : null;
  }
}

function toolArgs(action: DeviceAction): Record<string, unknown> {
  switch (action.kind) {
    case 'tap':
    case 'double_tap':
      return { x: action.x, y: action.y, cursor_mode: 'preserving' };
    case 'long_press':
      return { x: action.x, y: action.y, duration_ms: action.durationMs ?? 600, cursor_mode: 'preserving' };
    case 'swipe':
    case 'drag':
      return {
        from_x: action.fromX,
        from_y: action.fromY,
        to_x: action.toX,
        to_y: action.toY,
        ...(action.durationMs ? { duration_ms: action.durationMs } : {}),
        cursor_mode: 'preserving',
      };
    case 'type_text':
      return { text: action.text };
    case 'press_key':
      return { key: action.key.toLowerCase(), ...(action.modifiers?.length ? { modifiers: action.modifiers } : {}) };
    case 'launch_app':
      return { name: action.name };
    case 'open_url':
      return { url: action.url };
    case 'scroll_to':
      return {
        label: action.label,
        ...(action.direction ? { direction: action.direction } : {}),
        ...(action.maxScrolls ? { max_scrolls: action.maxScrolls } : {}),
      };
    default:
      return {};
  }
}

/** Generous per-tool timeouts (Mirroir may auto-resume a paused session for ~6 s first). */
function toolTimeout(action: DeviceAction): number {
  const base = 12000;
  switch (action.kind) {
    case 'long_press':
      return base + (action.durationMs ?? 600);
    case 'swipe':
    case 'drag':
      return base + (action.durationMs ?? 1000) + 3000;
    case 'type_text':
      return base + [...action.text].length * 80 + 4000;
    case 'launch_app':
      return 40000;
    case 'scroll_to':
      return 15000 + (action.maxScrolls ?? 10) * 4000;
    case 'press_back':
      return 30000;
    default:
      return base;
  }
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

export function describeAction(action: DeviceAction, showTypedText = false): string {
  switch (action.kind) {
    case 'tap':
      return `Tap at (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'double_tap':
      return `Double-tap at (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'long_press':
      return `Long-press at (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case 'swipe':
      return `Swipe from (${Math.round(action.fromX)}, ${Math.round(action.fromY)}) to (${Math.round(action.toX)}, ${Math.round(action.toY)})`;
    case 'drag':
      return `Drag from (${Math.round(action.fromX)}, ${Math.round(action.fromY)}) to (${Math.round(action.toX)}, ${Math.round(action.toY)})`;
    case 'type_text':
      return showTypedText ? `Type "${action.text.slice(0, 80)}"` : `Type ${[...action.text].length} characters`;
    case 'press_key':
      return `Press ${[...(action.modifiers ?? []), action.key].join('+')}`;
    case 'press_home':
      return 'Go to the Home Screen';
    case 'press_back':
      return 'Go back';
    case 'press_app_switcher':
      return 'Open the App Switcher';
    case 'spotlight':
      return 'Open Spotlight';
    case 'launch_app':
      return `Open ${action.name}`;
    case 'open_url':
      return 'Open a link';
    case 'scroll_to':
      return `Scroll to "${action.label}"`;
  }
}
