// HTTP + WebSocket server (Fastify). One instance per listener:
//  • 'local'  — always on, bound to 127.0.0.1 (desktop window and local browsers)
//  • 'remote' — optional, bound to one chosen interface address (see remote/remote-access.ts)
//
// main.ts usage:
//   const server = await startLocalServer(ctx, { port, desktopToken });
//   const remote = new RemoteAccessService(ctx);  // optional second listener
//   await remote.start();
//   process.stdout.write(`LISTENING ${server.port}\n`);
//   …on shutdown: await remote.stop(); await server.close();

import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppContext } from '../core/services.js';
import type { RemoteAccessApi } from '../remote/remote-access.js';
import { remoteAccessFor } from '../remote/registry.js';
import { sharedAuthService, type AuthService, type ListenerKind } from './auth.js';
import { HttpError, installErrorHandler } from './errors.js';
import type { RouteDeps } from './guards.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConnectionRoutes } from './routes/connection.js';
import { registerControlRoutes } from './routes/control.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerRemoteRoutes } from './routes/remote.js';
import { registerScreenRoutes } from './routes/screen.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { installSecurityHooks, needsSession } from './security.js';
import { registerStaticUi } from './static-ui.js';
import { registerWebSocket } from './ws.js';

const LOCAL_BIND_HOST = '127.0.0.1';
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export interface CreateHttpServerOptions {
  /** Address to bind. Ignored for 'local' (always 127.0.0.1). */
  host: string;
  /** 0 = pick a free port. */
  port: number;
  /** Per-launch desktop token (env IPHONE_AI_DESKTOP_TOKEN); null disables /auth/desktop. */
  desktopToken: string | null;
  listener: ListenerKind;
  /** Session store; defaults to the backend-wide sharedAuthService(ctx). */
  auth?: AuthService;
  /**
   * Remote-access service backing /api/remote*. Defaults to the one registered
   * for this ctx (looked up per request); null → those endpoints answer 503.
   */
  remote?: RemoteAccessApi | null;
  /**
   * Extra origins accepted on the local listener, e.g. the Vite dev server
   * ("http://localhost:5173"). Only loopback http origins are honoured.
   */
  devOrigins?: readonly string[];
}

export interface HttpServerHandle {
  app: FastifyInstance;
  auth: AuthService;
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

/** Keeps only http://localhost:<port> / http://127.0.0.1:<port> origins. */
export function sanitizeDevOrigins(origins: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of origins ?? []) {
    const value = raw.trim().toLowerCase().replace(/\/+$/, '');
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(value)) out.push(value);
  }
  return out;
}

