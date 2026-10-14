// Records manual control as workflow steps. Listens to the DeviceController's
// 'action' events (successful manual actions only) and converts each into a
// step, preferring visible text labels over coordinates. A fresh OCR snapshot
// is taken at start and shortly after each recorded action; a tap is only
// labelled from a snapshot taken after the previous action (else it is kept
// as a point, so a stale screen never produces a wrong label).

import type { ScreenElement, WorkflowStep } from '@iphone-ai/shared';

import type { Logger } from '../core/logger.js';
import type { RecorderStatus } from '../core/services.js';
import { matchElement } from '../device/element-matcher.js';
import { screenHasAuthPrompt } from '../policy/engine.js';
import { classifySwipe, formatKeyCombo, nearestElement } from './steps.js';
import {
  WorkflowError,
  type AutomationTiming,
  type DeviceActionEvent,
  type DeviceActionListener,
  type WorkflowDevice,
} from './types.js';

const MAX_RECORDED_STEPS = 200;
const LABEL_RADIUS_PT = 30;
const SECRET_FIELD = /pass(word|code)|\bpin\b|\bcode\b|verification|one[- ]time|\botp\b|2fa|security code|كلمة المرور|رمز/i;

interface Snapshot {
  elements: ScreenElement[];
  capturedAt: number;
}

export interface RecordingResult {
  name: string;
  startedAt: number;
  steps: WorkflowStep[];
  /** Actions that could not be turned into steps (shown in the saved workflow's description). */
  notes: string[];
}

export class WorkflowRecorder {
  private recording = false;
  private name: string | null = null;
  private startedAt: number | null = null;
  private steps: WorkflowStep[] = [];
  private notes: string[] = [];
  private snapshot: Snapshot | null = null;
  /** True after an action until the screen has been re-read. */
  private snapshotStale = true;
  private actionSeq = 0;
  private generation = 0;
  private counter = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listener: DeviceActionListener = (event) => this.onAction(event);

  constructor(
    private readonly device: WorkflowDevice,
    private readonly log: Logger,
    private readonly timing: AutomationTiming,
  ) {}

  status(): RecorderStatus {
    return { recording: this.recording, name: this.name, startedAt: this.startedAt, steps: this.steps.length };
  }

