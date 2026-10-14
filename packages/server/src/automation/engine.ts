// Workflow step engine. Executes one run sequentially over the shared device
// lane while holding the workflow's control lease:
//
// • every device action passes evaluatePolicy (actor 'workflow'); deny fails
//   the step, require_approval waits for the user (Assisted mode: always);
// • text steps resolve labels live with describe_screen + ElementMatcher;
// • pause takes effect before the next device action (the lease is paused so
//   the user can use the phone manually), stop / emergency stop abort waits,
//   approvals and polling immediately (an in-flight Mirroir call finishes);
// • the first failure ends the run and the remaining steps are skipped.

import {
  ACTION_TOOL,
  type ActionResult,
  type ApprovalStatus,
  type DeviceAction,
  type RiskLevel,
  type ScreenDescription,
  type StepRunResult,
  type SwipeDirection,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStep,
} from '@iphone-ai/shared';

import type { ActivityLog } from '../core/activity-log.js';
import type { Logger } from '../core/logger.js';
import { describeTypedText, redactToolArgs } from '../core/redact.js';
import type { SettingsStore } from '../core/settings-store.js';
import type { ScreenshotStore } from '../ai/screenshots.js';
import type { AiProvider, ModelContent } from '../ai/types.js';
import type { Lease } from '../device/device-controller.js';
import { matchElement, type ElementMatch } from '../device/element-matcher.js';
import type { ApprovalBroker } from '../policy/approvals.js';
import { evaluatePolicy, matchSensitiveRules, screenHasAuthPrompt } from '../policy/engine.js';
import {
  MUTATING_STEP_TYPES,
  describeStep,
  fillVariables,
  nearestElement,
  parseKeyCombo,
  swipeCoordinates,
} from './steps.js';
import { WorkflowError, type AutomationTiming, type WorkflowAgents, type WorkflowDevice } from './types.js';

export interface EngineDeps {
  settings: SettingsStore;
  activity: ActivityLog;
  approvals: Pick<ApprovalBroker, 'request' | 'listPending'>;
  screenshots: Pick<ScreenshotStore, 'put'>;
  agents: WorkflowAgents;
  device: WorkflowDevice;
  log: Logger;
  timing: AutomationTiming;
}

export interface ExecutionOptions {
  workflow: Workflow;
  /** Initial run record (steps prepared; earlier steps already 'skipped' for a retry). */
  run: WorkflowRun;
  lease: Lease;
  startIndex: number;
  /** Persists and publishes the run; called after every change. */
  save: (run: WorkflowRun) => void;
}

type Outcome = 'failed' | 'stopped';

/** A step failure with a readable message. 'stopped' outcomes end the run as stopped. */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly outcome: Outcome = 'failed',
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

interface StepOutput {
  message: string;
  output?: string | null;
  screenshotId?: string | null;
}

const UNKNOWN_GEOMETRY =
  "The iPhone window size is unknown, so touches can't be placed. Check that iPhone Mirroring is connected.";
const SCREEN_UNREADABLE =
  "The iPhone screen can't be read right now. iPhone Mirroring must be connected and Screen Recording allowed for iPhone AI.";
const COMMIT_KEYS = new Set(['return', 'enter']);

const READ_SCREEN_SYSTEM = [
  'You extract information from an iPhone screen for an automation workflow.',
  'You receive an instruction, the text recognised on the screen (OCR, top to bottom) and sometimes a screenshot.',
  'Reply with only the requested value — no explanation, no quotes, no Markdown.',
  'If the information is not on the screen, reply exactly: NOT FOUND.',
].join('\n');

export class WorkflowExecution {
  readonly runId: string;
  private readonly run: WorkflowRun;
  private readonly stopController = new AbortController();
  private readonly signal: AbortSignal;
  private stopReasonText: string | null = null;
  private paused = false;
  private resumeStatus: WorkflowRunStatus = 'running';
  private readonly resumeWaiters = new Set<() => void>();
  private screen: ScreenDescription | null = null;
  private screenFresh = false;
  private pendingTypedText = false;
  private readonly vars = new Map<string, string>();
  /** Time spent paused or waiting for approvals (excluded from the run duration limit). */
  private idleMs = 0;
  private currentStep: WorkflowStep | null = null;
  /** AI task (ai_task step) paused together with the run. */
  private pausedTaskId: string | null = null;
  private finished = false;

