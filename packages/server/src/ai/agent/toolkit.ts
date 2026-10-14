// The tools the AI uses to operate the iPhone, bound to one task.
//
// observe → act → verify is enforced here, not left to the model:
//  • every action is checked by the policy engine (and, when required, by the
//    user through an approval card) before DeviceController executes it;
//  • after every action the toolkit waits for the screen to settle and takes a
//    fresh observation, reporting whether the screen actually changed;
//  • the same action on an unchanged screen is refused after two attempts
//    (loop detection), and the action budget is enforced;
//  • finish_task's evidence is matched against the final on-screen text to
//    decide whether the outcome is verified.

import { z } from 'zod';

import {
  type ActionResult,
  type AgentStep,
  type ControlMode,
  type DeviceAction,
  type ScreenDescription,
  type ScreenElement,
  type SwipeDirection,
} from '@iphone-ai/shared';

import type { ActivityLog } from '../../core/activity-log.js';
import type { SettingsStore } from '../../core/settings-store.js';
import { describeTypedText, redactToolArgs } from '../../core/redact.js';
import { DeviceError, describeAction, type DeviceController } from '../../device/device-controller.js';
import { matchElement } from '../../device/element-matcher.js';
import { evaluatePolicy } from '../../policy/engine.js';
import type { ApprovalBroker } from '../../policy/approvals.js';
import type { ScreenshotStore } from '../screenshots.js';
import type { ExecutableTool, ModelContent, ModelToolDef, ToolCall } from '../types.js';

export class TaskAbortedError extends Error {
  constructor(
    message: string,
    readonly reason: 'cancelled' | 'stopped' | 'timeout' | 'loop',
  ) {
    super(message);
    this.name = 'TaskAbortedError';
  }
}

export interface FinishResult {
  status: 'success' | 'failed' | 'needs_user';
  summary: string;
  evidence: string[];
  verified: boolean;
  missingEvidence: string[];
}

export interface ToolkitDeps {
  device: DeviceController;
  approvals: ApprovalBroker;
  settings: SettingsStore;
  activity: ActivityLog;
  screenshots: ScreenshotStore;
}

export interface ToolkitTask {
  taskId: string;
  /** Lease used for device input; null in Observe Only mode. */
  leaseId: string | null;
  workflowRunId?: string | null;
  signal: AbortSignal;
  /** Whether the model accepts images. */
  vision: boolean;
  maxActions: number;
  /** Mode the tool set was built for (the live mode is re-read on every action). */
  mode: ControlMode;
  /** Optional screen summariser for text-only models (vision provider). */
  describeImage?: (imageBase64: string, mimeType: string, signal: AbortSignal) => Promise<string>;
  addStep(step: Omit<AgentStep, 'id' | 'taskId' | 'index' | 'createdAt'>): void;
  setActivity(text: string | null): void;
  setAwaitingApproval(waiting: boolean): void;
  /** Resolves when the task is not paused (immediately if running). */
  waitIfPaused(): Promise<void>;
  onActionsUsed(count: number): void;
}

interface Observation {
  description: ScreenDescription;
  byId: Map<string, ScreenElement>;
  screenshotId: string | null;
  afterAction: number;
}

const reason = z.string().max(300).describe('One short sentence: why this action moves the task forward.');
const target = {
  element_id: z.string().max(10).optional().describe('Id of an element from the latest observation, e.g. "e7". Preferred.'),
  x: z.number().min(0).max(4000).optional().describe('Window x in points — only for targets without an element id (read it from the grid).'),
  y: z.number().min(0).max(4000).optional().describe('Window y in points — only for targets without an element id.'),
};

