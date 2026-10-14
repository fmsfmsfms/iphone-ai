// OpenAiCompatibleProvider against a local server emulating the OpenAI
// Chat Completions streaming API (SSE with tool_call deltas).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderConfig } from '@iphone-ai/shared';

import { OpenAiCompatibleProvider } from '../../src/ai/providers/openai-compatible.js';
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
    id: 'local-test',
    kind: 'openai-compatible',
    label: 'Local test server',
    baseUrl: `${server.url}/v1`,
    model: 'local-model',
    vision: false,
    maxOutputTokens: 1024,
    contextTokens: 8192,
    timeoutMs: 10000,
    effort: null,
    enabled: true,
    hasApiKey: false,
    cloud: false,
    ...patch,
  };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'local-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function request(messages: TurnMessage[], extra: Partial<TurnRequest> = {}): TurnRequest {
  return { system: 'You control an iPhone.', messages, tools: TOOLS, signal: new AbortController().signal, ...extra };
}

const userTurn = (text: string): TurnMessage => ({ role: 'user', content: [{ type: 'text', text }] });

beforeAll(async () => {
  server = await startFakeServer((_req, res) => sendJson(res, 500, { error: { message: 'no handler' } }));
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.requests.length = 0;
});

describe('runTurn streaming', () => {
  it('streams text deltas and assembles tool calls from fragmented deltas', async () => {
    server.handle((_req, res) =>
      sendSse(res, [
        { data: chunk({ role: 'assistant', content: 'Opening ' }) },
        { data: chunk({ content: 'Settings.' }) },
        { data: chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tap_', arguments: '' } }] }) },
        { data: chunk({ tool_calls: [{ index: 0, function: { name: 'element', arguments: '{"elem' } }] }) },
        { data: chunk({ tool_calls: [{ index: 0, function: { arguments: 'ent": "e3"}' } }] }) },
        { data: chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'wait', arguments: '' } }] }) },
        { data: chunk({}, 'tool_calls') },
        { data: '[DONE]' },
      ]),
    );
    const deltas: string[] = [];
    const provider = new OpenAiCompatibleProvider(config(), null);
    const result = await provider.runTurn(request([userTurn('Open Settings')], { onText: (d) => deltas.push(d) }));

    expect(deltas).toEqual(['Opening ', 'Settings.']);
    expect(result.text).toBe('Opening Settings.');
    expect(result.stop).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'tap_element', args: { element: 'e3' } },
      { id: 'call_2', name: 'wait', args: {} },
    ]);

    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer not-needed');
    expect(sent.body).toMatchObject({ model: 'local-model', stream: true, max_tokens: 1024 });
    expect(sent.body).not.toHaveProperty('tool_choice');
    expect(sent.body).not.toHaveProperty('max_completion_tokens');
    expect(sent.body!.tools).toEqual([{ type: 'function', function: { name: 'tap_element', description: TOOLS[0]!.description, parameters: TOOLS[0]!.parameters } }]);
    expect(sent.body!.messages).toEqual([
      { role: 'system', content: 'You control an iPhone.' },
      { role: 'user', content: [{ type: 'text', text: 'Open Settings' }] },
    ]);
  });

  it('passes reasoning deltas through and ends with plain text', async () => {
    server.handle((_req, res) =>
      sendSse(res, [
        { data: chunk({ reasoning_content: 'Looking at the screen' }) },
        { data: chunk({ reasoning: ' carefully' }) },
        { data: chunk({ content: 'Done.' }, 'stop') },
        { data: '[DONE]' },
      ]),
    );
    const reasoning: string[] = [];
    const result = await new OpenAiCompatibleProvider(config(), 'sk-local').runTurn(
      request([userTurn('hi')], { onReasoning: (d) => reasoning.push(d) }),
    );
    expect(reasoning).toEqual(['Looking at the screen', ' carefully']);
    expect(result).toMatchObject({ text: 'Done.', stop: 'end', toolCalls: [], refusal: null });
    expect(server.requests[0]!.headers.authorization).toBe('Bearer sk-local');
  });

  it('drops tool calls from truncated turns and reports content filtering as a refusal', async () => {
    server.handle((_req, res) =>
      sendSse(res, [
        { data: chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'tap_element', arguments: '{"elem' } }] }) },
        { data: chunk({}, 'length') },
        { data: '[DONE]' },
      ]),
    );
    const provider = new OpenAiCompatibleProvider(config(), null);
    expect(await provider.runTurn(request([userTurn('x')]))).toMatchObject({ stop: 'max_tokens', toolCalls: [] });

    server.handle((_req, res) => sendSse(res, [{ data: chunk({ content: '' }, 'content_filter') }, { data: '[DONE]' }]));
    expect(await provider.runTurn(request([userTurn('x')]))).toMatchObject({
      stop: 'refusal',
      refusal: 'The provider filtered this response.',
    });
  });

  it('flags tool arguments that are not valid JSON objects', async () => {
    server.handle((_req, res) =>
      sendSse(res, [
        { data: chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'tap_element', arguments: '{"element": e3}' } }] }) },
        { data: chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'tap_element', arguments: '["e3"]' } }] }) },
        { data: chunk({ tool_calls: [{ index: 2, function: { name: 'tap_element', arguments: '{"element":"e1"}' } }] }) },
        { data: chunk({}, 'tool_calls') },
        { data: '[DONE]' },
      ]),
    );
    const result = await new OpenAiCompatibleProvider(config(), null).runTurn(request([userTurn('x')]));
    expect(result.toolCalls[0]).toMatchObject({ id: 'a', args: {}, parseError: expect.stringContaining('not valid JSON') });
    expect(result.toolCalls[1]).toMatchObject({ id: 'b', args: {}, parseError: 'Arguments were not a JSON object' });
    // A missing id is synthesised from the index.
    expect(result.toolCalls[2]).toEqual({ id: 'call_2', name: 'tap_element', args: { element: 'e1' } });
  });
});

