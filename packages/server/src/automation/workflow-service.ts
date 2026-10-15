// Saved, repeatable phone workflows: storage (workflows / workflow_runs),
// runs through the step engine (one at a time, holding the workflow control
// lease), AI suggestions, SKILL.md export and the manual-action recorder.
// Workflows returned to callers (the HTTP API, incl. view-only sessions) never
// contain the text of sensitive type_text steps.

import {
  workflowInputSchema,
  type Actor,
  type ScreenDescription,
  type Workflow,
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowSuggestion,
} from '@iphone-ai/shared';

import { newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { RecorderStatus, WorkflowServiceApi } from '../core/services.js';
import type { AiProvider } from '../ai/types.js';
import { fromJson, toJson } from '../db/database.js';
import type { Lease } from '../device/device-controller.js';
import { WorkflowExecution, errorMessage, type EngineDeps } from './engine.js';
import { WorkflowRecorder } from './recorder.js';
import { writeSkillFile } from './skill-export.js';
import { normalizeStepIds } from './steps.js';
import { SUGGEST_SYSTEM_PROMPT, buildSuggestionRequest, parseSuggestion } from './suggest.js';
import {
  DEFAULT_AUTOMATION_TIMING,
  WorkflowError,
  type AutomationTiming,
  type WorkflowServiceDeps,
} from './types.js';

interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  steps_json: string;
  source: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_run_status: string | null;
  last_success_at: number | null;
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  current_step_index: number;
  steps_json: string;
  error: string | null;
  retry_of: string | null;
}

const LIVE_STATUSES: readonly WorkflowRunStatus[] = ['running', 'paused', 'awaiting_approval'];

/** Stands in for the text of sensitive type_text steps in returned workflows; sent back unchanged it keeps the stored text. */
export const HIDDEN_TEXT = '••••••••';

