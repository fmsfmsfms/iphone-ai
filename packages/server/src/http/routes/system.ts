// Health, bootstrap snapshot, status and diagnostics.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir, release } from 'node:os';

import type { FastifyInstance } from 'fastify';
import type { AppSettings } from '@iphone-ai/shared';

import { redactSecrets, redactUrl } from '../../core/redact.js';
import type { AppContext } from '../../core/services.js';
import { requireSession, sessionSummary, type RouteDeps } from '../guards.js';

const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_LINES = 500;

/** Replaces the home directory with "~" so exports do not reveal the account name. */
export function scrubText(text: string): string {
  const home = homedir();
  const scrubbed = home ? text.split(home).join('~') : text;
  return redactSecrets(scrubbed);
}

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

/** Settings without anything secret-like (settings never hold keys; URLs may carry credentials). */
export function exportableSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    connection: { ...settings.connection, mirroirBinaryPath: scrubText(settings.connection.mirroirBinaryPath) },
    ai: {
      ...settings.ai,
      providers: settings.ai.providers.map((p) => ({ ...p, baseUrl: p.baseUrl ? redactUrl(p.baseUrl) : null })),
    },
  };
}

export function diagnosticsInfo(ctx: AppContext) {
  const server = ctx.mirroir.info();
  return {
    version: ctx.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dataDir: ctx.paths.dataDir,
    mirroirBinary: ctx.mirroir.resolveBinary() ?? server.binaryPath,
    mirroirVersion: server.version,
  };
}

function timestampForFile(at = new Date()): string {
  return at.toISOString().replace(/[:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

export function registerSystemRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  app.get('/api/health', async () => ({ ok: true, version: ctx.version }));

  app.get('/api/bootstrap', async (request) => {
    const session = requireSession(request);
    return {
      status: ctx.device.getStatus(),
      settings: ctx.settings.get(),
      stream: ctx.stream.stats(),
      pendingApprovals: ctx.approvals.listPending(),
      activeTask: ctx.agents.activeTask(),
      activeRun: ctx.workflows.activeRun(),
      session: sessionSummary(session, auth),
      version: ctx.version,
    };
  });

  app.get('/api/status', async () => ctx.device.getStatus());

  app.get('/api/diagnostics/info', async () => diagnosticsInfo(ctx));

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
