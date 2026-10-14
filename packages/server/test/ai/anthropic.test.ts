// AnthropicProvider against a local server emulating the Messages streaming
// API (thinking_delta, text_delta, tool_use + input_json_delta, refusals).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderConfig } from '@iphone-ai/shared';

import { AnthropicProvider } from '../../src/ai/providers/anthropic.js';
import { ProviderError, type ModelToolDef, type TurnMessage, type TurnRequest } from '../../src/ai/types.js';
import { sendJson, sendSse, startFakeServer, type FakeServer } from '../helpers/fake-http.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const TOOLS: ModelToolDef[] = [
  {
    name: 'tap_element',
    description: 'Tap an element from the latest observation.',
    parameters: { type: 'object', properties: { element: { type: 'string' } }, required: ['element'] },
  },
];

let server: FakeServer;

function config(patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'claude-test',
    kind: 'anthropic',
    label: 'Claude (test)',
    baseUrl: server.url,
    model: 'claude-opus-5-5',
    vision: true,
    maxOutputTokens: 4096,
    contextTokens: null,
    timeoutMs: 10000,
    effort: 'high',
    enabled: true,
    hasApiKey: true,
    cloud: true,
    ...patch,
  };
}

function request(messages: TurnMessage[], extra: Partial<TurnRequest> = {}): TurnRequest {
  return { system: 'You control an iPhone.', messages, tools: TOOLS, signal: new AbortController().signal, ...extra };
}

const userTurn = (text: string): TurnMessage => ({ role: 'user', content: [{ type: 'text', text }] });

type Block = { type: 'thinking' } | { type: 'text'; deltas: string[] } | { type: 'tool_use'; id: string; name: string; json: string[] };

/** Builds the SSE event sequence of one streamed message. */
function messageEvents(blocks: Block[], stopReason: string, stopDetails: Record<string, unknown> | null = null) {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 100 },
        },
      },
    },
    { event: 'ping', data: { type: 'ping' } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push(
        { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'The Settings icon ' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'is e3.' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
      );
    } else if (block.type === 'text') {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      for (const text of block.deltas) {
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
      }
    } else {
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
      });
      for (const partial of block.json) {
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } },
        });
      }
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push(
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: 57 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return events;
}

beforeAll(async () => {
  server = await startFakeServer((_req, res) => sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: 'no handler' } }));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.requests.length = 0;
});

