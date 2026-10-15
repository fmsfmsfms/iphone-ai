// Live Control's assistant panel at a laptop size, where it is narrowest (real
// layout in Chromium, the scripted fake model and the mock phone):
// - one scroll area; a pending approval's decision buttons are in view after
//   turns of streamed commentary, and the "Approval needed" cue leads back to
//   it (focus included);
// - an approval that arrives while the user reads further up is brought into
//   view;
// - while a task runs and its card is out of view, a strip under the
//   conversation keeps its status and pause / cancel at hand;
// - the view holds while the user reads further up and follows again from
//   the end; expanding steps that load slowly keeps the clicked toggle in place.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { api, login, openRoute, resetState, scriptModel, setControl, type ScriptedTurn, useFakeModel, writeMockState } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
  await useFakeModel(page);
});

const panel = (page: Page) => page.locator('[aria-label="Assistant panel"]');
const thread = (page: Page) => panel(page).getByRole('log', { name: 'Conversation' });
const strip = (page: Page) => panel(page).getByRole('region', { name: 'Running task' });
const distanceFromEnd = (page: Page) => thread(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Whether `target` is entirely inside the visible part of the panel's conversation. */
async function inThreadView(page: Page, target: Locator): Promise<boolean> {
  const view = await thread(page).boundingBox();
  const box = await target.boundingBox();
  return Boolean(view && box && box.y >= view.y - 1 && box.y + box.height <= view.y + view.height + 1);
}

/** Scrolls the conversation up the way a user does (wheel), so it stops following. */
async function wheelUp(page: Page, deltaY = -4000): Promise<void> {
  const box = (await thread(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/** A new conversation (the panel shows the newest one) on Live Control at a laptop size. */
async function openPanel(page: Page): Promise<string> {
  const conversation = await api<{ id: string }>(page, 'POST', '/api/conversations', {});
  await page.setViewportSize({ width: 1024, height: 700 });
  await openRoute(page, '#/live');
  await expect(thread(page)).toBeVisible();
  return conversation.id;
}

async function startTask(page: Page, conversationId: string, text: string): Promise<string> {
  const { task } = await api<{ task: { id: string } }>(page, 'POST', `/api/conversations/${conversationId}/messages`, { text });
  return task.id;
}

const taskStatus = async (page: Page, taskId: string) => (await api<{ task: { status: string } }>(page, 'GET', `/api/tasks/${taskId}`)).task.status;

async function waitForTask(page: Page, taskId: string): Promise<void> {
  await expect.poll(() => taskStatus(page, taskId), { timeout: 30_000 }).toMatch(/^(completed|failed|cancelled|stopped)$/);
}

/** Turns of commentary (each looks at the screen), long enough to fill the narrow panel. */
function commentary(count: number, delayMs = 0): ScriptedTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `Turn ${i + 1}: I looked at the screen and checked what is visible before choosing the next action, so nothing is tapped by mistake.`,
    tool: 'observe_screen',
    args: { reason: `Look ${i + 1}` },
    ...(delayMs ? { delayMs } : {}),
  }));
}

