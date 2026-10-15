// Display helpers shared by the chat components: status labels and tones,
// step types, durations and readable explanations of tasks that didn't
// succeed.

import type { AgentStepType, AgentTask, RiskLevel, TaskStatus } from '@iphone-ai/shared';

import type { Tone } from '../../lib/device-state';

export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  queued: 'default',
  running: 'ai',
  paused: 'warning',
  awaiting_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
  stopped: 'danger',
};

export const TASK_STATUS_KEY: Record<TaskStatus, string> = {
  queued: 'task.status.queued',
  running: 'task.status.running',
  paused: 'task.status.paused',
  awaiting_approval: 'task.status.awaitingApproval',
  completed: 'task.status.completed',
  failed: 'task.status.failed',
  cancelled: 'task.status.cancelled',
  stopped: 'task.status.stopped',
};

export const RISK_TONE: Record<RiskLevel, Tone> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

export const RISK_KEY: Record<RiskLevel, string> = {
  low: 'approval.risk.low',
  medium: 'approval.risk.medium',
  high: 'approval.risk.high',
};

export const STEP_TYPE_KEY: Record<AgentStepType, string> = {
  observe: 'step.type.observe',
  reasoning: 'step.type.reasoning',
  tool_call: 'step.type.toolCall',
  approval: 'step.type.approval',
  verify: 'step.type.verify',
  policy: 'step.type.policy',
  message: 'step.type.message',
  error: 'step.type.error',
};

/** Pretty JSON for (already redacted) tool arguments. */
export function formatArgs(args: Record<string, unknown> | null | undefined): string {
  if (!args || Object.keys(args).length === 0) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function formatDuration(ms: number | null | undefined, locale: string): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(ms)} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

export type Translate = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

/** How long a task has run (until now while it runs); null before it started. */
export function taskElapsedMs(task: Pick<AgentTask, 'startedAt' | 'endedAt'>, now: number): number | null {
  if (!task.startedAt) return null;
  return Math.max(0, (task.endedAt ?? now) - task.startedAt);
}

/** "8s", "4m 12s", "1h 3m" (localized digits and units). */
export function formatElapsed(ms: number, t: Translate): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t('task.duration.hours', { h, m });
  if (m > 0) return t('task.duration.minutes', { m, s });
  return t('task.duration.seconds', { s });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type FailureKind =
  | 'cancelled'
  | 'emergencyStop'
  | 'stopped'
  | 'timeout'
  | 'stepLimit'
  | 'loop'
  | 'auth'
  | 'config'
  | 'rateLimit'
  | 'network'
  | 'refusal'
  | 'needsUser'
  | 'mirroring'
  | 'permission'
  | 'mcp'
  | 'policy'
  | 'unsuccessful'
  | 'generic';

export const FAILURE_KINDS: readonly FailureKind[] = [
  'cancelled',
  'emergencyStop',
  'stopped',
  'timeout',
  'stepLimit',
  'loop',
  'auth',
  'config',
  'rateLimit',
  'network',
  'refusal',
  'needsUser',
  'mirroring',
  'permission',
  'mcp',
  'policy',
  'unsuccessful',
  'generic',
];

export type FailureAction = 'settings-ai' | 'live' | 'dashboard' | null;

export interface FailureExplanation {
  kind: FailureKind;
  titleKey: string;
  bodyKey: string;
  /** Whether sending the same instruction again is a sensible next step. */
  canRetry: boolean;
  action: FailureAction;
}

const PATTERNS: readonly [FailureKind, RegExp][] = [
  ['emergencyStop', /emergency stop/i],
  // Not a bare "sign in" / "log in": the AI's own summary often says an app on the iPhone needs one.
  ['auth', /api key|not signed in|unauthori[sz]ed|authentication|\b401\b|\b403\b/i],
  ['config', /settings\s*→\s*ai|choose a model|no model id|model not found|base url|server url|is disabled/i],
  ['rateLimit', /rate limit|\b429\b|overloaded|\b529\b/i],
  ['network', /cannot reach|can['’]t reach|not reachable|econnrefused|enotfound|fetch failed|network|connection (refused|reset|error)/i],
  ['timeout', /time limit|timed out|timeout/i],
  ['stepLimit', /step limit|action budget|max(imum)? actions/i],
  ['loop', /kept repeating|loop/i],
  ['refusal', /declined/i],
  ['needsUser', /needs your help/i],
  ['permission', /screen recording|accessibility permission/i],
  ['mirroring', /iphone mirroring|mirroring is|paused|not connected/i],
  ['mcp', /mirroir|mcp/i],
  ['policy', /blocked|not allowed|denied|policy/i],
];

function explanation(kind: FailureKind, canRetry: boolean, action: FailureAction = null): FailureExplanation {
  return { kind, titleKey: `task.failure.${kind}.title`, bodyKey: `task.failure.${kind}.body`, canRetry, action };
}

const ACTIONS: Partial<Record<FailureKind, FailureAction>> = {
  auth: 'settings-ai',
  config: 'settings-ai',
  mirroring: 'live',
  permission: 'dashboard',
  mcp: 'dashboard',
};

const NO_RETRY: ReadonlySet<FailureKind> = new Set(['auth', 'config', 'permission', 'policy', 'refusal']);

/** Readable explanation for a task that did not complete successfully (null when it did, or is still running). */
export function explainTaskFailure(task: Pick<AgentTask, 'status' | 'error' | 'outcome'>): FailureExplanation | null {
  switch (task.status) {
    case 'cancelled':
      return explanation('cancelled', true);
    case 'stopped':
      return /emergency stop/i.test(task.error ?? '') ? explanation('emergencyStop', true) : explanation('stopped', true);
    case 'completed':
      return task.outcome && !task.outcome.success ? explanation('unsuccessful', true) : null;
    case 'failed': {
      const text = `${task.error ?? ''} ${task.outcome?.summary ?? ''}`;
      for (const [kind, pattern] of PATTERNS) {
        if (pattern.test(text)) return explanation(kind, !NO_RETRY.has(kind), ACTIONS[kind] ?? null);
      }
      return explanation('generic', true);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Status at a glance
// ---------------------------------------------------------------------------

/** What the status line of a task shows: running / completed / didn't succeed / failed / needs you / stopped … */
export type TaskPhase = TaskStatus | 'needsYou' | 'unsuccessful';

export function taskPhase(task: Pick<AgentTask, 'status' | 'error' | 'outcome'>, failure: FailureExplanation | null = explainTaskFailure(task)): TaskPhase {
  if (task.status === 'failed' && failure?.kind === 'needsUser') return 'needsYou';
  if (task.status === 'completed' && failure?.kind === 'unsuccessful') return 'unsuccessful';
  return task.status;
}

export const TASK_PHASE_KEY: Record<TaskPhase, string> = { ...TASK_STATUS_KEY, needsYou: 'task.status.needsYou', unsuccessful: 'task.status.unsuccessful' };
export const TASK_PHASE_TONE: Record<TaskPhase, Tone> = { ...TASK_STATUS_TONE, needsYou: 'warning', unsuccessful: 'warning' };