export class WorkflowService implements WorkflowServiceApi {
  private readonly log: Logger;
  private readonly timing: AutomationTiming;
  private readonly recorder: WorkflowRecorder;
  private execution: WorkflowExecution | null = null;
  private readonly finishWaiters = new Map<string, ((run: WorkflowRun) => void)[]>();

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.log = deps.log.child('workflows');
    this.timing = { ...DEFAULT_AUTOMATION_TIMING, ...deps.timing };
    this.recorder = new WorkflowRecorder(deps.device, this.log, this.timing);
    this.recoverInterruptedRuns();
  }

  // ───────────────────────────── storage ─────────────────────────────

  list(): Workflow[] {
    return this.deps.db.all<WorkflowRow>('SELECT * FROM workflows ORDER BY updated_at DESC').map(rowToWorkflow).map(hideSecrets);
  }

  get(id: string): Workflow | null {
    const workflow = this.load(id);
    return workflow ? hideSecrets(workflow) : null;
  }

  /** The stored workflow including sensitive text (internal use only: runs and export). */
  private load(id: string): Workflow | null {
    const row = this.deps.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id);
    return row ? rowToWorkflow(row) : null;
  }

  create(input: WorkflowInput): Workflow {
    const parsed = parseInput(input);
    const now = Date.now();
    const workflow: Workflow = {
      id: newId('wf'),
      name: parsed.name,
      description: parsed.description,
      steps: restoreHiddenText(normalizeStepIds(parsed.steps), []),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      lastSuccessAt: null,
      source: parsed.source,
    };
    this.deps.db.run(
      `INSERT INTO workflows (id, name, description, steps_json, source, created_at, updated_at, last_run_at, last_run_status, last_success_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      workflow.id,
      workflow.name,
      workflow.description,
      toJson(workflow.steps),
      workflow.source,
      workflow.createdAt,
      workflow.updatedAt,
    );
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.created',
      actor: 'user',
      summary: `Saved workflow “${workflow.name}” (${workflow.steps.length} ${workflow.steps.length === 1 ? 'step' : 'steps'})`,
      detail: { workflowId: workflow.id, source: workflow.source },
    });
    return hideSecrets(workflow);
  }

  update(id: string, input: WorkflowInput): Workflow {
    const existing = this.requireWorkflow(id);
    const parsed = parseInput(input);
    // The input schema defaults `source` to 'manual'; keep the original origin unless one was sent.
    const sentSource = typeof (input as { source?: unknown }).source === 'string';
    const workflow: Workflow = {
      ...existing,
      name: parsed.name,
      description: parsed.description,
      steps: restoreHiddenText(normalizeStepIds(parsed.steps), existing.steps),
      source: sentSource ? parsed.source : existing.source,
      updatedAt: Date.now(),
    };
    this.deps.db.run(
      'UPDATE workflows SET name = ?, description = ?, steps_json = ?, source = ?, updated_at = ? WHERE id = ?',
      workflow.name,
      workflow.description,
      toJson(workflow.steps),
      workflow.source,
      workflow.updatedAt,
      id,
    );
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.updated',
      actor: 'user',
      summary: `Updated workflow “${workflow.name}”`,
      detail: { workflowId: id, steps: workflow.steps.length },
    });
    return hideSecrets(workflow);
  }

  remove(id: string): void {
    const workflow = this.requireWorkflow(id);
    const active = this.activeRun();
    if (active && active.workflowId === id) {
      throw new WorkflowError('This workflow is running. Stop it before deleting it.', 'conflict');
    }
    this.deps.db.transaction(() => {
      this.deps.db.run('DELETE FROM workflow_runs WHERE workflow_id = ?', id);
      this.deps.db.run('DELETE FROM workflows WHERE id = ?', id);
    });
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.deleted',
      actor: 'user',
      summary: `Deleted workflow “${workflow.name}”`,
      detail: { workflowId: id },
    });
  }

  // ───────────────────────────── runs ─────────────────────────────

  async run(id: string, actor: Actor): Promise<WorkflowRun> {
    const workflow = this.requireWorkflow(id);
    return this.startRun(workflow, actor, null);
  }

  pause(runId: string): WorkflowRun {
    return this.requireExecution(runId).pause();
  }

  resume(runId: string): WorkflowRun {
    return this.requireExecution(runId).resume();
  }

  stop(runId: string, reason: string): WorkflowRun {
    if (this.execution && this.execution.runId === runId) {
      return this.execution.stop(reason.trim() || 'Stopped by the user.');
    }
    const run = this.getRun(runId);
    if (!run) throw new WorkflowError('Workflow run not found.', 'not_found', 404);
    return run;
  }

  async retry(runId: string, fromFailedStep: boolean, actor: Actor): Promise<WorkflowRun> {
    const previous = this.getRun(runId);
    if (!previous) throw new WorkflowError('Workflow run not found.', 'not_found', 404);
    if (this.execution && this.execution.runId === runId && !this.execution.isFinished) {
      throw new WorkflowError('This run is still in progress.', 'conflict');
    }
    const workflow = this.load(previous.workflowId);
    if (!workflow) throw new WorkflowError('The workflow for this run no longer exists.', 'not_found', 404);
    let startIndex = 0;
    if (fromFailedStep) {
      const failed = previous.steps.find((s) => s.status === 'failed');
      const index = failed ? workflow.steps.findIndex((s) => s.id === failed.stepId) : -1;
      startIndex = index >= 0 ? index : 0;
    }
    return this.startRun(workflow, actor, { of: previous, startIndex });
  }

  runs(workflowId?: string, limit = 50): WorkflowRun[] {
    const max = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
    const rows = workflowId
      ? this.deps.db.all<RunRow>('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?', workflowId, max)
      : this.deps.db.all<RunRow>('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?', max);
    return rows.map(rowToRun);
  }

  getRun(runId: string): WorkflowRun | null {
    if (this.execution && this.execution.runId === runId) return this.execution.snapshot();
    const row = this.deps.db.get<RunRow>('SELECT * FROM workflow_runs WHERE id = ?', runId);
    return row ? rowToRun(row) : null;
  }

  activeRun(): WorkflowRun | null {
    if (!this.execution || this.execution.isFinished) return null;
    const run = this.execution.snapshot();
    return LIVE_STATUSES.includes(run.status) ? run : null;
  }

  /** Resolves with the final run once it has finished (immediately for finished runs). */
  waitForRun(runId: string): Promise<WorkflowRun> {
    if (!this.execution || this.execution.runId !== runId) {
      const run = this.getRun(runId);
      if (!run) return Promise.reject(new WorkflowError('Workflow run not found.', 'not_found', 404));
      return Promise.resolve(run);
    }
    return new Promise((resolve) => {
      const list = this.finishWaiters.get(runId) ?? [];
      list.push(resolve);
      this.finishWaiters.set(runId, list);
    });
  }

  private startRun(workflow: Workflow, actor: Actor, retry: { of: WorkflowRun; startIndex: number } | null): WorkflowRun {
    const { device, settings } = this.deps;
    if (this.execution) {
      const current = this.execution.snapshot();
      throw new WorkflowError(
        this.execution.isFinished || !LIVE_STATUSES.includes(current.status)
          ? `Workflow “${current.workflowName}” is still stopping. Try again in a moment.`
          : `Workflow “${current.workflowName}” is already running. Stop it first.`,
        'conflict',
      );
    }
    if (workflow.steps.length === 0) {
      throw new WorkflowError('Add at least one step before running this workflow.', 'invalid', 400);
    }
    if (settings.get().permissions.controlMode === 'observe') {
      throw new WorkflowError(
        'Workflows need Assisted Control or AI Mode. Observe Only never lets automation touch the iPhone.',
        'mode',
        403,
      );
    }
    if (device.isStopLatched) {
      throw new WorkflowError('The emergency stop is engaged. Re-arm control before running a workflow.', 'stop_latched');
    }
    const holder = device.currentLease;
    if (holder) {
      throw new WorkflowError(`${holder.label} is already controlling the iPhone. Stop it first.`, 'lease_conflict');
    }
    const mirroring = device.getStatus().mirroring;
    if (mirroring.state !== 'connected') {
      throw new WorkflowError(
        mirroring.state === 'paused'
          ? 'iPhone Mirroring is paused. Lock your iPhone and keep it nearby, click Resume, then run the workflow again.'
          : 'iPhone Mirroring is not connected. Connect it, then run the workflow again.',
        'not_connected',
      );
    }

    let lease: Lease;
    try {
      lease = device.acquireLease('workflow', `Workflow “${workflow.name}”`);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      throw new WorkflowError(errorMessage(err), code === 'stop_latched' ? 'stop_latched' : 'lease_conflict');
    }

    const startIndex = retry?.startIndex ?? 0;
    const now = Date.now();
    const run: WorkflowRun = {
      id: newId('run'),
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'running',
      startedAt: now,
      endedAt: null,
      currentStepIndex: startIndex,
      steps: workflow.steps.map((step, index) => ({
        stepId: step.id,
        status: index < startIndex ? 'skipped' : 'pending',
        startedAt: null,
        endedAt: null,
        message: index < startIndex ? 'Skipped (retry from failed step)' : null,
        output: null,
        screenshotId: null,
      })),
      error: null,
      retryOf: retry?.of.id ?? null,
    };

    try {
      this.saveRun(run);
      this.updateWorkflowStats(workflow.id, { lastRunAt: now, lastRunStatus: 'running' });
    } catch (err) {
      lease.release();
      throw err;
    }
    const retryText = retry ? (startIndex > 0 ? ` (retry from step ${startIndex + 1})` : ' (retry)') : '';
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.run.started',
      actor,
      summary: `Started workflow “${workflow.name}”${retryText}`,
      workflowRunId: run.id,
      detail: { workflowId: workflow.id, steps: workflow.steps.length, startIndex, retryOf: run.retryOf },
    });

    const engineDeps: EngineDeps = {
      settings: this.deps.settings,
      activity: this.deps.activity,
      approvals: this.deps.approvals,
      screenshots: this.deps.screenshots,
      agents: this.deps.agents,
      device: this.deps.device,
      log: this.log,
      timing: this.timing,
    };
    const execution = new WorkflowExecution(engineDeps, {
      workflow: structuredClone(workflow),
      run,
      lease,
      startIndex,
      save: (next) => this.saveRun(next),
    });
    this.execution = execution;
    execution.start().then(
      (final) => this.onRunFinished(execution, final),
      (err: unknown) => {
        // Only reachable if persisting the final state failed; make sure control is released.
        this.log.error('Workflow run crashed', { runId: run.id, error: errorMessage(err) });
        lease.release();
        const final = execution.snapshot();
        if (LIVE_STATUSES.includes(final.status)) {
          final.status = 'failed';
          final.error = `Internal error: ${errorMessage(err)}`;
          final.endedAt = Date.now();
        }
        this.onRunFinished(execution, final);
      },
    );
    return structuredClone(run);
  }

  private onRunFinished(execution: WorkflowExecution, final: WorkflowRun): void {
    if (this.execution === execution) this.execution = null;
    try {
      this.saveRun(final);
      this.updateWorkflowStats(final.workflowId, {
        lastRunStatus: final.status,
        ...(final.status === 'succeeded' ? { lastSuccessAt: final.endedAt ?? Date.now() } : {}),
      });
    } catch (err) {
      this.log.error('Could not store the final workflow run state', { runId: final.id, error: errorMessage(err) });
    }
    const counts = { succeeded: 0, failed: 0, skipped: 0 };
    for (const step of final.steps) {
      if (step.status === 'succeeded') counts.succeeded += 1;
      else if (step.status === 'failed') counts.failed += 1;
      else if (step.status === 'skipped') counts.skipped += 1;
    }
    const summary =
      final.status === 'succeeded'
        ? `Workflow “${final.workflowName}” finished successfully`
        : final.status === 'stopped'
          ? `Workflow “${final.workflowName}” stopped: ${final.error ?? 'stopped'}`
          : `Workflow “${final.workflowName}” failed: ${final.error ?? 'unknown error'}`;
    this.deps.activity.record({
      category: 'workflow',
      type: `workflow.run.${final.status}`,
      actor: 'workflow',
      severity: final.status === 'succeeded' ? 'info' : final.status === 'stopped' ? 'warning' : 'error',
      summary,
      success: final.status === 'succeeded',
      durationMs: (final.endedAt ?? Date.now()) - final.startedAt,
      workflowRunId: final.id,
      detail: { workflowId: final.workflowId, outcome: final.status, ...counts, retryOf: final.retryOf },
    });
    const waiters = this.finishWaiters.get(final.id) ?? [];
    this.finishWaiters.delete(final.id);
    for (const resolve of waiters) resolve(structuredClone(final));
  }

  // ───────────────────────────── suggestions & export ─────────────────────────────

  async suggest(goal: string, providerId?: string): Promise<WorkflowSuggestion> {
    const trimmed = goal.trim();
    if (!trimmed) throw new WorkflowError('Describe what the workflow should do.', 'invalid', 400);
    let provider: AiProvider;
    try {
      provider = await this.deps.agents.getProvider(providerId ?? null);
    } catch (err) {
      throw new WorkflowError(`No AI provider is available: ${errorMessage(err)}`, 'ai_unavailable', 412);
    }
    const settings = this.deps.settings.get();
    // Screen text only goes to a cloud provider after the privacy notice was accepted.
    const mayShareScreen = !provider.config.cloud || settings.privacy.cloudDisclosureAcknowledged;
    let screen: ScreenDescription | null = null;
    if (mayShareScreen && this.deps.device.canCaptureScreen()) {
      try {
        screen = await this.deps.device.describe({ includeImage: false });
      } catch (err) {
        this.log.debug('Screen not available for the workflow suggestion', { error: errorMessage(err) });
      }
    }
    let reply: string;
    try {
      reply = await provider.complete({
        system: SUGGEST_SYSTEM_PROMPT,
        content: [{ type: 'text', text: buildSuggestionRequest(trimmed, { screen, blockedApps: settings.permissions.blockedApps }) }],
        signal: AbortSignal.timeout(Math.max(provider.config.timeoutMs, 30_000)),
        maxTokens: Math.min(provider.config.maxOutputTokens, 8000),
      });
    } catch (err) {
      throw new WorkflowError(`The AI could not suggest a workflow: ${errorMessage(err)}`, 'ai_unavailable', 502);
    }
    const suggestion = parseSuggestion(reply, {
      goal: trimmed,
      geometryId: screen?.geometry?.geometryId ?? null,
      maxSteps: settings.automation.maxStepsPerRun,
    });
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.suggested',
      actor: 'ai',
      summary: `${provider.config.label} suggested a workflow with ${suggestion.steps.length} ${suggestion.steps.length === 1 ? 'step' : 'steps'}`,
      detail: { providerId: provider.config.id, screenShared: screen !== null },
    });
    return suggestion;
  }

  exportSkill(id: string): { path: string; markdown: string } {
    const workflow = this.requireWorkflow(id);
    const result = writeSkillFile(this.deps.paths.mirroirSkillsDir, workflow);
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.exported',
      actor: 'user',
      summary: `Exported workflow “${workflow.name}” as a Mirroir skill`,
      detail: { workflowId: id, path: result.path },
    });
    return result;
  }

  // ───────────────────────────── recorder ─────────────────────────────

  startRecording(name: string): RecorderStatus {
    const status = this.recorder.start(name);
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.recording.started',
      actor: 'user',
      summary: `Started recording “${status.name ?? name}” — manual actions on the iPhone become workflow steps`,
    });
    return status;
  }

  stopRecording(save: boolean): Workflow | null {
    const result = this.recorder.stop();
    if (!result) return null;
    this.deps.activity.record({
      category: 'workflow',
      type: 'workflow.recording.stopped',
      actor: 'user',
      summary: `Stopped recording “${result.name}” (${result.steps.length} ${result.steps.length === 1 ? 'step' : 'steps'}${save ? '' : ', discarded'})`,
    });
    if (!save || result.steps.length === 0) return null;
    const description = ['Recorded from manual control.', ...result.notes].join(' ').slice(0, 2000);
    return this.create({ name: result.name, description, steps: result.steps, source: 'recorded' });
  }

  recorderStatus(): RecorderStatus {
    return this.recorder.status();
  }

  /** Resolves once the recorder has no pending screen refresh. */
  recorderSettled(): Promise<void> {
    return this.recorder.settled();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private requireWorkflow(id: string): Workflow {
    const workflow = this.load(id);
    if (!workflow) throw new WorkflowError('Workflow not found.', 'not_found', 404);
    return workflow;
  }

  private requireExecution(runId: string): WorkflowExecution {
    if (this.execution && this.execution.runId === runId && !this.execution.isFinished) return this.execution;
    if (this.getRun(runId)) throw new WorkflowError('This workflow run has already finished.', 'conflict');
    throw new WorkflowError('Workflow run not found.', 'not_found', 404);
  }

  private saveRun(run: WorkflowRun): void {
    try {
      this.deps.db.run(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_name, status, started_at, ended_at, current_step_index, steps_json, error, retry_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at,
           current_step_index = excluded.current_step_index, steps_json = excluded.steps_json, error = excluded.error`,
        run.id,
        run.workflowId,
        run.workflowName,
        run.status,
        run.startedAt,
        run.endedAt,
        run.currentStepIndex,
        toJson(run.steps),
        run.error,
        run.retryOf,
      );
    } catch (err) {
      this.log.error('Could not store a workflow run', { runId: run.id, error: errorMessage(err) });
    }
    this.deps.hub.publish({ type: 'workflow_run', run: structuredClone(run) });
  }

  private updateWorkflowStats(
    id: string,
    stats: { lastRunAt?: number; lastRunStatus: WorkflowRunStatus; lastSuccessAt?: number },
  ): void {
    const sets = ['last_run_status = ?'];
    const params: (string | number)[] = [stats.lastRunStatus];
    if (stats.lastRunAt !== undefined) {
      sets.push('last_run_at = ?');
      params.push(stats.lastRunAt);
    }
    if (stats.lastSuccessAt !== undefined) {
      sets.push('last_success_at = ?');
      params.push(stats.lastSuccessAt);
    }
    this.deps.db.run(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  /** Runs left 'running' by a previous backend process (crash / force quit) are marked failed. */
  private recoverInterruptedRuns(): void {
    try {
      const retentionDays = this.deps.settings.get().privacy.historyRetentionDays;
      this.deps.db.run('DELETE FROM workflow_runs WHERE started_at < ?', Date.now() - retentionDays * 86_400_000);
      const placeholders = LIVE_STATUSES.map(() => '?').join(', ');
      const rows = this.deps.db.all<RunRow>(`SELECT * FROM workflow_runs WHERE status IN (${placeholders})`, ...LIVE_STATUSES);
      for (const row of rows) {
        const run = rowToRun(row);
        for (const step of run.steps) {
          if (step.status === 'running') {
            step.status = 'failed';
            step.message = 'Interrupted';
          } else if (step.status === 'pending') {
            step.status = 'skipped';
            step.message = 'Skipped (run interrupted)';
          }
        }
        run.status = 'failed';
        run.error = 'iPhone AI quit while this run was in progress.';
        run.endedAt = run.endedAt ?? Date.now();
        this.deps.db.run(
          'UPDATE workflow_runs SET status = ?, ended_at = ?, steps_json = ?, error = ? WHERE id = ?',
          run.status,
          run.endedAt,
          toJson(run.steps),
          run.error,
          run.id,
        );
        this.deps.db.run("UPDATE workflows SET last_run_status = 'failed' WHERE id = ? AND last_run_status = 'running'", run.workflowId);
      }
    } catch (err) {
      this.log.warn('Could not recover interrupted workflow runs', { error: errorMessage(err) });
    }
  }
}

function parseInput(input: WorkflowInput): WorkflowInput {
  const result = workflowInputSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
    throw new WorkflowError(`Invalid workflow: ${issue?.message ?? 'validation failed'}${where}`, 'invalid', 400);
  }
  return result.data;
}

