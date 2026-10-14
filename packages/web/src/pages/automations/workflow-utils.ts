// Pure helpers for the workflow editor and run views: list reordering, drafts,
// validation, run timing and status presentation.

import {
  workflowInputSchema,
  type ControlMode,
  type McpServerState,
  type MirroringState,
  type StepRunStatus,
  type Workflow,
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowSuggestion,
} from '@iphone-ai/shared';

import type { Tone } from '../../lib/device-state';
import { cleanStep, newStepId, validateStep, type StepIssue } from './step-meta';

// ---------------------------------------------------------------------------
// List operations (return new arrays; out-of-range input returns the list unchanged)
// ---------------------------------------------------------------------------

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list.slice();
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Moves the item at `index` one place up (delta -1) or down (delta +1). */
export function moveStep<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  return moveItem(list, index, index + delta);
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  if (index < 0 || index >= list.length) return list.slice();
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const at = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/** Copies the step at `index` (with a new id) right after it. */
export function duplicateStep(list: readonly WorkflowStep[], index: number, id: string = newStepId()): WorkflowStep[] {
  const source = list[index];
  if (!source) return list.slice();
  const copy = { ...structuredClone(source), id } as WorkflowStep;
  return insertAt(list, index + 1, copy);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface WorkflowDraft {
  name: string;
  description: string;
  steps: WorkflowStep[];
  source: Workflow['source'];
}

export function emptyDraft(): WorkflowDraft {
  return { name: '', description: '', steps: [], source: 'manual' };
}

export function draftFromWorkflow(workflow: Workflow): WorkflowDraft {
  return {
    name: workflow.name,
    description: workflow.description,
    steps: structuredClone(workflow.steps),
    source: workflow.source,
  };
}

/** A suggestion becomes an unsaved draft; steps get fresh ids so edits never collide. */
export function draftFromSuggestion(suggestion: WorkflowSuggestion): WorkflowDraft {
  return {
    name: suggestion.name,
    description: suggestion.description,
    steps: suggestion.steps.map((step) => ({ ...structuredClone(step), id: step.id?.trim() ? step.id : newStepId() }) as WorkflowStep),
    source: 'ai-suggested',
  };
}

export function toWorkflowInput(draft: WorkflowDraft): WorkflowInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    steps: draft.steps.map(cleanStep),
    source: draft.source,
  };
}

function canonical(draft: WorkflowDraft): string {
  return JSON.stringify(toWorkflowInput(draft));
}

export function isDraftDirty(draft: WorkflowDraft, saved: WorkflowDraft | null): boolean {
  if (!saved) return true;
  return canonical(draft) !== canonical(saved);
}

export interface DraftValidation {
  valid: boolean;
  /** i18n key for the name field, or null. */
  name: string | null;
  steps: Record<string, StepIssue[]>;
  invalidSteps: number;
  /** i18n key for a problem with the whole workflow (e.g. too many steps), or null. */
  general: string | null;
}

export const MAX_WORKFLOW_STEPS = 200;

