// Provider-neutral types for the agent loop. Each provider adapter converts
// these to and from its own wire format.

import type { ProviderConfig, ProviderTestResult } from '@iphone-ai/shared';

export type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Set when the model produced arguments that are not valid JSON. */
  parseError?: string;
}

export interface ToolResultMessage {
  callId: string;
  name: string;
  content: ModelContent[];
  isError: boolean;
}

export type TurnMessage =
  | { role: 'user'; content: ModelContent[] }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native assistant content replayed verbatim (e.g. Claude thinking blocks). */
      native?: unknown;
      nativeProvider?: string;
    }
  | { role: 'tool_results'; results: ToolResultMessage[] };

export interface ModelToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments (type: object). */
  parameters: Record<string, unknown>;
}

export type TurnStop = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: TurnStop;
  native?: unknown;
  refusal?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

export interface TurnRequest {
  system: string;
  messages: TurnMessage[];
  tools: ModelToolDef[];
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

/** A model that is driven turn-by-turn by iPhone AI's own agent loop. */
export interface TurnProvider {
  readonly kind: 'turn';
  readonly config: ProviderConfig;
  runTurn(request: TurnRequest): Promise<TurnResult>;
  /** One-shot completion (workflow suggestions, screen summaries). */
  complete(request: { system: string; content: ModelContent[]; signal: AbortSignal; maxTokens?: number }): Promise<string>;
  test(signal: AbortSignal): Promise<ProviderTestResult>;
}

/** A tool the AI can call, with execution bound to the current task. */
export interface ExecutableTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** zod raw shape, used by the Claude Agent SDK's tool() helper. */
  zodShape: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<{ content: ModelContent[]; isError: boolean }>;
}

export interface LoopRequest {
  system: string;
  prompt: string;
  tools: ExecutableTool[];
  signal: AbortSignal;
  maxTurns: number;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Returns true once the task has called finish_task (the loop should end). */
  isFinished: () => boolean;
}

/** A provider that runs its own agent loop (Claude Agent SDK / Claude Code). */
export interface LoopProvider {
  readonly kind: 'loop';
  readonly config: ProviderConfig;
  runLoop(request: LoopRequest): Promise<{ finalText: string; stop: 'finished' | 'max_turns' | 'end' | 'error'; error?: string }>;
  complete(request: { system: string; content: ModelContent[]; signal: AbortSignal; maxTokens?: number }): Promise<string>;
  test(signal: AbortSignal): Promise<ProviderTestResult>;
}

export type AiProvider = TurnProvider | LoopProvider;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: 'auth' | 'rate_limit' | 'unavailable' | 'bad_request' | 'refusal' | 'config' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
