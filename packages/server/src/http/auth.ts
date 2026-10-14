// Authentication: cookie sessions (desktop app, local browser, remote
// device), one-time browser login codes, remote passcode verification and
// login rate limiting.
//
// Sessions live in the `remote_sessions` table; only sha256(token) is stored.
// One AuthService is shared by the local and the remote listener so that
// revoking a session closes its WebSockets on both.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply } from 'fastify';
import { SESSION_COOKIE } from '@iphone-ai/shared';

import { newId, newToken } from '../core/ids.js';
import type { AppContext, RemoteSessionInfo } from '../core/services.js';
import { REMOTE_PASSCODE_ACCOUNT, verifyPasscode } from '../remote/passcode.js';

export type SessionKind = RemoteSessionInfo['kind'];
export type ListenerKind = 'local' | 'remote';

export interface AuthSession {
  id: string;
  kind: SessionKind;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Granted at login. Remote sessions additionally need remote.allowRemoteControl to still be on. */
  canControl: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the security hook for /api and /ws requests carrying a valid session cookie. */
    authSession: AuthSession | null;
  }
}

interface SessionRow {
  id: string;
  token_hash: string;
  kind: string;
  device_name: string | null;
  ip: string | null;
  user_agent: string | null;
  can_control: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export const DESKTOP_SESSION_TTL_MS = 30 * 24 * 3_600_000;
/**
 * Cookies are not isolated by port (RFC 6265 §8.5): a browser also sends the
 * local-browser cookie to any other service on 127.0.0.1. Until sessions are
 * bound to a secret only this origin holds, keep that exposure short: the
 * cookie lasts for the browser session only, expires after 8 h, and every
 * backend launch revokes it.
 */
export const LOCAL_BROWSER_SESSION_TTL_MS = 8 * 3_600_000;
const LOGIN_CODE_TTL_MS = 2 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;
const HOUSEKEEPING_AGE_MS = 30 * 24 * 3_600_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string comparison (both sides hashed first, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Reads one cookie from a raw Cookie header (independent of plugin hook order). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeMs: number | null): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: false,
    ...(maxAgeMs !== null ? { maxAge: Math.floor(maxAgeMs / 1000) } : {}),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
}

/** Outcome of reserving a login attempt: refused (waitMs > 0) or a ticket to pass to finish(). */
export type LoginReservation = { waitMs: number; ticket: null; busy: boolean } | { waitMs: 0; ticket: number; busy: false };

/**
 * In-memory failure counter for passcode logins (per IP plus a global
 * ceiling). Verification is slow and asynchronous (Keychain read + scrypt),
 * so an attempt is reserved — counted as a failure and marked in flight —
 * synchronously before verifying; finish() un-counts it unless it failed.
 * Concurrent attempts can therefore never overtake the limits.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private global: number[] = [];
  private readonly inFlight = new Map<string, number>();
  private globalInFlight = 0;

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 5 * 60_000,
    private readonly maxGlobalFailures = 50,
    private readonly maxGlobalInFlight = 4,
  ) {}

  /** Milliseconds until another attempt is allowed (0 = allowed now). */
  retryAfterMs(ip: string, now = Date.now()): number {
    this.prune(now);
    const own = this.failures.get(ip) ?? [];
    let wait = 0;
    if (own.length >= this.maxFailures) wait = Math.max(wait, own[0]! + this.windowMs - now);
    if (this.global.length >= this.maxGlobalFailures) wait = Math.max(wait, this.global[0]! + this.windowMs - now);
    return Math.max(0, wait);
  }

  /**
   * Checks the limits and reserves one attempt in the same synchronous step:
   * at most one verification per IP (and a few globally) runs at a time, and
   * the attempt counts as a failure until finish() says otherwise.
   */
  reserve(ip: string, now = Date.now()): LoginReservation {
    const wait = this.retryAfterMs(ip, now);
    if (wait > 0) return { waitMs: wait, ticket: null, busy: false };
    if ((this.inFlight.get(ip) ?? 0) >= 1 || this.globalInFlight >= this.maxGlobalInFlight) {
      return { waitMs: 1000, ticket: null, busy: true };
    }
    this.fail(ip, now);
    this.inFlight.set(ip, (this.inFlight.get(ip) ?? 0) + 1);
    this.globalInFlight += 1;
    return { waitMs: 0, ticket: now, busy: false };
  }

  /** Ends a reserved attempt; only an invalid passcode keeps counting as a failure. */
  finish(ip: string, ticket: number, outcome: 'ok' | 'invalid' | 'not_configured'): void {
    const running = (this.inFlight.get(ip) ?? 1) - 1;
    if (running <= 0) this.inFlight.delete(ip);
    else this.inFlight.set(ip, running);
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    if (outcome === 'invalid') return;
    const own = this.failures.get(ip);
    const index = own?.indexOf(ticket) ?? -1;
    if (own && index >= 0) own.splice(index, 1);
    if (own?.length === 0) this.failures.delete(ip);
    const globalIndex = this.global.indexOf(ticket);
    if (globalIndex >= 0) this.global.splice(globalIndex, 1);
    if (outcome === 'ok') this.succeed(ip);
  }

  fail(ip: string, now = Date.now()): void {
    this.prune(now);
    const own = this.failures.get(ip) ?? [];
    own.push(now);
    this.failures.set(ip, own);
    this.global.push(now);
    if (this.failures.size > 5000) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.global = this.global.filter((t) => t > cutoff);
    for (const [ip, times] of this.failures) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.failures.delete(ip);
      else if (kept.length !== times.length) this.failures.set(ip, kept);
    }
  }
}

