// 8. Automations: build a workflow in the editor (Open app "Settings" → Tap
// text "Wi-Fi"), switch to AI Mode from the run panel, run it, and see
// per-step results and the run in the history.

import { expect, test } from '@playwright/test';

import { callsSince, getSettings, login, mockStarts, openRoute, readCalls, resetState, waitForRestartAfter } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
});

test('a workflow built in the editor runs step by step in AI Mode', async ({ page }) => {
  const name = `E2E Wi-Fi ${Date.now()}`;
  await openRoute(page, '#/automations');
  await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New workflow' }).first().click();
  await expect(page.getByRole('heading', { name: 'New workflow', level: 1 })).toBeVisible();

  await page.getByRole('textbox', { name: 'Name' }).fill(name);

  // Step 1: Open app → Settings.
  await page.getByRole('button', { name: 'Add step' }).first().click();
  await page.getByRole('menuitem', { name: /^Open app/ }).click();
  await page.getByRole('textbox', { name: 'App name' }).fill('Settings');

  // Step 2: Tap text → Wi-Fi.
  await page.getByRole('button', { name: 'Add step' }).first().click();
  await page.getByRole('menuitem', { name: /^Tap text/ }).click();
  await page.getByRole('textbox', { name: 'Text on screen' }).fill('Wi-Fi');

  const editorSteps = page.getByRole('list', { name: 'Workflow steps' });
  await expect(editorSteps.getByRole('listitem')).toHaveCount(2);
  await expect(editorSteps).toContainText('Open “Settings”');
  await expect(editorSteps).toContainText('Tap “Wi-Fi”');

  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page).toHaveURL(/#\/automations\/(?!new)[^/]+$/);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  // Runs need Assisted or AI Mode: switch from the run panel (with confirmation).
  const run = page.getByRole('button', { name: 'Run workflow' });
  await expect(page.getByText('Runs need Assisted or AI Mode')).toBeVisible();
  await expect(run).toBeDisabled();
  const starts = mockStarts();
  await page.getByRole('button', { name: 'Switch to AI Mode' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Switch to AI Mode?' });
  await dialog.getByRole('button', { name: 'Switch to AI Mode' }).click();
  await expect(dialog).toBeHidden();
  await waitForRestartAfter(page, starts);
  expect((await getSettings(page)).permissions.controlMode).toBe('supervised');

  const mark = readCalls().length;
  await expect(run).toBeEnabled();
  await run.click();

  // Per-step results.
  const results = page.getByRole('list', { name: 'Step results' }).first();
  await expect(results.getByRole('listitem')).toHaveCount(2);
  await expect(results.getByRole('img', { name: 'Succeeded' })).toHaveCount(2, { timeout: 45_000 });
  await expect(page.getByText('2 of 2 steps succeeded').first()).toBeVisible();

  // The run is in the history.
  const history = page.getByRole('grid', { name: 'Run history' });
  await expect(history.getByRole('row').filter({ hasText: 'Succeeded' }).filter({ hasText: '2/2' })).toHaveCount(1, { timeout: 15_000 });

  const calls = callsSince(mark);
  expect(calls.filter((c) => c.name === 'launch_app').map((c) => c.args.name)).toEqual(['Settings']);
  expect(calls.filter((c) => c.name === 'tap')).toHaveLength(1);
});
