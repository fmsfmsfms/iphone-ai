// HTTP error model. Every error leaves the API as
// `{ "error": { "code": string, "message": string, ...details } }`.

import type { FastifyError, FastifyInstance } from 'fastify';

import type { Logger } from '../core/logger.js';
import { redactSecrets } from '../core/redact.js';
import { ProviderError } from '../ai/types.js';
import { DeviceError } from '../device/device-controller.js';
import { McpTimeoutError, McpUnavailableError } from '../mcp/mirroir-manager.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, 'not_found', `${what} was not found.`);

export interface ErrorBody {
  error: { code: string; message: string } & Record<string, unknown>;
}

interface MappedError {
  status: number;
  body: ErrorBody;
  /** Unexpected errors are logged with their stack; expected ones are not. */
  unexpected: boolean;
}

interface ZodLikeIssue {
  path: readonly PropertyKey[];
  message: string;
}

function isZodError(err: unknown): err is Error & { issues: ZodLikeIssue[] } {
  return err instanceof Error && err.name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues);
}

/** "permissions.controlMode: Invalid option; body: Required" */
export function formatZodIssues(issues: readonly ZodLikeIssue[]): string {
  const parts = issues.slice(0, 8).map((issue) => {
    const where = issue.path.map((p) => String(p)).join('.');
    return where ? `${where}: ${issue.message}` : issue.message;
  });
  if (issues.length > 8) parts.push(`…and ${issues.length - 8} more`);
  return parts.join('; ') || 'Invalid request.';
}

function body(code: string, message: string, details: Record<string, unknown> = {}): ErrorBody {
  return { error: { ...details, code, message: redactSecrets(message) } };
}

export function mapError(err: unknown): MappedError {
  if (err instanceof HttpError) {
    return { status: err.status, body: body(err.code, err.message, err.details), unexpected: false };
  }
  if (err instanceof DeviceError) {
    return { status: err.status, body: body(err.code, err.message), unexpected: false };
  }
  if (isZodError(err)) {
    return {
      status: 400,
      body: body('validation_error', formatZodIssues(err.issues), {
        issues: err.issues.slice(0, 20).map((i) => ({ path: i.path.map((p) => String(p)).join('.'), message: i.message })),
      }),
      unexpected: false,
    };
  }
  if (err instanceof ProviderError) {
    return { status: err.code === 'auth' ? 401 : 502, body: body(err.code, err.message, { retryable: err.retryable }), unexpected: false };
  }
  if (err instanceof McpUnavailableError) {
    return { status: 503, body: body('mcp_unavailable', err.message), unexpected: false };
  }
  if (err instanceof McpTimeoutError) {
    return { status: 502, body: body('mcp_timeout', err.message), unexpected: false };
  }
  if (err instanceof Error) {
    // Services may throw errors carrying an HTTP status and a code.
    const candidate = err as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
    const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
    if (typeof status === 'number' && status >= 400 && status <= 599) {
      const code = typeof candidate.code === 'string' ? candidate.code : null;
      // Fastify's own errors (bad JSON, body too large, wrong content type).
      if (code?.startsWith('FST_')) {
        if (status < 500) return { status, body: body('bad_request', err.message), unexpected: false };
      } else if (code) {
        return { status, body: body(code, err.message), unexpected: status >= 500 };
      }
    }
  }
  return { status: 500, body: body('internal', 'Something went wrong inside iPhone AI. Details are in the diagnostics log.'), unexpected: true };
}

export function installErrorHandler(app: FastifyInstance, log: Logger): void {
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    const mapped = mapError(err);
    if (mapped.unexpected) {
      log.error('Request failed', {
        method: request.method,
        url: request.url.split('?')[0],
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    void reply.code(mapped.status).header('cache-control', 'no-store').send(mapped.body);
  });
}