  constructor(
    private readonly deps: EngineDeps,
    private readonly options: ExecutionOptions,
  ) {
    this.run = structuredClone(options.run);
    this.runId = this.run.id;
    this.signal = AbortSignal.any([options.lease.signal, this.stopController.signal]);
    this.signal.addEventListener('abort', () => this.cancelPausedTask(), { once: true });
  }

  snapshot(): WorkflowRun {
    return structuredClone(this.run);
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Runs every step; resolves with the final run (never rejects for step failures). */
  start(): Promise<WorkflowRun> {
    return this.execute();
  }

  pause(): WorkflowRun {
    this.assertLive();
    if (!this.paused) {
      this.paused = true;
      this.resumeStatus = this.run.status === 'awaiting_approval' ? 'awaiting_approval' : 'running';
      this.run.status = 'paused';
      if (this.currentStep?.type === 'ai_task') this.pauseEmbeddedTask();
      this.deps.device.setLeasePaused(this.options.lease.id, true);
      this.save();
      this.recordRunEvent('workflow.run.paused', `Paused workflow “${this.run.workflowName}”. You can use the iPhone manually until you resume.`);
    }
    return this.snapshot();
  }

  resume(): WorkflowRun {
    this.assertLive();
    if (this.paused) {
      this.paused = false;
      this.deps.device.setLeasePaused(this.options.lease.id, false);
      this.resumeEmbeddedTask();
      this.run.status = this.resumeStatus;
      const waiters = [...this.resumeWaiters];
      this.resumeWaiters.clear();
      for (const wake of waiters) wake();
      this.save();
      this.recordRunEvent('workflow.run.resumed', `Resumed workflow “${this.run.workflowName}”.`);
    }
    return this.snapshot();
  }

  stop(reason: string): WorkflowRun {
    if (this.finished || this.signal.aborted) return this.snapshot();
    this.stopReasonText = reason;
    this.run.status = 'stopped';
    this.run.error = reason;
    this.stopController.abort(new StepFailure(reason, 'stopped'));
    this.save();
    return this.snapshot();
  }

  /** An ai_task step borrows the lease; pause the AI task itself so it stops acting too. */
  private pauseEmbeddedTask(): void {
    const task = this.deps.agents.activeTask();
    if (!task) return;
    try {
      this.deps.agents.pauseTask(task.id);
      this.pausedTaskId = task.id;
    } catch (err) {
      this.deps.log.debug('Could not pause the embedded AI task', { error: errorMessage(err) });
    }
  }

  /** A paused AI task waits for resume; cancelling it wakes it so the run can end and release control. */
  private cancelPausedTask(): void {
    const id = this.pausedTaskId;
    this.pausedTaskId = null;
    if (!id) return;
    try {
      this.deps.agents.cancelTask(id, this.stopMessage());
    } catch (err) {
      this.deps.log.debug('Could not cancel the embedded AI task', { error: errorMessage(err) });
    }
  }

  private resumeEmbeddedTask(): void {
    const id = this.pausedTaskId;
    this.pausedTaskId = null;
    if (!id) return;
    try {
      this.deps.agents.resumeTask(id);
    } catch (err) {
      this.deps.log.debug('Could not resume the embedded AI task', { error: errorMessage(err) });
    }
  }

  // ───────────────────────────── run loop ─────────────────────────────

  private async execute(): Promise<WorkflowRun> {
    const { workflow, startIndex } = this.options;
    const steps = workflow.steps;
    let failure: { message: string; outcome: Outcome } | null = null;
    try {
      const limit = this.deps.settings.get().automation.maxStepsPerRun;
      const toRun = steps.length - startIndex;
      if (toRun > limit) {
        throw new StepFailure(`This run has ${toRun} steps; the limit is ${limit} steps per run (Settings → Automation).`);
      }
      for (let i = startIndex; i < steps.length; i += 1) {
        await this.gate();
        this.throwIfStopped();
        this.checkDuration();
        const step = steps[i]!;
        const result = this.run.steps[i]!;
        this.run.currentStepIndex = i;
        result.status = 'running';
        result.startedAt = Date.now();
        result.endedAt = null;
        result.message = null;
        this.currentStep = step;
        this.save();

        let out: StepOutput;
        try {
          out = await this.executeStep(step);
        } catch (err) {
          failure = this.toFailure(err);
          this.currentStep = null;
          result.status = 'failed';
          result.endedAt = Date.now();
          result.message = failure.message;
          this.save();
          this.recordStep(step, i, result);
          break;
        }
        this.currentStep = null;
        result.status = 'succeeded';
        result.endedAt = Date.now();
        result.message = out.message;
        result.output = out.output ?? null;
        result.screenshotId = out.screenshotId ?? null;
        this.save();
        this.recordStep(step, i, result);
        if (MUTATING_STEP_TYPES.has(step.type) && i < steps.length - 1) {
          await this.sleep(this.deps.settings.get().ai.settleDelayMs);
        }
      }
    } catch (err) {
      failure = this.toFailure(err);
    }
    return this.finish(failure);
  }

  private finish(failure: { message: string; outcome: Outcome } | null): WorkflowRun {
    const aborted = this.signal.aborted;
    const outcome: Outcome | null = failure ? failure.outcome : aborted ? 'stopped' : null;
    for (const step of this.run.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'skipped';
        step.message = outcome === 'stopped' ? 'Skipped (run stopped)' : 'Skipped due to previous failure';
      }
    }
    this.run.status = outcome ?? 'succeeded';
    this.run.error = failure?.message ?? (aborted ? this.stopMessage() : null);
    this.run.endedAt = Date.now();
    this.finished = true;
    this.paused = false;
    this.resumeWaiters.clear();
    this.save();
    this.options.lease.release();
    return this.snapshot();
  }

