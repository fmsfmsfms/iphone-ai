// Control mode from the status bar: more AI autonomy needs a confirmation
// (cancelling changes nothing), less autonomy applies immediately.

import { expect, test } from '@playwright/test';

import { getSettings, login, mockStarts, resetState, statusBar, waitForDeviceReady, waitForRestartAfter } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
});

test('escalating the control mode asks first; going back to Observe Only does not', async ({ page }) => {
  const bar = statusBar(page);
  const menu = page.getByRole('dialog', { name: /^Control mode:/ });

  // Cancel an escalation: nothing changes, Mirroir keeps its input-free permission file.
  const starts = mockStarts();
  await bar.getByRole('button', { name: 'Control mode: Observe Only' }).click();
  await menu.getByRole('menuitemradio', { name: /^Assisted/ }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Switch to Assisted?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Nothing happens until you approve each action.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(bar.getByRole('button', { name: 'Control mode: Observe Only' })).toBeVisible();
  expect((await getSettings(page)).permissions.controlMode).toBe('observe');
  await page.waitForTimeout(500);
  expect(mockStarts()).toBe(starts);

  // Confirm an escalation.
  await bar.getByRole('button', { name: 'Control mode: Observe Only' }).click();
  await menu.getByRole('menuitemradio', { name: /^Supervised/ }).click();
  const confirm2 = page.getByRole('alertdialog', { name: 'Switch to Supervised?' });
  await confirm2.getByRole('button', { name: 'Switch to Supervised' }).click();
  await expect(bar.getByRole('button', { name: 'Control mode: Supervised' })).toBeVisible();
  expect((await getSettings(page)).permissions.controlMode).toBe('supervised');
  await waitForRestartAfter(page, starts);

  // De-escalation applies at once, without a dialog.
  const starts2 = mockStarts();
  await bar.getByRole('button', { name: 'Control mode: Supervised' }).click();
  await menu.getByRole('menuitemradio', { name: /^Observe Only/ }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Control mode: Observe Only' })).toBeVisible();
  expect((await getSettings(page)).permissions.controlMode).toBe('observe');
  // Mirroir is restarted with input tools removed again.
  await waitForDeviceReady(page, { minStarts: starts2 + 1 });
});