const SHAPES = {
  observe_screen: {},
  tap: { ...target, reason },
  double_tap: { ...target, reason },
  long_press: { ...target, duration_ms: z.number().int().min(300).max(3000).optional(), reason },
  swipe: {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Finger direction. "up" scrolls content down to reveal items further down.'),
    distance: z.enum(['short', 'medium', 'long']).optional(),
    reason,
  },
  type_text: { text: z.string().min(1).max(500).describe('Text to type into the focused field.'), reason },
  press_key: { key: z.enum(['return', 'escape', 'tab', 'delete', 'space', 'up', 'down', 'left', 'right']), reason },
  go_home: { reason },
  go_back: { reason },
  open_app: { name: z.string().min(1).max(80).describe('App name exactly as shown under its Home Screen icon.'), reason },
  scroll_to_text: {
    text: z.string().min(1).max(120).describe('Visible text to scroll to.'),
    direction: z.enum(['up', 'down']).optional().describe('Finger direction; "up" (default) scrolls down the page.'),
    reason,
  },
  wait: { seconds: z.number().min(0.5).max(10), reason },
  finish_task: {
    status: z.enum(['success', 'failed', 'needs_user']),
    summary: z.string().min(1).max(1500).describe('What happened, in the user’s language. Mention what you could not do.'),
    evidence: z
      .array(z.string().min(1).max(120))
      .max(5)
      .optional()
      .describe('For success: 1–3 exact texts visible on the FINAL screen that prove the goal was reached.'),
  },
} as const;

type ToolName = keyof typeof SHAPES;

const DESCRIPTIONS: Record<ToolName, string> = {
  observe_screen:
    'Look at the iPhone screen again: returns every visible text element (id, label, tap point) found by on-device OCR, unlabeled icons, hints, and a screenshot with a 25-point grid when supported. Use it when you need a fresh look without acting.',
  tap: 'Tap an element (preferred: element_id from the latest observation) or a point (x, y in window points). A fresh observation is returned afterwards.',
  double_tap: 'Double-tap an element or point (e.g. to zoom or select a word).',
  long_press: 'Press and hold an element or point (context menus, Quick Actions).',
  swipe: 'Swipe across the middle of the screen. "up" moves the finger up (scrolls down the page). Use for scrolling and paging.',
  type_text: 'Type text into the currently focused text field (tap the field first). Never use for passwords, passcodes or codes.',
  press_key: 'Press a key: return (submit/search), delete (backspace), escape, tab, space or arrows.',
  go_home: 'Go to the Home Screen.',
  go_back: 'Go back (taps the "<" back button at the top-left, or its usual position).',
  open_app: 'Open an app by name through Spotlight.',
  scroll_to_text: 'Scroll until the given text becomes visible (up to 10 swipes).',
  wait: 'Wait for content to load, then observe again.',
  finish_task:
    'End the task. status "success" only if the final screen proves the goal (give exact visible evidence texts); "failed" if it could not be done; "needs_user" if the user must act (passcode, sign-in, approval, decision).',
};

/** Map from AI tool to the Mirroir tool it uses (for the allowed-tools setting). */
const MIRROIR_TOOL: Partial<Record<ToolName, string>> = {
  tap: 'tap',
  double_tap: 'double_tap',
  long_press: 'long_press',
  swipe: 'swipe',
  type_text: 'type_text',
  press_key: 'press_key',
  go_home: 'press_home',
  go_back: 'press_back',
  open_app: 'launch_app',
  scroll_to_text: 'scroll_to',
};

const OBSERVE_ONLY_TOOLS: readonly ToolName[] = ['observe_screen', 'wait', 'finish_task'];

export class AgentToolkit {
  private observation: Observation | null = null;
  private actionsUsed = 0;
  private finished: FinishResult | null = null;
  private pendingTypedText = false;
  private readonly attempts = new Map<string, number>();
  private unchangedStreak = 0;
  private loopRefusals = 0;

  constructor(
    private readonly deps: ToolkitDeps,
    private readonly task: ToolkitTask,
  ) {}

  get result(): FinishResult | null {
    return this.finished;
  }

  get actionCount(): number {
    return this.actionsUsed;
  }

