// 4. STOP AI CONTROL: the button, ⌘. and Esc Esc latch the stop, manual input
// is refused while latched, and re-arming (with its confirmation) restores
// control. STOP also cancels a waiting AI approval, and SIGTERMs Mirroir when
// an input call is executing (then Mirroir is started again).

import { expect, test, type Page } from '@playwright/test';

import {
  api,
  apiFetch,
  callsSince,
  describeScreen,
  getBootstrap,
  getStatus,
  INPUT_TOOLS,
  login,
  mockStarts,
  openRoute,
  readCalls,
  readMockLog,
  resetState,
  scriptModel,
  setControl,
  statusBar,
  useFakeModel,
  viewerImage,
  waitForCall,
  waitForDeviceReady,
  writeMockState,
} from './helpers';

const touchSurface = (page: Page) => page.getByRole('application', { name: 'iPhone screen — click to tap, drag to swipe' });

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
});

async function openLiveWithManualControl(page: Page): Promise<void> {
  await setControl(page, { manual: true });
  await openRoute(page, '#/live');
  await expect(viewerImage(page)).toBeVisible();
  await expect(touchSurface(page)).toBeVisible();
}

/** Sends an instruction from a fresh conversation in the AI Assistant. */
async function sendInstruction(page: Page, text: string): Promise<void> {
  await openRoute(page, '#/assistant/new');
  const composer = page.getByRole('textbox', { name: 'Instruction for the AI' });
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.afterEach(async ({ page }) => {
  // Never leave the stop latched for the next test, whatever happened here.
  if ((await getStatus(page)).stopLatched) await api(page, 'POST', '/api/control/rearm', {});
});

test('STOP latches, refuses manual input, and re-arming restores control', async ({ page }) => {
  await openLiveWithManualControl(page);
  const bar = statusBar(page);
  const homeButton = page.locator('button', { hasText: /^Home$/ });
  await expect(homeButton).toBeEnabled();

  await bar.getByRole('button', { name: 'STOP AI CONTROL' }).click();

  // Latched: the button turns into the re-arm entry and the viewer says input is disabled.
  const latched = bar.getByRole('button', { name: 'Stopped — Re-arm control' });
  await expect(latched).toBeVisible();
  await expect(bar.getByRole('button', { name: 'STOP AI CONTROL' })).toHaveCount(0);
  await expect(page.getByText('Stopped — input disabled')).toBeVisible();
  await expect(page.getByText('Touch off', { exact: true })).toBeVisible();
  await expect(touchSurface(page)).toHaveCount(0);
  await expect(homeButton).toBeDisabled();
  await expect(page.getByText('The emergency stop is engaged. Re-arm control first.')).toBeVisible();
  const status = await getStatus(page);
  expect(status.stopLatched).toBe(true);
  expect(status.stopReason).toBe('STOP button pressed');

  // A manual action is refused by the backend while latched, and never reaches Mirroir.
  const mark = readCalls().length;
  const refused = await apiFetch(page, 'POST', '/api/control/action', { action: { kind: 'press_home' }, geometryId: null, frameSeq: null });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain('Emergency stop is engaged');
  await page.waitForTimeout(500);
  expect(callsSince(mark).filter((c) => INPUT_TOOLS.has(c.name))).toEqual([]);

  // Re-arm: popover → confirmation dialog.
  await latched.click();
  await expect(page.getByRole('heading', { name: 'AI control is stopped' })).toBeVisible();
  await expect(page.getByText('Reason: STOP button pressed')).toBeVisible();
  await page.getByRole('button', { name: 'Re-arm control', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Re-arm control?' });
  await expect(confirm).toBeVisible();
  expect((await getStatus(page)).stopLatched).toBe(true); // nothing happens before confirming
  await confirm.getByRole('button', { name: 'Re-arm', exact: true }).click();
  await expect(confirm).toBeHidden();

  await expect(bar.getByRole('button', { name: 'STOP AI CONTROL' })).toBeVisible();
  await expect(page.getByText('Stopped — input disabled')).toHaveCount(0);
  await expect(touchSurface(page)).toBeVisible();
  expect((await getStatus(page)).stopLatched).toBe(false);

  // Control works again.
  const mark2 = readCalls().length;
  await homeButton.click();
  await waitForCall((c) => c.name === 'press_home', { since: mark2, message: 'press_home did not reach the mock after re-arming' });
});

test('the ⌘. and Esc Esc shortcuts engage the stop from anywhere', async ({ page }) => {
  await openLiveWithManualControl(page);
  const bar = statusBar(page);
  // Focus inside a text field must not swallow the emergency shortcut.
  await page.getByRole('textbox', { name: 'Text to type' }).click();
  await page.keyboard.press('Meta+Period');

  await expect(bar.getByRole('button', { name: 'Stopped — Re-arm control' })).toBeVisible();
  await expect(page.getByText('Stopped — input disabled')).toBeVisible();
  const status = await getStatus(page);
  expect(status.stopLatched).toBe(true);
  expect(status.stopReason).toBe('Stop keyboard shortcut pressed');

  const refused = await apiFetch(page, 'POST', '/api/control/action', { action: { kind: 'press_home' }, geometryId: null, frameSeq: null });
  expect(refused.status()).toBe(403);

  await api(page, 'POST', '/api/control/rearm', {});
  await expect(bar.getByRole('button', { name: 'STOP AI CONTROL' })).toBeVisible();

  // Esc pressed twice in quick succession is the other emergency shortcut.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(bar.getByRole('button', { name: 'Stopped — Re-arm control' })).toBeVisible();
  expect((await getStatus(page)).stopReason).toBe('Stop keyboard shortcut pressed');
});

test('STOP cancels a pending approval and the AI task; nothing reaches the phone', async ({ page }) => {
  await useFakeModel(page);
  await setControl(page, { mode: 'assisted' });
  await scriptModel([
    { tool: 'open_app', args: { name: 'Settings', reason: 'The user asked for Settings' } },
    { tool: 'finish_task', args: { status: 'success', summary: 'Settings is open.', evidence: ['Settings'] } },
  ]);
  const mark = readCalls().length;
  await sendInstruction(page, 'Open Settings on my iPhone.');
  const card = page.getByRole('article', { name: 'Approval request' });
  await expect(card).toBeVisible({ timeout: 30_000 });

  await statusBar(page).getByRole('button', { name: 'STOP AI CONTROL' }).click();
  await expect(statusBar(page).getByRole('button', { name: 'Stopped — Re-arm control' })).toBeVisible();
  await expect(card).toBeHidden();
  await expect(page.getByRole('note').filter({ hasText: 'Stopped by the emergency stop' })).toBeVisible({ timeout: 15_000 });

  const boot = await getBootstrap(page);
  expect(boot.activeTask).toBeNull();
  expect(boot.pendingApprovals).toEqual([]);
  const recent = await api<{ status: string }[]>(page, 'GET', '/api/approvals?status=recent');
  expect(recent[0]?.status).toBe('cancelled');
  await page.waitForTimeout(500);
  expect(callsSince(mark).filter((c) => INPUT_TOOLS.has(c.name))).toEqual([]);
});

test('STOP during an executing input terminates Mirroir with SIGTERM and restarts it', async ({ page }) => {
  await useFakeModel(page);
  await setControl(page, { mode: 'supervised' });
  // launch_app hangs for 8 s inside Mirroir before it does anything.
  writeMockState({ slowMs: { launch_app: 8000 } });
  await scriptModel([
    { tool: 'open_app', args: { name: 'Settings', reason: 'The user asked for Settings' } },
    { tool: 'finish_task', args: { status: 'success', summary: 'Settings is open.', evidence: ['Settings'] } },
  ]);
  const logMark = readMockLog().length;
  const callMark = readCalls().length;
  const starts = mockStarts();
  await sendInstruction(page, 'Open Settings on my iPhone.');
  await waitForCall((c) => c.name === 'launch_app', { since: callMark, timeout: 30_000 });
  expect((await getStatus(page)).actionInFlight).toBe(true);

  await statusBar(page).getByRole('button', { name: 'STOP AI CONTROL' }).click();
  await expect(statusBar(page).getByRole('button', { name: 'Stopped — Re-arm control' })).toBeVisible();

  // Mirroir got SIGTERM (it releases held input on that signal) and was started again.
  await expect.poll(() => readMockLog().slice(logMark).some((e) => e.signal === 'SIGTERM'), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => mockStarts(), { timeout: 15_000 }).toBeGreaterThan(starts);
  await expect(page.getByRole('note').filter({ hasText: 'Stopped by the emergency stop' })).toBeVisible({ timeout: 15_000 });

  writeMockState({ slowMs: {} });
  await api(page, 'POST', '/api/control/rearm', {});
  await waitForDeviceReady(page);
  // The interrupted launch never happened: the phone is still on the Home Screen.
  expect((await describeScreen(page)).rawText).not.toContain('"Wi-Fi"');
});
