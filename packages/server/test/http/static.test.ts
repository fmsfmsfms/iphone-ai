// Built UI serving: cache headers and SPA fallback.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, LOCAL_HOST, localHeaders, loginDesktop, type Harness } from './harness.js';

describe('static UI', () => {
  let h: Harness;
  let dist: string;

  beforeEach(async () => {
    dist = mkdtempSync(path.join(tmpdir(), 'iphone-ai-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>iPhone AI</title><div id="root"></div>');
    writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
    h = await createHarness({ webDistDir: dist });
  });

  afterEach(async () => {
    await h.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves index.html without caching and hashed assets immutably', async () => {
    const index = await h.local.app.inject({ method: 'GET', url: '/', headers: { host: LOCAL_HOST } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<div id="root">');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(String(index.headers['content-security-policy'])).toContain("script-src 'self'");

    const asset = await h.local.app.inject({ method: 'GET', url: '/assets/index-abc123.js', headers: { host: LOCAL_HOST } });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client routes but not for API or missing files', async () => {
    const route = await h.local.app.inject({ method: 'GET', url: '/settings/permissions', headers: { host: LOCAL_HOST, accept: 'text/html' } });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('<div id="root">');

    const missingAsset = await h.local.app.inject({ method: 'GET', url: '/assets/gone-123.js', headers: { host: LOCAL_HOST } });
    expect(missingAsset.statusCode).toBe(404);

    const cookie = await loginDesktop(h);
    const api = await h.local.app.inject({ method: 'GET', url: '/api/does-not-exist', headers: localHeaders(cookie, { accept: 'text/html' }) });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: { code: 'not_found' } });

    const badHost = await h.local.app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example:47823' } });
    expect(badHost.statusCode).toBe(421);
  });
});
