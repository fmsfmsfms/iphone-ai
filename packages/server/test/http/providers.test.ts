// Provider configuration and Keychain-backed API keys.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, ProviderConfig } from '@iphone-ai/shared';

import { providerSecretAccount } from '../../src/security/secrets.js';
import { createHarness, localHeaders, loginDesktop, type Harness } from './harness.js';

const API_KEY = 'sk-test-THIS-IS-A-SECRET-KEY-0123456789';

describe('provider routes', () => {
  let h: Harness;
  let cookie: string;

  beforeEach(async () => {
    h = await createHarness();
    cookie = await loginDesktop(h);
  });

  afterEach(async () => {
    await h.close();
  });

  it('stores an API key without echoing it and flips hasApiKey', async () => {
    const res = await h.local.app.inject({
      method: 'PUT',
      url: '/api/providers/openai/secret',
      headers: localHeaders(cookie),
      payload: { apiKey: API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hasApiKey: true });
    expect(res.body).not.toContain(API_KEY);
    expect(await h.secrets.get(providerSecretAccount('openai'))).toBe(API_KEY);

    const list = await h.local.app.inject({ method: 'GET', url: '/api/providers', headers: localHeaders(cookie) });
    expect(list.body).not.toContain(API_KEY);
    const openai = list.json<ProviderConfig[]>().find((p) => p.id === 'openai');
    expect(openai?.hasApiKey).toBe(true);

    const settings = await h.local.app.inject({ method: 'GET', url: '/api/settings', headers: localHeaders(cookie) });
    expect(settings.body).not.toContain(API_KEY);

    const activity = await h.local.app.inject({ method: 'GET', url: '/api/activity', headers: localHeaders(cookie) });
    expect(activity.body).not.toContain(API_KEY);
    expect(activity.body).toContain('API key for OpenAI saved');

    const removed = await h.local.app.inject({ method: 'DELETE', url: '/api/providers/openai/secret', headers: localHeaders(cookie) });
    expect(removed.json()).toEqual({ hasApiKey: false });
    expect(await h.secrets.has(providerSecretAccount('openai'))).toBe(false);
    expect(h.ctx.settings.get().ai.providers.find((p) => p.id === 'openai')?.hasApiKey).toBe(false);
  });

  it('keeps hasApiKey from the backend when a provider is updated', async () => {
    const current = h.ctx.settings.get().ai.providers.find((p) => p.id === 'lmstudio')!;
    const res = await h.local.app.inject({
      method: 'PUT',
      url: '/api/providers/lmstudio',
      headers: localHeaders(cookie),
      payload: { ...current, model: 'qwen3-vl', hasApiKey: true, cloud: true },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<AppSettings>().ai.providers.find((p) => p.id === 'lmstudio')!;
    expect(updated.model).toBe('qwen3-vl');
    expect(updated.hasApiKey).toBe(false);
    expect(updated.cloud).toBe(false);
  });

  it('adds and deletes custom OpenAI-compatible providers only', async () => {
    const custom: ProviderConfig = {
      id: 'vllm-box',
      kind: 'openai-compatible',
      label: 'vLLM box',
      baseUrl: 'http://192.168.1.20:8000/v1',
      model: 'qwen',
      vision: true,
      maxOutputTokens: 4096,
      contextTokens: 32768,
      timeoutMs: 60000,
      effort: null,
      enabled: true,
      hasApiKey: true,
      cloud: false,
    };
    const added = await h.local.app.inject({ method: 'POST', url: '/api/providers', headers: localHeaders(cookie), payload: custom });
    expect(added.statusCode).toBe(200);
    const stored = added.json<AppSettings>().ai.providers.find((p) => p.id === 'vllm-box')!;
    expect(stored.hasApiKey).toBe(false);
    expect(stored.cloud).toBe(true);

    const duplicate = await h.local.app.inject({ method: 'POST', url: '/api/providers', headers: localHeaders(cookie), payload: custom });
    expect(duplicate.statusCode).toBe(409);

    const wrongKind = await h.local.app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: localHeaders(cookie),
      payload: { ...custom, id: 'another', kind: 'anthropic' },
    });
    expect(wrongKind.statusCode).toBe(400);

    const builtIn = await h.local.app.inject({ method: 'DELETE', url: '/api/providers/openai', headers: localHeaders(cookie) });
    expect(builtIn.statusCode).toBe(400);

    const deleted = await h.local.app.inject({ method: 'DELETE', url: '/api/providers/vllm-box', headers: localHeaders(cookie) });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<AppSettings>().ai.providers.some((p) => p.id === 'vllm-box')).toBe(false);
  });

  it('sets the active provider', async () => {
    const res = await h.local.app.inject({
      method: 'PUT',
      url: '/api/providers/active',
      headers: localHeaders(cookie),
      payload: { providerId: 'lmstudio' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AppSettings>().ai.activeProviderId).toBe('lmstudio');
    const missing = await h.local.app.inject({
      method: 'PUT',
      url: '/api/providers/active',
      headers: localHeaders(cookie),
      payload: { providerId: 'nope' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
