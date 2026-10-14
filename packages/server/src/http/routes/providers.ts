// AI provider configuration and API keys. Keys go to the Keychain via
// ctx.secrets and are never returned; `hasApiKey` always comes from the
// backend, never from the client.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_PROVIDERS, providerConfigSchema, providerSecretSchema, type ProviderConfig } from '@iphone-ai/shared';

import type { AppContext } from '../../core/services.js';
import { providerSecretAccount } from '../../security/secrets.js';
import { HttpError, notFound } from '../errors.js';
import { actorFor, parseBody, requireControl, requireLocal, requireSession, type RouteDeps } from '../guards.js';
import { settingsForSession } from '../redaction.js';

const DEFAULT_IDS = new Set(DEFAULT_PROVIDERS.map((p) => p.id));
/** Path segments under /api/providers that cannot be provider ids. */
const RESERVED_IDS = new Set(['active']);

const activeSchema = z.object({ providerId: z.string().min(1).max(100) });

export function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** "Requests leave this Mac" — derived from the endpoint, not trusted from the client. */
export function providerIsCloud(provider: Pick<ProviderConfig, 'baseUrl'>): boolean {
  return provider.baseUrl ? !isLoopbackUrl(provider.baseUrl) : true;
}

/**
 * Validates a full replacement provider list against the current one:
 * unique ids, built-in providers kept, kinds immutable, new providers must be
 * openai-compatible with a base URL; `hasApiKey` and `cloud` are recomputed.
 */