describe('message conversion', () => {
  const history: TurnMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'What is on screen?' }, { type: 'image', mimeType: 'image/png', data: PNG_B64 }] },
    { role: 'assistant', text: 'Tapping Settings.', toolCalls: [{ id: 'call_1', name: 'tap_element', args: { element: 'e3' } }] },
    {
      role: 'tool_results',
      results: [
        {
          callId: 'call_1',
          name: 'tap_element',
          isError: false,
          content: [
            { type: 'text', text: 'Tapped "Settings".' },
            { type: 'image', mimeType: 'image/png', data: PNG_B64 },
          ],
        },
      ],
    },
    {
      role: 'tool_results',
      results: [{ callId: 'call_2', name: 'wait', isError: true, content: [] }],
    },
  ];

  const endTurn = () =>
    server.handle((_req, res) => sendSse(res, [{ data: chunk({ content: 'ok' }, 'stop') }, { data: '[DONE]' }]));

  it('sends images only when the model has vision', async () => {
    endTurn();
    await new OpenAiCompatibleProvider(config({ vision: true }), null).runTurn(request(history));
    const withVision = server.requests[0]!.body!.messages as Record<string, unknown>[];
    expect(withVision[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is on screen?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      ],
    });
    expect(withVision[2]).toEqual({
      role: 'assistant',
      content: 'Tapping Settings.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tap_element', arguments: '{"element":"e3"}' } }],
    });
    expect(withVision[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Tapped "Settings".' });
    expect(withVision[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot after the last action:' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      ],
    });
    expect(withVision[5]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'ERROR: (no output)' });

    server.requests.length = 0;
    endTurn();
    await new OpenAiCompatibleProvider(config({ vision: false }), null).runTurn(request(history));
    const textOnly = server.requests[0]!.body!;
    expect(JSON.stringify(textOnly)).not.toContain('image_url');
    expect(JSON.stringify(textOnly)).not.toContain(PNG_B64);
    const messages = textOnly.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'What is on screen?' }] });
  });

  it('replaces image-only user content with a placeholder for text-only models', async () => {
    endTurn();
    await new OpenAiCompatibleProvider(config({ vision: false }), null).runTurn(
      request([{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: PNG_B64 }] }]),
    );
    expect((server.requests[0]!.body!.messages as unknown[])[1]).toEqual({ role: 'user', content: [{ type: 'text', text: '(empty)' }] });
  });
});

