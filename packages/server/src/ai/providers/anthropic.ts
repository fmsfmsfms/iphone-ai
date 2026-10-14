// Claude via the Anthropic API (official @anthropic-ai/sdk).
//
// • Streaming manual loop (iPhone AI owns the agent loop for approvals/stop).
// • Adaptive thinking with summarized display so the UI can show reasoning.
// • Tools use eager_input_streaming; the toolkit validates every input with zod.
// • Server-side refusal fallbacks ("default") on models that support them.
// • History is append-only and assistant content is replayed verbatim, so
//   thinking blocks stay valid and the prompt cache keeps hitting.

import Anthropic from '@anthropic-ai/sdk';
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

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

/** Models that take `thinking: {type: "adaptive"}` (4.6 and later). */
const ADAPTIVE_MODEL = /^claude-(opus|sonnet|haiku|fable|mythos)-(4-[6-9]|5)/;
/** Models documented to support the server-side `fallbacks: "default"` parameter. */
const FALLBACK_MODEL = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export class AnthropicProvider implements TurnProvider {
  readonly kind = 'turn' as const;
  private readonly client: Anthropic;

  constructor(
    readonly config: ProviderConfig,
    apiKey: string | null,
  ) {
    this.client = new Anthropic({
      // Without a stored key the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
      ...(apiKey ? { apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      timeout: config.timeoutMs,
      maxRetries: 2,
    });
  }

  private requestExtras(): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    if (ADAPTIVE_MODEL.test(this.config.model)) {
      extras.thinking = { type: 'adaptive', display: 'summarized' };
    }
    if (this.config.effort && ADAPTIVE_MODEL.test(this.config.model)) {
      extras.output_config = { effort: this.config.effort };
    }
    if (FALLBACK_MODEL.test(this.config.model) && !this.config.baseUrl) {
      extras.fallbacks = 'default';
      extras.betas = ['server-side-fallback-2026-07-01'];
    }
    return extras;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const tools: BetaToolUnion[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    const messages = this.toMessages(request.messages);
    let jsonRetries = 0;

    for (;;) {
      try {
        const stream = this.client.beta.messages.stream(
          {
            model: this.config.model,
            max_tokens: this.config.maxOutputTokens,
            system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
            messages,
            tools,
            ...this.requestExtras(),
          } as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
          { signal: request.signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') request.onText?.(event.delta.text);
            else if (event.delta.type === 'thinking_delta') request.onReasoning?.(event.delta.thinking);
          }
        }
        const message = await stream.finalMessage();
        jsonRetries = 0;
        return this.toResult(message);
      } catch (err) {
        if (request.signal.aborted) throw err;
        if (err instanceof Anthropic.APIError) throw mapApiError(err);
        // Eager input streaming: tool input that is not parseable JSON rejects the stream.
        if (err instanceof Error && /json/i.test(err.message) && jsonRetries < 2) {
          jsonRetries += 1;
          continue;
        }
        throw new ProviderError(err instanceof Error ? err.message : String(err), true, 'unknown');
      }
    }
  }

  private toResult(message: Anthropic.Beta.Messages.BetaMessage): TurnResult {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        const input = block.input;
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
          ...(input && typeof input === 'object' ? {} : { parseError: 'Tool input was not a JSON object' }),
        });
      }
    }
    const stopReason = message.stop_reason;
    const stop: TurnResult['stop'] =
      stopReason === 'end_turn'
        ? 'end'
        : stopReason === 'tool_use'
          ? 'tool_use'
          : stopReason === 'max_tokens'
            ? 'max_tokens'
            : stopReason === 'refusal'
              ? 'refusal'
              : 'other';
    const details = (message as unknown as { stop_details?: { explanation?: string | null; category?: string | null } | null })
      .stop_details;
    return {
      text,
      // Never run tools from a refused or truncated turn.
      toolCalls: stop === 'refusal' || stop === 'max_tokens' ? [] : toolCalls,
      stop,
      native: message.content,
      refusal: stop === 'refusal' ? details?.explanation ?? details?.category ?? 'The model declined this request.' : null,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }

  private toMessages(history: TurnMessage[]): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    for (const m of history) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: this.visible(m.content).map(toBlock) });
      } else if (m.role === 'assistant') {
        if (m.native && m.nativeProvider === this.config.id) {
          out.push({ role: 'assistant', content: m.native as BetaContentBlockParam[] });
        } else {
          const content: BetaContentBlockParam[] = [];
          if (m.text) content.push({ type: 'text', text: m.text });
          for (const call of m.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
          if (content.length === 0) content.push({ type: 'text', text: '(no response)' });
          out.push({ role: 'assistant', content });
        }
      } else {
        // All results for one assistant turn go back in a single user message.
        out.push({
          role: 'user',
          content: m.results.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.callId,
            is_error: r.isError,
            content: this.visible(r.content).map((c) =>
              c.type === 'text'
                ? { type: 'text' as const, text: c.text }
                : {
                    type: 'image' as const,
                    source: { type: 'base64' as const, media_type: c.mimeType as 'image/png', data: c.data },
                  },
            ),
          })),
        });
      }
    }
    return out;
  }

  /** Text-only configurations never receive images (ProviderConfig.vision contract). */
  private visible(content: ModelContent[]): ModelContent[] {
    if (this.config.vision) return content;
    const kept = content.filter((c) => c.type === 'text');
    return kept.length ? kept : [{ type: 'text', text: '(image omitted: this model is configured without vision)' }];
  }

  async complete(request: { system: string; content: ModelContent[]; signal: AbortSignal; maxTokens?: number }): Promise<string> {
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.config.model,
          max_tokens: request.maxTokens ?? 8000,
          system: request.system,
          messages: [{ role: 'user', content: this.visible(request.content).map(toBlock) }],
          ...this.requestExtras(),
        } as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
        { signal: request.signal },
      );
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new ProviderError('The model declined this request.', false, 'refusal');
      return message.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw mapApiError(err);
      throw err;
    }
  }

  /** Model ids available to this key (for the settings UI). */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    for await (const model of this.client.models.list({}, { signal })) ids.push(model.id);
    return ids;
  }

  async test(signal: AbortSignal): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const model = await this.client.models.retrieve(this.config.model, {}, { signal });
      const caps = (model as unknown as { capabilities?: Record<string, unknown> }).capabilities;
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `Connected. ${model.display_name ?? model.id} is available.`,
        model: model.id,
        supportsTools: true,
        supportsVision: caps ? Boolean((caps as { image_input?: unknown }).image_input ?? true) : true,
      };
    } catch (err) {
      const mapped = err instanceof Anthropic.APIError ? mapApiError(err) : err;
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: mapped instanceof Error ? mapped.message : String(mapped),
        model: null,
        supportsTools: null,
        supportsVision: null,
      };
    }
  }
}

function toBlock(c: ModelContent): BetaContentBlockParam {
  return c.type === 'text'
    ? { type: 'text', text: c.text }
    : { type: 'image', source: { type: 'base64', media_type: c.mimeType as 'image/png', data: c.data } };
}

function mapApiError(err: InstanceType<typeof Anthropic.APIError>): ProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('Claude rejected the API key. Check it in Settings → AI Providers.', false, 'auth');
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError(`Model not found: ${err.message}`, false, 'config');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError('Claude rate limit reached. Try again shortly.', true, 'rate_limit');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`Claude rejected the request: ${err.message}`, false, 'bad_request');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('Cannot reach the Anthropic API. Check your network connection.', true, 'unavailable');
  }
  if (typeof err.status === 'number' && err.status >= 500) {
    return new ProviderError(`Anthropic API error ${err.status}. Try again shortly.`, true, 'unavailable');
  }
  return new ProviderError(err.message, false, 'unknown');
}
