// AI providers, conversations, tasks and task steps.

import type { ControlMode } from './control.js';

export type ProviderKind = 'anthropic' | 'claude-agent-sdk' | 'openai' | 'openai-compatible';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Required for openai-compatible (e.g. http://127.0.0.1:1234/v1). Optional override for openai/anthropic. */
  baseUrl: string | null;
  model: string;
  /** Whether the model accepts images. Text-only models only receive OCR descriptions. */
  vision: boolean;
  maxOutputTokens: number;
  contextTokens: number | null;
  timeoutMs: number;
  /** Optional reasoning effort for providers that support it (Claude: low…max). */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  enabled: boolean;
  /** True when an API key is stored in the macOS Keychain (the key itself never leaves the backend). */
  hasApiKey: boolean;
  /** True when requests leave this Mac (shown in the privacy disclosure). */
  cloud: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  model: string | null;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  text: string;
  taskId: string | null;
  createdAt: number;
  /** True while the assistant text is still streaming. */
  streaming?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stopped';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'stopped'];

export interface TaskOutcome {
  success: boolean;
  /** Whether the final phone state was checked against a fresh observation. */
  verified: boolean;
  summary: string;
}

export interface AgentTask {
  id: string;
  conversationId: string;
  instruction: string;
  status: TaskStatus;
  providerId: string;
  providerLabel: string;
  model: string;
  mode: ControlMode;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  actionsUsed: number;
  maxActions: number;
  currentActivity: string | null;
  outcome: TaskOutcome | null;
  error: string | null;
}

export type AgentStepType =
  | 'observe'
  | 'reasoning'
  | 'tool_call'
  | 'approval'
  | 'verify'
  | 'policy'
  | 'message'
  | 'error';

export interface AgentStep {
  id: string;
  taskId: string;
  index: number;
  type: AgentStepType;
  title: string;
  detail: string | null;
  tool: {
    name: string;
    args: Record<string, unknown>;
    ok: boolean | null;
    result: string | null;
    durationMs: number | null;
  } | null;
  /** In-memory screenshot reference (served while the session lives; persisted only if the user opted in). */
  screenshotId: string | null;
  createdAt: number;
}

export interface StartTaskRequest {
  text: string;
  providerId?: string;
  maxActions?: number;
}
