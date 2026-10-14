// Mirroir server / iPhone Mirroring connection management.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { parseHealth } from '../../mcp/parsers.js';
import { actorFor, parseBody, requireControl, requireLocal, requireSession, type RouteDeps } from '../guards.js';
import { openWithSystem } from './auth.js';
import { scrubText } from './system.js';

/** The only System Settings panes the UI may open (no free-form URLs reach /usr/bin/open). */
export const SETTINGS_PANES = {
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
} as const;

const openSettingsSchema = z.object({ pane: z.enum(['screen-recording', 'accessibility', 'automation']) });

export function registerConnectionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  app.post('/api/connection/refresh', async (request) => {
    requireSession(request);
    await ctx.device.refreshPermissions();
    await ctx.device.refreshStatus();
    return ctx.device.getStatus();
  });

  app.post('/api/connection/restart', async (request) => {
    const session = requireControl(request, auth);
    ctx.activity.record({
      category: 'connection',
      type: 'mirroir.restart_requested',
      actor: actorFor(session),
      summary: 'Restart of the Mirroir MCP server requested.',
    });
    await ctx.mirroir.restart('Restart requested from the app');
    await ctx.device.refreshStatus().catch(() => undefined);
    return ctx.device.getStatus();
  });

  app.post('/api/connection/open-mirroring', async (request) => {
    requireControl(request, auth);
    return { opened: await ctx.device.openMirroringApp() };
  });

  app.post('/api/connection/check-health', async (request) => {
    requireControl(request, auth);
    const outcome = await ctx.device.checkHealth();
    const parsed = parseHealth(outcome.text);
    return { ok: outcome.ok && parsed.ok, items: parsed.items, raw: outcome.text };
  });

  app.get('/api/connection/doctor', async () => ({ checks: (await ctx.mirroir.runDoctor()) ?? [] }));

  app.get('/api/connection/tools', async () => ctx.mirroir.info().tools);

  app.get('/api/connection/stderr', async () => ctx.mirroir.recentStderr().map(scrubText));

  app.post('/api/connection/open-settings', async (request) => {
    requireLocal(request);
    const { pane } = parseBody(openSettingsSchema, request.body);
    return { opened: await openWithSystem(SETTINGS_PANES[pane]) };
  });
}
