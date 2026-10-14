// Test doubles for the automation package: a fake iPhone (screens of OCR
// elements on a 410×898 pt window; actions move between screens), a fake agent
// service, and a harness wiring the real DB / settings / approvals / activity.

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ACTION_TOOL,
  DEFAULT_PROVIDERS,
  type ActionResult,
  type AgentTask,
  type ApprovalRequest,
  type DeviceAction,
  type MirroringState,
  type ScreenDescription,
  type ScreenElement,
  type WindowGeometry,
  type WorkflowRun,
} from '@iphone-ai/shared';

import { ScreenshotStore } from '../../src/ai/screenshots.js';
import type { AiProvider, ModelContent, TurnProvider } from '../../src/ai/types.js';
import { WorkflowService } from '../../src/automation/workflow-service.js';
import type { WorkflowAgents, WorkflowDevice } from '../../src/automation/types.js';
import { ActivityLog } from '../../src/core/activity-log.js';
import { EventHub } from '../../src/core/events.js';
import { silentLogger } from '../../src/core/logger.js';
import { resolveAppPaths, type AppPaths } from '../../src/core/paths.js';
import type { EmbeddedTaskOptions, EmbeddedTaskResult } from '../../src/core/services.js';
import { SettingsStore } from '../../src/core/settings-store.js';
import { Database } from '../../src/db/database.js';
import type { ActionContext, Frame, Lease } from '../../src/device/device-controller.js';
import { ApprovalBroker } from '../../src/policy/approvals.js';

type ElementSpec = Omit<ScreenElement, 'id'>;

export const SCREENS: Record<string, ElementSpec[]> = {
  home: [
    { label: '9:41', x: 40, y: 20 },
    { label: 'Messages', x: 100, y: 600 },
    { label: 'Settings', x: 300, y: 600 },
    { label: 'Wallet', x: 200, y: 700 },
  ],
  settings: [
    { label: 'Settings', x: 205, y: 100 },
    { label: 'Wi-Fi', x: 205, y: 260 },
    { label: 'General', x: 205, y: 340 },
  ],
  general: [
    { label: 'General', x: 205, y: 100 },
    { label: 'About', x: 205, y: 300 },
    { label: 'Software Update', x: 205, y: 360 },
  ],
  about: [
    { label: 'About', x: 205, y: 100 },
    { label: 'Name', x: 80, y: 200 },
    { label: 'iPhone 17', x: 300, y: 200 },
  ],
};

/** "<screen>:<tapped label>" → next screen. */
const TAP_TRANSITIONS: Record<string, string> = {
  'home:Settings': 'settings',
  'settings:General': 'general',
  'general:About': 'about',
};

class FakeDeviceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

export class FakeDevice extends EventEmitter implements WorkflowDevice {
  screens: Record<string, ElementSpec[]> = structuredClone(SCREENS);
  current = 'home';
  geometryValue: WindowGeometry | null = { widthPt: 410, heightPt: 898, orientation: 'portrait', geometryId: '410x898', observedAt: Date.now() };
  mirroringState: MirroringState = 'connected';
  captureAllowed = true;
  stopLatched = false;
  performDelayMs = 0;
  /**
   * Runs while an action waits in the device lane (after it was accepted, before
   * it executes) — e.g. to pause or stop the run in that window. The action is
   * then checked again at execution time, like DeviceController does.
   */
  whileQueued: ((action: DeviceAction, ctx: ActionContext) => void | Promise<void>) | null = null;
  readonly performed: { action: DeviceAction; ctx: ActionContext }[] = [];
  readonly leasePausedHistory: boolean[] = [];
  describeCount = 0;
  private leaseState: { lease: Lease; controller: AbortController } | null = null;
  private leaseCounter = 0;

  get geometry(): WindowGeometry | null {
    return this.geometryValue;
  }

  get isStopLatched(): boolean {
    return this.stopLatched;
  }

