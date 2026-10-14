// Manual control, emergency stop, control mode and approvals.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvalDecisionSchema, controlModeSchema, manualActionRequestSchema } from '@iphone-ai/shared';

import { evaluatePolicy } from '../../policy/engine.js';
import { HttpError } from '../errors.js';
import {
  actorFor,
  parseBody,
  requireControl,
  requireSession,
  sessionLabel,
  type RouteDeps,
} from '../guards.js';
import { settingsForSession } from '../redaction.js';
import { applySettingsPatch, recordSettingsChange } from '../settings-apply.js';

const REFOCUS_DELAY_MS = 250;

const stopSchema = z.object({ reason: z.string().trim().max(200).optional() });
const modeSchema = z.object({ mode: controlModeSchema });
const manualSchema = z.object({ enabled: z.boolean() });
const approvalsQuerySchema = z.object({ status: z.enum(['pending', 'recent']).optional() });

export function registerControlRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  app.post('/api/control/action', async (request) => {
    const session = requireControl(request, auth);
    const body = parseBody(manualActionRequestSchema, request.body);
    const settings = ctx.settings.get();
    const actor = actorFor(session);
    const remoteControlAllowed = session.kind === 'remote' ? auth.canControl(session) : undefined;
    const decision = evaluatePolicy({
      actor,
      action: body.action,
      mode: settings.permissions.controlMode,
      permissions: settings.permissions,
      stopLatched: ctx.device.isStopLatched,
      remoteControlAllowed,
    });
    if (decision.verdict === 'deny') {
      throw new HttpError(403, 'policy_denied', decision.reasons.join(' ') || 'This action is not allowed.', {
        reasons: decision.reasons,
        rules: decision.rules,
      });
    }
    const result = await ctx.device.perform(body.action, {
      actor,
      geometryId: body.geometryId,
      decision,
      remoteControlAllowed,
    });
    if (settings.general.refocusAfterManualAction && session.kind === 'desktop' && result.focusChanged) {
      const timer = setTimeout(() => ctx.device.refocusApp(), REFOCUS_DELAY_MS);
      timer.unref();
    }
    return result;
  });

  // Works for every authenticated session, including view-only remote ones.
  app.post('/api/control/stop', async (request) => {
    const session = requireSession(request);
    const body = parseBody(stopSchema, request.body);
    const actor = actorFor(session);
    const reason =
      body.reason ||
      (session.kind === 'remote' ? `Stopped from remote device${session.deviceName ? ` "${session.deviceName}"` : ''}` : 'Stopped by the user');
    const failures: string[] = [];
    const attempt = async (label: string, fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        failures.push(label);
        ctx.log.error(`Emergency stop: ${label} failed`, { error: err instanceof Error ? err.message : String(err) });
      }
    };
    await attempt('device', () => ctx.device.emergencyStop(reason, actor));
    await attempt('approvals', () => ctx.approvals.cancelAll('Emergency stop'));
    await attempt('ai task', () => {
      const task = ctx.agents.activeTask();
      if (task) ctx.agents.cancelTask(task.id, reason);
    });
    await attempt('workflow', () => {
      const run = ctx.workflows.activeRun();
      if (run) ctx.workflows.stop(run.id, reason);
    });
    if (failures.length > 0) {
      ctx.activity.record({
        category: 'error',
        type: 'stop.partial',
        actor: 'system',
        severity: 'error',
        summary: `Emergency stop: could not stop ${failures.join(', ')} cleanly. Device input is still blocked.`,
      });
    }
    return ctx.device.getStatus();
  });

  app.post('/api/control/rearm', async (request) => {
    const session = requireControl(request, auth);
    ctx.device.rearm(actorFor(session));
    return ctx.device.getStatus();
  });

  app.put('/api/control/mode', async (request) => {
    const session = requireControl(request, auth);
    const { mode } = parseBody(modeSchema, request.body);
    if (session.kind === 'remote' && mode !== 'observe') {
      throw new HttpError(403, 'local_only', 'Assisted Control and Supervised Automation can only be turned on from the Mac.');
    }
    const previous = ctx.settings.get();
    const next = applySettingsPatch(ctx, { permissions: { controlMode: mode } });
    recordSettingsChange(ctx, previous, next, actorFor(session), ['permissions']);
    return settingsForSession(next, session);
  });

  app.put('/api/control/manual', async (request) => {
    const session = requireControl(request, auth);
    const { enabled } = parseBody(manualSchema, request.body);
    if (session.kind === 'remote' && enabled) {
      throw new HttpError(403, 'local_only', 'Manual control can only be turned on from the Mac.');
    }
    const previous = ctx.settings.get();
    const next = applySettingsPatch(ctx, { permissions: { manualControlEnabled: enabled } });
    recordSettingsChange(ctx, previous, next, actorFor(session), ['permissions']);
    return settingsForSession(next, session);
  });

  app.get('/api/approvals', async (request) => {
    const { status } = approvalsQuerySchema.parse(request.query ?? {});
    return status === 'recent' ? ctx.approvals.recent(100) : ctx.approvals.listPending();
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id', async (request) => {
    const session = requireControl(request, auth);
    const body = parseBody(approvalDecisionSchema, request.body);
    const decided = ctx.approvals.decide(request.params.id, body.decision, sessionLabel(session), body.note ?? null);
    if (!decided) {
      throw new HttpError(404, 'approval_not_pending', 'This approval is no longer pending (it was decided, expired or cancelled).');
    }
    return decided;
  });
}
