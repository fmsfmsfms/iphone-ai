// Narrow dependency contracts for the automation package, so the workflow
// engine and recorder can be exercised against fakes in tests while main.ts
// passes the real DeviceController / AgentService / ApprovalBroker.

import type {
  ActionResult,
  DeviceAction,
  DeviceStatus,
  ScreenDescription,
  WindowGeometry,
} from '@iphone-ai/shared';

import type { ActivityLog } from '../core/activity-log.js';
import type { EventHub } from '../core/events.js';
import type { Logger } from '../core/logger.js';
import type { AppPaths } from '../core/paths.js';
import type { AgentServiceApi } from '../core/services.js';
import type { SettingsStore } from '../core/settings-store.js';
import type { ScreenshotStore } from '../ai/screenshots.js';
import type { Database } from '../db/database.js';
import type { ActionContext, Frame, Lease } from '../device/device-controller.js';
import type { ApprovalBroker } from '../policy/approvals.js';

/** Payload of DeviceController's 'action' event (emitted after every executed device action). */
export interface DeviceActionEvent {
  action: DeviceAction;
  ctx: ActionContext;
  ok: boolean;
}

export type DeviceActionListener = (event: DeviceActionEvent) => void;

/** The subset of DeviceController the workflow engine and recorder use. */
export interface WorkflowDevice {
  acquireLease(owner: Lease['owner'], label: string): Lease;
  setLeasePaused(leaseId: string, paused: boolean): void;
  perform(action: DeviceAction, ctx: ActionContext): Promise<ActionResult>;
  describe(options?: { includeImage?: boolean; settleFirst?: boolean; allowResume?: boolean }): Promise<ScreenDescription>;
  captureFrame(options?: {
    settleMs?: number;
    reason?: string;
    allowResume?: boolean;
    priority?: 'frame' | 'observe';
  }): Promise<Frame>;
  getStatus(): Pick<DeviceStatus, 'mirroring' | 'stopLatched'>;
  readonly geometry: WindowGeometry | null;
  readonly isStopLatched: boolean;
  readonly currentLease: Lease | null;
  canCaptureScreen(): boolean;
  on(event: 'action', listener: DeviceActionListener): unknown;
  off(event: 'action', listener: DeviceActionListener): unknown;
}

/** Agent features used by workflows (ai_task incl. pause/resume, read_screen, suggestions). */
export type WorkflowAgents = Pick<
  AgentServiceApi,
  'getProvider' | 'runEmbeddedTask' | 'activeTask' | 'pauseTask' | 'resumeTask' | 'cancelTask'
>;

/** Tunable delays. Production uses the defaults; tests shorten them. */
export interface AutomationTiming {
  /** Extra describe attempts when a text label is not on screen yet. */
  findRetries: number;
  findRetryDelayMs: number;
  /** settle_ms for screenshot steps. */
  screenshotSettleMs: number;
  /** Delay before the recorder re-reads the screen after a recorded action. */
  recorderSnapshotDelayMs: number;
}

export const DEFAULT_AUTOMATION_TIMING: AutomationTiming = {
  findRetries: 3,
  findRetryDelayMs: 1000,
  screenshotSettleMs: 800,
  recorderSnapshotDelayMs: 700,
};

export interface WorkflowServiceDeps {
  db: Database;
  settings: SettingsStore;
  hub: EventHub;
  activity: ActivityLog;
  approvals: ApprovalBroker;
  screenshots: Pick<ScreenshotStore, 'put'>;
  paths: Pick<AppPaths, 'mirroirSkillsDir'>;
  agents: WorkflowAgents;
  device: WorkflowDevice;
  log: Logger;
  timing?: Partial<AutomationTiming>;
}

export type WorkflowErrorCode =
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'mode'
  | 'stop_latched'
  | 'lease_conflict'
  | 'not_connected'
  | 'ai_unavailable'
  | 'ai_bad_response';

/** Error with an HTTP status, shaped like DeviceError ({ code, status }) for the HTTP layer. */
export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowErrorCode,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
