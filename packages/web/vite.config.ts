// Vite config for the iPhone AI web UI. In development the UI runs on :5173
// and proxies the API, auth redirects and the WebSocket to the backend on
// 127.0.0.1:47823. In production the backend serves the built `dist/` itself.

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** Backend for the dev proxy; override with IPHONE_AI_BACKEND=http://127.0.0.1:<port>. */
const BACKEND = env['IPHONE_AI_BACKEND'] ?? 'http://127.0.0.1:47823';
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

interface HeaderedRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface ProxyRequest {
  setHeader(name: string, value: string): void;
}
interface ProxyServer {
  on(event: 'proxyReq' | 'proxyReqWs', listener: (proxyReq: ProxyRequest, req: HeaderedRequest) => void): unknown;
}

/**
 * The backend only accepts state-changing requests whose Origin matches its own
 * host. Requests that come from this dev server's own page are re-labelled with
 * the backend origin; anything else keeps its Origin and is rejected upstream.
 */
function rewriteDevOrigin(proxy: ProxyServer): void {
  const rewrite = (proxyReq: ProxyRequest, req: HeaderedRequest): void => {
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && DEV_ORIGINS.has(origin)) proxyReq.setHeader('origin', BACKEND);
  };
  proxy.on('proxyReq', rewrite);
  proxy.on('proxyReqWs', rewrite);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true, configure: (proxy) => rewriteDevOrigin(proxy as unknown as ProxyServer) },
      '/auth': { target: BACKEND, changeOrigin: true, configure: (proxy) => rewriteDevOrigin(proxy as unknown as ProxyServer) },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true, configure: (proxy) => rewriteDevOrigin(proxy as unknown as ProxyServer) },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
});
