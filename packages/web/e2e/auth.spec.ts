// 1. Sign-in: no session → "session expired"; a wrong desktop token is
// rejected; the right one opens the dashboard with the (mock) iPhone connected
// and Mirroir MCP ready.

import { expect, test } from '@playwright/test';

import { DESKTOP_TOKEN, getStatus, login, resetState, statusBar } from './helpers';

test.describe('sign-in', () => {
  test('without a session the UI asks to reopen from the app', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Session expired — reopen from the iPhone AI app' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    // Nothing of the app shell is rendered, and the API refuses the request.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    const res = await page.request.get('/api/status', { failOnStatusCode: false });
    expect(res.status()).toBe(401);
  });

  test('a wrong desktop token is rejected', async ({ page }) => {
    const response = await page.goto('/auth/desktop?token=wrong');
    expect(response?.status()).toBe(403);
    await expect(page.getByRole('heading', { name: 'Sign-in link not valid' })).toBeVisible();
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'iai_session')).toBeUndefined();
    // Still signed out afterwards.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Session expired/ })).toBeVisible();
  });

  test('the right token opens the dashboard with the mock iPhone connected', async ({ page }) => {
    const response = await page.goto(`/auth/desktop?token=${DESKTOP_TOKEN}`);
    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL(/\/#\/dashboard$/);
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'iai_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Strict');

    await login(page);
    await resetState(page);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

    const bar = statusBar(page);
    // Status chips (their tooltip triggers are named by the chip label).
    await expect(bar.getByRole('button', { name: 'MCP ready' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Mirroring connected' })).toBeVisible();
    await expect(bar.getByText('iPhone', { exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Control mode: Observe Only' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'STOP AI CONTROL' })).toBeVisible();

    // The dashboard's health card shows Mirroir's own status text from the mock.
    await expect(page.getByText(/Connected — mirroring active \(window: 410x898/).first()).toBeVisible();
    const status = await getStatus(page);
    expect(status.server.state).toBe('ready');
    expect(status.server.version).toBe('0.40.1');
    expect(status.mirroring.state).toBe('connected');
    expect(status.permissions.source).toMatch(/mock/i);
  });
});