  /** Tool names available for this task (mode + allowed-tools setting). */
  toolNames(): ToolName[] {
    if (this.task.mode === 'observe' || !this.task.leaseId) return [...OBSERVE_ONLY_TOOLS];
    const allowed = new Set(this.deps.settings.get().permissions.aiAllowedTools);
    return (Object.keys(SHAPES) as ToolName[]).filter((name) => {
      const mirroirTool = MIRROIR_TOOL[name];
      return !mirroirTool || allowed.has(mirroirTool);
    });
  }

  toolDefs(): ModelToolDef[] {
    return this.toolNames().map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      parameters: jsonSchema(SHAPES[name]),
    }));
  }

  executableTools(): ExecutableTool[] {
    return this.toolNames().map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      parameters: jsonSchema(SHAPES[name]),
      zodShape: SHAPES[name] as Record<string, unknown>,
      execute: (args) => this.run(name, args),
    }));
  }

  /** Executes a model tool call (used by the native loop). */
  async execute(call: ToolCall): Promise<{ content: ModelContent[]; isError: boolean }> {
    if (call.parseError) {
      return errorResult(`INVALID_JSON: ${call.parseError}. Call the tool again with valid JSON arguments.`);
    }
    if (!(call.name in SHAPES) || !this.toolNames().includes(call.name as ToolName)) {
      return errorResult(`Unknown or unavailable tool "${call.name}". Available: ${this.toolNames().join(', ')}.`);
    }
    return this.run(call.name as ToolName, call.args);
  }

  private async run(name: ToolName, rawArgs: Record<string, unknown>): Promise<{ content: ModelContent[]; isError: boolean }> {
    const parsed = z.object(SHAPES[name]).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`);
    }
    const args = parsed.data as Record<string, unknown>;
    this.assertActive();
    await this.task.waitIfPaused();
    this.assertActive();
    try {
      switch (name) {
        case 'observe_screen':
          return await this.observeTool();
        case 'wait':
          return await this.waitTool(Number(args.seconds), String(args.reason ?? ''));
        case 'finish_task':
          return await this.finishTool(args);
        default:
          return await this.actTool(name, args);
      }
    } catch (err) {
      if (err instanceof TaskAbortedError) throw err;
      if (err instanceof DeviceError && (err.code === 'stop_latched' || err.code === 'aborted')) {
        throw new TaskAbortedError(err.message, 'stopped');
      }
      const message = err instanceof Error ? err.message : String(err);
      this.task.addStep({ type: 'error', title: `${name} failed`, detail: message, tool: null, screenshotId: null });
      return errorResult(message);
    }
  }

  private assertActive(): void {
    if (this.task.signal.aborted) {
      const r = this.task.signal.reason;
      if (r instanceof TaskAbortedError) throw r;
      throw new TaskAbortedError('The task was stopped.', r instanceof DeviceError ? 'stopped' : 'cancelled');
    }
  }

  // ───────────────────────────── observation ─────────────────────────────

  /** Takes a fresh observation and returns it formatted for the model. */
  async observe(options: { settle?: boolean; title?: string } = {}): Promise<{ content: ModelContent[]; observation: Observation }> {
    this.task.setActivity('Looking at the screen');
    const description = await this.deps.device.describe({ includeImage: true, settleFirst: options.settle === true });
    const screenshotId = description.imageBase64
      ? this.deps.screenshots.put(description.imageBase64, description.imageMimeType ?? 'image/png', {
          taskId: this.task.taskId,
          workflowRunId: this.task.workflowRunId ?? null,
        })
      : null;
    const observation: Observation = {
      description,
      byId: new Map(description.elements.map((e) => [e.id, e])),
      screenshotId,
      afterAction: this.actionsUsed,
    };
    this.observation = observation;
    const text = formatObservation(description);
    const content: ModelContent[] = [{ type: 'text', text }];
    if (description.imageBase64) {
      if (this.task.vision) {
        content.push({ type: 'image', mimeType: description.imageMimeType ?? 'image/png', data: description.imageBase64 });
      } else if (this.task.describeImage) {
        try {
          const summary = await this.task.describeImage(description.imageBase64, description.imageMimeType ?? 'image/png', this.task.signal);
          if (summary.trim()) content.push({ type: 'text', text: `Visual summary from the vision model:\n${summary.trim()}` });
        } catch {
          // The OCR text is still available.
        }
      }
    }
    this.task.addStep({
      type: 'observe',
      title: options.title ?? 'Observed the screen',
      detail: `${description.elements.filter((e) => e.label).length} text elements${description.geometry ? ` · ${description.geometry.widthPt}×${description.geometry.heightPt} pt` : ''}`,
      tool: { name: 'describe_screen', args: {}, ok: true, result: truncate(description.rawText, 4000), durationMs: null },
      screenshotId,
    });
    this.task.setActivity(null);
    return { content, observation };
  }

  private async observeTool(): Promise<{ content: ModelContent[]; isError: boolean }> {
    const { content } = await this.observe();
    return { content, isError: false };
  }

  private async waitTool(seconds: number, why: string): Promise<{ content: ModelContent[]; isError: boolean }> {
    this.task.setActivity(`Waiting ${seconds}s`);
    await abortableSleep(seconds * 1000, this.task.signal);
    this.task.addStep({ type: 'message', title: `Waited ${seconds}s`, detail: why || null, tool: null, screenshotId: null });
    const { content } = await this.observe({ title: 'Observed after waiting' });
    return { content, isError: false };
  }

  // ───────────────────────────── finish ─────────────────────────────

  private async finishTool(args: Record<string, unknown>): Promise<{ content: ModelContent[]; isError: boolean }> {
    const status = args.status as FinishResult['status'];
    const summary = String(args.summary ?? '').trim();
    const evidence = Array.isArray(args.evidence) ? (args.evidence as string[]).map((e) => e.trim()).filter(Boolean) : [];
    let verified = false;
    let missing: string[] = [];
    if (status === 'success') {
      // Verify against a fresh look if anything happened since the last observation.
      let observation = this.observation;
      if (!observation || observation.afterAction !== this.actionsUsed || Date.now() - observation.description.capturedAt > 5000) {
        try {
          observation = (await this.observe({ title: 'Final check of the screen' })).observation;
        } catch {
          observation = this.observation;
        }
      }
      const elements = observation?.description.elements ?? [];
      missing = evidence.filter((e) => !matchElement(elements, e));
      verified = evidence.length > 0 && missing.length === 0;
    }
    this.finished = { status, summary, evidence, verified, missingEvidence: missing };
    this.task.addStep({
      type: 'verify',
      title:
        status === 'success'
          ? verified
            ? 'Finished — verified on screen'
            : 'Finished — could not verify on screen'
          : status === 'needs_user'
            ? 'Needs your help'
            : 'Could not complete the task',
      detail: [
        summary,
        evidence.length ? `Evidence: ${evidence.map((e) => `“${e}”`).join(', ')}` : null,
        missing.length ? `Not found on the final screen: ${missing.map((e) => `“${e}”`).join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      tool: null,
      screenshotId: this.observation?.screenshotId ?? null,
    });
    return {
      content: [{ type: 'text', text: 'Task end recorded. Do not call any more tools; reply with one short sentence for the user.' }],
      isError: false,
    };
  }

  // ───────────────────────────── actions ─────────────────────────────

  private async actTool(name: ToolName, args: Record<string, unknown>): Promise<{ content: ModelContent[]; isError: boolean }> {
    if (!this.task.leaseId) {
      return errorResult('Observe Only mode: you cannot interact with the iPhone. Describe what you see or what you would do, then call finish_task.');
    }
    if (this.actionsUsed >= this.task.maxActions) {
      return errorResult(`Action budget exhausted (${this.task.maxActions} actions). Call finish_task now and explain where you stopped.`);
    }
    if (!this.observation) await this.observe();
    const observation = this.observation!;
    const geometry = observation.description.geometry ?? this.deps.device.geometry;

    // Resolve the target and build the device action.
    let action: DeviceAction;
    let targetLabel: string | null = null;
    let targetDescription = '';
    const pointer = name === 'tap' || name === 'double_tap' || name === 'long_press';
    if (pointer) {
      const resolved = this.resolveTarget(args, observation);
      if ('error' in resolved) return errorResult(resolved.error);
      targetLabel = resolved.label;
      targetDescription = resolved.description;
      action =
        name === 'tap'
          ? { kind: 'tap', x: resolved.x, y: resolved.y }
          : name === 'double_tap'
            ? { kind: 'double_tap', x: resolved.x, y: resolved.y }
            : { kind: 'long_press', x: resolved.x, y: resolved.y, ...(args.duration_ms ? { durationMs: Number(args.duration_ms) } : {}) };
    } else if (name === 'swipe') {
      if (!geometry) return errorResult('The screen size is unknown; call observe_screen first.');
      action = swipeAction(args.direction as SwipeDirection, (args.distance as 'short' | 'medium' | 'long' | undefined) ?? 'medium', geometry.widthPt, geometry.heightPt);
      targetDescription = `${String(args.direction)} (${String(args.distance ?? 'medium')})`;
    } else if (name === 'type_text') {
      action = { kind: 'type_text', text: String(args.text) };
      targetLabel = focusedFieldGuess(observation.description.elements);
    } else if (name === 'press_key') {
      action = { kind: 'press_key', key: String(args.key) };
    } else if (name === 'go_home') {
      action = { kind: 'press_home' };
    } else if (name === 'go_back') {
      action = { kind: 'press_back' };
    } else if (name === 'open_app') {
      action = { kind: 'launch_app', name: String(args.name) };
      targetLabel = String(args.name);
    } else if (name === 'scroll_to_text') {
      const direction = (args.direction as 'up' | 'down' | undefined) ?? 'up';
      action = { kind: 'scroll_to', label: String(args.text), direction, maxScrolls: 10 };
    } else {
      return errorResult(`Unsupported action ${name}.`);
    }

    // Loop detection: the same action on an unchanged screen.
    const signature = `${observation.description.fingerprint}|${actionSignature(action)}`;
    const previous = this.attempts.get(signature) ?? 0;
    if (previous >= 2) {
      this.loopRefusals += 1;
      this.task.addStep({
        type: 'policy',
        title: 'Repeated action refused',
        detail: `${describeAction(action)} was already tried twice on this unchanged screen.`,
        tool: null,
        screenshotId: null,
      });
      if (this.loopRefusals >= 3) {
        throw new TaskAbortedError('Stopped: the AI kept repeating actions that did not change the screen.', 'loop');
      }
      return errorResult('Loop detected: you already tried this exact action twice on this unchanged screen. Try a different approach, or call finish_task.');
    }

    // Policy (live settings: the user may have changed mode during the task).
    const settings = this.deps.settings.get();
    const decision = evaluatePolicy({
      actor: 'ai',
      action,
      mode: settings.permissions.controlMode,
      permissions: settings.permissions,
      stopLatched: this.deps.device.isStopLatched,
      target: { label: targetLabel },
      context: {
        pendingTypedText: this.pendingTypedText,
        screenTexts: observation.description.elements.map((e) => e.label).filter(Boolean),
      },
    });
    const summary = `${humanAction(action, settings.privacy.logTypedText)}${targetDescription ? ` — ${targetDescription}` : ''}`;
    const displayArgs = redactToolArgs(action.kind, stripKind(action), { keepTypedText: settings.privacy.logTypedText });

    if (decision.verdict === 'deny') {
      this.task.addStep({
        type: 'policy',
        title: `Blocked: ${summary}`,
        detail: decision.reasons.join('\n'),
        tool: { name: action.kind, args: displayArgs, ok: false, result: 'Blocked by policy', durationMs: null },
        screenshotId: null,
      });
      this.deps.activity.record({
        category: 'policy',
        type: 'policy.denied',
        actor: 'ai',
        severity: 'warning',
        summary: `Blocked AI action: ${summary}`,
        taskId: this.task.taskId,
        workflowRunId: this.task.workflowRunId ?? null,
        tool: action.kind,
        detail: { reasons: decision.reasons, rules: decision.rules, args: displayArgs },
      });
      return errorResult(
        `BLOCKED by iPhone AI's safety policy: ${decision.reasons.join(' ')} Do not try to reach the same result another way. Tell the user and call finish_task (status "needs_user" or "failed").`,
      );
    }

    let approvalId: string | null = null;
    if (decision.verdict === 'require_approval') {
      this.task.setAwaitingApproval(true);
      this.task.setActivity(`Waiting for your approval: ${summary}`);
      const approvalStarted = Date.now();
      let requestId: string | null = null;
      const status = await this.deps.approvals.request(
        {
          actor: 'ai',
          taskId: this.task.taskId,
          workflowRunId: this.task.workflowRunId ?? null,
          summary,
          action: { tool: action.kind, args: displayArgs },
          risk: decision.risk,
          reasons: decision.reasons,
          frameSeq: this.deps.device.getLatestFrame()?.meta.seq ?? null,
          timeoutSec: settings.permissions.approvalTimeoutSec,
          onCreated: (id) => {
            requestId = id;
          },
        },
        this.task.signal,
      );
      this.task.setAwaitingApproval(false);
      this.task.setActivity(null);
      this.assertActive();
      this.task.addStep({
        type: 'approval',
        title: status === 'approved' ? `Approved: ${summary}` : `Not approved (${status}): ${summary}`,
        detail: decision.reasons.join('\n'),
        tool: null,
        screenshotId: null,
      });
      if (status !== 'approved') {
        return errorResult(
          status === 'rejected'
            ? 'The user REJECTED this action. Do not retry it. Choose a different approach or call finish_task.'
            : `The approval request ${status} after ${Math.round((Date.now() - approvalStarted) / 1000)}s. Do not retry it; call finish_task with status "needs_user".`,
        );
      }
      approvalId = requestId;
      // The user saw and approved what was typed; a subsequent commit is intentional.
      if (decision.rules.includes('commit.after_typing')) this.pendingTypedText = false;
    }

    // Execute.
    this.task.setActivity(summary);
    const fingerprintBefore = observation.description.fingerprint;
    let result: ActionResult;
    const started = Date.now();
    try {
      result = await this.deps.device.perform(action, {
        actor: 'ai',
        leaseId: this.task.leaseId,
        geometryId: geometry?.geometryId ?? null,
        taskId: this.task.taskId,
        workflowRunId: this.task.workflowRunId ?? null,
        decision,
        approvalId,
      });
    } catch (err) {
      if (err instanceof DeviceError && (err.code === 'stop_latched' || err.code === 'aborted')) throw new TaskAbortedError(err.message, 'stopped');
      const message = err instanceof Error ? err.message : String(err);
      this.task.addStep({
        type: 'tool_call',
        title: summary,
        detail: message,
        tool: { name: action.kind, args: displayArgs, ok: false, result: message, durationMs: Date.now() - started },
        screenshotId: null,
      });
      if (err instanceof DeviceError && err.code === 'geometry_changed') {
        this.observation = null;
        return errorResult(`${message} Call observe_screen to get fresh coordinates.`);
      }
      return errorResult(`${message}`);
    }

    this.actionsUsed += 1;
    this.task.onActionsUsed(this.actionsUsed);
    this.attempts.set(signature, previous + 1);
    if (action.kind === 'type_text' && result.ok) this.pendingTypedText = true;
    if (action.kind === 'press_home' || action.kind === 'launch_app') this.pendingTypedText = false;

    // Verify: settle, then look again.
    await abortableSleep(settings.ai.settleDelayMs, this.task.signal);
    let after: { content: ModelContent[]; observation: Observation } | null = null;
    let observeError: string | null = null;
    try {
      after = await this.observe({ settle: true, title: 'Checked the result' });
    } catch (err) {
      observeError = err instanceof Error ? err.message : String(err);
    }
    const changed = after ? after.observation.description.fingerprint !== fingerprintBefore : null;
    this.unchangedStreak = changed === false ? this.unchangedStreak + 1 : 0;

    this.task.addStep({
      type: 'tool_call',
      title: summary,
      detail: changed === null ? `Could not re-check the screen: ${observeError}` : changed ? 'The screen changed.' : 'The screen did not change.',
      tool: {
        name: result.tool,
        args: displayArgs,
        ok: result.ok,
        result: truncate(result.message, 500),
        durationMs: result.durationMs,
      },
      screenshotId: after?.observation.screenshotId ?? null,
    });

    const header = [
      `Action: ${describeAction(action, true)}`,
      `Mirroir: ${result.ok ? 'OK' : 'FAILED'} — ${truncate(result.message, 300)}`,
      changed === null
        ? `Could not observe the screen afterwards: ${observeError}`
        : changed
          ? 'Screen changed: yes. Check that it changed the way you expected.'
          : `Screen changed: NO (unchanged after ${this.unchangedStreak} action(s) in a row). The action may not have registered or targeted the wrong place.`,
      `Actions used: ${this.actionsUsed}/${this.task.maxActions}.`,
      result.message.includes('Warning:') ? 'Note: text went through the clipboard (Universal Clipboard); verify it arrived.' : null,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      content: [{ type: 'text', text: header }, ...(after?.content ?? [])],
      isError: !result.ok,
    };
  }

  private resolveTarget(
    args: Record<string, unknown>,
    observation: Observation,
  ): { x: number; y: number; label: string | null; description: string } | { error: string } {
    const geometry = observation.description.geometry ?? this.deps.device.geometry;
    if (typeof args.element_id === 'string' && args.element_id) {
      const element = observation.byId.get(args.element_id);
      if (!element) {
        return { error: `Unknown element id "${args.element_id}" — ids change with every observation. Use an id from the latest observation.` };
      }
      return {
        x: element.x,
        y: element.y,
        label: element.label || null,
        description: element.label ? `“${element.label}” (${element.id})` : `icon ${element.id} at (${element.x}, ${element.y})`,
      };
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      if (!geometry) return { error: 'The screen size is unknown; call observe_screen first.' };
      if (args.x > geometry.widthPt || args.y > geometry.heightPt) {
        return { error: `(${args.x}, ${args.y}) is outside the screen (${geometry.widthPt}×${geometry.heightPt} points).` };
      }
      // The nearest labelled element tells the policy what is being touched.
      const nearest = nearestElement(observation.description.elements, args.x, args.y, 40);
      return {
        x: args.x,
        y: args.y,
        label: nearest?.label || null,
        description: nearest ? `near “${nearest.label}” at (${Math.round(args.x)}, ${Math.round(args.y)})` : `point (${Math.round(args.x)}, ${Math.round(args.y)})`,
      };
    }
    return { error: 'Give element_id (preferred) or both x and y.' };
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function errorResult(text: string): { content: ModelContent[]; isError: boolean } {
  return { content: [{ type: 'text', text }], isError: true };
}

export function jsonSchema(shape: Record<string, z.ZodType>): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function formatObservation(description: ScreenDescription): string {
  const g = description.geometry;
  const lines: string[] = [];
  lines.push(
    g
      ? `Screen: ${g.widthPt}×${g.heightPt} points (${g.orientation}). Coordinates are window points from the top-left.`
      : 'Screen size unknown.',
  );
  const text = description.elements.filter((e) => e.label);
  const icons = description.elements.filter((e) => !e.label);
  if (text.length === 0) lines.push('No text was detected on screen (it may be loading, locked, or image-only).');
  else {
    lines.push('Visible text elements (tap by id):');
    for (const e of text) lines.push(`[${e.id}] "${e.label}" at (${e.x}, ${e.y})`);
  }
  if (icons.length) {
    lines.push('Unlabeled icons:');
    for (const e of icons) lines.push(`[${e.id}] ${e.kind ?? 'icon'} at (${e.x}, ${e.y})`);
  }
  const hints = description.rawText
    .split('\n')
    .filter((l) => l.startsWith('- ') && /navigation|Tab bar/i.test(l))
    .map((l) => l.slice(2));
  if (hints.length) lines.push(`Hints: ${hints.join(' ')}`);
  if (/OCR FAILED/.test(description.rawText)) lines.push('Warning: text recognition failed for this observation.');
  return lines.join('\n');
}

function nearestElement(elements: readonly ScreenElement[], x: number, y: number, maxDistance: number): ScreenElement | null {
  let best: ScreenElement | null = null;
  let bestDistance = maxDistance;
  for (const e of elements) {
    if (!e.label) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d <= bestDistance) {
      best = e;
      bestDistance = d;
    }
  }
  return best;
}

