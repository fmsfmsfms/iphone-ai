// Optional remote access: a SECOND HTTP listener bound to one chosen network
// address (normally the Mac's Tailscale 100.x address), never 0.0.0.0.
//
// • Runs only while settings.remote.enabled is on AND a passcode hash exists
//   in the Keychain; reacts to settings changes and to the address appearing
//   or disappearing (checked every 30 s).
// • Remote devices sign in with the passcode (scrypt hash, rate limited) and
//   get revocable, expiring sessions. They are view-only unless
//   settings.remote.allowRemoteControl is on. Every device action still runs
//   on this Mac through the same DeviceController and policy engine.
//
// main.ts:
//   const remote = new RemoteAccessService(ctx);   // after startLocalServer(ctx, …)
//   await remote.start();                           // opens the listener when enabled
//   …on shutdown: await remote.stop();
// It shares the AuthService of the local listener (sharedAuthService(ctx)) and
// registers itself so the local listener's /api/remote routes can reach it.

import type { Actor, RemoteSettings } from '@iphone-ai/shared';

import type { AppContext, NetworkAddress, RemoteSessionInfo } from '../core/services.js';
import { sharedAuthService, type AuthService } from '../http/auth.js';
import { createHttpServer, type CreateHttpServerOptions, type HttpServerHandle } from '../http/server.js';
import { bindAddressProblem, listNetworkAddresses } from './network.js';
import { hashPasscode, REMOTE_PASSCODE_ACCOUNT } from './passcode.js';
import { registerRemoteAccess, unregisterRemoteAccess } from './registry.js';

export interface RemoteInfo {
  settings: RemoteSettings;
  listening: boolean;
  url: string | null;
  addresses: NetworkAddress[];
  /** Why the listener is not running although remote access is enabled. */
  error: string | null;
}

/** What the HTTP routes need from the remote-access service. */
export interface RemoteAccessApi {
  info(): RemoteInfo;
  setPasscode(passcode: string, actor: Actor): Promise<void>;
  listSessions(currentSessionId: string | null): RemoteSessionInfo[];
  /** Revokes one session (closing its WebSockets). False when it was not active. */
  revokeSession(id: string, actor: Actor): boolean;
  /** Revokes every remote and local-browser session except `exceptSessionId`. */
  revokeAll(exceptSessionId: string | null, actor: Actor): number;
}

export type HttpServerFactory = (ctx: AppContext, options: CreateHttpServerOptions) => HttpServerHandle;

export interface RemoteAccessOptions {
  /** Defaults to the backend-wide shared AuthService. */
  auth?: AuthService;
  /** Defaults to createHttpServer (override in tests). */
  createServer?: HttpServerFactory;
  /** Defaults to the Mac's IPv4 interfaces (override in tests). */
  listAddresses?: () => NetworkAddress[];
  recheckIntervalMs?: number;
}

export class RemoteAccessService implements RemoteAccessApi {
  private server: HttpServerHandle | null = null;
  private boundKey: string | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private passcodeStored: boolean | null = null;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  private readonly auth: AuthService;
  private readonly createServer: HttpServerFactory;

  constructor(
    private readonly ctx: AppContext,
    private readonly options: RemoteAccessOptions = {},
  ) {
    this.auth = options.auth ?? sharedAuthService(ctx);
    this.createServer = options.createServer ?? createHttpServer;
    registerRemoteAccess(ctx, this);
  }

  private addresses(): NetworkAddress[] {
    return (this.options.listAddresses ?? listNetworkAddresses)();
  }

  start(): Promise<void> {
    if (!this.stopped) return this.queue;
    this.stopped = false;
    this.unsubscribe = this.ctx.settings.onChange((next, previous) => {
      if (JSON.stringify(next.remote) === JSON.stringify(previous.remote)) return;
      if (previous.remote.enabled && !next.remote.enabled) {
        const revoked = this.auth.revokeWhere((s) => s.kind === 'remote', 'Remote access was turned off');
        if (revoked > 0) {
          this.ctx.activity.record({
            category: 'security',
            type: 'remote.sessions_revoked',
            actor: 'system',
            summary: `Remote access turned off: ${revoked} remote session${revoked === 1 ? '' : 's'} signed out.`,
          });
        }
      }
      void this.reconcile();
    });
    this.timer = setInterval(() => void this.reconcile(), this.options.recheckIntervalMs ?? 30_000);
    this.timer.unref();
    return this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    unregisterRemoteAccess(this.ctx, this);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = this.queue.then(() => this.stopServer());
    await this.queue;
  }

  /** Serialised: brings the listener in line with settings and the current interfaces. Never throws. */
  reconcile(): Promise<void> {
    this.queue = this.queue
      .then(() => (this.stopped ? this.stopServer() : this.reconcileNow()))
      .catch((err: unknown) => {
        this.ctx.log.error('Remote access reconcile failed', { error: err instanceof Error ? err.message : String(err) });
      });
    return this.queue;
  }

