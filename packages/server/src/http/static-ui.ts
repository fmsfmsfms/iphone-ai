// Serves the built web UI (packages/web/dist) with an SPA fallback. When the
// UI has not been built, "/" explains how to run the Vite dev server instead.

import { existsSync } from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WS_PATH } from '@iphone-ai/shared';

import type { AppContext } from '../core/services.js';
import { pathOf } from './guards.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Minimal self-contained page (inline styles only; the CSP forbids inline scripts). */
export function htmlPage(title: string, message: string, hint?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0f; color: #e8e8ee;
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { color: #b4b4c0; margin: .5rem 0; }
  code { background: #1c1c24; padding: .1rem .35rem; border-radius: 4px; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${hint ? `<p>${hint}</p>` : ''}</main></body>
</html>`;
}

const NOT_BUILT_PAGE = htmlPage(
  'iPhone AI — the interface is not built',
  'The backend is running, but the web interface has not been built into this copy of iPhone AI.',
  'For development run <code>pnpm dev</code> and open the Vite dev server (it proxies <code>/api</code>, <code>/auth</code> and <code>/ws</code> here). To serve the UI from the backend, run <code>pnpm --filter @iphone-ai/web build</code>.',
);

function isApiLike(urlPath: string): boolean {
  return urlPath === '/api' || urlPath.startsWith('/api/') || urlPath.startsWith('/auth/') || urlPath === WS_PATH;
}

function wantsHtml(request: FastifyRequest, urlPath: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  // A missing file (e.g. /assets/old-chunk.js) must 404, not receive index.html.
  if ((urlPath.split('/').pop() ?? '').includes('.')) return false;
  const accept = request.headers.accept ?? '';
  return accept === '' || accept.includes('text/html') || accept.includes('*/*');
}

/** Registers static serving (when built) and the not-found handler. Returns whether the UI is served. */
export function registerStaticUi(app: FastifyInstance, ctx: AppContext): boolean {
  const dist = ctx.paths.webDistDir;
  const hasUi = dist !== null && existsSync(path.join(dist, 'index.html'));

  if (hasUi) {
    const root = path.resolve(dist);
    const assetsDir = path.join(root, 'assets') + path.sep;
    app.register(fastifyStatic, {
      root,
      prefix: '/',
      index: ['index.html'],
      wildcard: true,
      dotfiles: 'ignore',
      cacheControl: false,
      etag: true,
      lastModified: true,
      setHeaders: (reply, filePath) => {
        // Vite emits content-hashed files under assets/; everything else (index.html) must revalidate.
        void reply.header('cache-control', path.resolve(filePath).startsWith(assetsDir) ? IMMUTABLE : 'no-cache');
      },
    });
  } else {
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(NOT_BUILT_PAGE));
  }

  app.setNotFoundHandler(async (request, reply) => {
    const urlPath = pathOf(request.url);
    if (!isApiLike(urlPath) && wantsHtml(request, urlPath)) {
      if (hasUi) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.code(404).type('text/html; charset=utf-8').send(NOT_BUILT_PAGE);
    }
    return reply.code(404).send({ error: { code: 'not_found', message: `No such endpoint: ${request.method} ${urlPath}` } });
  });

  return hasUi;
}
