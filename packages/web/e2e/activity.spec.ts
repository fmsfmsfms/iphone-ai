// 9. Activity History lists what happened (including events this test causes),
// filters by category, and exports the filtered list as a download.

import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';
import type { ActivityEvent } from '@iphone-ai/shared';

import { api, login, openRoute, resetState, setControl, waitForCall, readCalls } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
});

test('activity history shows events, filters by category and exports a download', async ({ page }) => {
  // A manual action from this test: manual control on, then Home.
  await setControl(page, { manual: true });
  const mark = readCalls().length;
  await api(page, 'POST', '/api/control/action', { action: { kind: 'press_home' }, geometryId: null, frameSeq: null });
  await waitForCall((c) => c.name === 'press_home', { since: mark });

  await openRoute(page, '#/activity');
  await expect(page.getByRole('heading', { name: 'Activity History', level: 1 })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const manualEvent = page.getByRole('button', { name: /^Go to the Home Screen — done — Show details$/ }).first();
  // setControl() above recorded this settings change.
  const settingsEvent = page.getByRole('button', { name: /^Manual control turned on\. — Show details$/ }).first();
  await expect(manualEvent).toBeVisible();
  await expect(settingsEvent).toBeVisible();

  // The detail drawer explains the event.
  await manualEvent.click();
  const drawer = page.getByRole('dialog', { name: 'Event details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('press_home').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Category filter: only manual-control events remain.
  await page.getByRole('grid', { name: 'Category' }).getByText('Manual control', { exact: true }).click();
  await expect(settingsEvent).toBeHidden();
  await expect(manualEvent).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();

  // Export (JSON) is delivered as a file download, filtered like the list.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export as JSON' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^iphone-ai-activity-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  const events = JSON.parse(readFileSync(await download.path(), 'utf8')) as ActivityEvent[];
  expect(events.length).toBeGreaterThan(0);
  expect(new Set(events.map((e) => e.category))).toEqual(new Set(['manual']));
  expect(events.some((e) => e.tool === 'press_home' && e.success === true)).toBe(true);
  await expect(page.getByText('Export saved')).toBeVisible();

  // Clearing the filter brings everything back.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(settingsEvent).toBeVisible();

  // Older events are found by searching (server-side), e.g. this backend's start in MOCK mode.
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('MOCK mode');
  await expect(page.getByRole('button', { name: /started in MOCK mode \(no real iPhone\)\. — Show details$/ }).first()).toBeVisible();
  await expect(manualEvent).toBeHidden();
});