  private async executeStep(step: WorkflowStep): Promise<StepOutput> {
    const settings = this.deps.settings.get();
    switch (step.type) {
      case 'launch_app': {
        await this.act({ kind: 'launch_app', name: step.app }, { summary: `Open ${step.app}` });
        return { message: `Opened ${step.app}` };
      }
      case 'tap_text':
      case 'long_press_text': {
        const label = this.fill(step.label);
        const match = await this.findElement(label, step.type === 'tap_text' && step.exact === true);
        const geometryId = this.requireGeometryId();
        const { x, y, label: seen } = match.element;
        const tap = step.type === 'tap_text';
        await this.act(tap ? { kind: 'tap', x, y } : { kind: 'long_press', x, y }, {
          summary: `${tap ? 'Tap' : 'Long-press'} “${seen}”`,
          targetLabel: seen,
          geometryId,
        });
        const how = match.strategy === 'exact' ? '' : ` (matched “${label}”, ${match.strategy})`;
        return { message: `${tap ? 'Tapped' : 'Long-pressed'} “${seen}”${how}` };
      }
      case 'tap_point': {
        const current = this.requireGeometryId();
        if (step.geometryId !== current) {
          throw new StepFailure(
            step.geometryId
              ? `This tap was recorded for a different window size (${step.geometryId}); the iPhone window is now ${current}. Re-record it or change it to tap a text label.`
              : `This tap was recorded for a different window size (unknown); the iPhone window is now ${current}. Re-record it or change it to tap a text label.`,
          );
        }
        await this.screenTextsForPolicy();
        const near = this.screen ? nearestElement(this.screen.elements, step.x, step.y, 30) : null;
        const at = `(${Math.round(step.x)}, ${Math.round(step.y)})`;
        await this.act({ kind: 'tap', x: step.x, y: step.y }, {
          summary: near ? `Tap “${near.label}” at ${at}` : `Tap at ${at}`,
          targetLabel: near?.label ?? null,
          geometryId: current,
        });
        return { message: `Tapped at ${at}${near ? ` near “${near.label}”` : ''}` };
      }
      case 'swipe': {
        const geometry = this.deps.device.geometry;
        if (!geometry) throw new StepFailure(UNKNOWN_GEOMETRY);
        const points = swipeCoordinates(geometry.widthPt, geometry.heightPt, step.direction, step.distance);
        await this.act({ kind: 'swipe', ...points }, { summary: `Swipe ${step.direction}`, geometryId: geometry.geometryId });
        return { message: `Swiped ${step.direction}` };
      }
      case 'type_text': {
        const text = this.fill(step.text);
        const show = step.sensitive !== true && settings.privacy.logTypedText;
        const shown = show ? `“${truncate(text, 80)}”` : describeTypedText(text);
        await this.act({ kind: 'type_text', text }, { summary: `Type ${shown}`, showTypedText: show });
        return { message: `Typed ${shown}` };
      }
      case 'press_key': {
        const { key, modifiers } = parseKeyCombo(step.key);
        const action: DeviceAction = modifiers.length > 0 ? { kind: 'press_key', key, modifiers } : { kind: 'press_key', key };
        await this.act(action, { summary: `Press ${step.key}` });
        return { message: `Pressed ${step.key}` };
      }
      case 'press_home': {
        await this.act({ kind: 'press_home' }, { summary: 'Go to the Home Screen' });
        return { message: 'Went to the Home Screen' };
      }
      case 'press_back': {
        await this.act({ kind: 'press_back' }, { summary: 'Go back' });
        return { message: 'Went back' };
      }
      case 'open_url':
        throw new StepFailure('Mirroir cannot open URLs on iPhone; use launch_app Safari + type_text');
      case 'scroll_to':
        return this.scrollTo(step.label, step.direction);
      case 'wait_for_text':
        return this.waitForText(this.fill(step.label), step.timeoutMs ?? settings.automation.defaultWaitTimeoutMs);
      case 'assert_text': {
        const label = this.fill(step.label);
        await this.gate();
        const screen = await this.observe();
        const visible = matchElement(screen.elements, label) !== null;
        if (visible !== step.present) {
          throw new StepFailure(
            step.present ? `Expected “${label}” to be visible, but it isn't on screen` : `Expected “${label}” not to be visible, but it is on screen`,
          );
        }
        return { message: step.present ? `“${label}” is visible` : `“${label}” is not visible` };
      }
      case 'screenshot': {
        await this.gate();
        if (!this.deps.device.canCaptureScreen()) throw new StepFailure(SCREEN_UNREADABLE);
        const frame = await this.deps.device.captureFrame({ settleMs: this.deps.timing.screenshotSettleMs, priority: 'observe', reason: 'workflow screenshot' });
        const screenshotId = this.deps.screenshots.put(frame.data, frame.meta.mimeType, { workflowRunId: this.run.id });
        return { message: `Saved screenshot “${step.label}”`, screenshotId };
      }
      case 'read_screen':
        return this.readScreen(step.saveAs, step.instruction);
      case 'ai_task': {
        await this.gate();
        const result = await this.deps.agents.runEmbeddedTask({
          instruction: this.fill(step.instruction),
          ...(step.maxActions !== undefined ? { maxActions: step.maxActions } : {}),
          workflowRunId: this.run.id,
          leaseId: this.options.lease.id,
          signal: this.signal,
        });
        this.pausedTaskId = null;
        this.screenFresh = false;
        this.pendingTypedText = false;
        if (!result.success) {
          throw new StepFailure(result.summary ? `The AI task did not succeed: ${result.summary}` : 'The AI task did not succeed.');
        }
        return { message: result.verified ? result.summary : `${result.summary} (not verified on screen)` };
      }
      case 'checkpoint': {
        const message = this.fill(step.message);
        await this.requestApproval(
          {
            summary: `Checkpoint: ${message}`,
            action: { tool: 'checkpoint', args: { message } },
            risk: 'low',
            reasons: ['This workflow asks you to confirm before it continues.'],
          },
          'You stopped the workflow at this checkpoint.',
        );
        return { message: 'Confirmed — continuing' };
      }
      case 'wait': {
        await this.sleep(step.ms);
        return { message: `Waited ${(step.ms / 1000).toFixed(step.ms % 1000 === 0 ? 0 : 1)} s` };
      }
    }
  }