describe('runTurn streaming', () => {
  it('streams thinking and text deltas and parses tool_use input from input_json_delta', async () => {
    server.handle((_req, res) =>
      sendSse(
        res,
        messageEvents(
          [
            { type: 'thinking' },
            { type: 'text', deltas: ['Opening ', 'Settings.'] },
            { type: 'tool_use', id: 'toolu_1', name: 'tap_element', json: ['{"elem', 'ent": ', '"e3"}'] },
          ],
          'tool_use',
        ),
      ),
    );
    const text: string[] = [];
    const reasoning: string[] = [];
    const provider = new AnthropicProvider(config(), 'sk-ant-test-key-0000');
    const result = await provider.runTurn(
      request([userTurn('Open Settings')], { onText: (d) => text.push(d), onReasoning: (d) => reasoning.push(d) }),
    );

    expect(text).toEqual(['Opening ', 'Settings.']);
    expect(reasoning).toEqual(['The Settings icon ', 'is e3.']);
    expect(result).toMatchObject({
      text: 'Opening Settings.',
      stop: 'tool_use',
      refusal: null,
      toolCalls: [{ id: 'toolu_1', name: 'tap_element', args: { element: 'e3' } }],
      usage: { inputTokens: 120, outputTokens: 57, cacheReadTokens: 100 },
    });
    // Assistant content is kept verbatim (thinking + signature) for replay.
    const native = result.native as { type: string; thinking?: string; signature?: string }[];
    expect(native.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(native[0]).toMatchObject({ thinking: 'The Settings icon is e3.', signature: 'sig-abc' });

    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toMatch(/^\/v1\/messages/);
    expect(sent.headers['x-api-key']).toBe('sk-ant-test-key-0000');
    expect(sent.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'You control an iPhone.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Open Settings' }] }],
      tools: [{ name: 'tap_element', description: TOOLS[0]!.description, input_schema: TOOLS[0]!.parameters, eager_input_streaming: true }],
    });
    // Server-side fallbacks are only requested from the real API (no custom base URL).
    expect(sent.body).not.toHaveProperty('fallbacks');
    expect(sent.headers['anthropic-beta']).toBeUndefined();
  });

  it('handles a refusal: no tool calls are run and the explanation is surfaced', async () => {
    server.handle((_req, res) =>
      sendSse(
        res,
        messageEvents(
          [
            { type: 'text', deltas: ['I can'] },
            { type: 'tool_use', id: 'toolu_2', name: 'tap_element', json: ['{"element":"e9"}'] },
          ],
          'refusal',
          { type: 'refusal', category: 'cyber', explanation: 'This request was declined by the safety system.' },
        ),
      ),
    );
    const result = await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]));
    expect(result).toMatchObject({ stop: 'refusal', toolCalls: [], refusal: 'This request was declined by the safety system.' });

    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'text', deltas: ['No.'] }], 'refusal')));
    const bare = await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]));
    expect(bare.refusal).toBe('The model declined this request.');
  });

  it('maps stop reasons and drops tool calls from truncated turns', async () => {
    server.handle((_req, res) =>
      sendSse(res, messageEvents([{ type: 'tool_use', id: 'toolu_3', name: 'tap_element', json: ['{"element":"e1"}'] }], 'max_tokens')),
    );
    expect(await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]))).toMatchObject({ stop: 'max_tokens', toolCalls: [] });

    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'text', deltas: ['All done.'] }], 'end_turn')));
    expect(await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]))).toMatchObject({ stop: 'end', text: 'All done.' });

    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'text', deltas: ['…'] }], 'pause_turn')));
    expect((await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]))).stop).toBe('other');
  });

  it('omits adaptive thinking for older models and effort when unset', async () => {
    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'text', deltas: ['ok'] }], 'end_turn')));
    await new AnthropicProvider(config({ model: 'claude-3-7-sonnet-latest', effort: 'high' }), 'k').runTurn(request([userTurn('x')]));
    await new AnthropicProvider(config({ effort: null }), 'k').runTurn(request([userTurn('x')]));
    expect(server.requests[0]!.body).not.toHaveProperty('thinking');
    expect(server.requests[0]!.body).not.toHaveProperty('output_config');
    expect(server.requests[1]!.body).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(server.requests[1]!.body).not.toHaveProperty('output_config');
  });
});

describe('history conversion', () => {
  it('replays native assistant content verbatim and batches tool results with images', async () => {
    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'text', deltas: ['ok'] }], 'end_turn')));
    const native = [
      { type: 'thinking', thinking: 'Plan.', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'tap_element', input: { element: 'e3' } },
    ];
    const history: TurnMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', mimeType: 'image/png', data: PNG_B64 }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_1', name: 'tap_element', args: { element: 'e3' } }], native, nativeProvider: 'claude-test' },
      {
        role: 'tool_results',
        results: [
          { callId: 'toolu_1', name: 'tap_element', isError: false, content: [{ type: 'text', text: 'Tapped.' }, { type: 'image', mimeType: 'image/png', data: PNG_B64 }] },
          { callId: 'toolu_x', name: 'wait', isError: true, content: [{ type: 'text', text: 'Unknown element' }] },
        ],
      },
      // Assistant turn produced by a different provider: rebuilt from text + tool calls.
      { role: 'assistant', text: 'Switching.', toolCalls: [], native: [{ type: 'bogus' }], nativeProvider: 'openai' },
      { role: 'assistant', text: '', toolCalls: [] },
    ];
    await new AnthropicProvider(config(), 'k').runTurn(request(history));
    const messages = server.requests[0]!.body!.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      ],
    });
    expect(messages[1]).toEqual({ role: 'assistant', content: native });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          is_error: false,
          content: [
            { type: 'text', text: 'Tapped.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          ],
        },
        { type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: [{ type: 'text', text: 'Unknown element' }] },
      ],
    });
    expect(messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Switching.' }] });
    expect(messages[4]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '(no response)' }] });
  });
});

