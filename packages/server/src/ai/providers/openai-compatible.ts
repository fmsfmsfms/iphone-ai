// OpenAI and OpenAI-compatible servers (LM Studio, vLLM, Ollama, …) through
// the official `openai` SDK's Chat Completions API with function calling.
//
// Text-only models (config.vision === false) never receive images: the agent
// gives them the OCR element list from describe_screen instead.

import OpenAI from 'openai';
import type { ProviderConfig, ProviderTestResult } from '@iphone-ai/shared';

import {
  ProviderError,
  type ModelContent,
  type ToolCall,
  type TurnMessage,
  type TurnProvider,
  type TurnRequest,
  type TurnResult,
} from '../types.js';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

export class OpenAiCompatibleProvider implements TurnProvider {
  readonly kind = 'turn' as const;
  private readonly client: OpenAI;

  constructor(
    readonly config: ProviderConfig,
    apiKey: string | null,
  ) {
    if (config.kind === 'openai-compatible' && !config.baseUrl) {
      throw new ProviderError('A base URL is required for OpenAI-compatible providers.', false, 'config');
    }
    this.client = new OpenAI({
      // Local servers usually ignore the key but the SDK requires a value.
      apiKey: apiKey ?? (config.kind === 'openai' ? process.env.OPENAI_API_KEY ?? '' : 'not-needed'),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      timeout: config.timeoutMs,
      maxRetries: config.kind === 'openai' ? 2 : 0,
    });
  }

  private limitParams(): Record<string, number> {
    // OpenAI's current models take max_completion_tokens; most local servers still expect max_tokens.
    return this.config.kind === 'openai'
      ? { max_completion_tokens: this.config.maxOutputTokens }
      : { max_tokens: this.config.maxOutputTokens };
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (!this.config.model) throw new ProviderError('No model ID is configured for this provider.', false, 'config');
    const messages = this.toMessages(request.system, request.messages);
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages,
          tools,
          // Ollama rejects tool_choice; "auto" is the default everywhere anyway.
          ...(this.config.kind === 'openai' ? { tool_choice: 'auto' as const } : {}),
          stream: true,
          ...this.limitParams(),
        },
        { signal: request.signal },
      );
      let text = '';
      let finish: string | null = null;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta as {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        if (delta.content) {
          text += delta.content;
          request.onText?.(delta.content);
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) request.onReasoning?.(reasoning);
        for (const tc of delta.tool_calls ?? []) {
          const entry = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          calls.set(tc.index, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, c]) => parseCall(c, index));
      const stop: TurnResult['stop'] =
        finish === 'length' ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : finish === 'content_filter' ? 'refusal' : 'end';
      return {
        text,
        toolCalls: stop === 'max_tokens' ? [] : toolCalls,
        stop,
        refusal: stop === 'refusal' ? 'The provider filtered this response.' : null,
      };
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw mapError(err, this.config);
    }
  }

  private toMessages(system: string, history: TurnMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [{ role: 'system', content: system }];
    for (const m of history) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: this.parts(m.content) });
      } else if (m.role === 'assistant') {
        out.push({
          role: 'assistant',
          content: m.text || null,
          ...(m.toolCalls.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        });
      } else {
        // Tool messages are text-only in Chat Completions; images go in a follow-up user message.
        const images: ModelContent[] = [];
        for (const r of m.results) {
          const textParts = r.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text);
          out.push({
            role: 'tool',
            tool_call_id: r.callId,
            content: `${r.isError ? 'ERROR: ' : ''}${textParts.join('\n') || '(no output)'}`,
          });
          images.push(...r.content.filter((c) => c.type === 'image'));
        }
        if (images.length && this.config.vision) {
          out.push({
            role: 'user',
            content: [{ type: 'text', text: 'Screenshot after the last action:' }, ...this.parts(images)],
          });
        }
      }
    }
    return out;
  }

  private parts(content: ModelContent[]): ContentPart[] {
    const parts: ContentPart[] = [];
    for (const c of content) {
      if (c.type === 'text') parts.push({ type: 'text', text: c.text });
      else if (this.config.vision) parts.push({ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } });
    }
    return parts.length ? parts : [{ type: 'text', text: '(empty)' }];
  }

  async complete(request: { system: string; content: ModelContent[]; signal: AbortSignal; maxTokens?: number }): Promise<string> {
    if (!this.config.model) throw new ProviderError('No model ID is configured for this provider.', false, 'config');
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: this.parts(request.content) },
          ],
          ...this.limitParams(),
        },
        { signal: request.signal },
      );
      return res.choices[0]?.message?.content ?? '';
    } catch (err) {
      throw mapError(err, this.config);
    }
  }

  async test(signal: AbortSignal): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const models: string[] = [];
      for await (const m of this.client.models.list({ signal })) {
        models.push(m.id);
        if (models.length > 500) break;
      }
      const configured = this.config.model;
      const found = configured ? models.includes(configured) : false;
      return {
        ok: configured ? found || models.length === 0 : models.length > 0,
        latencyMs: Date.now() - started,
        message: configured
          ? found
            ? `Connected. Model "${configured}" is available.`
            : models.length
              ? `Connected, but "${configured}" is not in the server's model list (${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}).`
              : 'Connected. The server did not list models.'
          : models.length
            ? `Connected. Choose a model: ${models.slice(0, 12).join(', ')}${models.length > 12 ? '…' : ''}`
            : 'Connected, but no models are loaded.',
        model: found ? configured : models[0] ?? null,
        supportsTools: null,
        supportsVision: this.config.vision,
      };
    } catch (err) {
      const mapped = mapError(err, this.config);
      return { ok: false, latencyMs: Date.now() - started, message: mapped.message, model: null, supportsTools: null, supportsVision: null };
    }
  }

  /** Lists models for the settings UI. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const models: string[] = [];
    for await (const m of this.client.models.list({ signal })) models.push(m.id);
    return models;
  }
}

function parseCall(c: { id: string; name: string; args: string }, index: number): ToolCall {
  const id = c.id || `call_${index}`;
  if (!c.args.trim()) return { id, name: c.name, args: {} };
  try {
    const parsed = JSON.parse(c.args) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { id, name: c.name, args: parsed as Record<string, unknown> };
    return { id, name: c.name, args: {}, parseError: 'Arguments were not a JSON object' };
  } catch {
    return { id, name: c.name, args: {}, parseError: `Arguments were not valid JSON: ${c.args.slice(0, 200)}` };
  }
}

function mapError(err: unknown, config: ProviderConfig): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError(`${config.label} rejected the API key.`, false, 'auth');
  }
  if (err instanceof OpenAI.RateLimitError) return new ProviderError(`${config.label} rate limit or quota reached.`, true, 'rate_limit');
  if (err instanceof OpenAI.NotFoundError) return new ProviderError(`${config.label}: model or endpoint not found (${err.message}).`, false, 'config');
  if (err instanceof OpenAI.BadRequestError) {
    const hint = /tool/i.test(err.message) ? ' The model may not support tool calling.' : '';
    return new ProviderError(`${config.label} rejected the request: ${err.message}.${hint}`, false, 'bad_request');
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(
      `Cannot reach ${config.label}${config.baseUrl ? ` at ${config.baseUrl}` : ''}. Is the server running?`,
      true,
      'unavailable',
    );
  }
  if (err instanceof OpenAI.APIError && typeof err.status === 'number' && err.status >= 500) {
    return new ProviderError(`${config.label} server error ${err.status}.`, true, 'unavailable');
  }
  return new ProviderError(err instanceof Error ? err.message : String(err), false, 'unknown');
}