  get currentLease(): Lease | null {
    return this.leaseState?.lease ?? null;
  }

  acquireLease(owner: Lease['owner'], label: string): Lease {
    if (this.stopLatched) throw new FakeDeviceError('Emergency stop is engaged.', 'stop_latched');
    if (this.leaseState) throw new FakeDeviceError(`${this.leaseState.lease.label} is already controlling the iPhone.`, 'lease_conflict');
    const controller = new AbortController();
    this.leaseCounter += 1;
    const id = `lease_${this.leaseCounter}`;
    const lease: Lease = {
      id,
      owner,
      label,
      signal: controller.signal,
      paused: false,
      release: () => {
        if (this.leaseState?.lease.id === id) this.leaseState = null;
      },
    };
    this.leaseState = { lease, controller };
    return lease;
  }

  setLeasePaused(leaseId: string, paused: boolean): void {
    if (this.leaseState?.lease.id === leaseId && this.leaseState.lease.paused !== paused) {
      this.leaseState.lease.paused = paused;
      this.leasePausedHistory.push(paused);
    }
  }

  emergencyStop(): void {
    this.stopLatched = true;
    if (this.leaseState) {
      this.leaseState.controller.abort(new FakeDeviceError('Stopped by the emergency stop.', 'stop_latched'));
      this.leaseState = null;
    }
  }

  async perform(action: DeviceAction, ctx: ActionContext): Promise<ActionResult> {
    this.assertAuthorized(action, ctx);
    if (this.whileQueued) {
      await this.whileQueued(action, ctx);
      this.assertAuthorized(action, ctx);
    }
    if (this.performDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.performDelayMs));
    this.performed.push({ action, ctx });
    this.applyTransition(action);
    this.emit('action', { action, ctx, ok: true });
    return { ok: true, tool: ACTION_TOOL[action.kind], durationMs: 1, message: 'ok', focusChanged: false };
  }

  private assertAuthorized(action: DeviceAction, ctx: ActionContext): void {
    if (this.stopLatched) throw new FakeDeviceError('Emergency stop is engaged.', 'stop_latched');
    if (ctx.signal?.aborted) throw new FakeDeviceError('The task was cancelled before this action ran.', 'aborted');
    if (ctx.decision.verdict === 'deny') throw new FakeDeviceError('Denied by policy.', 'not_authorized');
    if (ctx.decision.verdict === 'require_approval' && !ctx.approvalId) {
      throw new FakeDeviceError('This action needs approval first.', 'not_authorized');
    }
    if (ctx.actor === 'workflow' || ctx.actor === 'ai') {
      const lease = this.leaseState?.lease;
      if (!lease || lease.id !== ctx.leaseId) throw new FakeDeviceError('No longer holds control.', 'lease_conflict');
      if (lease.paused) throw new FakeDeviceError('The task was paused before this action ran; it was not executed.', 'lease_paused');
    }
    if (['tap', 'double_tap', 'long_press', 'swipe', 'drag'].includes(action.kind) && ctx.geometryId !== this.geometryValue?.geometryId) {
      throw new FakeDeviceError('The iPhone window changed size.', 'geometry_changed');
    }
  }

  private applyTransition(action: DeviceAction): void {
    switch (action.kind) {
      case 'launch_app':
        if (action.name === 'Settings') this.current = 'settings';
        break;
      case 'press_home':
        this.current = 'home';
        break;
      case 'tap': {
        const element = (this.screens[this.current] ?? []).find((e) => e.x === action.x && e.y === action.y);
        const next = element ? TAP_TRANSITIONS[`${this.current}:${element.label}`] : undefined;
        if (next) this.current = next;
        break;
      }
      default:
        break;
    }
  }

  async describe(options: { includeImage?: boolean } = {}): Promise<ScreenDescription> {
    if (!this.canCaptureScreen()) throw new FakeDeviceError('Screen capture unavailable.', 'screen_capture_unavailable');
    this.describeCount += 1;
    const elements = (this.screens[this.current] ?? []).map((e, i) => ({ id: `e${i + 1}`, ...e }));
    return {
      capturedAt: Date.now(),
      elements,
      rawText: elements.map((e) => `- "${e.label}" at (${e.x}, ${e.y})`).join('\n'),
      imageBase64: options.includeImage ? Buffer.from('fake-png').toString('base64') : null,
      imageMimeType: options.includeImage ? 'image/png' : null,
      geometry: this.geometryValue,
      fingerprint: this.current,
    };
  }

  async captureFrame(): Promise<Frame> {
    if (!this.canCaptureScreen()) throw new FakeDeviceError('Screen capture unavailable.', 'screen_capture_unavailable');
    return {
      meta: {
        seq: 1,
        capturedAt: Date.now(),
        latencyMs: 1,
        widthPx: 820,
        heightPx: 1796,
        mimeType: 'image/png',
        pxPerPt: 2,
        geometry: this.geometryValue,
      },
      data: Buffer.from('fake-png'),
    };
  }

  getStatus(): { mirroring: { state: MirroringState; rawStatus: string; target: string; geometry: WindowGeometry | null; checkedAt: number }; stopLatched: boolean } {
    return {
      mirroring: { state: this.mirroringState, rawStatus: '', target: 'iphone', geometry: this.geometryValue, checkedAt: Date.now() },
      stopLatched: this.stopLatched,
    };
  }

  canCaptureScreen(): boolean {
    return this.captureAllowed && this.mirroringState === 'connected';
  }

  /** Simulates a manual action on the live viewer (as DeviceController emits it). */
  emitManual(action: DeviceAction, ok = true, actor: ActionContext['actor'] = 'user'): void {
    this.emit('action', {
      action,
      ctx: { actor, geometryId: this.geometryValue?.geometryId ?? null, decision: { verdict: 'allow', risk: 'low', reasons: [], rules: [] } },
      ok,
    });
  }
}

