// AI assistant against the scripted fake model (local OpenAI-compatible
// provider) and the mock phone:
// 5. AI Mode: open Settings → tap "Wi-Fi" → finish, verified on screen; an
//    action Assisted would flag runs without an approval card.
// 6. Assisted: every action waits for an approval card; approve runs it,
//    reject does not.
//    An approval nobody answers expires and counts as "no".
// 7. A blocked app (Wallet) is refused by policy before Mirroir sees it.

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  api,
  callsSince,
  getSettings,
  login,
  mockStarts,
  modelRequests,
  openRoute,
  readCalls,
  resetState,
  scriptModel,
  setControl,
  switchModeInUi,
  useFakeModel,
  waitForCall,
  waitForRestartAfter,
  writeMockState,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
  await useFakeModel(page);
});

/** Opens a fresh conversation and sends one instruction from the composer. */
async function sendInstruction(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Instruction for the AI' });
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
}

function taskSteps(page: Page): Locator {
  return page.getByRole('list', { name: 'Task steps' }).last();
}

/** Expands the newest task's steps (they are collapsed by default) and returns its timeline. */
async function openSteps(page: Page): Promise<Locator> {
  const toggle = page.getByRole('button', { name: /^Show( \d+)? steps?$/ }).last();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Hide steps' }).last()).toHaveAttribute('aria-expanded', 'true');
  return taskSteps(page);
}