  // ───────────────────────────── step helpers ─────────────────────────────

  private async findElement(label: string, exactOnly: boolean): Promise<ElementMatch> {
    const { findRetries, findRetryDelayMs } = this.deps.timing;
    for (let attempt = 0; attempt <= findRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(findRetryDelayMs);
      await this.gate();
      this.throwIfStopped();
      const screen = await this.observe();
      const match = matchElement(screen.elements, label, { exactOnly });
      if (match) return match;
    }
    throw new StepFailure(`Couldn't find “${label}” on screen`);
  }

  private async scrollTo(rawLabel: string, direction: SwipeDirection | undefined): Promise<StepOutput> {
    const label = this.fill(rawLabel);
    const result = await this.act(
      { kind: 'scroll_to', label, ...(direction ? { direction } : {}) },
      { summary: `Scroll to “${label}”` },
    );
    // Mirroir's text says "events posted"; confirm the label really is on screen.
    if (this.deps.device.canCaptureScreen()) {
      const screen = await this.observe();
      if (!matchElement(screen.elements, label)) throw new StepFailure(`Couldn't find “${label}” after scrolling`);
    } else if (/not found/i.test(result.message)) {
      throw new StepFailure(firstLine(result.message));
    }
    return { message: `Scrolled to “${label}”` };
  }

