// iPhone AI backend entry point.
//
// Environment (set by the Tauri shell or scripts/dev.mjs):
//   IPHONE_AI_PORT            port for the local listener (0 = random; default 47823)
//   IPHONE_AI_DESKTOP_TOKEN   per-launch secret for the desktop window login
//   IPHONE_AI_DATA_DIR        data directory (default ~/Library/Application Support/iPhone AI)
//   IPHONE_AI_WEB_DIST        built UI to serve (optional)
//   IPHONE_AI_LOG_FILE        log file (default <data>/logs/iphone-ai.log)
//   IPHONE_AI_BUNDLE_ID       set by the desktop app; enables re-focusing it and
//                             exiting when the app closes our stdin
//   IPHONE_AI_CLAUDE_CODE_BIN bundled Claude Code binary (Claude Agent SDK provider)
//   IPHONE_AI_CAPTURE_BIN     bundled ScreenCaptureKit live capture helper (iphone-ai-capture);
//                             in development <repo>/src-tauri/binaries/iphone-ai-capture-<arch>-apple-darwin
//                             is used when it exists. Without a helper, screenshot polling stays in charge.
//   IPHONE_AI_MIRROIR_MOCK    path to the mock Mirroir server — TESTS/CI ONLY; the UI
//                             and logs label the session as mock
// Prints "LISTENING <port>" on stdout once the HTTP server is ready.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION, DEFAULT_PROVIDERS } from '@iphone-ai/shared';

import { AgentService } from './ai/agent-service.js';
import { ScreenshotStore } from './ai/screenshots.js';
import { WorkflowService } from './automation/workflow-service.js';
import { ActivityLog } from './core/activity-log.js';
import { EventHub } from './core/events.js';
import { newId } from './core/ids.js';
import { createLogger } from './core/logger.js';
import { ensureAppDirectories, resolveAppPaths } from './core/paths.js';
import type { AppContext } from './core/services.js';
import { SettingsStore } from './core/settings-store.js';
import { Database } from './db/database.js';
import { DeviceController } from './device/device-controller.js';
import { LiveCapture, resolveCaptureHelper } from './device/live-capture.js';
import { ScreenStream } from './device/screen-stream.js';
import { startLocalServer } from './http/server.js';
import { MirroirManager } from './mcp/mirroir-manager.js';
import { ApprovalBroker } from './policy/approvals.js';
import { RemoteAccessService } from './remote/remote-access.js';
import { KeychainSecretStore, MemorySecretStore, providerSecretAccount } from './security/secrets.js';

const VERSION = APP_VERSION;

