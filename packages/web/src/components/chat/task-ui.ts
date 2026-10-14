// Display helpers shared by the chat components.

import type { AgentStepType, RiskLevel, TaskStatus } from '@iphone-ai/shared';

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