  private async waitForText(label: string, timeoutMs: number): Promise<StepOutput> {
    let deadline = Date.now() + timeoutMs;
    let delay = 200;
    for (;;) {
      deadline += await this.gate();
      this.throwIfStopped();
      this.checkDuration();
      const screen = await this.observe();
      if (matchElement(screen.elements, label)) return { message: `“${label}” appeared` };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 2000);
    }
    throw new StepFailure(`Timed out waiting for “${label}” after ${Math.round(timeoutMs / 100) / 10}s`);
  }

  private async readScreen(saveAs: string, rawInstruction: string | undefined): Promise<StepOutput> {
    const settings = this.deps.settings.get();
    const instruction = rawInstruction?.trim() ? this.fill(rawInstruction.trim()) : null;
    let provider: AiProvider | null = null;
    let note = '';
    if (instruction) {
      try {
        provider = await this.deps.agents.getProvider();
      } catch (err) {
        note = `No AI provider is configured (${errorMessage(err)}), so the visible text was saved instead.`;
      }
      if (provider && provider.config.cloud && !settings.privacy.cloudDisclosureAcknowledged) {
        provider = null;
        note = 'Screen contents are not sent to a cloud AI provider until you accept the privacy notice, so the visible text was saved instead.';
      }
    }
    await this.gate();
    const withImage = provider?.config.vision === true;
    const screen = await this.observe(withImage);
    const texts = screen.elements.map((e) => e.label.trim()).filter(Boolean);
    const ocrText = texts.join('\n');
    let value = ocrText;
    if (provider && instruction) {
      const content: ModelContent[] = [
        {
          type: 'text',
          text: `Instruction: ${instruction}\n\nVisible text on the iPhone screen (OCR, top to bottom):\n${ocrText || '(no text recognised)'}`,
        },
      ];
      if (withImage && screen.imageBase64) {
        content.push({ type: 'image', mimeType: screen.imageMimeType ?? 'image/png', data: screen.imageBase64 });
      }
      const answer = await provider.complete({ system: READ_SCREEN_SYSTEM, content, signal: this.signal, maxTokens: 1024 });
      value = answer.trim();
      if (!value || /^not found\.?$/i.test(value)) {
        throw new StepFailure(`The AI could not find “${truncate(instruction, 80)}” on screen`);
      }
    }
    value = value.slice(0, 4000);
    this.vars.set(saveAs, value);
    const authRules = settings.permissions.sensitiveRules.filter((r) => r.id === 'auth');
    const sensitive = screenHasAuthPrompt([...texts, value]) !== null || matchSensitiveRules(value, authRules).length > 0;
    const parts = [
      `Saved ${provider ? 'the answer' : 'the visible text'} as {${saveAs}}`,
      sensitive ? '(hidden: the screen looks like it shows a password or code)' : '',
      note,
    ].filter(Boolean);
    return { message: parts.join(' '), output: sensitive ? describeTypedText(value) : value };
  }

  /** Policy → (approval) → DeviceController for one device action. */
  private async act(
    action: DeviceAction,
    opts: { summary: string; targetLabel?: string | null; geometryId?: string | null; showTypedText?: boolean },
  ): Promise<ActionResult> {
    await this.gate();
    this.throwIfStopped();
    const screenTexts = await this.screenTextsForPolicy();
    const settings = this.deps.settings.get();
    const decision = evaluatePolicy({
      actor: 'workflow',
      action,
      mode: settings.permissions.controlMode,
      permissions: settings.permissions,
      stopLatched: this.deps.device.isStopLatched,
      target: { label: opts.targetLabel ?? null },
      context: { pendingTypedText: this.pendingTypedText, screenTexts },
    });
    if (decision.verdict === 'deny') {
      throw new StepFailure(`Not allowed: ${decision.reasons.join(' ') || 'blocked by your safety settings.'}`);
    }
    let approvalId: string | null = null;
    if (decision.verdict === 'require_approval') {
      const tool = ACTION_TOOL[action.kind];
      const { kind: _kind, ...args } = action;
      approvalId = await this.requestApproval({
        summary: opts.summary,
        action: { tool, args: redactToolArgs(tool, args as Record<string, unknown>, { keepTypedText: opts.showTypedText === true }) },
        risk: decision.risk,
        reasons: decision.reasons,
      });
      await this.gate();
      this.throwIfStopped();
    }
    const result = await this.deps.device.perform(action, {
      actor: 'workflow',
      leaseId: this.options.lease.id,
      geometryId: opts.geometryId ?? null,
      workflowRunId: this.run.id,
      decision,
      approvalId,
    });
    this.screenFresh = false;
    if (!result.ok) throw new StepFailure(firstLine(result.message) || `${result.tool} failed.`);
    this.trackTyping(action);
    return result;
  }

  private trackTyping(action: DeviceAction): void {
    switch (action.kind) {
      case 'type_text':
        this.pendingTypedText = true;
        break;
      case 'tap':
      case 'double_tap':
      case 'long_press':
      case 'launch_app':
      case 'press_home':
      case 'press_back':
        this.pendingTypedText = false;
        break;
      case 'press_key':
        if (COMMIT_KEYS.has(action.key.toLowerCase())) this.pendingTypedText = false;
        break;
      default:
        break;
    }
  }

  /** Returns the approval id when approved; throws a StepFailure otherwise. */
  private async requestApproval(
    input: { summary: string; action: { tool: string; args: Record<string, unknown> }; risk: RiskLevel; reasons: string[] },
    rejectedMessage?: string,
  ): Promise<string> {
    const timeoutSec = this.deps.settings.get().permissions.approvalTimeoutSec;
    this.setStatus('awaiting_approval');
    this.save();
    const started = Date.now();
    let status: ApprovalStatus;
    let approvalId: string | null = null;
    try {
      const pending = this.deps.approvals.request(
        {
          actor: 'workflow',
          taskId: null,
          workflowRunId: this.run.id,
          summary: input.summary,
          action: input.action,
          risk: input.risk,
          reasons: input.reasons,
          timeoutSec,
        },
        this.signal,
      );
      // The broker registers the request synchronously; its id authorises the device action.
      approvalId =
        this.deps.approvals
          .listPending()
          .filter((a) => a.workflowRunId === this.run.id)
          .sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
      status = await pending;
    } finally {
      this.idleMs += Date.now() - started;
      this.setStatus('running');
      this.save();
    }
    switch (status) {
      case 'approved':
        if (!approvalId) throw new StepFailure('The approval could not be matched to this action.');
        return approvalId;
      case 'rejected':
        throw new StepFailure(rejectedMessage ?? `You rejected: ${input.summary}`, 'stopped');
      case 'expired':
        throw new StepFailure(`No decision within ${timeoutSec}s: ${input.summary}`);
      default:
        throw new StepFailure(this.signal.aborted ? this.stopMessage() : `Approval was cancelled: ${input.summary}`, 'stopped');
    }
  }

  private async observe(includeImage = false): Promise<ScreenDescription> {
    if (!this.deps.device.canCaptureScreen()) throw new StepFailure(SCREEN_UNREADABLE);
    const screen = await this.deps.device.describe({ includeImage });
    this.throwIfStopped();
    this.screen = screen;
    this.screenFresh = true;
    return screen;
  }

  /** Visible texts for the policy's screen checks, refreshed after every device action when possible. */
  private async screenTextsForPolicy(): Promise<string[]> {
    if (!this.screenFresh && this.deps.device.canCaptureScreen()) {
      try {
        await this.observe();
      } catch (err) {
        if (this.signal.aborted) throw err;
        this.deps.log.warn('Could not refresh the screen before a workflow action', { error: errorMessage(err) });
      }
    }
    return this.screen ? this.screen.elements.map((e) => e.label) : [];
  }

  private requireGeometryId(): string {
    const id = this.deps.device.geometry?.geometryId ?? this.screen?.geometry?.geometryId ?? null;
    if (!id) throw new StepFailure(UNKNOWN_GEOMETRY);
    return id;
  }

  private fill(text: string): string {
    return fillVariables(text, this.vars);
  }

  // ───────────────────────────── control ─────────────────────────────

  /** Waits while paused (pausing the lease so the user can intervene). Returns the time spent paused. */
  private async gate(): Promise<number> {
    if (!this.paused) return 0;
    const started = Date.now();
    this.deps.device.setLeasePaused(this.options.lease.id, true);
    await new Promise<void>((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new StepFailure(this.stopMessage(), 'stopped'));
        return;
      }
      const onAbort = () => {
        this.resumeWaiters.delete(wake);
        reject(new StepFailure(this.stopMessage(), 'stopped'));
      };
      const wake = () => {
        this.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.resumeWaiters.add(wake);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    const waited = Date.now() - started;
    this.idleMs += waited;
    return waited;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.signal.aborted) {
        reject(new StepFailure(this.stopMessage(), 'stopped'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new StepFailure(this.stopMessage(), 'stopped'));
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private throwIfStopped(): void {
    if (this.signal.aborted) throw new StepFailure(this.stopMessage(), 'stopped');
  }

  private checkDuration(): void {
    const limitSec = this.deps.settings.get().automation.maxRunDurationSec;
    const activeMs = Date.now() - this.run.startedAt - this.idleMs;
    if (activeMs > limitSec * 1000) {
      throw new StepFailure(`The run exceeded its ${limitSec}s time limit (Settings → Automation).`);
    }
  }

  private setStatus(status: WorkflowRunStatus): void {
    if (this.finished || this.signal.aborted) return;
    if (this.paused) {
      this.resumeStatus = status;
      return;
    }
    this.run.status = status;
  }

  private assertLive(): void {
    if (this.finished || this.signal.aborted) {
      throw new WorkflowError('This workflow run has already finished.', 'conflict');
    }
  }

  private toFailure(err: unknown): { message: string; outcome: Outcome } {
    if (this.signal.aborted) return { message: this.stopMessage(), outcome: 'stopped' };
    if (err instanceof StepFailure) return { message: err.message, outcome: err.outcome };
    const code = deviceErrorCode(err);
    if (code === 'stop_latched' || code === 'aborted') return { message: errorMessage(err), outcome: 'stopped' };
    return { message: errorMessage(err), outcome: 'failed' };
  }

  private stopMessage(): string {
    if (this.stopReasonText) return this.stopReasonText;
    const reason: unknown = this.options.lease.signal.reason;
    if (reason instanceof Error && reason.message) return reason.message;
    if (typeof reason === 'string' && reason) return reason;
    return 'The workflow was stopped.';
  }

  private save(): void {
    this.options.save(this.snapshot());
  }

  // ───────────────────────────── activity ─────────────────────────────

  private recordStep(step: WorkflowStep, index: number, result: StepRunResult): void {
    const settings = this.deps.settings.get();
    const ok = result.status === 'succeeded';
    const total = this.options.workflow.steps.length;
    const phrase = describeStep(step, { showTypedText: settings.privacy.logTypedText });
    this.deps.activity.record({
      category: 'workflow',
      type: ok ? 'workflow.step.succeeded' : 'workflow.step.failed',
      actor: 'workflow',
      severity: ok ? 'info' : 'warning',
      summary: `Step ${index + 1}/${total} · ${phrase} — ${ok ? 'done' : `failed: ${result.message ?? 'unknown error'}`}`,
      tool: stepTool(step),
      success: ok,
      durationMs: result.startedAt !== null && result.endedAt !== null ? result.endedAt - result.startedAt : null,
      workflowRunId: this.run.id,
      detail: {
        workflowId: this.run.workflowId,
        stepId: step.id,
        stepType: step.type,
        index,
        message: result.message,
        screenshotId: result.screenshotId,
      },
    });
  }

  private recordRunEvent(type: string, summary: string): void {
    this.deps.activity.record({
      category: 'workflow',
      type,
      actor: 'user',
      summary,
      workflowRunId: this.run.id,
      detail: { workflowId: this.run.workflowId },
    });
  }
}

function stepTool(step: WorkflowStep): string | null {
  switch (step.type) {
    case 'launch_app':
      return 'launch_app';
    case 'tap_text':
    case 'tap_point':
      return 'tap';
    case 'long_press_text':
      return 'long_press';
    case 'swipe':
    case 'type_text':
    case 'press_key':
    case 'press_home':
    case 'press_back':
    case 'scroll_to':
      return step.type;
    case 'wait_for_text':
    case 'assert_text':
    case 'read_screen':
      return 'describe_screen';
    case 'screenshot':
      return 'screenshot';
    default:
      return null;
  }
}

function deviceErrorCode(err: unknown): string | null {
  if (err instanceof Error && err.name === 'DeviceError') {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 300);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