describe('error mapping', () => {
  const provider = () => new OpenAiCompatibleProvider(config(), null);
  const failWith = async (status: number, message: string): Promise<ProviderError> => {
    server.handle((_req, res) => sendJson(res, status, { error: { message, type: 'error' } }, { 'x-should-retry': 'false' }));
    try {
      await provider().runTurn(request([userTurn('x')]));
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      return err as ProviderError;
    }
    throw new Error('expected a ProviderError');
  };

  it('maps 401 to auth (not retryable)', async () => {
    expect(await failWith(401, 'Invalid API key')).toMatchObject({ code: 'auth', retryable: false, message: 'Local test server rejected the API key.' });
  });

  it('maps 429 to rate_limit (retryable)', async () => {
    expect(await failWith(429, 'Too many requests')).toMatchObject({ code: 'rate_limit', retryable: true });
  });

  it('maps 5xx to unavailable', async () => {
    expect(await failWith(500, 'boom')).toMatchObject({ code: 'unavailable', retryable: true, message: 'Local test server server error 500.' });
    expect(await failWith(503, 'loading model')).toMatchObject({ code: 'unavailable' });
  });

  it('maps 404 to config and 400 to bad_request (with a tool-calling hint)', async () => {
    expect(await failWith(404, 'model not found')).toMatchObject({ code: 'config', retryable: false });
    const bad = await failWith(400, 'this model does not support tools');
    expect(bad.code).toBe('bad_request');
    expect(bad.message).toContain('The model may not support tool calling.');
  });

  it('maps an unreachable server to unavailable', async () => {
    const dead = new OpenAiCompatibleProvider(config({ baseUrl: 'http://127.0.0.1:9/v1' }), null);
    await expect(dead.runTurn(request([userTurn('x')]))).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('rethrows the abort error when the task is cancelled', async () => {
    server.handle(() => undefined); // never answers
    const controller = new AbortController();
    const pending = provider().runTurn(request([userTurn('x')], { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(controller.signal.aborted).toBe(true);
  });

  it('refuses to run without a model or a base URL', async () => {
    await expect(new OpenAiCompatibleProvider(config({ model: '' }), null).runTurn(request([userTurn('x')]))).rejects.toMatchObject({
      code: 'config',
    });
    expect(() => new OpenAiCompatibleProvider(config({ baseUrl: null }), null)).toThrow(ProviderError);
    expect(server.requests).toHaveLength(0);
  });
});

describe('OpenAI (cloud) kind', () => {
  it('sends tool_choice auto and max_completion_tokens', async () => {
    server.handle((_req, res) => sendSse(res, [{ data: chunk({ content: 'ok' }, 'stop') }, { data: '[DONE]' }]));
    await new OpenAiCompatibleProvider(config({ kind: 'openai', baseUrl: `${server.url}/v1` }), 'sk-test-key').runTurn(request([userTurn('x')]));
    const body = server.requests[0]!.body!;
    expect(body.tool_choice).toBe('auto');
    expect(body.max_completion_tokens).toBe(1024);
    expect(body).not.toHaveProperty('max_tokens');
  });
});

describe('complete / test / listModels', () => {
  it('completes without streaming', async () => {
    server.handle((_req, res) =>
      sendJson(res, 200, {
        id: 'x',
        object: 'chat.completion',
        created: 1,
        model: 'local-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A summary.' }, finish_reason: 'stop' }],
      }),
    );
    const text = await new OpenAiCompatibleProvider(config(), null).complete({
      system: 'Summarise.',
      content: [{ type: 'text', text: 'Screen text' }],
      signal: new AbortController().signal,
    });
    expect(text).toBe('A summary.');
    expect(server.requests[0]!.body).not.toHaveProperty('stream');
  });

  it('tests the connection by listing models', async () => {
    server.handle((_req, res) =>
      sendJson(res, 200, { object: 'list', data: [{ id: 'local-model', object: 'model', created: 1, owned_by: 'me' }, { id: 'other', object: 'model', created: 1, owned_by: 'me' }] }),
    );
    const ok = await new OpenAiCompatibleProvider(config(), null).test(new AbortController().signal);
    expect(ok).toMatchObject({ ok: true, model: 'local-model', message: 'Connected. Model "local-model" is available.', supportsVision: false });
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' });

    const missing = await new OpenAiCompatibleProvider(config({ model: 'absent' }), null).test(new AbortController().signal);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('"absent" is not in the server\'s model list (local-model, other)');

    const choose = await new OpenAiCompatibleProvider(config({ model: '' }), null).test(new AbortController().signal);
    expect(choose).toMatchObject({ ok: true, message: 'Connected. Choose a model: local-model, other' });
    expect(await new OpenAiCompatibleProvider(config(), null).listModels(new AbortController().signal)).toEqual(['local-model', 'other']);
  });

  it('reports a failed connection test without throwing', async () => {
    server.handle((_req, res) => sendJson(res, 401, { error: { message: 'nope' } }));
    const result = await new OpenAiCompatibleProvider(config(), null).test(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, model: null, message: 'Local test server rejected the API key.' });
  });
});
