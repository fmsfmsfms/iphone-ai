// Settings and privacy (local data deletion).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HttpError } from '../errors.js';
import { actorFor, parseBody, requireControl, requireLocal, requireSession, type RouteDeps } from '../guards.js';
import { settingsForSession } from '../redaction.js';
import { applySettingsPatch, parseSettingsPatch, recordSettingsChange } from '../settings-apply.js';
import { dropProviderSecrets, reconcileProviders } from './providers.js';

/** Sections a remote session (with control) may change; everything else is security-relevant. */
const REMOTE_EDITABLE_SECTIONS = new Set(['general']);

const privacyDeleteSchema = z
  .object({
    activity: z.boolean().optional(),
    conversations: z.boolean().optional(),
    screenshots: z.boolean().optional(),
    approvals: z.boolean().optional(),
  })
  .strict();

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  app.get('/api/settings', async (request) => settingsForSession(ctx.settings.get(), requireSession(request)));

  app.put('/api/settings', async (request) => {
    const session = requireControl(request, auth);
    const patch = parseSettingsPatch(request.body);
    const sections = Object.keys(patch);
    if (session.kind === 'remote') {
      const blocked = sections.filter((s) => !REMOTE_EDITABLE_SECTIONS.has(s));
      if (blocked.length > 0) {
        throw new HttpError(403, 'local_only', `These settings can only be changed from the Mac: ${blocked.join(', ')}.`);
      }
    }
    const bindAddress = patch.remote?.bindAddress?.trim();
    if (bindAddress === '0.0.0.0' || bindAddress === '::' || bindAddress === '[::]') {
      throw new HttpError(400, 'validation_error', 'remote.bindAddress: listening on every interface is not allowed; choose one address.');
    }

    const previous = ctx.settings.get();
    let added: string[] = [];
    let removed: string[] = [];
    if (patch.ai?.providers) {
      const reconciled = reconcileProviders(patch.ai.providers, previous.ai.providers);
      patch.ai = { ...patch.ai, providers: reconciled.providers };
      added = reconciled.added;
      removed = reconciled.removed;
    }
    // Never let a new provider inherit a Keychain entry left by an earlier one with the same id.
    if (added.length) await dropProviderSecrets(ctx, added);
    const next = applySettingsPatch(ctx, patch);
    if (removed.length) await dropProviderSecrets(ctx, removed);
    recordSettingsChange(ctx, previous, next, actorFor(session), sections);
    return settingsForSession(next, session);
  });

  app.post('/api/privacy/delete', async (request) => {
    const session = requireLocal(request);
    const body = parseBody(privacyDeleteSchema, request.body);
    const deleted: Record<string, number> = {};

    if (body.conversations && (ctx.agents.activeTask() || ctx.workflows.activeRun())) {
      throw new HttpError(409, 'task_running', 'An AI task or workflow is running. Stop it before deleting conversations.');
    }
    if (body.activity) deleted.activity = ctx.activity.clear();
    if (body.conversations) {
      const conversations = ctx.agents.listConversations();
      for (const conversation of conversations) ctx.agents.deleteConversation(conversation.id);
      // AI steps of workflow runs live in a hidden conversation that must keep
      // existing; remove its messages and tasks (task steps cascade).
      ctx.db.run('DELETE FROM chat_messages');
      ctx.db.run('DELETE FROM tasks');
      deleted.conversations = conversations.length;
    }
    if (body.approvals) {
      const pending = ctx.approvals.listPending().map((a) => a.id);
      const placeholders = pending.map(() => '?').join(', ');
      deleted.approvals = ctx.db.run(
        pending.length ? `DELETE FROM approvals WHERE id NOT IN (${placeholders})` : 'DELETE FROM approvals',
        ...pending,
      ).changes;
    }
    if (body.screenshots) deleted.screenshots = ctx.screenshots.prune(true);

    const parts = Object.entries(deleted).map(([what, count]) => `${what} (${count})`);
    ctx.activity.record({
      category: 'security',
      type: 'privacy.deleted',
      actor: actorFor(session),
      severity: 'warning',
      summary: parts.length ? `Local data deleted: ${parts.join(', ')}.` : 'Local data deletion requested (nothing selected).',
      detail: { deleted },
    });
    return { deleted };
  });
}