  info(): RemoteInfo {
    return {
      settings: this.ctx.settings.get().remote,
      listening: this.server !== null,
      url: this.server ? this.url : null,
      addresses: this.addresses(),
      error: this.lastError,
    };
  }

  async setPasscode(passcode: string, actor: Actor): Promise<void> {
    const hash = await hashPasscode(passcode);
    const hadPasscode = this.ctx.settings.get().remote.passcodeSet;
    await this.ctx.secrets.set(REMOTE_PASSCODE_ACCOUNT, hash);
    this.passcodeStored = true;
    // A new passcode invalidates every existing remote session.
    const revoked = this.auth.revokeWhere((s) => s.kind === 'remote', 'The remote passcode was changed');
    this.ctx.settings.mutate((draft) => {
      draft.remote.passcodeSet = true;
    });
    this.ctx.activity.record({
      category: 'security',
      type: hadPasscode ? 'remote.passcode_changed' : 'remote.passcode_set',
      actor,
      summary: hadPasscode
        ? `Remote access passcode changed${revoked ? `; ${revoked} remote session${revoked === 1 ? '' : 's'} signed out` : ''}.`
        : 'Remote access passcode set.',
    });
    await this.reconcile();
  }

  listSessions(currentSessionId: string | null): RemoteSessionInfo[] {
    return this.auth.listActive().map((s) => this.auth.toInfo(s, currentSessionId));
  }

  revokeSession(id: string, actor: Actor): boolean {
    const session = this.auth.get(id);
    const revoked = this.auth.revoke(id, 'Session revoked');
    if (revoked && session) {
      this.ctx.activity.record({
        category: 'security',
        type: 'session.revoked',
        actor,
        summary: `Signed out ${describeSession(session.kind, session.deviceName)}.`,
        detail: { sessionId: id, kind: session.kind, ip: session.ip },
      });
    }
    return revoked;
  }

  revokeAll(exceptSessionId: string | null, actor: Actor): number {
    const revoked = this.auth.revokeWhere(
      (s) => s.id !== exceptSessionId && (s.kind === 'remote' || s.kind === 'local-browser'),
      'All sessions were revoked',
    );
    this.ctx.activity.record({
      category: 'security',
      type: 'session.revoked_all',
      actor,
      summary: `Signed out ${revoked} browser and remote session${revoked === 1 ? '' : 's'}.`,
    });
    return revoked;
  }

  // ───────────────────────────── listener lifecycle ─────────────────────────────

  private async reconcileNow(): Promise<void> {
    const settings = this.ctx.settings.get().remote;
    if (!settings.enabled) {
      await this.stopServer();
      this.setError(null);
      return;
    }
    if (this.passcodeStored === null || !this.passcodeStored) {
      this.passcodeStored = await this.ctx.secrets.has(REMOTE_PASSCODE_ACCOUNT);
    }
    if (!settings.passcodeSet || !this.passcodeStored) {
      await this.stopServer();
      this.setError('Set a remote access passcode first.');
      return;
    }
    const address = settings.bindAddress.trim();
    const problem = bindAddressProblem(address, this.addresses());
    if (problem) {
      await this.stopServer();
      this.setError(problem);
      return;
    }
    const key = `${address}:${settings.port}`;
    if (this.server && this.boundKey === key) return;
    await this.stopServer();

    const server = this.createServer(this.ctx, {
      host: address,
      port: settings.port,
      desktopToken: null,
      listener: 'remote',
      auth: this.auth,
      remote: this,
    });
    try {
      const { url } = await server.listen();
      this.server = server;
      this.boundKey = key;
      this.url = url;
      this.setError(null);
      this.ctx.activity.record({
        category: 'security',
        type: 'remote.listening',
        actor: 'system',
        severity: 'warning',
        summary: `Remote access is on at ${url}${settings.allowRemoteControl ? ' (remote control allowed)' : ' (view-only)'}.`,
      });
    } catch (err) {
      await server.close().catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      this.setError(`Could not listen on ${key}: ${message}`);
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundKey = null;
    this.url = null;
    try {
      await server.close();
    } catch (err) {
      this.ctx.log.warn('Closing the remote listener failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.ctx.activity.record({
      category: 'security',
      type: 'remote.stopped',
      actor: 'system',
      summary: 'Remote access listener stopped.',
    });
  }

  private setError(error: string | null): void {
    if (error === this.lastError) return;
    this.lastError = error;
    if (error && this.ctx.settings.get().remote.enabled) {
      this.ctx.log.warn('Remote access unavailable', { reason: error });
      this.ctx.activity.record({
        category: 'security',
        type: 'remote.unavailable',
        actor: 'system',
        severity: 'warning',
        summary: `Remote access is not listening: ${error}`,
      });
    }
  }
}

function describeSession(kind: RemoteSessionInfo['kind'], deviceName: string | null): string {
  if (kind === 'remote') return deviceName ? `remote device "${deviceName}"` : 'a remote device';
  if (kind === 'local-browser') return 'a browser session on this Mac';
  return 'the desktop app session';
}