export function createHttpServer(ctx: AppContext, options: CreateHttpServerOptions): HttpServerHandle {
  const listener = options.listener;
  const bindHost = listener === 'local' ? LOCAL_BIND_HOST : options.host.trim();
  if (listener === 'remote' && (!bindHost || bindHost === '0.0.0.0' || bindHost === '::')) {
    throw new Error('The remote listener must bind one specific address.');
  }
  const auth = options.auth ?? sharedAuthService(ctx);
  const devOrigins = listener === 'local' ? sanitizeDevOrigins(options.devOrigins) : [];
  let boundPort = options.port;

  const allowedHosts = (): ReadonlySet<string> => {
    const hosts = new Set<string>();
    if (listener === 'local') {
      hosts.add(`127.0.0.1:${boundPort}`);
      hosts.add(`localhost:${boundPort}`);
      for (const origin of devOrigins) hosts.add(origin.replace(/^http:\/\//, ''));
    } else {
      hosts.add(`${bindHost.toLowerCase()}:${boundPort}`);
    }
    return hosts;
  };

  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    forceCloseConnections: true,
    return503OnClosing: true,
  });

  app.decorateRequest('authSession', null);

  // Empty JSON bodies (e.g. POST with content-type but no payload) count as "no body".
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJsonParser(request, text, done);
  });

  // Root-level hook: runs first for every route, static file, 404 and WebSocket upgrade.
  installSecurityHooks(app, {
    listener,
    auth,
    allowedHosts,
    extraOrigins: new Set(devOrigins),
    enabled: () => listener === 'local' || ctx.settings.get().remote.enabled,
  });
  installErrorHandler(app, ctx.log.child(`http.${listener}`));

  app.register(fastifyCookie);
  app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
  registerStaticUi(app, ctx);

  const deps: RouteDeps = {
    ctx,
    auth,
    remote: () => (options.remote !== undefined ? options.remote : remoteAccessFor(ctx)),
    listener,
    desktopToken: listener === 'local' ? options.desktopToken : null,
    baseUrl: () => `http://${listener === 'local' ? LOCAL_BIND_HOST : bindHost}:${boundPort}`,
  };

  // Routes live in a child context registered after @fastify/websocket (its onRoute hook must see them).
  app.register(async (instance) => {
    // Defence in depth, independent of how the URL was spelled: every matched
    // /api route (except the public ones) and /ws needs the session the root
    // hook resolved.
    instance.addHook('onRequest', async (request) => {
      if (!request.authSession && needsSession(request.method, request.routeOptions.url ?? '')) {
        throw new HttpError(401, 'unauthenticated', 'Sign in to iPhone AI first.');
      }
    });
    registerSystemRoutes(instance, deps);
    registerAuthRoutes(instance, deps);
    registerConnectionRoutes(instance, deps);
    registerScreenRoutes(instance, deps);
    registerControlRoutes(instance, deps);
    registerAssistantRoutes(instance, deps);
    registerProviderRoutes(instance, deps);
    registerWorkflowRoutes(instance, deps);
    registerActivityRoutes(instance, deps);
    registerSettingsRoutes(instance, deps);
    registerRemoteRoutes(instance, deps);
    registerWebSocket(instance, deps);
  });

  return {
    app,
    auth,
    async listen() {
      await app.listen({ host: bindHost, port: options.port });
      const address = app.server.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : options.port;
      return { port: boundPort, url: deps.baseUrl() };
    },
    async close() {
      await app.close();
    },
  };
}

export interface LocalServerOptions {
  port: number;
  desktopToken: string | null;
  /**
   * Origins of a dev UI server. Defaults to env IPHONE_AI_DEV_ORIGINS
   * (comma-separated) or, outside production builds, the Vite dev server
   * on port 5173.
   */
  devOrigins?: readonly string[];
}

export interface LocalServer {
  app: FastifyInstance;
  auth: AuthService;
  port: number;
  url: string;
  close(): Promise<void>;
}

function defaultDevOrigins(): string[] {
  const fromEnv = process.env.IPHONE_AI_DEV_ORIGINS;
  if (fromEnv !== undefined) return fromEnv.split(',');
  if (process.env.NODE_ENV === 'production') return [];
  return ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

/**
 * Starts the local listener on 127.0.0.1:<port>. Also forwards settings
 * changes to connected UIs as `settings` events. The optional remote listener
 * is managed separately by RemoteAccessService (remote/remote-access.ts).
 */
export async function startLocalServer(ctx: AppContext, options: LocalServerOptions): Promise<LocalServer> {
  const auth = sharedAuthService(ctx);
  auth.startup();
  const server = createHttpServer(ctx, {
    host: LOCAL_BIND_HOST,
    port: options.port,
    desktopToken: options.desktopToken,
    listener: 'local',
    auth,
    devOrigins: options.devOrigins ?? defaultDevOrigins(),
  });
  const { port, url } = await server.listen();
  const stopSettingsEvents = ctx.settings.onChange((next) => ctx.hub.publish({ type: 'settings', settings: next }));
  return {
    app: server.app,
    auth,
    port,
    url,
    async close() {
      stopSettingsEvents();
      await server.close();
    },
  };
}