export class FakeAgents implements WorkflowAgents {
  /** Replies returned by provider.complete(), in order. */
  readonly replies: string[] = [];
  readonly completions: { system: string; content: ModelContent[] }[] = [];
  readonly embedded: EmbeddedTaskOptions[] = [];
  readonly taskControl: string[] = [];
  providerAvailable = true;
  embeddedResult: EmbeddedTaskResult = { success: true, verified: true, summary: 'Done', taskId: 'task_fake' };
  /** When set, runEmbeddedTask waits for this promise (simulates a long AI step). */
  embeddedGate: Promise<void> | null = null;
  private running: AgentTask | null = null;

  activeTask(): AgentTask | null {
    return this.running;
  }

  pauseTask(id: string): AgentTask {
    if (!this.running || this.running.id !== id) throw new Error('No such task');
    this.taskControl.push(`pause:${id}`);
    this.running = { ...this.running, status: 'paused' };
    return this.running;
  }

  resumeTask(id: string): AgentTask {
    if (!this.running || this.running.id !== id) throw new Error('No such task');
    this.taskControl.push(`resume:${id}`);
    this.running = { ...this.running, status: 'running' };
    return this.running;
  }

  cancelTask(id: string, reason: string): AgentTask {
    if (!this.running || this.running.id !== id) throw new Error('No such task');
    this.taskControl.push(`cancel:${id}`);
    this.running = { ...this.running, status: 'cancelled', error: reason };
    this.cancelEmbedded?.();
    return this.running;
  }

  private cancelEmbedded: (() => void) | null = null;