describe('error mapping', () => {
  const failWith = async (status: number, type: string): Promise<ProviderError> => {
    server.handle((_req, res) =>
      sendJson(res, status, { type: 'error', error: { type, message: `${type} happened` } }, { 'x-should-retry': 'false' }),
    );
    server.requests.length = 0;
    try {
      await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]));
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      // x-should-retry: false → exactly one request, no hidden retries.
      expect(server.requests).toHaveLength(1);
      return err as ProviderError;
    }
    throw new Error('expected a ProviderError');
  };

  it('maps 401/403 to auth', async () => {
    expect(await failWith(401, 'authentication_error')).toMatchObject({ code: 'auth', retryable: false });
    expect(await failWith(403, 'permission_error')).toMatchObject({ code: 'auth' });
  });

  it('maps 429 to rate_limit', async () => {
    expect(await failWith(429, 'rate_limit_error')).toMatchObject({ code: 'rate_limit', retryable: true });
  });

  it('maps 500 and 529 to unavailable', async () => {
    expect(await failWith(500, 'api_error')).toMatchObject({ code: 'unavailable', retryable: true, message: 'Anthropic API error 500. Try again shortly.' });
    expect(await failWith(529, 'overloaded_error')).toMatchObject({ code: 'unavailable' });
  });

  it('maps 400 to bad_request and 404 to config', async () => {
    expect(await failWith(400, 'invalid_request_error')).toMatchObject({ code: 'bad_request', retryable: false });
    expect(await failWith(404, 'not_found_error')).toMatchObject({ code: 'config' });
  });

  it('retries a retryable failure, then succeeds', async () => {
    let calls = 0;
    server.handle((_req, res) => {
      calls += 1;
      if (calls === 1) sendJson(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { 'retry-after-ms': '1' });
      else sendSse(res, messageEvents([{ type: 'text', deltas: ['recovered'] }], 'end_turn'));
    });
    const result = await new AnthropicProvider(config(), 'k').runTurn(request([userTurn('x')]));
    expect(result.text).toBe('recovered');
    expect(calls).toBe(2);
  });
});

describe('complete / test', () => {
  it('returns the text of a one-shot completion and maps refusals', async () => {
    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'thinking' }, { type: 'text', deltas: ['A ', 'summary.'] }], 'end_turn')));
    const text = await new AnthropicProvider(config(), 'k').complete({
      system: 'Summarise.',
      content: [{ type: 'text', text: 'Screen' }, { type: 'image', mimeType: 'image/png', data: PNG_B64 }],
      signal: new AbortController().signal,
      maxTokens: 500,
    });
    expect(text).toBe('A summary.');
    expect(server.requests[0]!.body).toMatchObject({ max_tokens: 500, system: 'Summarise.' });

    server.handle((_req, res) => sendSse(res, messageEvents([{ type: 'text', deltas: [''] }], 'refusal')));
    await expect(
      new AnthropicProvider(config(), 'k').complete({ system: 's', content: [{ type: 'text', text: 'x' }], signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'refusal' });
  });

  it('tests the connection with a model lookup', async () => {
    server.handle((req, res) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/models/claude-opus-5-5')) {
        sendJson(res, 200, { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' });
      } else {
        sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }, { 'x-should-retry': 'false' });
      }
    });
    const ok = await new AnthropicProvider(config(), 'k').test(new AbortController().signal);
    expect(ok).toMatchObject({ ok: true, model: 'claude-opus-5-5', message: 'Connected. Claude Opus 5.5 is available.', supportsTools: true });
    const missing = await new AnthropicProvider(config({ model: 'nope' }), 'k').test(new AbortController().signal);
    expect(missing).toMatchObject({ ok: false, model: null });
    expect(missing.message).toMatch(/^Model not found/);
  });
});
