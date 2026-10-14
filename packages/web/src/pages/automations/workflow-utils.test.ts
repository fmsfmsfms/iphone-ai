import type { Workflow, WorkflowRun, WorkflowStep } from '@iphone-ai/shared';
import { describe, expect, it } from 'vitest';

import { makeRun } from '../../test/fixtures';
import {
  draftFromSuggestion,
  draftFromWorkflow,
  duplicateStep,
  formatClockDuration,
  insertAt,
  isDraftDirty,
  isRunLive,
  lastSuccessfulRun,
  mergeRuns,
  moveItem,
  moveStep,
  removeAt,
  retryOptions,
  runBlockReason,
  runDurationMs,
  runProgress,
  toWorkflowInput,
  validateDraft,
  type RunGateContext,
} from './workflow-utils';

const steps: WorkflowStep[] = [
  { id: 'a', type: 'launch_app', app: 'Settings' },
  { id: 'b', type: 'tap_text', label: 'General' },
  { id: 'c', type: 'wait', ms: 500 },
];

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf_1',
    name: 'Morning check',
    description: '',
    steps,
    createdAt: 1,
    updatedAt: 2,
    lastRunAt: null,
    lastRunStatus: null,
    lastSuccessAt: null,
    source: 'manual',
    ...overrides,
  };
}