  async getProvider(): Promise<AiProvider> {
    if (!this.providerAvailable) throw new Error('No API key is stored for this provider.');
    const provider: TurnProvider = {
      kind: 'turn',
      config: { ...DEFAULT_PROVIDERS[3]!, id: 'fake-local', label: 'Fake local model', model: 'fake', cloud: false, vision: false },
      runTurn: async () => {
        throw new Error('runTurn is not used by workflows');
      },
      complete: async (request) => {
        this.completions.push({ system: request.system, content: request.content });
        return this.replies.shift() ?? '';
      },
      test: async () => ({ ok: true, latencyMs: 1, message: 'ok', model: 'fake', supportsTools: true, supportsVision: false }),
    };
    return provider;
  }

  async runEmbeddedTask(options: EmbeddedTaskOptions): Promise<EmbeddedTaskResult> {
    this.embedded.push(options);
    this.running = {
      id: this.embeddedResult.taskId,
      conversationId: 'workflow-steps',
      instruction: options.instruction,
      status: 'running',
      providerId: 'fake-local',
      providerLabel: 'Fake local model',
      model: 'fake',
      mode: 'supervised',
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      actionsUsed: 0,
      maxActions: options.maxActions ?? 25,
      currentActivity: null,
      outcome: null,
      error: null,
    };
    // Like the real agent service: a paused task only wakes on resume or cancelTask (not on abort).
    const cancelled = new Promise<'cancelled'>((resolve) => {
      this.cancelEmbedded = () => resolve('cancelled');
    });
    try {
      if (this.embeddedGate) {
        const outcome = await Promise.race([this.embeddedGate, cancelled]);
        if (outcome === 'cancelled') return { ...this.embeddedResult, success: false, summary: 'Cancelled' };
      }
      return this.embeddedResult;
    } finally {
      this.running = null;
      this.cancelEmbedded = null;
    }
  }
}

export interface Harness {
  service: WorkflowService;
  device: FakeDevice;
  agents: FakeAgents;
  db: Database;
  hub: EventHub;
  settings: SettingsStore;
  activity: ActivityLog;
  approvals: ApprovalBroker;
  paths: AppPaths;
  runEvents: WorkflowRun[];
  cleanup(): void;
}

export function createHarness(): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'iphone-ai-automation-'));
  const paths = resolveAppPaths({ dataDir });
  const db = new Database(':memory:');
  const hub = new EventHub();
  const settings = new SettingsStore(db);
  settings.mutate((draft) => {
    draft.permissions.controlMode = 'supervised';
    // Short settle delay for tests (the public schema minimum is 100 ms).
    draft.ai.settleDelayMs = 5;
  });
  const activity = new ActivityLog(db, hub, 'session_test');
  const approvals = new ApprovalBroker(db, hub, activity);
  const screenshots = new ScreenshotStore(db, paths, settings);
  const device = new FakeDevice();
  const agents = new FakeAgents();
  const runEvents: WorkflowRun[] = [];
  hub.subscribe((event) => {
    if (event.type === 'workflow_run') runEvents.push(event.run);
  });
  const service = new WorkflowService({
    db,
    settings,
    hub,
    activity,
    approvals,
    screenshots,
    paths,
    agents,
    device,
    log: silentLogger,
    timing: { findRetries: 3, findRetryDelayMs: 10, screenshotSettleMs: 0, recorderSnapshotDelayMs: 10 },
  });
  return {
    service,
    device,
    agents,
    db,
    hub,
    settings,
    activity,
    approvals,
    paths,
    runEvents,
    cleanup: () => {
      approvals.cancelAll('test finished');
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Decides every approval request with `decide` (asynchronously, as a user would). */
export function autoDecide(
  h: Harness,
  decide: (approval: ApprovalRequest) => 'approved' | 'rejected' | null,
): { requests: ApprovalRequest[]; unsubscribe: () => void } {
  const requests: ApprovalRequest[] = [];
  const unsubscribe = h.hub.subscribe((event) => {
    if (event.type !== 'approval_requested') return;
    requests.push(event.approval);
    const decision = decide(event.approval);
    if (decision) setTimeout(() => h.approvals.decide(event.approval.id, decision, 'test-user'), 0);
  });
  return { requests, unsubscribe };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