function isHiddenStep(step: WorkflowStep): boolean {
  return step.type === 'type_text' && step.sensitive === true;
}

/** A copy without the text of sensitive type_text steps (passwords / codes are never returned). */
function hideSecrets(workflow: Workflow): Workflow {
  if (!workflow.steps.some(isHiddenStep)) return workflow;
  return { ...workflow, steps: workflow.steps.map((step) => (isHiddenStep(step) ? { ...step, text: HIDDEN_TEXT } : step)) };
}

/** Puts the stored text back into sensitive steps that were sent back with the HIDDEN_TEXT placeholder. */
function restoreHiddenText(steps: WorkflowStep[], stored: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.map((step, index) => {
    if (step.type !== 'type_text' || step.text !== HIDDEN_TEXT) return step;
    const original = stored.find((s) => s.id === step.id);
    if (!original || original.type !== 'type_text' || original.sensitive !== true) {
      throw new WorkflowError(`Step ${index + 1} contains hidden text that can't be copied. Type the text again.`, 'invalid', 400);
    }
    // Hidden text stays hidden; it only becomes visible again by typing it anew.
    return { ...step, text: original.text, sensitive: true };
  });
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps: fromJson<Workflow['steps']>(row.steps_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: (row.last_run_status as WorkflowRunStatus | null) ?? null,
    lastSuccessAt: row.last_success_at,
    source: row.source as Workflow['source'],
  };
}

function rowToRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status as WorkflowRunStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    currentStepIndex: row.current_step_index,
    steps: fromJson<WorkflowRun['steps']>(row.steps_json, []),
    error: row.error,
    retryOf: row.retry_of,
  };
}