test('one scroll area; an approval after turns of commentary stays in view and the cue leads back to it', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  const conversationId = await openPanel(page);
  await scriptModel([
    ...commentary(6),
    { text: 'Now opening the app named Ab, which needs your approval.', tool: 'open_app', args: { name: 'Ab', reason: 'Open Ab' } },
    { tool: 'finish_task', args: { status: 'failed', summary: 'You rejected opening Ab.' } },
  ]);
  const taskId = await startTask(page, conversationId, 'Open Ab after looking around');

  const card = panel(page).getByRole('article', { name: 'Approval request' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // One vertical scroll area — the conversation — and nothing wider than the panel.
  const layout = await panel(page).evaluate((root) => {
    const log = root.querySelector<HTMLElement>('[role="log"]')!;
    const scrollers = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    });
    return { scrollers: scrollers.length, isThread: scrollers[0] === log, overflowX: log.scrollWidth - log.clientWidth };
  });
  expect(layout).toEqual({ scrollers: 1, isThread: true, overflowX: 0 });
  // The approval is the newest thing in the turn: its decision buttons are in view.
  await expect.poll(() => inThreadView(page, card.getByRole('button', { name: 'Approve' }))).toBe(true);

  // Scrolled away from it, the thread says an approval is waiting and goes back to it (focus included).
  await thread(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  const cue = panel(page).getByRole('button', { name: 'Approval needed' });
  await expect(cue).toBeVisible();
  await cue.focus();
  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();
  await expect.poll(() => inThreadView(page, card.getByRole('button', { name: 'Approve' }))).toBe(true);
  await expect(cue).toBeHidden();

  await card.getByRole('button', { name: 'Reject' }).click();
  await waitForTask(page, taskId);
  await expect(panel(page).getByText('Failed', { exact: true })).toBeVisible();
  // The summary is said once, at the end of the reply.
  await expect.poll(async () => (await panel(page).innerText()).split('You rejected opening Ab.').length - 1).toBe(1);
});

test('an approval that arrives while the user reads further up is brought into view', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  const conversationId = await openPanel(page);
  await scriptModel([
    ...commentary(4),
    { delayMs: 3000, text: 'Opening the app named Ab now.', tool: 'open_app', args: { name: 'Ab', reason: 'Open Ab' } },
    { tool: 'finish_task', args: { status: 'failed', summary: 'You rejected opening Ab.' } },
  ]);
  const taskId = await startTask(page, conversationId, 'Look around, then open Ab');
  await expect(thread(page).getByText(/^Turn 4:/m)).toBeVisible({ timeout: 30_000 });

  await wheelUp(page);
  await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(100);
  const card = panel(page).getByRole('article', { name: 'Approval request' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => inThreadView(page, card.getByRole('button', { name: 'Approve' }))).toBe(true);
  await expect(panel(page).getByRole('button', { name: 'Approval needed' })).toBeHidden();

  await card.getByRole('button', { name: 'Reject' }).click();
  await waitForTask(page, taskId);
});

test('while the running task’s card is out of view, a strip keeps its status and pause / cancel at hand', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  const conversationId = await openPanel(page);
  await scriptModel([
    ...commentary(4),
    // Keeps the task running while the test looks at it, then it finishes on its own.
    { delayMs: 12_000, tool: 'finish_task', args: { status: 'success', summary: 'Looked around.', evidence: [] } },
  ]);
  const taskId = await startTask(page, conversationId, 'Look around for a while');
  await expect(thread(page).getByText(/^Turn 4:/m)).toBeVisible({ timeout: 30_000 });
  const card = panel(page).getByRole('region', { name: 'AI task' });
  await expect(card.getByText('Working', { exact: true })).toBeVisible();

  // At the end the card itself has the controls: no strip repeating them.
  await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(2);
  await expect(strip(page)).toHaveCount(0);

  // Reading further up: the strip sits between the conversation and the composer, outside the scroll area.
  await wheelUp(page);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText('Working');
  await expect(strip(page).getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(strip(page).getByRole('button', { name: 'Cancel task' })).toBeVisible();
  expect(await thread(page).evaluate((log) => log.contains(document.querySelector('[aria-label="Running task"]')))).toBe(false);
  const [stripBox, composerBox] = await Promise.all([strip(page).boundingBox(), panel(page).getByRole('textbox', { name: 'Instruction for the AI' }).boundingBox()]);
  expect(stripBox!.y + stripBox!.height).toBeLessThanOrEqual(composerBox!.y);

  // It leads back to the card (focus included for keyboard users), then steps aside.
  await strip(page).getByRole('button', { name: /^Working/ }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => inThreadView(page, card.getByRole('button', { name: 'Cancel task' }))).toBe(true);
  await expect(card).toBeFocused();
  await expect(strip(page)).toHaveCount(0);

  // Its controls act on the task.
  await wheelUp(page);
  await strip(page).getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => taskStatus(page, taskId)).toBe('paused');
  await expect(strip(page)).toContainText('Paused');
  await strip(page).getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => taskStatus(page, taskId)).toBe('running');
  await expect(strip(page)).toContainText('Working');

  // Once the task has ended there is nothing left to stop: the strip goes away.
  await waitForTask(page, taskId);
  await expect(strip(page)).toHaveCount(0);
  await expect(card.getByText('Completed', { exact: true })).toBeVisible();
});