/** Best guess of the focused field's label (used to block typing into password fields). */
function focusedFieldGuess(elements: readonly ScreenElement[]): string | null {
  // Only field-like labels (placeholders/prompts), not list rows such as "Face ID & Passcode".
  const fieldLabel =
    /^(enter )?(your )?(apple (account|id) )?(password|passcode|pin|code|verification code|one[- ]time code|security code)( required)?:?$|^(كلمة المرور|رمز التحقق|رمز المرور)$/i;
  const field = elements.find((e) => fieldLabel.test(e.label.trim()));
  return field?.label ?? null;
}

export function swipeAction(direction: SwipeDirection, distance: 'short' | 'medium' | 'long', width: number, height: number): DeviceAction {
  const travel = { short: 0.2, medium: 0.35, long: 0.5 }[distance];
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const dy = Math.round((height * travel) / 2);
  const dx = Math.round((width * travel) / 2);
  switch (direction) {
    case 'up':
      return { kind: 'swipe', fromX: cx, fromY: cy + dy, toX: cx, toY: cy - dy, durationMs: 300 };
    case 'down':
      return { kind: 'swipe', fromX: cx, fromY: cy - dy, toX: cx, toY: cy + dy, durationMs: 300 };
    case 'left':
      return { kind: 'swipe', fromX: cx + dx, fromY: cy, toX: cx - dx, toY: cy, durationMs: 300 };
    case 'right':
      return { kind: 'swipe', fromX: cx - dx, fromY: cy, toX: cx + dx, toY: cy, durationMs: 300 };
  }
}

function actionSignature(action: DeviceAction): string {
  const round = (n: number) => Math.round(n / 15);
  switch (action.kind) {
    case 'tap':
    case 'double_tap':
    case 'long_press':
      return `${action.kind}:${round(action.x)},${round(action.y)}`;
    case 'swipe':
    case 'drag':
      return `${action.kind}:${round(action.fromX)},${round(action.fromY)}>${round(action.toX)},${round(action.toY)}`;
    case 'type_text':
      return `type:${action.text}`;
    case 'press_key':
      return `key:${action.key}`;
    case 'launch_app':
      return `launch:${action.name.toLowerCase()}`;
    case 'scroll_to':
      return `scroll_to:${action.label.toLowerCase()}`;
    default:
      return action.kind;
  }
}

function humanAction(action: DeviceAction, showText: boolean): string {
  if (action.kind === 'type_text') return showText ? `Type “${truncate(action.text, 60)}”` : `Type ${describeTypedText(action.text)}`;
  return describeAction(action, showText);
}

function stripKind(action: DeviceAction): Record<string, unknown> {
  const { kind: _kind, ...rest } = action;
  return rest as Record<string, unknown>;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new TaskAbortedError('The task was stopped.', 'cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new TaskAbortedError('The task was stopped.', 'cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