function defaultWebDist(): string | null {
  if (process.env.IPHONE_AI_WEB_DIST) return process.env.IPHONE_AI_WEB_DIST;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '../../web/dist');
    return existsSync(path.join(candidate, 'index.html')) ? candidate : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const paths = resolveAppPaths({ webDistDir: defaultWebDist() });
  ensureAppDirectories(paths);

  const db = new Database(paths.dbFile);
  const settings = new SettingsStore(db);
  const log = createLogger({
    file: process.env.IPHONE_AI_LOG_FILE ?? paths.logFile,
    level: settings.get().advanced.debugLogging ? 'debug' : 'info',
  });
  settings.onChange((next) => log.setLevel(next.advanced.debugLogging ? 'debug' : 'info'));

  const sessionId = newId('sess');
  const hub = new EventHub();
  const activity = new ActivityLog(db, hub, sessionId);
  const mockServer = process.env.IPHONE_AI_MIRROIR_MOCK ?? null;
  const secrets = process.env.IPHONE_AI_SECRETS === 'memory' || mockServer ? new MemorySecretStore() : new KeychainSecretStore();

  // Keep the hasApiKey flags in sync with the Keychain (keys may have been removed outside the app).
  const flags = new Map<string, boolean>();
  for (const provider of settings.get().ai.providers) {
    flags.set(provider.id, await secrets.has(providerSecretAccount(provider.id)).catch(() => false));
  }
  settings.mutate((draft) => {
    for (const provider of draft.ai.providers) provider.hasApiKey = flags.get(provider.id) ?? false;
    // Restore any built-in provider that an older settings file lacks.
    for (const builtin of DEFAULT_PROVIDERS) {
      if (!draft.ai.providers.some((p) => p.id === builtin.id)) draft.ai.providers.push({ ...builtin });
    }
  });

  const mirroir = new MirroirManager({
    paths,
    settings,
    log,
    activity,
    command: mockServer ? { command: process.execPath, args: [mockServer] } : null,
  });
  if (mockServer) log.warn('MOCK MODE: using the mock Mirroir server — no real iPhone is connected', { mockServer });
  const device = new DeviceController(
    mirroir,
    settings,
    hub,
    activity,
    log,
    mockServer ? { screenRecording: 'granted', accessibility: 'granted', source: 'mock Mirroir (assumed, not a real device)' } : null,
  );
  const captureHelper = resolveCaptureHelper({ mock: Boolean(mockServer) });
  const live = new LiveCapture({
    device,
    settings,
    hub,
    log,
    helper: captureHelper.helper,
    unavailableReason: captureHelper.reason,
  });
  const stream = new ScreenStream(device, settings, hub, log, live);
  const approvals = new ApprovalBroker(db, hub, activity);
  const screenshots = new ScreenshotStore(db, paths, settings);
  const agents = new AgentService({ db, settings, secrets, hub, activity, device, approvals, screenshots, paths, log });
  const workflows = new WorkflowService({ db, settings, hub, activity, approvals, screenshots, paths, agents, device, log });

  const ctx: AppContext = {
    version: VERSION,
    sessionId,
    paths,
    log,
    db,
    hub,
    settings,
    secrets,
    activity,
    mirroir,
    device,
    stream,
    live,
    approvals,
    screenshots,
    agents,
    workflows,
  };

  activity.record({
    category: 'session',
    type: 'session.started',
    actor: 'system',
    summary: `iPhone AI ${VERSION} started${mockServer ? ' in MOCK mode (no real iPhone)' : ''}.`,
    detail: { node: process.version, dataDir: paths.dataDir, mock: Boolean(mockServer) },
  });

  // Retention.
  const prune = () => {
    const s = settings.get();
    activity.pruneOlderThan(Date.now() - s.privacy.historyRetentionDays * 86_400_000);
    screenshots.prune();
  };
  prune();
  setInterval(prune, 6 * 3_600_000).unref();

  // Listen first so the desktop window can show progress while Mirroir starts
  // (the shell gives the backend 30 s to print LISTENING).
  const port = Number(process.env.IPHONE_AI_PORT ?? 47823);
  const server = await startLocalServer(ctx, { port, desktopToken: process.env.IPHONE_AI_DESKTOP_TOKEN ?? null });
  const remote = new RemoteAccessService(ctx);
  await remote.start().catch((err: unknown) => log.warn('Remote access did not start', { error: String(err) }));
  log.info('iPhone AI backend listening', { port: server.port, mock: Boolean(mockServer) });
  process.stdout.write(`LISTENING ${server.port}\n`);

  device.start();
  live.start();
  stream.start();
  void mirroir.start().catch((err: unknown) => log.error('Mirroir failed to start', { error: String(err) }));

  if (settings.get().general.openMirroringOnLaunch) void device.openMirroringApp();

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { reason });
    const active = agents.activeTask();
    if (active) agents.cancelTask(active.id, 'iPhone AI is closing.');
    const run = workflows.activeRun();
    if (run) workflows.stop(run.id, 'iPhone AI is closing.');
    approvals.cancelAll('iPhone AI is closing');
    stream.stop();
    await live.shutdown().catch(() => undefined);
    device.stopMonitoring();
    activity.record({ category: 'session', type: 'session.ended', actor: 'system', summary: `iPhone AI stopped (${reason}).` });
    // SIGTERM lets Mirroir release any held touch or key before exiting.
    await mirroir.terminate('iPhone AI is closing').catch(() => undefined);
    await remote.stop().catch(() => undefined);
    await server.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  // Last resort: the capture helper must never outlive the backend.
  process.on('exit', () => live.killNow());
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  if (process.env.IPHONE_AI_BUNDLE_ID) {
    // The desktop app keeps our stdin open; EOF means it quit or crashed.
    process.stdin.on('end', () => void shutdown('desktop app closed'));
    process.stdin.on('close', () => void shutdown('desktop app closed'));
    process.stdin.resume();
  }
}

// Safety net: a stray rejected promise must never take down the process that
// owns the phone connection; it is logged instead.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
