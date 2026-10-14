// Health, bootstrap snapshot, status and diagnostics.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { release } from 'node:os';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../../core/services.js';
import type { AuthSession } from '../auth.js';
import { requireSession, sessionSummary, type RouteDeps } from '../guards.js';
import { exportableSettings, scrubText, settingsForSession } from '../redaction.js';

const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_LINES = 500;

function readLogTail(file: string): string[] {
  if (!existsSync(file)) return [];
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    if (size > length) lines.shift(); // first line is probably partial
    return lines.slice(-LOG_TAIL_LINES).map(scrubText);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Paths are shown as stored to local sessions; remote sessions get them without the account name. */
export function diagnosticsInfo(ctx: AppContext, session: Pick<AuthSession, 'kind'> | null) {
  const server = ctx.mirroir.info();
  const path = (value: string): string => (session && session.kind !== 'remote' ? value : scrubText(value));
  return {
    version: ctx.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dataDir: path(ctx.paths.dataDir),
    mirroirBinary: path(ctx.mirroir.resolveBinary() ?? server.binaryPath),
    mirroirVersion: server.version,
  };
}

function timestampForFile(at = new Date()): string {
  return at.toISOString().replace(/[:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

export function registerSystemRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  // `listener` lets the UI tell the Mac-only listener from the remote one before
  // it has a session (the remote one shows a passcode sign-in instead of
  // "reopen from the app").
  app.get('/api/health', async () => ({ ok: true, version: ctx.version, listener: deps.listener }));

  app.get('/api/bootstrap', async (request) => {
    const session = requireSession(request);
    return {
      status: ctx.device.getStatus(),
      settings: settingsForSession(ctx.settings.get(), session),
      stream: ctx.stream.stats(),
      pendingApprovals: ctx.approvals.listPending(),
      activeTask: ctx.agents.activeTask(),
      activeRun: ctx.workflows.activeRun(),
      session: sessionSummary(session, auth),
      version: ctx.version,
    };
  });

  app.get('/api/status', async () => ctx.device.getStatus());

  app.get('/api/diagnostics/info', async (request) => diagnosticsInfo(ctx, requireSession(request)));

  app.get('/api/diagnostics/export', async (_request, reply) => {
    const server = ctx.mirroir.info();
    const status = ctx.device.getStatus();
    const payload = {
      generatedAt: new Date().toISOString(),
      versions: {
        app: ctx.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        mirroir: server.version,
        mcpProtocol: server.protocolVersion,
      },
      status: {
        ...status,
        server: { ...status.server, binaryPath: scrubText(status.server.binaryPath), permissionFile: status.server.permissionFile ? scrubText(status.server.permissionFile) : null },
        mirroring: { ...status.mirroring, rawStatus: scrubText(status.mirroring.rawStatus) },
      },
      stream: ctx.stream.stats(),
      settings: exportableSettings(ctx.settings.get()),
      activity: ctx.activity.query({ limit: 300 }),
      mirroirStderr: ctx.mirroir.recentStderr().map(scrubText),
      appLog: readLogTail(ctx.paths.logFile),
    };
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="iphone-ai-diagnostics-${timestampForFile()}.json"`)
      .send(JSON.stringify(payload, null, 2));
  });
}
