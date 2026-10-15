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
  DEFAULT_BLOCKED_APPS,
  DEFAULT_SENSITIVE_RULES,
  type ActionResult,
  type AgentStep,
  type ControlMode,
  type DeviceAction,
  type PolicyDecision,
  type ScreenDescription,
  type ScreenElement,
  type SensitiveRule,
  type SwipeDirection,
  type SwipeDistance,
  swipeAction,
} from '@iphone-ai/shared';

import type { ActivityLog } from '../../core/activity-log.js';
import type { SettingsStore } from '../../core/settings-store.js';
import { describeTypedText, redactSecrets, redactToolArgs } from '../../core/redact.js';
import { DeviceError, describeAction, type DeviceController } from '../../device/device-controller.js';
import { matchElement } from '../../device/element-matcher.js';
import { inStatusBarRow, statusAreaBottom, statusBarRowY } from '../../mcp/parsers.js';
import {
  containsKeyword,
  evaluatePolicy,
  matchesBlockedApp,
  normalizeText,
  screenHasAuthPrompt,
  type BlockedForeground,
  type PolicyTarget,
} from '../../policy/engine.js';
import { detectBlockedForeground } from '../../policy/foreground.js';
import { isReadableLabel, labelsAtPoint } from '../../policy/target.js';
import type { ApprovalBroker } from '../../policy/approvals.js';
import { downscaleForModel } from '../image.js';
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
  /** Device-wide "typed but not sent" state (drafts typed by an earlier task, a workflow step or the user). */
  uncommittedTyping?: () => boolean;
  /** Screenshots sent to the model per task before observations become text-only (default 30). */
  maxImages?: number;
}

interface Observation {
  description: ScreenDescription;
  byId: Map<string, ScreenElement>;
  screenshotId: string | null;
  afterAction: number;
  /** A blocked app that appears to be in front on this screen. */
  foreground: BlockedForeground | null;
}

/** How a device action's target was chosen (re-resolved against a fresh screen after an approval wait). */
type TargetRef =
  | { kind: 'element'; label: string | null }
  | { kind: 'point' }
  | { kind: 'none' };

type ToolOutput = { content: ModelContent[]; isError: boolean };

