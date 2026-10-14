// Test-only fetch stubs (never imported by production code).

import { vi } from 'vitest';

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { error: { code, message } }, headers);
}

export type RouteHandler = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stubs global fetch with handlers keyed by "METHOD /path" or "/path" (any
 * method). Unknown URLs answer 404 so a missing route shows up in assertions.
 */
export function routeFetch(routes: Record<string, RouteHandler>) {
  const fn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const handler = routes[`${method} ${url}`] ?? routes[url];
    if (!handler) return errorResponse(404, 'not_found', `No test route for ${method} ${url}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** "METHOD /path" of every call made through a routeFetch stub. */
export function calledRoutes(fn: ReturnType<typeof routeFetch>): string[] {
  return fn.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`);
}