describe('list operations', () => {
  it('moves steps up and down and ignores moves past the ends', () => {
    expect(moveStep(steps, 1, -1).map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(moveStep(steps, 1, 1).map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(moveStep(steps, 0, -1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(moveStep(steps, 2, 1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(moveItem(steps, 0, 2).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('removes and inserts without mutating the input', () => {
    const copy = steps.slice();
    expect(removeAt(steps, 1).map((s) => s.id)).toEqual(['a', 'c']);
    expect(removeAt(steps, 9).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(insertAt(['x', 'y'], 1, 'z')).toEqual(['x', 'z', 'y']);
    expect(insertAt(['x'], 99, 'z')).toEqual(['x', 'z']);
    expect(steps).toEqual(copy);
  });

  it('duplicates a step right after it, with a new id and an independent copy', () => {
    const next = duplicateStep(steps, 1, 'b2');
    expect(next.map((s) => s.id)).toEqual(['a', 'b', 'b2', 'c']);
    expect(next[2]).toEqual({ id: 'b2', type: 'tap_text', label: 'General' });
    (next[2] as { label: string }).label = 'Changed';
    expect((steps[1] as { label: string }).label).toBe('General');
  });
});

describe('drafts', () => {
  it('detects unsaved changes', () => {
    const saved = draftFromWorkflow(workflow());
    expect(isDraftDirty(draftFromWorkflow(workflow()), saved)).toBe(false);
    expect(isDraftDirty({ ...saved, name: 'Other' }, saved)).toBe(true);
    expect(isDraftDirty({ ...saved, steps: moveStep(saved.steps, 0, 1) }, saved)).toBe(true);
    expect(isDraftDirty(saved, null)).toBe(true);
    // Whitespace-only differences in the name are not changes.
    expect(isDraftDirty({ ...saved, name: 'Morning check  ' }, saved)).toBe(false);
  });

  it('turns suggestions into unsaved AI drafts with step ids', () => {
    const draft = draftFromSuggestion({
      name: 'Low Power',
      description: 'Turns it on',
      notes: '',
      steps: [{ id: '', type: 'launch_app', app: 'Settings' } as WorkflowStep],
    });
    expect(draft.source).toBe('ai-suggested');
    expect(draft.steps[0]!.id).not.toBe('');
  });

  it('validates the whole workflow with the shared schema', () => {
    const ok = validateDraft(draftFromWorkflow(workflow()));
    expect(ok.valid).toBe(true);
    const bad = validateDraft({ name: ' ', description: '', source: 'manual', steps: [{ id: 'x', type: 'tap_text', label: '' }] });
    expect(bad.valid).toBe(false);
    expect(bad.name).toBe('automations.validation.nameRequired');
    expect(bad.invalidSteps).toBe(1);
    expect(bad.steps['x']).toEqual([{ field: 'label', key: 'automations.validation.required' }]);
    const dup = validateDraft({ name: 'n', description: '', source: 'manual', steps: [steps[0]!, steps[0]!] });
    expect(dup.general).toBe('automations.validation.duplicateIds');
  });

  it('trims the name and description for saving', () => {
    expect(toWorkflowInput({ name: '  Name ', description: ' d ', steps: [], source: 'recorded' })).toEqual({
      name: 'Name',
      description: 'd',
      steps: [],
      source: 'recorded',
    });
  });
});

describe('runs', () => {
  const finished = (overrides: Partial<WorkflowRun>) => makeRun({ status: 'succeeded', endedAt: 5_000, ...overrides });

  it('summarises progress and retry options', () => {
    const run = makeRun({
      status: 'failed',
      endedAt: 3_000,
      steps: [
        { stepId: 'a', status: 'succeeded', startedAt: 1, endedAt: 2, message: null, output: null, screenshotId: null },
        { stepId: 'b', status: 'failed', startedAt: 2, endedAt: 3, message: 'Not found', output: null, screenshotId: null },
        { stepId: 'c', status: 'skipped', startedAt: null, endedAt: null, message: null, output: null, screenshotId: null },
      ],
    });
    expect(runProgress(run)).toEqual({ done: 3, total: 3, failedIndex: 1, succeeded: 1, skipped: 1 });
    expect(retryOptions(run)).toEqual({ whole: true, fromFailed: true });
    expect(retryOptions(makeRun({ status: 'running' }))).toEqual({ whole: false, fromFailed: false });
    expect(retryOptions(finished({}))).toEqual({ whole: false, fromFailed: false });
  });

  it('measures durations (live runs up to now)', () => {
    expect(runDurationMs({ startedAt: 1_000, endedAt: 4_000 })).toBe(3_000);
    expect(runDurationMs({ startedAt: 1_000, endedAt: null }, 2_500)).toBe(1_500);
    expect(formatClockDuration(65_000)).toBe('1:05');
    expect(formatClockDuration(3_723_000)).toBe('1:02:03');
  });

  it('finds the last successful run and merges live runs over fetched ones', () => {
    const a = finished({ id: 'r1', startedAt: 1_000 });
    const b = finished({ id: 'r2', startedAt: 2_000, status: 'failed' });
    const c = finished({ id: 'r3', startedAt: 3_000 });
    expect(lastSuccessfulRun([a, b, c])?.id).toBe('r3');
    expect(lastSuccessfulRun([b])).toBeNull();
    const fetchedLive = makeRun({ id: 'r2', startedAt: 2_000, status: 'running', currentStepIndex: 0 });
    const live = makeRun({ id: 'r2', startedAt: 2_000, status: 'paused', currentStepIndex: 1 });
    const other = makeRun({ id: 'x', workflowId: 'other', startedAt: 9_000 });
    const merged = mergeRuns([a, fetchedLive], [live, other], 'wf_1');
    expect(merged.map((r) => r.id)).toEqual(['r2', 'r1']);
    // Both live: the store copy (fed by events) is the fresher one.
    expect(merged[0]!.status).toBe('paused');
    expect(merged[0]!.currentStepIndex).toBe(1);
  });

  it('never lets a stale live store copy hide a run the server reports as finished', () => {
    // The socket dropped while the run was stopped elsewhere: the store still says "running".
    const stale = makeRun({ id: 'r1', status: 'running' });
    const stopped = makeRun({ id: 'r1', status: 'stopped', endedAt: 5_000 });
    const merged = mergeRuns([stopped], [stale], 'wf_1');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('stopped');
    expect(isRunLive(merged[0])).toBe(false);
    // A finished store copy still wins over an older fetched live one.
    expect(mergeRuns([stale], [stopped], 'wf_1')[0]!.status).toBe('stopped');
  });
});

describe('runBlockReason', () => {
  const ready: RunGateContext = {
    connected: true,
    canControl: true,
    mode: 'assisted',
    stopLatched: false,
    dirty: false,
    stepCount: 3,
    workflowId: 'wf_1',
    activeRun: null,
    activeTaskRunning: false,
    mcpState: 'ready',
    mirroringState: 'connected',
  };

  it('allows a run when everything is ready', () => {
    expect(runBlockReason(ready)).toBeNull();
  });

  it('explains each precondition', () => {
    expect(runBlockReason({ ...ready, mode: 'observe' })?.key).toBe('automations.run.reason.observe');
    expect(runBlockReason({ ...ready, stopLatched: true })?.key).toBe('automations.run.reason.stopLatched');
    expect(runBlockReason({ ...ready, dirty: true })?.key).toBe('automations.run.reason.unsaved');
    expect(runBlockReason({ ...ready, stepCount: 0 })?.key).toBe('automations.run.reason.noSteps');
    expect(runBlockReason({ ...ready, activeTaskRunning: true })?.key).toBe('automations.run.reason.aiTask');
    expect(runBlockReason({ ...ready, mcpState: 'crashed' })?.key).toBe('automations.run.reason.mcp');
    expect(runBlockReason({ ...ready, mirroringState: 'paused' })?.key).toBe('automations.run.reason.paused');
    expect(runBlockReason({ ...ready, mirroringState: 'unknown' })?.key).toBe('automations.run.reason.notConnected');
    expect(runBlockReason({ ...ready, canControl: false })?.key).toBe('automations.run.reason.viewOnly');
    expect(runBlockReason({ ...ready, connected: false })?.key).toBe('automations.run.reason.offline');
    expect(runBlockReason({ ...ready, activeRun: makeRun({ workflowId: 'wf_1' }) })?.key).toBe('automations.run.reason.alreadyRunning');
    expect(runBlockReason({ ...ready, activeRun: makeRun({ workflowId: 'wf_2', workflowName: 'Other' }) })).toEqual({
      key: 'automations.run.reason.otherRun',
      vars: { name: 'Other' },
    });
  });
});