test('AI Mode: the AI opens Settings, taps Wi-Fi and the result is verified on screen', async ({ page }) => {
  await scriptModel([
    { text: 'Opening Settings.', tool: 'open_app', args: { name: 'Settings', reason: 'Wi-Fi lives in Settings' } },
    { tool: 'tap', args: { element_id: '$id:Wi-Fi', reason: 'Open the Wi-Fi settings' } },
    { tool: 'finish_task', args: { status: 'success', summary: 'Wi-Fi settings are open.', evidence: ['Wi-Fi'] } },
  ]);

  // Mode change through the UI, with its confirmation.
  const starts = mockStarts();
  await switchModeInUi(page, 'AI Mode');
  await waitForRestartAfter(page, starts);
  expect((await getSettings(page)).permissions.controlMode).toBe('supervised');

  await openRoute(page, '#/assistant/new');
  await expect(page.getByRole('heading', { name: 'What should the AI do on your iPhone?' })).toBeVisible();
  // A local provider needs no cloud privacy notice.
  await expect(page.getByText(/runs in the cloud/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /AI provider: LM Studio \(local\)/ }).first()).toBeVisible();

  const mark = readCalls().length;
  await sendInstruction(page, 'Navigate to Wi-Fi settings.');

  // The task finishes and says it was checked against the final screen.
  await expect(page.getByText('Verified on screen', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();

  // The step timeline (collapsed once finished) shows the real MCP tool calls and the verification.
  await expect(page.getByRole('list', { name: 'Task steps' })).toHaveCount(0);
  const steps = await openSteps(page);
  await expect(steps.locator('code', { hasText: /^launch_app$/ })).toBeVisible();
  await expect(steps.locator('code', { hasText: /^tap$/ })).toBeVisible();
  await expect(steps.getByText('Finished — verified on screen')).toBeVisible();
  await expect(steps.getByText('The screen changed.').first()).toBeVisible();

  const calls = callsSince(mark);
  expect(calls.filter((c) => c.name === 'launch_app').map((c) => c.args.name)).toEqual(['Settings']);
  expect(calls.filter((c) => c.name === 'tap')).toHaveLength(1);

  const log = await modelRequests();
  expect(log.requests.flatMap((r) => r.problems)).toEqual([]);
  // A text-only local model only gets the iPhone tools of the current mode.
  expect(log.requests[0]?.tools).toEqual(expect.arrayContaining(['open_app', 'tap', 'finish_task']));
});

test('AI Mode: an action Assisted would flag runs without an approval card', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  // A very short app name: Spotlight could open anything, so Assisted mode warns about it on the card.
  await scriptModel([
    { tool: 'open_app', args: { name: 'Ab', reason: 'The user asked for Ab' } },
    { tool: 'finish_task', args: { status: 'failed', summary: 'Ab did not open.' } },
  ]);
  await openRoute(page, '#/assistant/new');
  const mark = readCalls().length;
  const since = Date.now();
  await sendInstruction(page, 'Open Ab.');

  await waitForCall((c) => c.name === 'launch_app', { since: mark, timeout: 30_000 });
  await expect(page.getByText('Failed', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('article', { name: 'Approval request' })).toHaveCount(0);
  const recent = await api<{ createdAt: number }[]>(page, 'GET', '/api/approvals?status=recent');
  expect(recent.filter((a) => a.createdAt >= since)).toEqual([]);
  expect(callsSince(mark).filter((c) => c.name === 'launch_app').map((c) => c.args.name)).toEqual(['Ab']);
});

test('Assisted: approving runs the action, rejecting does not', async ({ page }) => {
  await setControl(page, { mode: 'assisted' });
  await openRoute(page, '#/assistant/new');

  // Run 1 — approve.
  await scriptModel([
    { tool: 'open_app', args: { name: 'Settings', reason: 'The user asked for Settings' } },
    { tool: 'finish_task', args: { status: 'success', summary: 'Settings is open.', evidence: ['Settings'] } },
  ]);
  const mark = readCalls().length;
  await sendInstruction(page, 'Open Settings on my iPhone.');

  const card = page.getByRole('article', { name: 'Approval request' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('AI needs approval')).toBeVisible();
  await expect(card.locator('code', { hasText: /^launch_app$/ })).toBeVisible();
  await expect(card).toContainText('Settings');
  await expect(page.getByText('Waiting for approval').first()).toBeVisible();
  // Nothing reached the phone while waiting.
  await page.waitForTimeout(500);
  expect(callsSince(mark, 'launch_app')).toEqual([]);

  await card.getByRole('button', { name: 'Approve' }).click();
  await waitForCall((c) => c.name === 'launch_app' && c.args.name === 'Settings', { since: mark, timeout: 20_000 });
  await expect(card).toBeHidden();
  await expect(page.getByText('Verified on screen', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect((await openSteps(page)).getByText(/^Approved: /)).toBeVisible();

  // Run 2 — reject (phone back on the Home Screen).
  writeMockState({ screen: 'home', resetSeq: Date.now() });
  await scriptModel([
    { tool: 'open_app', args: { name: 'Settings', reason: 'The user asked for Settings' } },
    { tool: 'finish_task', args: { status: 'failed', summary: 'You rejected opening Settings.' } },
  ]);
  const mark2 = readCalls().length;
  await sendInstruction(page, 'Open Settings again.');
  const card2 = page.getByRole('article', { name: 'Approval request' });
  await expect(card2).toBeVisible({ timeout: 30_000 });
  await card2.getByRole('button', { name: 'Reject' }).click();
  await expect(card2).toBeHidden();
  await expect(page.getByText('Failed', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  // A quiet status with a retry on the newest task — no paragraph repeating the AI's reply, which says it once.
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(1);
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByText('You rejected opening Settings.', { exact: true })).toHaveCount(1);
  await expect((await openSteps(page)).getByText(/^Not approved \(rejected\): /)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(callsSince(mark2, 'launch_app')).toEqual([]);
});

test('an unanswered approval expires and counts as "no"', async ({ page }) => {
  await api(page, 'PUT', '/api/settings', { permissions: { approvalTimeoutSec: 10 } });
  await setControl(page, { mode: 'assisted' });
  await scriptModel([
    { tool: 'open_app', args: { name: 'Settings', reason: 'The user asked for Settings' } },
    { tool: 'finish_task', args: { status: 'needs_user', summary: 'The approval expired; nothing was done.' } },
  ]);
  await openRoute(page, '#/assistant/new');
  const mark = readCalls().length;
  await sendInstruction(page, 'Open Settings on my iPhone.');

  const card = page.getByRole('article', { name: 'Approval request' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/^0:(0\d|10)$/)).toBeVisible();
  await expect(card).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText('Needs you', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect((await openSteps(page)).getByText(/^Not approved \(expired\): /)).toBeVisible({ timeout: 15_000 });
  const recent = await api<{ status: string }[]>(page, 'GET', '/api/approvals?status=recent');
  expect(recent[0]?.status).toBe('expired');
  expect(callsSince(mark).filter((c) => c.name === 'launch_app')).toEqual([]);
});

test('a blocked app is refused by policy and never launched', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  await scriptModel([
    { tool: 'open_app', args: { name: 'Wallet', reason: 'The user asked for Wallet' } },
    { tool: 'finish_task', args: { status: 'failed', summary: 'Wallet is blocked by your safety settings.' } },
  ]);
  await openRoute(page, '#/assistant/new');
  const mark = readCalls().length;
  await sendInstruction(page, 'Open Wallet.');

  const steps = await openSteps(page);
  await expect(steps.getByText(/^Blocked: /)).toBeVisible({ timeout: 30_000 });
  await expect(steps.getByText(/Safety rule ·/)).toBeVisible();
  await expect(steps.getByText(/blocked app/i).first()).toBeVisible();
  await expect(steps.getByText('Blocked by policy')).toBeVisible();
  // The reply says why (once); the card adds the status and, with the steps, what to do about it — no note, no retry.
  await expect(page.getByText('Failed', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Wallet is blocked by your safety settings.', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByText(/isn’t allowed by your safety settings/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.waitForTimeout(500);
  const calls = callsSince(mark);
  expect(calls.filter((c) => c.name === 'launch_app')).toEqual([]);
  expect(calls.filter((c) => JSON.stringify(c.args).toLowerCase().includes('wallet'))).toEqual([]);
});