type SocketCloser = (code: number, reason: string) => void;

export interface CreateSessionInput {
  kind: SessionKind;
  canControl: boolean;
  ttlMs: number;
  deviceName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** WebSocket close code used when a session is revoked, expires or logs out. */
export const WS_CLOSE_SESSION_ENDED = 4401;

const sharedServices = new WeakMap<AppContext, AuthService>();

/** The AuthService shared by every listener of one backend (created on first use). */
export function sharedAuthService(ctx: AppContext): AuthService {
  let auth = sharedServices.get(ctx);
  if (!auth) {
    auth = new AuthService(ctx);
    sharedServices.set(ctx, auth);
  }
  return auth;
}

export class AuthService {
  readonly loginLimiter = new LoginRateLimiter();
  private readonly loginCodes = new Map<string, number>();
  private readonly sockets = new Map<string, Set<SocketCloser>>();
  private started = false;

  constructor(private readonly ctx: AppContext) {}

  /**
   * Called once per backend launch: desktop sessions are bound to the
   * per-launch token, so sessions from earlier launches are revoked, and so
   * are local-browser sessions (see LOCAL_BROWSER_SESSION_TTL_MS). Old rows
   * are purged.
   */
  startup(): void {
    if (this.started) return;
    this.started = true;
    const now = Date.now();
    this.ctx.db.run(
      "UPDATE remote_sessions SET revoked_at = ? WHERE kind IN ('desktop', 'local-browser') AND revoked_at IS NULL",
      now,
    );
    this.ctx.db.run(
      'DELETE FROM remote_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
      now - HOUSEKEEPING_AGE_MS,
      now - HOUSEKEEPING_AGE_MS,
    );
  }

  // ───────────────────────────── sessions ─────────────────────────────