export function reconcileProviders(
  incoming: readonly ProviderConfig[],
  current: readonly ProviderConfig[],
): { providers: ProviderConfig[]; added: string[]; removed: string[] } {
  const byId = new Map(current.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const providers: ProviderConfig[] = [];
  const added: string[] = [];
  for (const raw of incoming) {
    const provider = providerConfigSchema.parse(raw) as ProviderConfig;
    if (seen.has(provider.id)) throw new HttpError(400, 'duplicate_provider', `Provider id "${provider.id}" is used twice.`);
    seen.add(provider.id);
    const existing = byId.get(provider.id);
    if (existing) {
      if (existing.kind !== provider.kind) {
        throw new HttpError(400, 'provider_kind_immutable', `The type of provider "${existing.label}" cannot be changed.`);
      }
    } else {
      if (RESERVED_IDS.has(provider.id) || DEFAULT_IDS.has(provider.id)) {
        throw new HttpError(400, 'reserved_provider_id', `"${provider.id}" cannot be used as a provider id.`);
      }
      if (provider.kind !== 'openai-compatible') {
        throw new HttpError(400, 'unsupported_provider_kind', 'Custom providers must use the OpenAI-compatible API.');
      }
      added.push(provider.id);
    }
    if (provider.kind === 'openai-compatible' && !provider.baseUrl) {
      throw new HttpError(400, 'base_url_required', `Provider "${provider.label}" needs a base URL (for example http://127.0.0.1:1234/v1).`);
    }
    if (provider.baseUrl && !/^https?:$/.test(new URL(provider.baseUrl).protocol)) {
      throw new HttpError(400, 'invalid_base_url', 'Provider base URLs must use http or https.');
    }
    providers.push({ ...provider, hasApiKey: existing?.hasApiKey ?? false, cloud: providerIsCloud(provider) });
  }
  const removed = current.filter((p) => !seen.has(p.id)).map((p) => p.id);
  const removedDefault = removed.find((id) => DEFAULT_IDS.has(id));
  if (removedDefault) throw new HttpError(400, 'cannot_remove_default', `The built-in provider "${removedDefault}" cannot be removed.`);
  return { providers, added, removed };
}

/** Deletes Keychain entries of removed providers and stale ones for re-used ids. */
export async function dropProviderSecrets(ctx: AppContext, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await ctx.secrets.delete(providerSecretAccount(id));
    } catch (err) {
      ctx.log.warn('Could not delete a provider key', { provider: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function registerProviderRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  const findProvider = (id: string): ProviderConfig => {
    const provider = ctx.settings.get().ai.providers.find((p) => p.id === id);
    if (!provider) throw notFound('AI provider');
    return provider;
  };

  app.get('/api/providers', async (request) => settingsForSession(ctx.settings.get(), requireSession(request)).ai.providers);

  app.get('/api/providers/claude-code/status', async () => ctx.agents.claudeCodeStatus());

  app.put('/api/providers/active', async (request) => {
    const session = requireLocal(request);
    const { providerId } = parseBody(activeSchema, request.body);
    const provider = findProvider(providerId);
    if (!provider.enabled) throw new HttpError(409, 'provider_disabled', `${provider.label} is turned off.`);
    const settings = ctx.settings.mutate((draft) => {
      draft.ai.activeProviderId = providerId;
    });
    ctx.activity.record({
      category: 'settings',
      type: 'provider.activated',
      actor: actorFor(session),
      summary: `AI provider set to ${provider.label}${provider.cloud ? ' (cloud)' : ' (on this Mac)'}.`,
    });
    return settings;
  });

  app.post('/api/providers', async (request) => {
    const session = requireLocal(request);
    const body = providerConfigSchema.parse(request.body ?? {}) as ProviderConfig;
    const current = ctx.settings.get().ai.providers;
    if (current.some((p) => p.id === body.id)) throw new HttpError(409, 'provider_exists', `A provider with id "${body.id}" already exists.`);
    const { providers } = reconcileProviders([...current, body], current);
    // A Keychain entry left behind by an earlier provider with this id must not be re-used.
    await dropProviderSecrets(ctx, [body.id]);
    const settings = ctx.settings.mutate((draft) => {
      draft.ai.providers = providers;
    });
    ctx.activity.record({
      category: 'settings',
      type: 'provider.added',
      actor: actorFor(session),
      summary: `AI provider "${body.label}" added.`,
    });
    return settings;
  });

  app.put<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    const session = requireLocal(request);
    const body = providerConfigSchema.parse(request.body ?? {}) as ProviderConfig;
    if (body.id !== request.params.id) throw new HttpError(400, 'provider_id_mismatch', 'The provider id in the body does not match the URL.');
    findProvider(request.params.id);
    const current = ctx.settings.get().ai.providers;
    const { providers } = reconcileProviders(
      current.map((p) => (p.id === body.id ? body : p)),
      current,
    );
    const settings = ctx.settings.mutate((draft) => {
      draft.ai.providers = providers;
    });
    ctx.activity.record({
      category: 'settings',
      type: 'provider.updated',
      actor: actorFor(session),
      summary: `AI provider "${body.label}" updated.`,
    });
    return settings;
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    const session = requireLocal(request);
    const provider = findProvider(request.params.id);
    if (DEFAULT_IDS.has(provider.id)) throw new HttpError(400, 'cannot_remove_default', 'Built-in providers cannot be removed.');
    await dropProviderSecrets(ctx, [provider.id]);
    const settings = ctx.settings.mutate((draft) => {
      draft.ai.providers = draft.ai.providers.filter((p) => p.id !== provider.id);
    });
    ctx.activity.record({
      category: 'settings',
      type: 'provider.removed',
      actor: actorFor(session),
      summary: `AI provider "${provider.label}" removed.`,
    });
    return settings;
  });

  app.put<{ Params: { id: string } }>('/api/providers/:id/secret', async (request) => {
    const session = requireLocal(request);
    const provider = findProvider(request.params.id);
    const { apiKey } = parseBody(providerSecretSchema, request.body);
    await ctx.secrets.set(providerSecretAccount(provider.id), apiKey);
    ctx.settings.mutate((draft) => {
      const target = draft.ai.providers.find((p) => p.id === provider.id);
      if (target) target.hasApiKey = true;
    });
    ctx.activity.record({
      category: 'security',
      type: 'provider.key_saved',
      actor: actorFor(session),
      summary: `API key for ${provider.label} saved to the Keychain.`,
    });
    return { hasApiKey: true };
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id/secret', async (request) => {
    const session = requireLocal(request);
    const provider = findProvider(request.params.id);
    await ctx.secrets.delete(providerSecretAccount(provider.id));
    ctx.settings.mutate((draft) => {
      const target = draft.ai.providers.find((p) => p.id === provider.id);
      if (target) target.hasApiKey = false;
    });
    ctx.activity.record({
      category: 'security',
      type: 'provider.key_removed',
      actor: actorFor(session),
      summary: `API key for ${provider.label} removed from the Keychain.`,
    });
    return { hasApiKey: false };
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (request) => {
    requireControl(request, auth);
    findProvider(request.params.id);
    return ctx.agents.testProvider(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request) => {
    findProvider(request.params.id);
    return ctx.agents.listProviderModels(request.params.id);
  });
}