export function validateDraft(draft: WorkflowDraft): DraftValidation {
  const steps: Record<string, StepIssue[]> = {};
  let invalidSteps = 0;
  for (const step of draft.steps) {
    const issues = validateStep(step);
    if (issues.length > 0) {
      steps[step.id] = issues;
      invalidSteps += 1;
    }
  }
  const name = draft.name.trim().length === 0 ? 'automations.validation.nameRequired' : draft.name.trim().length > 120 ? 'automations.validation.nameTooLong' : null;
  let general: string | null = null;
  if (draft.steps.length > MAX_WORKFLOW_STEPS) general = 'automations.validation.tooManySteps';
  else if (draft.description.length > 2000) general = 'automations.validation.descriptionTooLong';
  else if (new Set(draft.steps.map((s) => s.id)).size !== draft.steps.length) general = 'automations.validation.duplicateIds';
  // Final check with the same schema the backend uses.
  const parsed = workflowInputSchema.safeParse(toWorkflowInput(draft));
  if (!parsed.success && !name && !general && invalidSteps === 0) general = 'automations.validation.generic';
  return { valid: parsed.success && !name && !general && invalidSteps === 0, name, steps, invalidSteps, general };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const LIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ['running', 'paused', 'awaiting_approval'];

export function isRunLive(run: WorkflowRun | null | undefined): boolean {
  return Boolean(run && LIVE_RUN_STATUSES.includes(run.status));
}

export const RUN_STATUS_TONE: Record<WorkflowRunStatus, Tone> = {
  running: 'ai',
  paused: 'warning',
  awaiting_approval: 'warning',
  succeeded: 'success',
  failed: 'danger',
  stopped: 'default',
};

export const STEP_RUN_TONE: Record<StepRunStatus, Tone> = {
  pending: 'default',
  running: 'ai',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'default',
};

export function runDurationMs(run: Pick<WorkflowRun, 'startedAt' | 'endedAt'>, now: number = Date.now()): number {
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

export function stepDurationMs(step: { startedAt: number | null; endedAt: number | null }, now: number = Date.now()): number | null {
  if (step.startedAt === null) return null;
  return Math.max(0, (step.endedAt ?? now) - step.startedAt);
}

/** Most recent succeeded run (runs may come in any order). */
export function lastSuccessfulRun(runs: readonly WorkflowRun[]): WorkflowRun | null {
  let best: WorkflowRun | null = null;
  for (const run of runs) {
    if (run.status !== 'succeeded') continue;
    if (!best || run.startedAt > best.startedAt) best = run;
  }
  return best;
}

export interface RunProgress {
  done: number;
  total: number;
  failedIndex: number;
  succeeded: number;
  skipped: number;
}

export function runProgress(run: WorkflowRun): RunProgress {
  let done = 0;
  let succeeded = 0;
  let skipped = 0;
  for (const step of run.steps) {
    if (step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped') done += 1;
    if (step.status === 'succeeded') succeeded += 1;
    if (step.status === 'skipped') skipped += 1;
  }
  return { done, total: run.steps.length, failedIndex: run.steps.findIndex((s) => s.status === 'failed'), succeeded, skipped };
}

/** Retry options for a finished run. */
export function retryOptions(run: WorkflowRun): { whole: boolean; fromFailed: boolean } {
  if (isRunLive(run)) return { whole: false, fromFailed: false };
  const finishedBadly = run.status === 'failed' || run.status === 'stopped';
  const failedIndex = run.steps.findIndex((s) => s.status === 'failed');
  return { whole: finishedBadly, fromFailed: finishedBadly && failedIndex > 0 };
}

/** Merges runs fetched over HTTP with live copies from the store (by id), newest first. */
export function mergeRuns(fetched: readonly WorkflowRun[], live: readonly WorkflowRun[], workflowId: string): WorkflowRun[] {
  const byId = new Map<string, WorkflowRun>();
  for (const run of fetched) byId.set(run.id, run);
  for (const run of live) if (run.workflowId === workflowId) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function formatClockDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Sort workflows: most recently updated first. */
export function sortWorkflows(list: readonly Workflow[]): Workflow[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Run preconditions (mirrors the backend's checks so the UI can explain them)
// ---------------------------------------------------------------------------

export interface RunGateContext {
  connected: boolean;
  canControl: boolean;
  mode: ControlMode;
  stopLatched: boolean;
  dirty: boolean;
  stepCount: number;
  workflowId: string;
  activeRun: WorkflowRun | null;
  activeTaskRunning: boolean;
  mcpState: McpServerState | undefined;
  mirroringState: MirroringState | undefined;
}

export interface Reason {
  key: string;
  vars?: Record<string, string | number>;
}

/** Why a run (or retry) can't start right now, or null when it can. */
export function runBlockReason(ctx: RunGateContext): Reason | null {
  if (!ctx.connected) return { key: 'automations.run.reason.offline' };
  if (!ctx.canControl) return { key: 'automations.run.reason.viewOnly' };
  if (ctx.stopLatched) return { key: 'automations.run.reason.stopLatched' };
  if (ctx.mode === 'observe') return { key: 'automations.run.reason.observe' };
  if (ctx.dirty) return { key: 'automations.run.reason.unsaved' };
  if (ctx.stepCount === 0) return { key: 'automations.run.reason.noSteps' };
  if (ctx.activeRun && isRunLive(ctx.activeRun)) {
    return ctx.activeRun.workflowId === ctx.workflowId
      ? { key: 'automations.run.reason.alreadyRunning' }
      : { key: 'automations.run.reason.otherRun', vars: { name: ctx.activeRun.workflowName } };
  }
  if (ctx.activeTaskRunning) return { key: 'automations.run.reason.aiTask' };
  if (ctx.mcpState !== 'ready') return { key: 'automations.run.reason.mcp' };
  if (ctx.mirroringState === 'paused') return { key: 'automations.run.reason.paused' };
  if (ctx.mirroringState !== 'connected') return { key: 'automations.run.reason.notConnected' };
  return null;
}