test('holds the reading position while the AI keeps writing, and follows again from the end', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  const conversationId = await openPanel(page);
  const long = 'I am looking at the screen and describing what I see before the next step. '.repeat(5);
  await scriptModel([
    { text: `First look. ${long}`, tool: 'observe_screen', args: { reason: 'Look' } },
    { text: `Second look. ${long}`, tool: 'observe_screen', args: { reason: 'Look again' } },
    { delayMs: 4000, text: `Third look. ${long}`, tool: 'observe_screen', args: { reason: 'Look once more' } },
    { delayMs: 1000, text: `Fourth look. ${long}`, tool: 'finish_task', args: { status: 'success', summary: 'Described the Home Screen.', evidence: [] } },
  ]);
  const taskId = await startTask(page, conversationId, 'Describe the screen');
  await expect(thread(page).getByText(/Second look\./)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(2);

  // A small scroll up is enough to stop following.
  await wheelUp(page, -60);
  await expect.poll(() => distanceFromEnd(page)).toBeGreaterThan(20);
  const held = await thread(page).evaluate((el) => el.scrollTop);
  await expect(thread(page).getByText(/Fourth look\./)).toBeVisible({ timeout: 30_000 });
  expect(Math.abs((await thread(page).evaluate((el) => el.scrollTop)) - held)).toBeLessThanOrEqual(2);

  // "Jump to latest" goes to the end, keeps keyboard focus in the thread, and the view follows again.
  const jump = panel(page).getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeVisible();
  await jump.focus();
  await page.keyboard.press('Enter');
  await expect(jump).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.closest('[aria-label="Assistant panel"]') !== null)).toBe(true);
  await waitForTask(page, taskId);
  await expect(panel(page).getByText('Completed', { exact: true })).toBeVisible();
  await expect.poll(() => distanceFromEnd(page)).toBeLessThanOrEqual(2);
});

test('expanding steps that load slowly keeps the toggle in place', async ({ page }) => {
  await setControl(page, { mode: 'supervised' });
  const conversation = await api<{ id: string }>(page, 'POST', '/api/conversations', {});
  for (let i = 1; i <= 2; i += 1) {
    writeMockState({ screen: 'home', resetSeq: Date.now() });
    await scriptModel([
      { text: `Looking around, part ${i}. `.repeat(8), tool: 'observe_screen', args: { reason: 'Look' } },
      { tool: 'finish_task', args: { status: 'success', summary: `Done ${i}.`, evidence: [] } },
    ]);
    await waitForTask(page, await startTask(page, conversation.id, `History instruction ${i}`));
  }
  // A finished task's steps load when first opened; make that slow.
  await page.route('**/api/tasks/*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.reload();
  await openRoute(page, '#/live');
  await expect(thread(page).getByText('History instruction 2')).toBeVisible();
  const toggle = panel(page).getByRole('button', { name: /^Show( \d+)? steps?$/ }).last();
  await expect.poll(() => inThreadView(page, toggle)).toBe(true);
  const before = (await toggle.boundingBox())!.y;
  await toggle.click();
  const hide = panel(page).getByRole('button', { name: 'Hide steps' });
  await expect(panel(page).getByRole('list', { name: 'Task steps' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  expect(Math.abs((await hide.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  // The summary is the reply's; the closing check keeps only what it adds.
  await expect(panel(page).getByRole('list', { name: 'Task steps' }).getByText(/Done 2\./)).toHaveCount(0);
});