/** Screenshots per task sent to the model; later observations are text only (history is never edited). */
export const MAX_IMAGES_PER_TASK = 30;
/** Default pause between repeated swipes (swipe `times` > 1); every swipe has already settled when it returns. */
export const DEFAULT_SWIPE_INTERVAL_MS = 300;
const ALREADY_FINISHED = 'The task already finished (finish_task was called). No more tools can run; reply with one short sentence for the user.';

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
    direction: z
      .enum(['up', 'down', 'left', 'right'])
      .describe('Finger direction. "up" moves the finger up: the page scrolls down to reveal items further down (in TikTok/Reels/Shorts: the next video).'),
    distance: z
      .enum(['short', 'medium', 'long'])
      .optional()
      .describe('long (default) pages: a one-screen flick that lands on the next item (TikTok, Reels, Shorts: the next video). short or medium scroll a list 25% or 45% of the screen without inertia.'),
    times: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Repeat the swipe this many times (1–10, default 1), e.g. to page through several videos or screens. One observation is returned after the last swipe.'),
    interval_ms: z
      .number()
      .int()
      .min(300)
      .max(800)
      .optional()
      .describe('Pause between repeated swipes in milliseconds (300–800, default 300). Keep the default: each swipe already waits for the page to settle.'),
    reason,
  },
  type_text: {
    text: z.string().min(1).max(500).describe('Text to type into the focused field. No line breaks: to submit, call press_key "return" afterwards.'),
    reason,
  },
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
  swipe:
    'Swipe across the middle of the screen. The default (long) pages to the next item and returns once the feed has settled (usually under a second); short and medium scroll lists without inertia. "up" moves the finger up (scrolls down the page; next video in TikTok, Reels or Shorts). With times > 1 it swipes repeatedly (interval_ms apart) and returns one observation after the last swipe.',
  type_text:
    'Type text into the currently focused text field (tap the field first). Never use for passwords, passcodes or codes. Do not include line breaks; use press_key "return" to submit.',
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
  private imagesSent = 0;
  private lastForeground: string | null = null;
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

  private async run(name: ToolName, rawArgs: Record<string, unknown>): Promise<ToolOutput> {
    // Every provider path (native loop and Claude Agent SDK) ends here: nothing runs after finish_task.
    if (this.finished) return errorResult(ALREADY_FINISHED);
    const parsed = z.object(SHAPES[name]).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`);
    }
    const args = parsed.data as Record<string, unknown>;
    this.assertActive();
    await this.task.waitIfPaused();
    this.assertActive();
    if (this.finished) return errorResult(ALREADY_FINISHED);
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
        this.assertActive();
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

  /**
   * Takes a fresh observation and returns it formatted for the model.
   * `image: false` skips the screenshot (a quick re-check; text only).
   */
  async observe(options: { settle?: boolean; title?: string; image?: boolean } = {}): Promise<{ content: ModelContent[]; observation: Observation }> {
    this.task.setActivity('Looking at the screen');
    const withImage = options.image !== false;
    const description = await this.deps.device.describe({ includeImage: withImage, settleFirst: options.settle === true });
    // describe_screen can take a while; a cancel during it must not be lost.
    this.assertActive();
    const screenshotId = description.imageBase64
      ? this.deps.screenshots.put(description.imageBase64, description.imageMimeType ?? 'image/png', {
          taskId: this.task.taskId,
          workflowRunId: this.task.workflowRunId ?? null,
        })
      : null;
    // Only tasks that can act need the warning (Observe Only tasks cannot touch anything).
    const foreground = this.task.leaseId
      ? detectBlockedForeground(
          description.elements,
          description.geometry?.heightPt ?? this.deps.device.geometry?.heightPt ?? null,
          this.deps.settings.get().permissions.blockedApps,
        )
      : null;
    const observation: Observation = {
      description,
      byId: new Map(description.elements.map((e) => [e.id, e])),
      screenshotId,
      afterAction: this.actionsUsed,
      foreground,
    };
    this.observation = observation;
    const text = formatObservation(description);
    const content: ModelContent[] = [{ type: 'text', text }];
    if (foreground) content.push({ type: 'text', text: foregroundNotice(foreground) });
    if (withImage && description.imageBase64) {
      const mimeType = description.imageMimeType ?? 'image/png';
      if (this.task.vision) {
        const limit = this.task.maxImages ?? MAX_IMAGES_PER_TASK;
        // Decided now, for this observation only: earlier history is never edited.
        if (this.imagesSent < limit) {
          const image = await this.forModel(description.imageBase64, mimeType);
          content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
          this.imagesSent += 1;
        } else {
          content.push({ type: 'text', text: `(No screenshot attached: this task already sent ${limit} screenshots. Rely on the text elements above.)` });
        }
      } else if (this.task.describeImage) {
        try {
          const image = await this.forModel(description.imageBase64, mimeType);
          const summary = await this.task.describeImage(image.data, image.mimeType, this.task.signal);
          if (summary.trim()) content.push({ type: 'text', text: `Visual summary from the vision model:\n${summary.trim()}` });
        } catch {
          // The OCR text is still available.
        }
      }
    }
    this.recordForeground(foreground, screenshotId);
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

  /** Downscaled JPEG copy for the model (the stored step screenshot keeps full resolution). */
  private async forModel(data: string, mimeType: string): Promise<{ data: string; mimeType: string }> {
    if (mimeType !== 'image/png') return { data, mimeType };
    const image = await downscaleForModel(data);
    return { data: image.data, mimeType: image.mimeType };
  }

  /** Records (once per change) that a blocked app appears to be in front. */
  private recordForeground(foreground: BlockedForeground | null, screenshotId: string | null): void {
    const key = foreground ? `${foreground.where}:${foreground.app}` : null;
    if (key === this.lastForeground) return;
    this.lastForeground = key;
    if (!foreground) return;
    const what =
      foreground.where === 'top_hit'
        ? `Spotlight's top hit “${foreground.label}” is a blocked app (${foreground.app}).`
        : `A blocked app (${foreground.app}) appears to be open (“${foreground.label}”). AI actions in it need your approval.`;
    this.task.addStep({ type: 'policy', title: 'Blocked app on screen', detail: what, tool: null, screenshotId });
    this.deps.activity.record({
      category: 'policy',
      type: 'policy.blocked_app_on_screen',
      actor: 'ai',
      severity: 'warning',
      summary: what,
      taskId: this.task.taskId,
      workflowRunId: this.task.workflowRunId ?? null,
      detail: { app: foreground.app, label: foreground.label, where: foreground.where },
    });
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
        } catch (err) {
          if (err instanceof TaskAbortedError) throw err;
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

  private async actTool(name: ToolName, args: Record<string, unknown>): Promise<ToolOutput> {
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
    let ref: TargetRef = { kind: 'none' };
    let targetDescription = '';
    /** Repeated swipes (swipe `times`): each is policy-checked; one observation follows the last. */
    let repeat = 1;
    let intervalMs = DEFAULT_SWIPE_INTERVAL_MS;
    const pointer = name === 'tap' || name === 'double_tap' || name === 'long_press';
    if (pointer) {
      const resolved = this.resolveTarget(args, observation);
      if ('error' in resolved) return errorResult(resolved.error);
      ref = resolved.ref;
      targetDescription = resolved.description;
      action =
        name === 'tap'
          ? { kind: 'tap', x: resolved.x, y: resolved.y }
          : name === 'double_tap'
            ? { kind: 'double_tap', x: resolved.x, y: resolved.y }
            : { kind: 'long_press', x: resolved.x, y: resolved.y, ...(args.duration_ms ? { durationMs: Number(args.duration_ms) } : {}) };
    } else if (name === 'swipe') {
      if (!geometry) return errorResult('The screen size is unknown; call observe_screen first.');
      action = swipeAction(args.direction as SwipeDirection, (args.distance as SwipeDistance | undefined) ?? 'long', geometry.widthPt, geometry.heightPt);
      repeat = typeof args.times === 'number' ? Math.min(10, Math.max(1, Math.round(args.times))) : 1;
      intervalMs = typeof args.interval_ms === 'number' ? Math.min(800, Math.max(300, Math.round(args.interval_ms))) : DEFAULT_SWIPE_INTERVAL_MS;
      targetDescription = `${String(args.direction)} (${String(args.distance ?? 'long')})${repeat > 1 ? ` ×${repeat}` : ''}`;
    } else if (name === 'type_text') {
      action = { kind: 'type_text', text: String(args.text) };
    } else if (name === 'press_key') {
      action = { kind: 'press_key', key: String(args.key) };
    } else if (name === 'go_home') {
      action = { kind: 'press_home' };
    } else if (name === 'go_back') {
      action = { kind: 'press_back' };
    } else if (name === 'open_app') {
      action = { kind: 'launch_app', name: String(args.name) };
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
    let decision = this.decide(action, this.policyTarget(action, ref, observation), observation);
    const summary = `${humanAction(action, settings.privacy.logTypedText)}${targetDescription ? ` — ${targetDescription}` : ''}`;
    const displayArgs = {
      ...redactToolArgs(action.kind, stripKind(action), { keepTypedText: settings.privacy.logTypedText }),
      ...(repeat > 1 ? { times: repeat, intervalMs } : {}),
    };

    if (decision.verdict === 'deny') return this.blocked(action, summary, displayArgs, decision);

    let approvalId: string | null = null;
    let current = observation;
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
          preview: action.kind === 'type_text' ? typingPreview(action.text, targetDescription, decision, observation) : null,
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
      // The user approved what they saw. Wait out a pause, then make sure the
      // screen, the target and the policy (mode, rules) still match before acting.
      await this.task.waitIfPaused();
      this.assertActive();
      const recheck = await this.recheckAfterApproval(action, ref, observation, decision, summary, displayArgs);
      if ('refused' in recheck) return recheck.refused;
      // The user saw and approved what was typed; a subsequent commit is intentional.
      if (decision.rules.includes('commit.after_typing')) this.pendingTypedText = false;
      decision = recheck.decision;
      current = recheck.observation;
    }

    // Execute (a repeated swipe runs `repeat` times, then one observation).
    this.task.setActivity(repeat > 1 ? `${summary} (1/${repeat})` : summary);
    const fingerprintBefore = current.description.fingerprint;
    const geometryNow = current.description.geometry ?? this.deps.device.geometry;
    let result: ActionResult | null = null;
    let performed = 0;
    let stoppedEarly: string | null = null;
    const started = Date.now();
    for (let i = 0; i < repeat; i += 1) {
      if (i > 0) {
        const gate = await this.beforeRepeat(action, ref, current, decision, approvalId, intervalMs);
        if ('stop' in gate) {
          stoppedEarly = gate.stop;
          break;
        }
        decision = gate.decision;
        this.task.setActivity(`${summary} (${i + 1}/${repeat})`);
      }
      try {
        result = await this.deps.device.perform(action, {
          actor: 'ai',
          leaseId: this.task.leaseId,
          geometryId: geometryNow?.geometryId ?? null,
          taskId: this.task.taskId,
          workflowRunId: this.task.workflowRunId ?? null,
          decision,
          approvalId,
          signal: this.task.signal,
        });
      } catch (err) {
        if (err instanceof DeviceError && (err.code === 'stop_latched' || err.code === 'aborted')) {
          this.assertActive();
          throw new TaskAbortedError(err.message, 'stopped');
        }
        const message = err instanceof Error ? err.message : String(err);
        this.task.addStep({
          type: 'tool_call',
          title: summary,
          detail: performed > 0 ? `Stopped after ${performed} of ${repeat} swipes: ${message}` : message,
          tool: { name: action.kind, args: displayArgs, ok: false, result: message, durationMs: Date.now() - started },
          screenshotId: null,
        });
        if (err instanceof DeviceError && err.code === 'lease_paused') {
          // Not a stop: the next tool call waits at the pause gate. The user may change the screen meanwhile.
          this.observation = null;
          if (performed > 0) this.attempts.set(signature, previous + 1);
          return errorResult(
            performed > 0
              ? `The task was paused after ${performed} of ${repeat} swipes; the remaining swipes were NOT executed. When the task resumes, call observe_screen and decide again.`
              : 'The task was paused before this action ran; it was NOT executed. When the task resumes, call observe_screen and decide again.',
          );
        }
        if (performed === 0) {
          if (err instanceof DeviceError && err.code === 'geometry_changed') {
            this.observation = null;
            return errorResult(`${message} Call observe_screen to get fresh coordinates.`);
          }
          return errorResult(`${message}`);
        }
        // Some swipes already ran: report them with a fresh observation below.
        stoppedEarly = message;
        break;
      }
      performed += 1;
      this.actionsUsed += 1;
      this.task.onActionsUsed(this.actionsUsed);
      if (!result.ok) break;
    }
    // performed ≥ 1 here (a first failure returned above), so result is set.
    result = result!;
    const durationMs = repeat > 1 ? Date.now() - started : result.durationMs;
    this.attempts.set(signature, previous + 1);
    // Text ending in a line break was committed by that Return (it needed approval).
    if (action.kind === 'type_text' && result.ok) this.pendingTypedText = !/[\r\n]$/.test(action.text);
    if (action.kind === 'press_home' || action.kind === 'launch_app') this.pendingTypedText = false;

    // Verify: settle, then look again.
    await abortableSleep(settings.ai.settleDelayMs, this.task.signal);
    let after: { content: ModelContent[]; observation: Observation } | null = null;
    let observeError: string | null = null;
    try {
      after = await this.observe({ settle: true, title: 'Checked the result' });
    } catch (err) {
      if (err instanceof TaskAbortedError) throw err;
      observeError = err instanceof Error ? err.message : String(err);
      // Never act on the pre-action screen: the next action observes first.
      this.observation = null;
    }
    const changed = after ? after.observation.description.fingerprint !== fingerprintBefore : null;
    this.unchangedStreak = changed === false ? this.unchangedStreak + 1 : 0;

    const swipes =
      repeat > 1
        ? performed < repeat
          ? `Performed ${performed} of ${repeat} swipes (stopped: ${stoppedEarly ?? 'Mirroir reported a failure'}).`
          : `Performed ${repeat} swipes, ${intervalMs} ms apart.`
        : null;
    this.task.addStep({
      type: 'tool_call',
      title: summary,
      detail: [
        swipes,
        changed === null ? `Could not re-check the screen: ${observeError}` : changed ? 'The screen changed.' : 'The screen did not change.',
      ]
        .filter(Boolean)
        .join(' '),
      tool: {
        name: result.tool,
        args: displayArgs,
        ok: result.ok,
        result: truncate(result.message, 500),
        durationMs,
      },
      screenshotId: after?.observation.screenshotId ?? null,
    });

    const header = [
      `Action: ${describeAction(action, true)}${repeat > 1 ? ` ×${repeat}` : ''}`,
      `Mirroir: ${result.ok ? 'OK' : 'FAILED'} — ${truncate(result.message, 300)}`,
      swipes,
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

  /**
   * Gate before each repeated swipe after the first: waits the interval, then
   * re-checks the budget and the live policy (mode, allowed tools, rules). The
   * approval given for the batch covers the repetitions only while the policy
   * asks for nothing new.
   */
  private async beforeRepeat(
    action: DeviceAction,
    ref: TargetRef,
    observation: Observation,
    approved: PolicyDecision,
    approvalId: string | null,
    intervalMs: number,
  ): Promise<{ decision: PolicyDecision } | { stop: string }> {
    await abortableSleep(intervalMs, this.task.signal);
    this.assertActive();
    if (this.actionsUsed >= this.task.maxActions) {
      return { stop: `the action budget (${this.task.maxActions} actions) is used up` };
    }
    const decision = this.decide(action, this.policyTarget(action, ref, observation), observation);
    if (decision.verdict === 'deny') {
      this.task.addStep({ type: 'policy', title: 'Repeated swipe blocked', detail: decision.reasons.join('\n'), tool: null, screenshotId: null });
      return { stop: `blocked by iPhone AI's safety policy (${decision.reasons.join(' ')})` };
    }
    if (decision.verdict === 'require_approval') {
      const added = decision.rules.filter((rule) => !approved.rules.includes(rule));
      if (!approvalId || added.length > 0) return { stop: 'the next swipe needs a new approval' };
    }
    return { decision };
  }

  /** Evaluates the policy against live settings and the given observation. */
  private decide(action: DeviceAction, target: PolicyTarget, observation: Observation): PolicyDecision {
    const settings = this.deps.settings.get();
    return evaluatePolicy({
      actor: 'ai',
      action,
      mode: settings.permissions.controlMode,
      permissions: settings.permissions,
      stopLatched: this.deps.device.isStopLatched,
      target,
      context: {
        pendingTypedText: this.pendingTypedText || (this.task.uncommittedTyping?.() ?? false),
        screenTexts: observation.description.elements.map((e) => e.label).filter(Boolean),
        blockedForeground: observation.foreground,
      },
    });
  }

  /** What the policy is told the action touches, derived from an observation. */
  private policyTarget(action: DeviceAction, ref: TargetRef, observation: Observation): PolicyTarget {
    if (ref.kind === 'element' && ref.label && isReadableLabel(ref.label)) return { label: ref.label };
    if (ref.kind === 'element' && 'x' in action) {
      // An unlabeled icon (a chevron, an arrow button) or one OCR read as a stray
      // glyph ("a", ">"): the labels around it say what it does, checked like
      // those of a coordinate tap at the same point.
      const hit = labelsAtPoint(observation.description.elements, action.x, action.y);
      return { label: ref.label, candidates: hit.candidates, nearby: hit.nearby };
    }
    if (ref.kind === 'point' && 'x' in action) {
      const hit = labelsAtPoint(observation.description.elements, action.x, action.y);
      return { label: hit.primary, candidates: hit.candidates, nearby: hit.nearby };
    }
    if (ref.kind === 'element') return { label: null };
    if (action.kind === 'type_text') return { label: focusedFieldGuess(observation.description.elements) };
    if (action.kind === 'launch_app') return { label: action.name };
    return { label: null };
  }

  private blocked(action: DeviceAction, summary: string, displayArgs: Record<string, unknown>, decision: PolicyDecision): ToolOutput {
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

  /**
   * After an approval wait (up to minutes) the screen may differ from the one
   * the user approved: a banner, a list refresh, manual use while paused, or a
   * different app. Looks again and refuses unless the same target is still
   * there and the live policy asks for nothing the user has not approved.
   */
  private async recheckAfterApproval(
    action: DeviceAction,
    ref: TargetRef,
    before: Observation,
    approved: PolicyDecision,
    summary: string,
    displayArgs: Record<string, unknown>,
  ): Promise<{ decision: PolicyDecision; observation: Observation } | { refused: ToolOutput }> {
    let fresh: { content: ModelContent[]; observation: Observation };
    try {
      fresh = await this.observe({ title: 'Re-checked the screen after approval', image: false });
    } catch (err) {
      if (err instanceof TaskAbortedError) throw err;
      if (err instanceof DeviceError && (err.code === 'stop_latched' || err.code === 'aborted')) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { refused: errorResult(`Could not re-check the screen after your approval, so the action was NOT performed (${message}). Call observe_screen and try again.`) };
    }
    const { sensitiveRules, blockedApps } = this.deps.settings.get().permissions;
    const changed = screenChange(action, ref, before, fresh.observation, { sensitiveRules, blockedApps });
    if (changed) {
      this.task.addStep({
        type: 'policy',
        title: 'Screen changed while waiting for approval',
        detail: `${summary} was not performed: ${changed}.`,
        tool: null,
        screenshotId: null,
      });
      return {
        refused: {
          content: [
            {
              type: 'text',
              text: `The screen changed while waiting for approval (${changed}), so the approved action was NOT performed. Here is the current screen; re-plan, and a new approval will be requested if needed.`,
            },
            ...fresh.content,
          ],
          isError: true,
        },
      };
    }
    const decision = this.decide(action, this.policyTarget(action, ref, fresh.observation), fresh.observation);
    if (decision.verdict === 'deny') return { refused: this.blocked(action, summary, displayArgs, decision) };
    const added = decision.rules.filter((rule) => !approved.rules.includes(rule));
    if (added.length > 0) {
      const reasons = decision.reasons.filter((_, i) => added.includes(decision.rules[i]!));
      this.task.addStep({
        type: 'policy',
        title: 'Needs a new approval',
        detail: `${summary} was not performed: ${reasons.join(' ')}`,
        tool: null,
        screenshotId: null,
      });
      return {
        refused: errorResult(
          `Things changed while waiting for approval (${reasons.join(' ')}), so the approved action was NOT performed. Call the tool again to request a new approval, or call finish_task.`,
        ),
      };
    }
    return { decision, observation: fresh.observation };
  }

  private resolveTarget(
    args: Record<string, unknown>,
    observation: Observation,
  ): { x: number; y: number; ref: TargetRef; description: string } | { error: string } {
    const geometry = observation.description.geometry ?? this.deps.device.geometry;
    if (typeof args.element_id === 'string' && args.element_id) {
      const element = observation.byId.get(args.element_id);
      if (!element) {
        return { error: `Unknown element id "${args.element_id}" — ids change with every observation. Use an id from the latest observation.` };
      }
      return {
        x: element.x,
        y: element.y,
        ref: { kind: 'element', label: element.label || null },
        description: element.label ? `“${element.label}” (${element.id})` : `icon ${element.id} at (${element.x}, ${element.y})`,
      };
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      if (!geometry) return { error: 'The screen size is unknown; call observe_screen first.' };
      if (args.x > geometry.widthPt || args.y > geometry.heightPt) {
        return { error: `(${args.x}, ${args.y}) is outside the screen (${geometry.widthPt}×${geometry.heightPt} points).` };
      }
      // Every label the tap may hit tells the policy what is being touched.
      const hit = labelsAtPoint(observation.description.elements, args.x, args.y);
      const near = [hit.primary, ...hit.candidates].find((l): l is string => !!l && isReadableLabel(l)) ?? hit.primary ?? hit.candidates[0] ?? null;
      return {
        x: args.x,
        y: args.y,
        ref: { kind: 'point' },
        description: near ? `near “${near}” at (${Math.round(args.x)}, ${Math.round(args.y)})` : `point (${Math.round(args.x)}, ${Math.round(args.y)})`,
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

/** Why the screen no longer matches what was approved (null: it still matches). */
function screenChange(action: DeviceAction, ref: TargetRef, before: Observation, fresh: Observation, guard: DiffGuard): string | null {
  const contentChange = screenDiff(before.description, fresh.description, guard);
  if ('x' in action) {
    const g0 = before.description.geometry?.geometryId ?? null;
    const g1 = fresh.description.geometry?.geometryId ?? null;
    if (g0 && g1 && g0 !== g1) return 'the iPhone window changed size';
    const at = `(${Math.round(action.x)}, ${Math.round(action.y)})`;
    // The target must still be there AND the rest of the screen must match: the
    // next checkout step can have "Continue" at the very same spot.
    if (ref.kind === 'element' && ref.label) {
      const label = ref.label;
      const still = fresh.description.elements.some(
        (e) => e.label && sameLabel(e.label, label) && Math.hypot(e.x - action.x, e.y - action.y) <= 20,
      );
      return still ? contentChange : `“${label}” is no longer at ${at}`;
    }
    if (ref.kind === 'element') {
      // An unlabeled icon: it must still be there, on the same screen.
      const icon = fresh.description.elements.some((e) => !e.label && Math.hypot(e.x - action.x, e.y - action.y) <= 15);
      return icon ? contentChange : `the icon at ${at} is gone`;
    }
    if (ref.kind === 'point') {
      const was = labelsAtPoint(before.description.elements, action.x, action.y).primary;
      const now = labelsAtPoint(fresh.description.elements, action.x, action.y).primary;
      if ((was ?? '') !== (now ?? '') && !(was && now && sameLabel(was, now))) {
        return now ? `the label at ${at} is now “${now}”` : `“${was}” is no longer at ${at}`;
      }
      return contentChange;
    }
    return contentChange;
  }
  // Going Home or opening an app does the same thing on any screen.
  if (action.kind === 'press_home' || action.kind === 'launch_app') return null;
  return contentChange;
}

/** Live permissions consulted by the screen comparison (the defaults are always consulted too). */
export interface DiffGuard {
  sensitiveRules?: readonly SensitiveRule[];
  blockedApps?: readonly string[];
}

/** Text that changes on its own (clocks, timers, counters, percentages) — ignored when comparing screens. */
const VOLATILE_TEXT = /^[\d\s:.,%+\-–—()/]*(am|pm)?$/i;
/** A blinking text cursor that OCR reads as part of a word ("cheese|"). */
const CARET = /[|¦│]/g;
/**
 * A currency next to digits makes the text an amount ("SAR 49.00", "49 SR",
 * "$4.99"): it never counts as noise when its digits change. OCR reads the
 * Saudi riyal sign (U+20C1) as "#" ("# 19.00"), and NFKC turns "﷼" into "ریال".
 */
const CURRENCY = /\b(sar|sr|usd|aed|eur|gbp|kwd|qar|bhd|omr)\b|ر\s?\.\s?س|ريال|ریال|[$€£¥#\u20c1]/u;
/** A text that is only a currency ("SAR" read apart from "49.00" on the same line). */
const CURRENCY_ONLY = /^(sar|sr|usd|aed|eur|gbp|kwd|qar|bhd|omr|ر\s?\.\s?س|ريال|ریال|[$€£¥#\u20c1])\.?$/u;
/**
 * Below the status area, any currency sign ("฿ 49", "₹ 49"), a masked number
 * ("•••• 4321") or a quantity ("×2") makes an amount too. Not in the status
 * area, where OCR reads the clock and signal glyphs as such ("฿112", "••").
 */
const AMOUNT_MARK = /\p{Sc}|×\s*\p{N}|\p{N}\s*×|[•*●·∙]{2,}\s*\p{N}/u;
const CURRENCY_SIGN_ONLY = /^\p{Sc}\.?$/u;
/** A count or relative time that ticks on its own: "5m", "2h", "3d", "• 9.5K", "1.2M". */
const TICKER = /^([^\p{L}\p{N}]*)\d{1,3}(?:[.,]\d)?\s?([smhdwykb])$/u;
/** Words that answer or act: never OCR noise, whatever their length. */
const DECISIVE_WORDS: ReadonlySet<string> = new Set([
  'ok', 'okay', 'yes', 'no', 'pay', 'buy', 'get', 'add', 'done', 'allow', 'accept', 'agree', 'confirm', 'send', 'delete',
  'نعم', 'لا', 'تم', 'موافق', 'دفع', 'ادفع', 'حذف', 'مسح', 'نشر', 'شراء', 'إرسال', 'ارسال', 'تأكيد', 'تاكيد', 'اطلب',
]);
/** "The same spot" for an OCR re-read: text centres move a little when a reading gains or loses characters. */
const SAME_SPOT_X = 15;
const SAME_SPOT_Y = 8;
/** A currency text this close on the same line turns a bare number into an amount. */
const AMOUNT_NEIGHBOUR_X = 80;

const lettersOf = (text: string) => (text.match(/\p{L}/gu) ?? []).join('');

/** Text as compared across observations: no caret, normalized. */
function stableText(label: string): string {
  return normalizeText(label.replace(CARET, ''));
}

interface DiffItem {
  element: ScreenElement;
  text: string;
  amount: boolean;
  /** In the top 12% of the window (status bar, Dynamic Island), where OCR misreads glyphs. */
  statusArea: boolean;
}

/** The texts of one observation that take part in the comparison. */
function diffItems(d: ScreenDescription, guard: DiffGuard): DiffItem[] {
  // The status bar (clock, signal, battery) changes on its own and OCR reads it
  // differently every time ("3:17 a", "•Ill 4G 60"); it is found by its clock.
  const statusRow = statusBarRowY(d.elements, d.geometry?.heightPt, d.geometry?.widthPt);
  const statusBottom = statusAreaBottom(d.geometry?.heightPt);
  const currencies = d.elements.filter((e) => {
    const text = e.label ? stableText(e.label) : '';
    return CURRENCY_ONLY.test(text) || (e.y >= statusBottom && CURRENCY_SIGN_ONLY.test(text));
  });
  const items: DiffItem[] = [];
  for (const element of d.elements) {
    if (!element.label) continue;
    const text = stableText(element.label);
    if (!text) continue;
    const statusArea = element.y < statusBottom;
    const amount =
      /\p{N}/u.test(text) &&
      (CURRENCY.test(text) ||
        (!statusArea && AMOUNT_MARK.test(text)) ||
        currencies.some((c) => c !== element && Math.abs(c.y - element.y) <= SAME_SPOT_Y && Math.abs(c.x - element.x) <= AMOUNT_NEIGHBOUR_X));
    // An amount, a decision word or a keyword counts even on the status row
    // (a "Pay" pill beside the clock, a price read as the anchor).
    if (inStatusBarRow(element, statusRow) && !amount && !alwaysCounts(text, guard)) continue;
    if (VOLATILE_TEXT.test(text) && !amount) continue;
    items.push({ element, text, amount, statusArea });
  }
  return items;
}

/** New text that counts however it came about: decision words, sensitive keywords, blocked apps. */
function alwaysCounts(text: string, guard: DiffGuard): boolean {
  if (DECISIVE_WORDS.has(lettersOf(text))) return true;
  // Every keyword, enabled or not, live or default: here a match only means "not noise".
  for (const rules of [DEFAULT_SENSITIVE_RULES, guard.sensitiveRules ?? []]) {
    if (rules.some((rule) => rule.keywords.some((keyword) => containsKeyword(text, keyword)))) return true;
  }
  return matchesBlockedApp(text, [...DEFAULT_BLOCKED_APPS, ...(guard.blockedApps ?? [])]) !== null;
}

/** A letter OCR garbles when it reads Arabic in Latin mode ("jai" → "jaû"): non-ASCII Latin, Cyrillic or Greek. */
function isGarbleLetter(c: string): boolean {
  return /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(c) && /\p{L}/u.test(c) && !/[a-z]/.test(c);
}

/**
 * Whether `now` is OCR re-reading `was`: the same text but for spaces and one
 * letter edit OCR makes (a garbled letter, or i/l mixed up). Digits, signs and
 * symbols must match exactly, so an amount, a recipient ("Ahmed" → "Ahmad")
 * or a check mark moving to another row is never a re-read.
 */
function isReread(was: string, now: string): boolean {
  const a = [...was.replace(/\s+/g, '')];
  const b = [...now.replace(/\s+/g, '')];
  if (Math.abs(a.length - b.length) > 1) return false;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const lost = a.slice(head, a.length - tail);
  const gained = b.slice(head, b.length - tail);
  if (lost.length > 1 || gained.length > 1) return false;
  const changed = [...lost, ...gained];
  if (changed.length === 0) return true;
  if (lost.length === 1 && gained.length === 1 && /^[il]$/.test(lost[0]!) && /^[il]$/.test(gained[0]!)) return true;
  return changed.every((c) => /\p{L}/u.test(c)) && changed.some(isGarbleLetter);
}

/** The same counter or relative time at the same spot, ticked: "5m" → "6m", "• 9.5k" → "• 9.6k". */
function isTick(was: string, now: string): boolean {
  const a = TICKER.exec(was);
  const b = TICKER.exec(now);
  return !!a && !!b && a[1]!.replace(/\s+/g, '') === b[1]!.replace(/\s+/g, '') && a[2] === b[2];
}

/**
 * Whether a text that was not on the earlier observation is OCR noise: a
 * re-read of the text already at that spot (see isReread), a counter that
 * ticked there, or — only in the status area, where OCR misreads the clock and
 * signal glyphs — digits and symbols, or a lone letter where there was no text.
 * Anything else is new: a dialog, a banner, a short answer ("OK", "No", "نعم")
 * at a spot that was empty, a changed amount, a masked card number.
 */
function isOcrNoise(item: DiffItem, before: readonly ScreenElement[], guard: DiffGuard): boolean {
  const { element, text, amount, statusArea } = item;
  if (alwaysCounts(text, guard)) return false;
  const priors = before
    .filter((p) => p.label && Math.abs(p.x - element.x) <= SAME_SPOT_X && Math.abs(p.y - element.y) <= SAME_SPOT_Y)
    .map((p) => stableText(p.label));
  if (priors.some((was) => isReread(was, text))) return true;
  if (!amount && priors.some((was) => isTick(was, text))) return true;
  if (!statusArea || amount) return false;
  const letters = lettersOf(text).length;
  return letters === 0 || (letters === 1 && priors.length === 0);
}

/**
 * Compares two observations of "the same screen": refuses when new text
 * appeared (a dialog, another app, a changed amount) or most of the text is
 * gone. Ignores the status bar, numbers and times that tick, text cursors,
 * items that only moved and OCR noise (see isOcrNoise). `guard` adds the live
 * sensitive keywords and blocked apps to the texts that always count.
 */
export function screenDiff(before: ScreenDescription, fresh: ScreenDescription, guard: DiffGuard = {}): string | null {
  // No shortcut on equal fingerprints: the fingerprint may be computed without
  // the window size and so may skip a different status-bar row.
  const was = diffItems(before, guard);
  const now = diffItems(fresh, guard);
  const wasTexts = new Set(was.map((i) => i.text));
  const nowTexts = new Set(now.map((i) => i.text));
  for (const item of now) {
    if (wasTexts.has(item.text)) continue;
    if (!isOcrNoise(item, before.elements, guard)) return `new text appeared (“${item.text}”)`;
  }
  const removed = [...wasTexts].filter((t) => !nowTexts.has(t));
  if (removed.length > Math.max(2, wasTexts.size / 3)) return 'most of the screen changed';
  return null;
}

function sameLabel(a: string, b: string): boolean {
  return stableText(a) === stableText(b);
}

/** Told to the model with every observation while a blocked app is on screen. */
function foregroundNotice(foreground: BlockedForeground): string {
  return foreground.where === 'top_hit'
    ? `SAFETY: Spotlight's top hit “${foreground.label}” is a blocked app (${foreground.app}). Pressing Return would open it and is refused. Clear the search or go Home.`
    : `SAFETY: A blocked app (${foreground.app}) appears to be open (“${foreground.label}”). Do not act inside it: call go_home, or finish_task with status "needs_user". Any other action needs the user's approval.`;
}

/**
 * The approval card shows the text that will actually be typed (live only —
 * the stored approval and the activity history keep "«N characters»"). Text
 * that looks like a secret stays hidden.
 */
function typingPreview(
  text: string,
  targetDescription: string,
  decision: PolicyDecision,
  observation: Observation,
): { summary: string; args: Record<string, unknown> } {
  const masked =
    decision.rules.some((r) => r.startsWith('sensitive.auth') || r.startsWith('auth.')) ||
    screenHasAuthPrompt(observation.description.elements.map((e) => e.label)) !== null;
  const suffix = targetDescription ? ` — ${targetDescription}` : '';
  if (masked) {
    return { summary: `Type ${describeTypedText(text)} (hidden: it looks like a password or code)${suffix}`, args: { text: describeTypedText(text) } };
  }
  const shown = redactSecrets(text);
  // Make Return and Tab visible on the card.
  const visible = shown.replace(/\r\n|\r|\n/g, '⏎').replace(/\t/g, '⇥');
  return { summary: `Type “${visible}”${suffix}`, args: { text: shown } };
}

/** Best guess of the focused field's label (used to block typing into password fields). */
function focusedFieldGuess(elements: readonly ScreenElement[]): string | null {
  // Only field-like labels (placeholders/prompts), not list rows such as "Face ID & Passcode".
  const fieldLabel =
    /^(enter )?(your )?(apple (account|id) )?(password|passcode|pin|code|verification code|one[- ]time code|security code)( required)?:?$|^(كلمة المرور|رمز التحقق|رمز المرور)$/i;
  const field = elements.find((e) => fieldLabel.test(e.label.trim()));
  return field?.label ?? null;
}

// Swipe geometry and pacing live in @iphone-ai/shared (swipe.ts); re-exported for the step engine and tests.
export { SWIPE_MARGIN_X, SWIPE_MARGIN_Y, SWIPE_TRAVEL, swipeAction, type SwipeDistance } from '@iphone-ai/shared';

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
