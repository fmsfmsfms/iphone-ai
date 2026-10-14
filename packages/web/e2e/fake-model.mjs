#!/usr/bin/env node
// Fake OpenAI-compatible model server for the browser E2E tests (node:http,
// no dependencies). It never calls a real model: every reply is SCRIPTED by
// the test that is running.
//
//   GET  /v1/models              → one model, "scripted"
//   POST /v1/chat/completions    → the next scripted turn (SSE when stream:true)
//   POST /__script {turns:[…]}   → replaces the queue of turns and clears the request log
//   GET  /__requests             → what the backend sent so far (for debugging / assertions)
//   GET  /__health               → { ok: true }
//
// A turn is either
//   { "text": "Opening Settings." }
// or
//   { "text"?: "…", "tool": "open_app", "args": { "name": "Settings", "reason": "…" } }
//   { "tools": [{ "name": "tap", "args": {…} }, …] }
// String argument values of the form "$id:<label>" are replaced with the id of
// the element whose label is exactly <label> in the newest observation the
// backend sent (lines like `[e7] "Wi-Fi" at (x, y)` in tool / user messages).
// When the queue is empty the model answers with plain text ("Done.").
//
// Listens on 127.0.0.1:$FAKE_MODEL_PORT (0 = random) and prints
// "FAKE_MODEL_LISTENING <port>" once ready.

import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_MODEL_PORT ?? 0);
const MODEL = 'scripted';

/** @type {Array<Record<string, unknown>>} */
let queue = [];
/** @type {Array<Record<string, unknown>>} */
let requests = [];
let callSeq = 0;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Text of one chat message (string content or an array of parts). */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds `[eN] "<label>"` in the newest user/tool message that contains it. */
function elementIdFor(messages, label) {
  const pattern = new RegExp(`\\[(e\\d+)\\] "${escapeRegExp(label)}"`);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'tool' && m?.role !== 'user') continue;
    const match = pattern.exec(messageText(m));
    if (match) return match[1];
  }
  return null;
}

function resolveArgs(value, messages, problems) {
  if (typeof value === 'string' && value.startsWith('$id:')) {
    const label = value.slice('$id:'.length);
    const id = elementIdFor(messages, label);
    if (!id) {
      problems.push(`No element labelled "${label}" in the latest observation`);
      return 'e9999';
    }
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, messages, problems));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveArgs(v, messages, problems)]));
  }
  return value;
}

/** Normalises a scripted turn into { text, calls: [{ id, name, arguments }] }. */
function buildTurn(turn, messages) {
  const problems = [];
  const text = typeof turn.text === 'string' ? turn.text : '';
  const specs = Array.isArray(turn.tools) ? turn.tools : typeof turn.tool === 'string' ? [{ name: turn.tool, args: turn.args ?? {} }] : [];
  const calls = specs.map((spec) => {
    callSeq += 1;
    return {
      id: `call_e2e_${callSeq}`,
      name: String(spec.name),
      arguments: JSON.stringify(resolveArgs(spec.args ?? {}, messages, problems)),
    };
  });
  return { text, calls, problems };
}

function chunk(id, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function handleCompletion(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const scripted = queue.shift() ?? { text: 'Done.' };
  const turn = buildTurn(scripted, messages);
  requests.push({
    at: Date.now(),
    stream: body.stream === true,
    model: body.model ?? null,
    tools: Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name) : [],
    lastMessage: messages.length ? { role: messages[messages.length - 1].role, text: messageText(messages[messages.length - 1]).slice(0, 4000) } : null,
    reply: { text: turn.text, calls: turn.calls.map((c) => ({ name: c.name, arguments: c.arguments })) },
    problems: turn.problems,
  });
  if (turn.problems.length) process.stderr.write(`[fake-model] ${turn.problems.join('; ')}\n`);
  const delayMs = typeof scripted.delayMs === 'number' ? scripted.delayMs : 0;
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

  const id = `chatcmpl-e2e-${Date.now()}`;
  const finish = turn.calls.length > 0 ? 'tool_calls' : 'stop';

  if (body.stream !== true) {
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          finish_reason: finish,
          message: {
            role: 'assistant',
            content: turn.text || null,
            ...(turn.calls.length
              ? { tool_calls: turn.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  send(chunk(id, { role: 'assistant', content: '' }));
  if (turn.text) {
    // Stream the text in a few pieces, like a real model.
    const words = turn.text.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 4) send(chunk(id, { content: words.slice(i, i + 4).join('') }));
  }
  turn.calls.forEach((call, index) => {
    send(chunk(id, { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
    // Arguments arrive in fragments, as with real servers.
    const args = call.arguments;
    const step = Math.max(1, Math.ceil(args.length / 3));
    for (let i = 0; i < args.length; i += step) send(chunk(id, { tool_calls: [{ index, function: { arguments: args.slice(i, i + step) } }] }));
  });
  send(chunk(id, {}, finish));
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
  (async () => {
    switch (route) {
      case 'GET /__health':
        return sendJson(res, 200, { ok: true, queued: queue.length });
      case 'GET /v1/models':
        return sendJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'e2e' }] });
      case 'POST /v1/chat/completions':
        return handleCompletion(req, res);
      case 'POST /__script': {
        const body = JSON.parse((await readBody(req)) || '{}');
        queue = Array.isArray(body.turns) ? body.turns : [];
        requests = [];
        return sendJson(res, 200, { ok: true, queued: queue.length });
      }
      case 'GET /__requests':
        return sendJson(res, 200, { requests, queued: queue.length });
      default:
        return sendJson(res, 404, { error: { message: `Not found: ${route}`, type: 'not_found' } });
    }
  })().catch((err) => {
    process.stderr.write(`[fake-model] ${err instanceof Error ? err.stack : String(err)}\n`);
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(err), type: 'server_error' } });
    else res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`FAKE_MODEL_LISTENING ${typeof address === 'object' && address ? address.port : PORT}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