  createSession(input: CreateSessionInput): { session: AuthSession; token: string } {
    const token = newToken(32);
    const now = Date.now();
    const session: AuthSession = {
      id: newId('ses'),
      kind: input.kind,
      deviceName: input.deviceName?.trim() ? input.deviceName.trim().slice(0, 80) : null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
      canControl: input.canControl,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + input.ttlMs,
      revokedAt: null,
    };
    this.ctx.db.run(
      `INSERT INTO remote_sessions (id, token_hash, kind, device_name, ip, user_agent, can_control, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      session.id,
      hashToken(token),
      session.kind,
      session.deviceName,
      session.ip,
      session.userAgent,
      session.canControl ? 1 : 0,
      session.createdAt,
      session.lastSeenAt,
      session.expiresAt,
    );
    return { session, token };
  }

  /**
   * Resolves a cookie token to an active session usable on this listener
   * (remote sessions only on the remote listener, local ones only locally).
   * Updates last_seen_at at most once a minute.
   */
  resolve(token: string | null, listener: ListenerKind): AuthSession | null {
    if (!token || token.length > 200) return null;
    const row = this.ctx.db.get<SessionRow>('SELECT * FROM remote_sessions WHERE token_hash = ?', hashToken(token));
    if (!row) return null;
    const session = rowToSession(row);
    const now = Date.now();
    if (session.revokedAt !== null || session.expiresAt <= now) return null;
    if ((listener === 'remote') !== (session.kind === 'remote')) return null;
    if (now - session.lastSeenAt > TOUCH_INTERVAL_MS) {
      this.ctx.db.run('UPDATE remote_sessions SET last_seen_at = ? WHERE id = ?', now, session.id);
      session.lastSeenAt = now;
    }
    return session;
  }

  get(id: string): AuthSession | null {
    const row = this.ctx.db.get<SessionRow>('SELECT * FROM remote_sessions WHERE id = ?', id);
    return row ? rowToSession(row) : null;
  }

  isActive(id: string): boolean {
    const session = this.get(id);
    return session !== null && session.revokedAt === null && session.expiresAt > Date.now();
  }

  /** Remote sessions lose control as soon as remote.allowRemoteControl is turned off. */
  canControl(session: AuthSession): boolean {
    if (session.kind !== 'remote') return true;
    return session.canControl && this.ctx.settings.get().remote.allowRemoteControl;
  }

  /** Active (not revoked, not expired) sessions, most recently used first. */
  listActive(): AuthSession[] {
    return this.ctx.db
      .all<SessionRow>(
        'SELECT * FROM remote_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 500',
        Date.now(),
      )
      .map(rowToSession);
  }

  toInfo(session: AuthSession, currentSessionId: string | null): RemoteSessionInfo {
    return {
      id: session.id,
      kind: session.kind,
      deviceName: session.deviceName,
      ip: session.ip,
      userAgent: session.userAgent,
      canControl: this.canControl(session),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      ...(currentSessionId !== null ? { current: session.id === currentSessionId } : {}),
    };
  }

  /** Revokes a session and closes its WebSockets immediately. Returns false if it was not active. */
  revoke(id: string, reason: string): boolean {
    const result = this.ctx.db.run('UPDATE remote_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), id);
    this.closeSockets(id, reason);
    return result.changes > 0;
  }

  revokeWhere(predicate: (session: AuthSession) => boolean, reason: string): number {
    let count = 0;
    for (const session of this.listActive()) {
      if (predicate(session) && this.revoke(session.id, reason)) count += 1;
    }
    return count;
  }

  // ───────────────────────────── one-time browser codes ─────────────────────────────

  createLoginCode(): string {
    this.pruneCodes();
    const code = newToken(24);
    this.loginCodes.set(hashToken(code), Date.now() + LOGIN_CODE_TTL_MS);
    return code;
  }

  /** Single use: a code is deleted on first presentation, valid or not. */
  consumeLoginCode(code: string): boolean {
    this.pruneCodes();
    if (!code || code.length > 200) return false;
    const key = hashToken(code);
    const expiresAt = this.loginCodes.get(key);
    this.loginCodes.delete(key);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private pruneCodes(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.loginCodes) {
      if (expiresAt <= now) this.loginCodes.delete(key);
    }
  }

  // ───────────────────────────── remote passcode ─────────────────────────────

  async verifyRemotePasscode(passcode: string): Promise<'ok' | 'invalid' | 'not_configured'> {
    const stored = await this.ctx.secrets.get(REMOTE_PASSCODE_ACCOUNT);
    if (!stored) return 'not_configured';
    try {
      return (await verifyPasscode(passcode, stored)) ? 'ok' : 'invalid';
    } catch {
      return 'invalid';
    }
  }

  // ───────────────────────────── WebSocket tracking ─────────────────────────────

  trackSocket(sessionId: string, close: SocketCloser): () => void {
    let set = this.sockets.get(sessionId);
    if (!set) {
      set = new Set();
      this.sockets.set(sessionId, set);
    }
    set.add(close);
    return () => {
      const current = this.sockets.get(sessionId);
      if (!current) return;
      current.delete(close);
      if (current.size === 0) this.sockets.delete(sessionId);
    };
  }

  closeSockets(sessionId: string, reason: string): void {
    const set = this.sockets.get(sessionId);
    if (!set) return;
    this.sockets.delete(sessionId);
    for (const close of set) {
      try {
        close(WS_CLOSE_SESSION_ENDED, reason.slice(0, 120));
      } catch {
        // socket already gone
      }
    }
  }
}

function rowToSession(row: SessionRow): AuthSession {
  const kind: SessionKind = row.kind === 'desktop' || row.kind === 'local-browser' ? row.kind : 'remote';
  return {
    id: row.id,
    kind,
    deviceName: row.device_name,
    ip: row.ip,
    userAgent: row.user_agent,
    canControl: row.can_control === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
