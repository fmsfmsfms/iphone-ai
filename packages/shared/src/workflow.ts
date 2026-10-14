// Saved automation workflows. Steps reference on-screen text (resolved live via
// describe_screen), never hardcoded coordinates — except `tap_point`, which is
// only produced by manual recording and is re-validated against geometry.

import type { SwipeDirection } from './control.js';

export type WorkflowStep =
  | { id: string; type: 'launch_app'; app: string }
  | { id: string; type: 'tap_text'; label: string; exact?: boolean }
  | { id: string; type: 'long_press_text'; label: string }
  | { id: string; type: 'tap_point'; x: number; y: number; geometryId: string | null; note?: string }
  | { id: string; type: 'swipe'; direction: SwipeDirection; distance?: 'short' | 'medium' | 'long' }
  | { id: string; type: 'type_text'; text: string; sensitive?: boolean }
  | { id: string; type: 'press_key'; key: string }
  | { id: string; type: 'press_home' }
  | { id: string; type: 'press_back' }
  | { id: string; type: 'open_url'; url: string }
  | { id: string; type: 'scroll_to'; label: string; direction?: SwipeDirection }
  | { id: string; type: 'wait_for_text'; label: string; timeoutMs?: number }
  | { id: string; type: 'assert_text'; label: string; present: boolean }
  | { id: string; type: 'screenshot'; label: string }
  | { id: string; type: 'read_screen'; saveAs: string; instruction?: string }
  | { id: string; type: 'ai_task'; instruction: string; maxActions?: number }
  | { id: string; type: 'checkpoint'; message: string }
  | { id: string; type: 'wait'; ms: number };

export type WorkflowStepType = WorkflowStep['type'];

/** Steps that require an AI provider to run. */
export const AI_STEP_TYPES: readonly WorkflowStepType[] = ['ai_task'];

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  lastRunStatus: WorkflowRunStatus | null;
  lastSuccessAt: number | null;
  /** Origin of the workflow: hand-written, AI suggestion, or manual recording. */
  source: 'manual' | 'ai-suggested' | 'recorded' | 'imported';
}

export type WorkflowRunStatus =
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'stopped';

export type StepRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StepRunResult {
  stepId: string;
  status: StepRunStatus;
  startedAt: number | null;
  endedAt: number | null;
  message: string | null;
  /** Captured value for read_screen steps (redacted when sensitive). */
  output: string | null;
  screenshotId: string | null;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  startedAt: number;
  endedAt: number | null;
  currentStepIndex: number;
  steps: StepRunResult[];
  error: string | null;
  /** Run started from a retry of this earlier run. */
  retryOf: string | null;
}

export interface WorkflowSuggestion {
  name: string;
  description: string;
  steps: WorkflowStep[];
  notes: string;
}
