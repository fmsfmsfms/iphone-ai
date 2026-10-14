// Local node:http server that emulates provider APIs (OpenAI Chat
// Completions, Anthropic Messages) for provider tests. Bound to 127.0.0.1 on a
// random port; records every request (method, path, headers, JSON body).

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

export type FakeHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  /** Replaces the handler for subsequent requests. */
  handle(handler: FakeHandler): void;
  close(): Promise<void>;
}

export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { raw };
        }
      }
      const recorded: RecordedRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body };
      requests.push(recorded);
      Promise.resolve(current(recorded, res)).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Writes a complete server-sent-events response. `data` objects are JSON encoded. */
export function sendSse(res: ServerResponse, events: { event?: string; data: unknown }[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const e of events) {
    if (e.event) res.write(`event: ${e.event}\n`);
    res.write(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
