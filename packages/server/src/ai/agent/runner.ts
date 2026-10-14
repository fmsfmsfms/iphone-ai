// Drives one agent task with either kind of provider:
//  • TurnProvider (Anthropic API, OpenAI, OpenAI-compatible): iPhone AI's own
//    loop — model turn → execute tool calls sequentially → append results.
//  • LoopProvider (Claude Agent SDK): the SDK runs the loop and calls the very
//    same toolkit tools in-process.
// Both share the toolkit, so policy, approvals, limits and verification are
// identical regardless of provider.

import type { AiProvider, ModelContent, ToolResultMessage, TurnMessage } from '../types.js';
import { ProviderError } from '../types.js';
import { TaskAbortedError, type AgentToolkit } from './toolkit.js';

export interface RunCallbacks {
  onText(delta: string): void;
  onReasoning(delta: string): void;
  /** Called at the end of each model turn with the reasoning collected during it. */
  onTurnEnd(reasoning: string, text: string): void;
}

export type RunStop = 'finished' | 'no_finish' | 'max_turns' | 'refusal' | 'error';

export interface RunOutcome {
  stop: RunStop;
  finalText: string;
  error?: string;
}

export async function runAgent(options: {
  provider: AiProvider;
  toolkit: AgentToolkit;
  system: string;
  prompt: ModelContent[];
  signal: AbortSignal;
  maxTurns: number;
  callbacks: RunCallbacks;
}): Promise<RunOutcome> {
  const { provider, toolkit, signal, callbacks } = options;

  if (provider.kind === 'loop') {
    // A loop provider spawns its own session; never start one for a task that is already cancelled.
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new TaskAbortedError('The task was stopped.', 'cancelled');
    let reasoning = '';
    let text = '';
    const result = await provider.runLoop({
      system: options.system,
      prompt: options.prompt
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n\n'),
      tools: toolkit.executableTools(),
      signal,
      maxTurns: options.maxTurns,
      onText: (d) => {
        text += d;
        callbacks.onText(d);
      },
      onReasoning: (d) => {
        reasoning += d;
        callbacks.onReasoning(d);
      },
      isFinished: () => toolkit.result !== null,
    });
    callbacks.onTurnEnd(reasoning, text);
    if (toolkit.result) return { stop: 'finished', finalText: result.finalText };
    if (result.stop === 'max_turns') return { stop: 'max_turns', finalText: result.finalText };
    if (result.stop === 'error') return { stop: 'error', finalText: result.finalText, error: result.error ?? 'Claude Code reported an error.' };
    return { stop: 'no_finish', finalText: result.finalText };
  }

  // The first user turn may contain an image (initial observation) for vision models.
  const messages: TurnMessage[] = [{ role: 'user', content: options.prompt }];
  let nudged = false;
  let finalText = '';
  for (let turn = 0; turn < options.maxTurns; turn += 1) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new TaskAbortedError('The task was stopped.', 'cancelled');
    let reasoning = '';
    let text = '';
    const result = await provider.runTurn({
      system: options.system,
      messages,
      tools: toolkit.toolDefs(),
      signal,
      onText: (d) => {
        text += d;
        callbacks.onText(d);
      },
      onReasoning: (d) => {
        reasoning += d;
        callbacks.onReasoning(d);
      },
    });
    callbacks.onTurnEnd(reasoning, result.text || text);
    finalText = result.text || text;
    messages.push({
      role: 'assistant',
      text: result.text,
      toolCalls: result.toolCalls,
      native: result.native,
      nativeProvider: provider.config.id,
    });

    if (result.stop === 'refusal') {
      return { stop: 'refusal', finalText, error: result.refusal ?? 'The model declined this request.' };
    }
    if (result.toolCalls.length === 0) {
      if (toolkit.result) return { stop: 'finished', finalText };
      if (result.stop === 'max_tokens') {
        return { stop: 'error', finalText, error: 'The model ran out of output tokens. Increase "Max output tokens" for this provider.' };
      }
      if (nudged) return { stop: 'no_finish', finalText };
      nudged = true;
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Continue the task. When you are done (or cannot continue), call finish_task with the status, a summary and evidence.' }],
      });
      continue;
    }

    // Execute tool calls one at a time (the phone is a single, serial device).
    const results: ToolResultMessage[] = [];
    for (const call of result.toolCalls) {
      if (toolkit.result) {
        results.push({ callId: call.id, name: call.name, content: [{ type: 'text', text: 'Skipped: the task already finished.' }], isError: true });
        continue;
      }
      const output = await toolkit.execute(call);
      results.push({ callId: call.id, name: call.name, content: output.content, isError: output.isError });
    }
    messages.push({ role: 'tool_results', results });
    if (toolkit.result) return { stop: 'finished', finalText };
  }
  return { stop: 'max_turns', finalText };
}

export function describeProviderError(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
