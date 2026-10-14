import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activityQueryString, api, ApiError, setUnauthorizedHandler } from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it('sends same-origin GETs without the CSRF header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, version: '1' }));
    await api.health();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/health');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['x-iphone-ai']).toBeUndefined();
  });

  it('adds the CSRF header and a JSON body to state-changing requests', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { opened: true }));
    await api.connection.openSettings('screen-recording');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/connection/open-settings');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-iphone-ai']).toBe('1');
    expect(headers['content-type']).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ pane: 'screen-recording' }));
  });

  it('uses PUT and DELETE where the API says so', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.conversations.remove('c/1');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/conversations/c%2F1');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.control.setMode('assisted');
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[1]![1]?.body).toBe(JSON.stringify({ mode: 'assisted' }));
  });

  it('turns JSON errors into ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'geometry_changed', message: 'The iPhone window changed size.' } }));
    const err = await api.control
      .action({ action: { kind: 'tap', x: 1, y: 2 }, geometryId: '410x890', frameSeq: 3 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'geometry_changed', message: 'The iPhone window changed size.' });
  });

  it('reports a 401 to the session handler', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'unauthenticated', message: 'No session' } }));
    await expect(api.bootstrap()).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not report quiet 401 probes', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'unauthenticated', message: 'No session' } }));
    await expect(api.auth.session({ quiet401: true })).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps network failures and proxy errors to unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const network = await api.status().catch((e: unknown) => e);
    expect(network).toMatchObject({ status: 0, code: 'network' });
    expect((network as ApiError).isUnreachable).toBe(true);

    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }));
    const proxy = await api.status().catch((e: unknown) => e);
    expect(proxy).toMatchObject({ status: 502, code: 'bad_gateway' });
  });

  it('serialises activity queries with comma-separated lists', () => {
    expect(activityQueryString({ categories: ['ai', 'manual'], limit: 8, search: 'tap' })).toBe('?categories=ai%2Cmanual&search=tap&limit=8');
    expect(activityQueryString({})).toBe('');
  });

  it('builds frame and screenshot URLs', () => {
    expect(api.screen.latestFrameUrl(12)).toBe('/api/screen/frame/latest?seq=12');
    expect(api.screen.screenshotUrl('shot 1')).toBe('/api/screenshots/shot%201');
  });
});