  start(name: string): RecorderStatus {
    if (this.recording) throw new WorkflowError('A recording is already in progress. Stop it first.', 'conflict');
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed) throw new WorkflowError('Give the recording a name.', 'invalid', 400);
    this.generation += 1;
    this.recording = true;
    this.name = trimmed;
    this.startedAt = Date.now();
    this.steps = [];
    this.notes = [];
    this.snapshot = null;
    this.snapshotStale = true;
    this.counter = 0;
    this.device.on('action', this.listener);
    void this.refresh(this.generation);
    return this.status();
  }

  stop(): RecordingResult | null {
    if (!this.recording || this.name === null || this.startedAt === null) return null;
    this.device.off('action', this.listener);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.generation += 1;
    const result: RecordingResult = { name: this.name, startedAt: this.startedAt, steps: this.steps, notes: this.notes };
    this.recording = false;
    this.name = null;
    this.startedAt = null;
    this.steps = [];
    this.notes = [];
    this.snapshot = null;
    return result;
  }

  /** Resolves once no screen refresh is scheduled or running (tests and UI hints). */
  async settled(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (this.refreshing) {
        await this.refreshing;
        continue;
      }
      if (this.refreshTimer) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(10, this.timing.recorderSnapshotDelayMs / 2)));
        continue;
      }
      return;
    }
  }

  private onAction(event: DeviceActionEvent): void {
    if (!this.recording || !event.ok) return;
    if (event.ctx.actor !== 'user' && event.ctx.actor !== 'remote-user') return;
    this.actionSeq += 1;
    try {
      const step = this.convert(event);
      if (step) {
        if (this.steps.length >= MAX_RECORDED_STEPS) {
          if (!this.notes.some((n) => n.startsWith('Recording limit'))) {
            this.notes.push(`Recording limit reached: only the first ${MAX_RECORDED_STEPS} steps were kept.`);
          }
        } else {
          this.steps.push(step);
        }
      }
    } catch (err) {
      this.log.warn('Could not record a manual action', { error: err instanceof Error ? err.message : String(err) });
    }
    this.snapshotStale = true;
    this.scheduleRefresh();
  }

  private nextId(): string {
    this.counter += 1;
    return `s${this.counter}`;
  }

  private convert(event: DeviceActionEvent): WorkflowStep | null {
    const { action, ctx } = event;
    const fresh = this.snapshot && !this.snapshotStale ? this.snapshot : null;
    switch (action.kind) {
      case 'tap': {
        const label = fresh ? this.labelAt(fresh.elements, action.x, action.y) : null;
        if (label) return { id: this.nextId(), type: 'tap_text', label };
        return {
          id: this.nextId(),
          type: 'tap_point',
          x: Math.round(action.x),
          y: Math.round(action.y),
          geometryId: ctx.geometryId ?? this.device.geometry?.geometryId ?? null,
        };
      }
      case 'long_press': {
        const label = fresh ? this.labelAt(fresh.elements, action.x, action.y) : null;
        if (label) return { id: this.nextId(), type: 'long_press_text', label };
        this.notes.push(`A long press at (${Math.round(action.x)}, ${Math.round(action.y)}) had no readable label nearby and was not recorded.`);
        return null;
      }
      case 'double_tap':
        this.notes.push(`A double-tap at (${Math.round(action.x)}, ${Math.round(action.y)}) was not recorded (workflows have no double-tap step).`);
        return null;
      case 'swipe': {
        const g = this.device.geometry;
        const { direction, distance } = classifySwipe(action.fromX, action.fromY, action.toX, action.toY, g?.widthPt ?? null, g?.heightPt ?? null);
        return { id: this.nextId(), type: 'swipe', direction, distance };
      }
      case 'drag':
        this.notes.push('A drag was not recorded (workflows have no drag step).');
        return null;
      case 'type_text': {
        const texts = (this.snapshot?.elements ?? []).map((e) => e.label);
        // Without any screen information we cannot tell, so treat the text as sensitive.
        const sensitive = this.snapshot === null || screenHasAuthPrompt(texts) !== null || texts.some((t) => SECRET_FIELD.test(t));
        return { id: this.nextId(), type: 'type_text', text: action.text, ...(sensitive ? { sensitive: true } : {}) };
      }
      case 'press_key':
        return { id: this.nextId(), type: 'press_key', key: formatKeyCombo(action.key, action.modifiers) };
      case 'press_home':
        return { id: this.nextId(), type: 'press_home' };
      case 'press_back':
        return { id: this.nextId(), type: 'press_back' };
      case 'launch_app':
        return { id: this.nextId(), type: 'launch_app', app: action.name };
      case 'scroll_to':
        return { id: this.nextId(), type: 'scroll_to', label: action.label, ...(action.direction ? { direction: action.direction } : {}) };
      case 'press_app_switcher':
        this.notes.push('Opening the App Switcher was not recorded.');
        return null;
      case 'spotlight':
        this.notes.push('Opening Spotlight was not recorded; use an “Open app” step instead.');
        return null;
      case 'open_url':
        this.notes.push('Opening a link was not recorded (Mirroir cannot open URLs on iPhone).');
        return null;
    }
  }

  /** The label of the element within 30 pt of the touch, if replaying that label would hit the same element. */
  private labelAt(elements: readonly ScreenElement[], x: number, y: number): string | null {
    const near = nearestElement(elements, x, y, LABEL_RADIUS_PT);
    if (!near) return null;
    const label = near.label.trim().slice(0, 200);
    const replayed = matchElement(elements, label);
    if (!replayed || Math.hypot(replayed.element.x - near.x, replayed.element.y - near.y) > LABEL_RADIUS_PT) {
      return null;
    }
    return label;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const generation = this.generation;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh(generation);
    }, this.timing.recorderSnapshotDelayMs);
    this.refreshTimer.unref?.();
  }

  private async refresh(generation: number): Promise<void> {
    if (!this.recording || generation !== this.generation) return;
    if (!this.device.canCaptureScreen()) return;
    const seq = this.actionSeq;
    const task = (async () => {
      try {
        const screen = await this.device.describe({ includeImage: false });
        if (!this.recording || generation !== this.generation) return;
        this.snapshot = { elements: screen.elements, capturedAt: screen.capturedAt };
        // Only trust it for labels if no further action happened while it was taken.
        if (this.actionSeq === seq) this.snapshotStale = false;
      } catch (err) {
        this.log.debug('Recorder screen refresh failed', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    this.refreshing = task;
    try {
      await task;
    } finally {
      if (this.refreshing === task) this.refreshing = null;
    }
  }
}
